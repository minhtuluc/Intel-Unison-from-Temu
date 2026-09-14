@echo off
title UniversalTrans Server (Port 8080)
color 0B
cd /d "%~dp0\.."

echo ========================================================
echo         UniversalTrans - AirDrop cho Windows ^& Mobile
echo ========================================================
echo.

set "INSTANCE=%TEMP%\utrans-8080.json"
set "PID="

rem Khong kill moi tien trinh dang giu port 8080. Chi bao trung neu chinh
rem UniversalTrans dang chay (dua tren file instance do app ghi lai).
if exist "%INSTANCE%" (
    for /f "tokens=2 delims=:," %%a in ('findstr /i "\"pid\"" "%INSTANCE%"') do set "PID=%%a"
)
if defined PID set "PID=%PID: =%"

if defined PID (
    tasklist /FI "PID eq %PID%" 2>nul | findstr /i "%PID%" >nul
    if not errorlevel 1 (
        for /f "tokens=5" %%p in ('netstat -aon ^| findstr ":8080" ^| findstr "LISTENING"') do (
            if "%%p"=="%PID%" (
                echo [INFO] UniversalTrans dang chay san voi PID %PID%.
                echo [INFO] Chay "UniversalTrans - Tat" truoc, hoac dung server hien tai.
                ping 127.0.0.1 -n 3 >nul
                exit /b 0
            )
        )
        echo [CANH BAO] PID %PID% trong file instance khong con giu port 8080.
    )
    del "%INSTANCE%" >nul 2>&1
)

echo Dang khoi dong server tren Port 8080...
echo.

node bin/utrans.js

echo.
echo Server da dung.
pause
