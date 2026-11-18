@echo off
REM Turn the virtual monitor on or off.  Usage:  vdd.cmd on | off | status
REM Needs admin rights for on/off; asks for them automatically (UAC prompt).
setlocal
set "ACTION=%~1"
if /i "%ACTION%"=="status" goto run
if /i "%ACTION%"=="on" goto admin
if /i "%ACTION%"=="off" goto admin
echo Usage: vdd.cmd on ^| off ^| status
exit /b 1

:admin
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%ACTION%' -Verb RunAs"
  exit /b
)

:run
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$d = Get-PnpDevice -Class Display -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -match 'Virtual Display|IddSample|MttVDD' };" ^
  "if (-not $d) { Write-Host 'Virtual display driver not found.'; exit 1 }" ^
  "switch ('%ACTION%') {" ^
  "  'on'  { $d | Enable-PnpDevice  -Confirm:$false; Write-Host 'Virtual monitor ON' }" ^
  "  'off' { $d | Disable-PnpDevice -Confirm:$false; Write-Host 'Virtual monitor OFF' }" ^
  "};" ^
  "Get-PnpDevice -InstanceId $d.InstanceId | Format-Table Status, FriendlyName -AutoSize"
if /i not "%ACTION%"=="status" timeout /t 3 >nul
