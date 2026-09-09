@echo off
title UniversalTrans Server (Port 8080)
color 0B
cd /d "%~dp0\.."

echo ========================================================
echo         UniversalTrans - AirDrop cho Windows ^& Mobile
echo ========================================================
rem Kiem tra va giai phong port 8080 neu co process cu dang treo
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":8080" ^| findstr "LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
)

echo Dang khoi dong server tren Port 8080...
echo.

node bin/utrans.js

echo.
echo Server da dung.
pause
