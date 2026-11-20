@echo off
REM Starts everything: virtual monitor detection, tunnel, skill deploy, touch. Options: see server.js
cd /d "%~dp0"
node server.js %*
pause
