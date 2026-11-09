@echo off
rem THE GAME, no AI model waiting around. Same rules, same gate, same dice,
rem but the game master is a canned script so rounds are instant. Use this to
rem try the buttons without burning 60 seconds per round.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File launch-alpha.ps1 -FakeDm
echo.
echo Game window closed.
pause
