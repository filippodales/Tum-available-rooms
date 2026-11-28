@echo off
chcp 65001 >nul
cd /d "%~dp0"
title TUM Free Rooms - Publish to GitHub

set "NO_PAUSE=0"
if /i "%~1"=="--no-pause" set "NO_PAUSE=1"

where git >nul 2>&1
if errorlevel 1 (
    if exist "%LOCALAPPDATA%\Microsoft\WinGet\Links\git.exe" set "PATH=%LOCALAPPDATA%\Microsoft\WinGet\Links;%PATH%"
)
where git >nul 2>&1
if errorlevel 1 (
    if exist "C:\Program Files\Git\cmd\git.exe" set "PATH=C:\Program Files\Git\cmd;%PATH%"
)

where git >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Git not found in PATH.
    if "%NO_PAUSE%"=="0" pause
    exit /b 1
)

echo [1/3] Syncing with GitHub (origin/main)...
git pull --rebase --autostash origin main
if errorlevel 1 (
    echo [ERROR] Failed to sync with GitHub.
    if "%NO_PAUSE%"=="0" pause
    exit /b 1
)

set "HAS_CHANGES="
for /f "delims=" %%i in ('git status --porcelain') do set "HAS_CHANGES=1"

if not defined HAS_CHANGES (
    echo.
    echo No local changes to publish. GitHub is already up to date.
    goto :done
)

echo.
echo Modified / new files:
git status --short
echo.

set "COMMIT_MSG=Update TUM Free Rooms"
if "%NO_PAUSE%"=="0" (
    set /p "USER_MSG=Commit message [Enter = Update TUM Free Rooms]: "
    if defined USER_MSG set "COMMIT_MSG=%USER_MSG%"
)

echo.
echo [2/3] Creating commit...
git add -A
git commit -m "%COMMIT_MSG%"
if errorlevel 1 (
    echo [ERROR] Commit failed.
    if "%NO_PAUSE%"=="0" pause
    exit /b 1
)

echo.
echo [3/3] Pushing to GitHub...
git push origin main
if errorlevel 1 (
    echo [ERROR] Push failed.
    if "%NO_PAUSE%"=="0" pause
    exit /b 1
)

echo.
echo Published! GitHub Pages will update automatically in ~30-60 seconds:
echo https://filippodales.github.io/Tum-available-rooms/

:done
echo.
if "%NO_PAUSE%"=="0" pause
