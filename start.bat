@echo off
chcp 65001 >nul
title Dubline Server
cd /d "%~dp0"

rem ==========================================
rem 1. Node.js: needed for the server (friends don't need to install anything)
rem Parenthesized blocks are not used here: "(x86)" in PATH breaks their parsing
rem ==========================================
where node >nul 2>nul
if not errorlevel 1 goto node_ok
if not exist "%ProgramFiles%\nodejs\node.exe" goto ask_node
set "PATH=%ProgramFiles%\nodejs;%PATH%"
goto node_ok

:ask_node
echo [Dubline] The server needs Node.js, but it is not installed.
choice /c YN /m "Install Node.js LTS via winget now"
if errorlevel 2 goto no_node
winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
rem PATH in this window is still the old one: add the standard install folder manually
set "PATH=%ProgramFiles%\nodejs;%PATH%"
where node >nul 2>nul
if errorlevel 1 goto no_node

:node_ok
for /f "tokens=1 delims=v." %%v in ('node -v') do set "NODE_MAJOR=%%v"
if %NODE_MAJOR% GEQ 18 goto deps
echo [Dubline] Node.js v%NODE_MAJOR% is too old. Version 18 or newer is required: https://nodejs.org
goto end

rem ==========================================
rem 2. Dependencies: installed automatically on the first run and after updates
rem ==========================================
:deps
node tools\ensure-deps.js
if errorlevel 1 goto end

rem ==========================================
rem 3. Server (the browser opens once it is ready)
rem ==========================================
if not defined DUBLINE_NO_BROWSER set "DUBLINE_OPEN_BROWSER=1"
node server.js
goto end

:no_node
echo.
echo [Dubline] Install Node.js manually from https://nodejs.org (LTS version) and run start.bat again.

:end
pause
