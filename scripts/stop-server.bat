@echo off
title UniversalTrans - Tat Server
color 0C
echo ========================================================
echo         UniversalTrans - Dang tat server tren Port 8080...
echo ========================================================
echo.

set FOUND=0
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":8080" ^| findstr "LISTENING"') do (
    set FOUND=1
    taskkill /F /PID %%a >nul 2>&1
    echo [OK] Da dong process PID %%a tren port 8080.
)

if "%FOUND%"=="0" (
    echo [INFO] Khong tim thay server UniversalTrans nao dang chay tren port 8080.
) else (
    echo.
    echo [OK] UniversalTrans da duoc tat hoan toan!
)

ping 127.0.0.1 -n 2 >nul
