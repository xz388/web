const dgram = require('dgram');
const { execSync } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');

var cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

var FB = cfg.firebaseUrl.replace(/\/+$/, '');
var QUERY_PORT = cfg.queryPort;
var INTERVAL = cfg.queryIntervalMs || 15000;
var PROC = cfg.processName || 'ASADedicatedManager';
var SOCKET_TIMEOUT = 4000;

var startedAt = null;
var lastStatus = null;
var stateFile = path.join(__dirname, 'state.json');

function readState() {
    try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch(e) { return {}; }
}
function writeState(s) {
    try { fs.writeFileSync(stateFile, JSON.stringify(s)); } catch(e) {} 
}

var st = readState();
if (st.startedAt) startedAt = st.startedAt;

function isProcessRunning(name) {
    try {
        execSync('tasklist /FI "IMAGENAME eq ' + name + '.exe" 2>nul | find /I "' + name + '.exe" >nul', { stdio: 'pipe' });
        return true;
    } catch(e) { return false; }
}

function parseStr(buf, off) {
    var end = off;
    while (end < buf.length && buf[end] !== 0) end++;
    return { value: buf.toString('utf8', off, end), offset: end + 1 };
}

function a2sResponse(buf) {
    if (buf.length < 6 || buf[4] !== 0x49) return null;
    var o = 5;
    o++; // protocol
    var r, name, map, folder, game;
    r = parseStr(buf, o); name = r.value; o = r.offset;
    r = parseStr(buf, o); map = r.value; o = r.offset;
    r = parseStr(buf, o); folder = r.value; o = r.offset;
    r = parseStr(buf, o); game = r.value; o = r.offset;
    if (o + 7 > buf.length) return null;
    var appId = buf.readInt16LE(o); o += 2;
    var players = buf[o++];
    var maxPlayers = buf[o++];
    var bots = buf[o++];
    o++; o++; o++; o++; // serverType, env, vis, vac
    if (o < buf.length) {
        var edf = buf[o++];
        if (edf & 0x80) o += 2;
        if (edf & 0x10) o += 8;
        if (edf & 0x40) { o += 2; r = parseStr(buf, o); o = r.offset; }
        if (edf & 0x20) { r = parseStr(buf, o); o = r.offset; }
        if (edf & 0x01) o += 8;
    }
    return { name: name, map: map, players: players, maxPlayers: maxPlayers, bots: bots };
}

function a2sQuery(port) {
    return new Promise(function(resolve) {
        var sock = dgram.createSocket('udp4');
        var timedOut = false;
        var timer = setTimeout(function() {
            timedOut = true;
            sock.close();
            resolve(null);
        }, SOCKET_TIMEOUT);

        var req = Buffer.alloc(25);
        req[0] = 0xFF; req[1] = 0xFF; req[2] = 0xFF; req[3] = 0xFF;
        req[4] = 0x54;
        req.write('Source Engine Query\0', 5);

        sock.on('message', function(msg) {
            if (timedOut) return;
            if (msg.length < 5) return;
            if (msg[4] === 0x49) {
                clearTimeout(timer);
                sock.close();
                resolve(a2sResponse(msg));
            } else if (msg[4] === 0x41 && msg.length >= 9) {
                var challenge = Buffer.alloc(29);
                req.copy(challenge, 0, 0, 25);
                msg.copy(challenge, 25, 5, 9);
                try { sock.send(challenge, 0, 29, port, '127.0.0.1'); } catch(e) {}
            }
        });

        sock.on('error', function() {
            clearTimeout(timer);
            sock.close();
            resolve(null);
        });

        try { sock.send(req, 0, 25, port, '127.0.0.1'); } catch(e) {
            clearTimeout(timer);
            sock.close();
            resolve(null);
        }
    });
}

function fbPut(urlPath, data) {
    return new Promise(function(resolve) {
        var json = JSON.stringify(data);
        var url = new URL(urlPath, FB);
        var opts = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' }
        };
        var req = https.request(opts, function(res) {
            res.resume();
            res.on('end', resolve);
        });
        req.on('error', resolve);
        req.write(json);
        req.end();
    });
}

function pad(n) { return n < 10 ? '0' + n : '' + n; }
function fmtDur(sec) {
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    return (h > 0 ? h + 'h ' : '') + pad(m) + 'm ' + pad(s) + 's';
}

async function tick() {
    var running = isProcessRunning(PROC);
    var data = {
        status: 'offline',
        name: '',
        players: 0,
        maxPlayers: 0,
        map: '',
        ping: 0,
        uptime: 0,
        uptimeStr: '',
        customText: cfg.customText || '',
        customTextLink: cfg.customTextLink || '',
        nextRestart: cfg.nextRestart || null,
        lastSeen: Date.now(),
        lastOnline: null
    };

    if (running) {
        var result = await a2sQuery(QUERY_PORT);
        if (result) {
            data.status = 'online';
            data.name = result.name || cfg.serverName || '';
            data.players = result.players || 0;
            data.maxPlayers = result.maxPlayers || 0;
            data.map = result.map || '';
            if (!startedAt) {
                startedAt = Date.now();
                writeState({ startedAt: startedAt });
            }
            data.lastOnline = startedAt;
        } else {
            data.status = 'standby';
            if (startedAt) data.lastOnline = startedAt;
        }
    } else {
        if (startedAt) {
            startedAt = null;
            writeState({});
        }
    }

    if (startedAt) {
        var sec = Math.floor((Date.now() - startedAt) / 1000);
        data.uptime = sec;
        data.uptimeStr = fmtDur(sec);
    }

    if (data.status === 'offline') {
        data.status = 'offline';
    }

    await fbPut('/serverStatus.json', data);
    lastStatus = data.status;
}

console.log('[ARK Monitor] Started - polling every ' + (INTERVAL/1000) + 's');
tick();
setInterval(tick, INTERVAL);

process.on('SIGINT', function() { console.log('[ARK Monitor] Stopped'); process.exit(); });
process.on('SIGTERM', function() { process.exit(); });
