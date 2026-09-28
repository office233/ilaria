@echo off
:: Repara WSL blocat fara restart de PC. Cere drepturi de admin (apasa "Da").
powershell -NoProfile -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','E:\Swypik\ops\fix-wsl.ps1'"
