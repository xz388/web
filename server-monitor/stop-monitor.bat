@echo off
powershell -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*monitor*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Output 'Monitor stopped' }"
if %errorlevel% neq 0 echo Monitor not running or already stopped.
pause
