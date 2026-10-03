@echo off
title Swypik Safe Deploy Live
echo ========================================================
echo   Swypik Live Production Deploy: Step A + Step B
echo ========================================================
echo.
echo [1/2] Rulare Pasul A (Backup, Git Pull, Migrari SQL)...
wsl -d swypik -u root -- bash /mnt/e/Swypik/deploy-step-a.sh
if %errorlevel% neq 0 (
    echo.
    echo [!] EROARE la Pasul A. Deploy oprit pentru siguranta datelor.
    pause
    exit /b %errorlevel%
)

echo.
echo [2/2] Rulare Pasul B (Docker Rebuild web-next, Smoke Tests)...
wsl -d swypik -u root -- bash /mnt/e/Swypik/deploy-step-b.sh
if %errorlevel% neq 0 (
    echo.
    echo [!] EROARE la Pasul B.
    pause
    exit /b %errorlevel%
)

echo.
echo ========================================================
echo   FELICITARI! DEPLOY-UL ESTE COMPLET LIVE PE SWYPIK.COM!
echo ========================================================
pause
