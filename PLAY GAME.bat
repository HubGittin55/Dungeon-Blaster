@echo off
rem THE GAME. Real AI game master, voice on, pictures on.
rem First start takes a couple of minutes while the big model loads off disk.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File launch-alpha.ps1 -Port 8770
echo.
echo Game window closed. Services that were already running are still running.
pause
