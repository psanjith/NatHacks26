@echo off
rem Starts the PNJEX sim on Windows: double-click this file.
rem Keep this window open while you use the sim; close it to stop.
cd /d "%~dp0"

where py >nul 2>nul
if %errorlevel%==0 (
  py -3 run.py %*
  goto end
)
where python >nul 2>nul
if %errorlevel%==0 (
  python run.py %*
  goto end
)
echo Python 3 was not found.
echo Install it from https://www.python.org/downloads/ and tick "Add python.exe to PATH",
echo then double-click this file again.

:end
pause
