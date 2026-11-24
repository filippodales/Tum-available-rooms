@echo off
chcp 65001 >nul
cd /d "%~dp0"
title TUM Free Rooms

where python >nul 2>&1
if %errorlevel%==0 (
    python run_local.py %*
    goto :done
)

where py >nul 2>&1
if %errorlevel%==0 (
    py -3 run_local.py %*
    goto :done
)

echo [ERROR] Python not found in PATH. Install Python 3.10+ and try again.
pause
exit /b 1

:done
if errorlevel 1 (
    echo.
    echo [ERROR] Launch failed.
    pause
    exit /b 1
)
