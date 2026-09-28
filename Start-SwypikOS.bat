@echo off
setlocal
if not exist "%~dp0bin\swypik-os.exe" (
    echo Native SwypikOS executable is missing.
    echo Build it with: powershell -File "%~dp0scripts\build.ps1"
    exit /b 1
)
start "" "%~dp0bin\swypik-os.exe" -workspace "%~dp0." %*
exit /b %errorlevel%
