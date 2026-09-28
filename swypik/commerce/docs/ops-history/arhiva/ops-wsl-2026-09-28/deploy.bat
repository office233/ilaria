@echo off
title Swypik deploy (din git)
echo Deploy Swypik: backup, git pull, migrari, build, health, smoke.
echo Doar ce e pe GitHub main ajunge live.
echo.
wsl -d swypik -u root -- bash -c "tr -d '\r' < /mnt/e/Swypik/ops/deploy.sh > /tmp/swypik-deploy.sh && bash /tmp/swypik-deploy.sh %*"
if %errorlevel% neq 0 (
    echo.
    echo [!] DEPLOY ESUAT - vezi mesajele de mai sus.
    pause
    exit /b %errorlevel%
)
echo.
echo DEPLOY COMPLET.
pause
