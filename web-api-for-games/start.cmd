@echo off
REM Alexa skill + touch. Example: start.cmd --adapter 1 --display 0 --target 1280x800 --touch --tunnel
cd /d "%~dp0"
node server.js %*
pause
