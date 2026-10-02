@echo off
setlocal DisableDelayedExpansion
if not exist "%~dp0bin\swyp.exe" (
    echo Swyp is not built. Run: powershell -NoProfile -File "%~dp0scripts\build-local.ps1" 1>&2
    exit /b 1
)
"%~dp0bin\swyp.exe" %*
exit /b %errorlevel%
