@echo off
title UniversalTrans - Tat Server
color 0C
setlocal enabledelayedexpansion
echo ========================================================
echo         UniversalTrans - Dang tat server tren Port 8080...
echo ========================================================
echo.

set "INSTANCE=%TEMP%\utrans-8080.json"
set "PID="

rem Chi dung dung tien trinh do UniversalTrans ghi lai, khong kill theo port.
if exist "%INSTANCE%" (
    for /f "tokens=2 delims=:," %%a in ('findstr /i "\"pid\"" "%INSTANCE%"') do set "PID=%%a"
)

if defined PID set "PID=%PID: =%"

if not defined PID (
    echo [INFO] Khong tim thay tien trinh UniversalTrans nao dang chay.
    echo [INFO] Khong co file instance "%INSTANCE%" hoac file khong hop le.
    ping 127.0.0.1 -n 2 >nul
    exit /b 0
)

tasklist /FI "PID eq %PID%" 2>nul | findstr /i "%PID%" >nul
if errorlevel 1 (
    echo [INFO] Tien trinh PID %PID% khong con chay. Dang xoa file instance cu.
    del "%INSTANCE%" >nul 2>&1
    ping 127.0.0.1 -n 2 >nul
    exit /b 0
)

rem PID co the da duoc cap lai cho tien trinh khac: xac nhan PID nay dang giu port 8080.
set "OWNS_PORT=0"
for /f "tokens=5" %%p in ('netstat -aon ^| findstr ":8080" ^| findstr "LISTENING"') do (
    if "%%p"=="%PID%" set "OWNS_PORT=1"
)

if "%OWNS_PORT%"=="0" (
    echo [CANH BAO] PID %PID% khong con giu port 8080.
    echo [CANH BAO] Co the PID da duoc cap lai cho tien trinh khac. Khong tat.
    echo [INFO] Dang xoa file instance cu. Hay kiem tra bang Task Manager.
    del "%INSTANCE%" >nul 2>&1
    ping 127.0.0.1 -n 2 >nul
    exit /b 0
)

taskkill /F /PID %PID% >nul 2>&1
if errorlevel 1 (
    echo [LOI] Khong the tat PID %PID%. Hay tat bang Task Manager.
) else (
    echo [OK] Da tat UniversalTrans PID %PID% tren port 8080.
)

del "%INSTANCE%" >nul 2>&1
echo.
echo [OK] UniversalTrans da duoc tat hoan toan!
ping 127.0.0.1 -n 2 >nul
