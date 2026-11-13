@echo off
title CSC Ticket Printer (app.py) - keep this window open
cd /d "%~dp0"
:loop
py app.py
echo.
echo The ticket printer stopped. It restarts in 10 seconds. Close this window to stop it for good.
timeout /t 10 >nul
goto loop
