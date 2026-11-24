@echo off
chcp 65001 >nul
cd /d "%~dp0"
title TUM Free Rooms - Update Catalog

where python >nul 2>&1
if %errorlevel%==0 (
    python scripts\build_catalog.py
    goto :end
)

where py >nul 2>&1
if %errorlevel%==0 (
    py -3 scripts\build_catalog.py
    goto :end
)

echo [ERROR] Python not found in PATH. Install Python 3.10+ and try again.

:end
echo.
pause
