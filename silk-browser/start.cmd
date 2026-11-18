@echo off
REM Double-click: starts the second screen server. Check with the test pattern first: start.cmd --source test
cd /d "%~dp0"
node server.js %*
pause
