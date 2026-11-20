@echo off
REM Virtual monitor helper.
REM   vdd.cmd on | off | status      enable / disable the virtual display driver
REM   vdd.cmd path                   show where the driver reads vdd_settings.xml from
REM   vdd.cmd path D:\Tools\VDD      read the settings from another folder (stored in the registry)
REM on/off/path <folder> need admin rights and ask for them automatically (UAC prompt).
setlocal
set "ACTION=%~1"
set "NEWPATH=%~2"
set "REGKEY=HKLM\SOFTWARE\MikeTheTech\VirtualDisplayDriver"
if /i "%ACTION%"=="status" goto run
if /i "%ACTION%"=="path" if "%NEWPATH%"=="" goto showpath
if /i "%ACTION%"=="path" goto admin
if /i "%ACTION%"=="on" goto admin
if /i "%ACTION%"=="off" goto admin
echo Usage: vdd.cmd on ^| off ^| status ^| path [folder]
exit /b 1

:showpath
reg query "%REGKEY%" /v VDDPATH >nul 2>&1
if errorlevel 1 (
  echo Settings folder: C:\VirtualDisplayDriver  ^(default, no VDDPATH in the registry^)
) else (
  for /f "tokens=2,*" %%a in ('reg query "%REGKEY%" /v VDDPATH ^| findstr VDDPATH') do echo Settings folder: %%b  ^(from registry VDDPATH^)
)
exit /b 0

:admin
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%ACTION% \"%NEWPATH%\"' -Verb RunAs"
  exit /b
)
if /i not "%ACTION%"=="path" goto run
if not exist "%NEWPATH%\vdd_settings.xml" (
  echo "%NEWPATH%\vdd_settings.xml" not found. Copy driver\vdd_settings.xml there first.
  timeout /t 5 >nul
  exit /b 1
)
reg add "%REGKEY%" /v VDDPATH /t REG_SZ /d "%NEWPATH%" /f >nul || (echo Could not write the registry. & timeout /t 5 >nul & exit /b 1)
echo Settings folder set to %NEWPATH%. Restarting the driver so it reads it...
set "ACTION=restart"

:run
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$d = Get-PnpDevice -Class Display -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -match 'Virtual Display|IddSample|MttVDD' };" ^
  "if (-not $d) { Write-Host 'Virtual display driver not found.'; exit 1 }" ^
  "switch ('%ACTION%') {" ^
  "  'on'      { $d | Enable-PnpDevice  -Confirm:$false; Write-Host 'Virtual monitor ON' }" ^
  "  'off'     { $d | Disable-PnpDevice -Confirm:$false; Write-Host 'Virtual monitor OFF' }" ^
  "  'restart' { $d | Disable-PnpDevice -Confirm:$false; Start-Sleep 2; $d | Enable-PnpDevice -Confirm:$false; Write-Host 'Driver restarted' }" ^
  "};" ^
  "Get-PnpDevice -InstanceId $d.InstanceId | Format-Table Status, FriendlyName -AutoSize"
if /i not "%ACTION%"=="status" timeout /t 3 >nul
