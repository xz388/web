param(
    [string]$ManagerPath = "D:\ARKMAN\ASADedicatedManager.exe",
    [string]$MonitorScript = "D:\web\server-monitor\monitor.js"
)

Write-Host "[Launcher] Starting ARK Dedicated Manager..."
$mgr = Start-Process -FilePath $ManagerPath -PassThru
Write-Host "[Launcher] Starting monitor..."
$mon = Start-Process -FilePath "node" -ArgumentList @("`"$MonitorScript`"") -WindowStyle Hidden -PassThru

Write-Host "[Launcher] Manager PID: $($mgr.Id), Monitor PID: $($mon.Id)"

$mgr.WaitForExit()

Write-Host "[Launcher] Manager closed. Stopping monitor..."
try { Stop-Process -Id $mon.Id -Force -ErrorAction Stop } catch { }

Write-Host "[Launcher] Done."
