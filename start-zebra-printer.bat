@echo off
title CSC Zebra Label Server (print_server.py) - keep this window open
cd /d "%~dp0"
:loop
py print_server.py
echo.
echo The Zebra label server stopped. It restarts in 10 seconds. Close this window to stop it for good.
timeout /t 10 >nul
goto loop
