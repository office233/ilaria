@echo off
cd /d "%~dp0"
if not exist "%~dp0bin\swypik-os.exe" (
  echo Executabilul lipseste. Ruleaza powershell -File scripts\build.ps1
  pause
  exit /b 1
)
if not exist "%~dp0desktop\node_modules\electron\dist\electron.exe" (
  echo Instaleaza gazda desktop: cd desktop ^&^& npm ci ^&^& npm run setup
  pause
  exit /b 1
)
start "" "%~dp0desktop\node_modules\electron\dist\electron.exe" "%~dp0desktop" %*
