@echo off
cd /d "%~dp0"
echo Starting...
echo Dir: %CD%
node_modules\electron\dist\electron.exe .
echo Exit: %errorlevel%
pause
