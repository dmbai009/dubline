@echo off
chcp 65001 >nul
title Dubline Server
cd /d "%~dp0"

rem ==========================================
rem 1. Node.js: нужен для сервера (друзьям ставить ничего не надо)
rem Блоки со скобками тут не используются: "(x86)" в PATH ломает их разбор
rem ==========================================
where node >nul 2>nul
if not errorlevel 1 goto node_ok
if not exist "%ProgramFiles%\nodejs\node.exe" goto ask_node
set "PATH=%ProgramFiles%\nodejs;%PATH%"
goto node_ok

:ask_node
echo [Dubline] Для сервера нужен Node.js, но он не установлен.
choice /c YN /m "Установить Node.js LTS через winget сейчас"
if errorlevel 2 goto no_node
winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
rem В этом окне PATH еще старый — добавляем стандартную папку установки вручную
set "PATH=%ProgramFiles%\nodejs;%PATH%"
where node >nul 2>nul
if errorlevel 1 goto no_node

:node_ok
for /f "tokens=1 delims=v." %%v in ('node -v') do set "NODE_MAJOR=%%v"
if %NODE_MAJOR% GEQ 18 goto deps
echo [Dubline] Установлен слишком старый Node.js v%NODE_MAJOR%. Нужна версия 18 или новее: https://nodejs.org
goto end

rem ==========================================
rem 2. Зависимости: ставятся сами при первом запуске и после обновления
rem ==========================================
:deps
node tools\ensure-deps.js
if errorlevel 1 goto end

rem ==========================================
rem 3. Сервер (браузер откроется, когда он будет готов)
rem ==========================================
if not defined DUBLINE_NO_BROWSER set "DUBLINE_OPEN_BROWSER=1"
node server.js
goto end

:no_node
echo.
echo [Dubline] Установите Node.js вручную с https://nodejs.org (версия LTS) и запустите start.bat снова.

:end
pause
