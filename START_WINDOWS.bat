@echo off
cd /d "%~dp0"
set WUXING_DATA_DIR=%~dp0server-data
node server.js
pause
