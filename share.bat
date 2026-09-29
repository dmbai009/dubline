@echo off
chcp 65001 >nul
title Dubline Public Link
cd /d "%~dp0"

set "CF="
set "TRIED_INSTALL="

:find
where cloudflared >nul 2>nul && set "CF=cloudflared"
if not defined CF if exist "%ProgramFiles%\cloudflared\cloudflared.exe" set "CF=%ProgramFiles%\cloudflared\cloudflared.exe"
if not defined CF if exist "%ProgramFiles(x86)%\cloudflared\cloudflared.exe" set "CF=%ProgramFiles(x86)%\cloudflared\cloudflared.exe"
if defined CF goto run
if defined TRIED_INSTALL goto fallback

echo [Dubline] cloudflared не найден. Он дает стабильную ссылку без страницы с паролем.
choice /c YN /m "Установить cloudflared через winget сейчас"
if errorlevel 2 goto fallback
set "TRIED_INSTALL=1"
winget install --id Cloudflare.cloudflared -e --accept-source-agreements --accept-package-agreements
goto find

:run
echo.
echo [Dubline] Создаем публичную ссылку для друзей...
echo [Dubline] Ищите ниже адрес вида https://....trycloudflare.com и отправьте его друзьям.
echo [Dubline] Не закрывайте это окно, пока идет игра.
echo.
"%CF%" tunnel --no-autoupdate --url http://localhost:3000
pause
goto :eof

:fallback
echo.
echo [Dubline] Запускаю запасной туннель localtunnel (может показывать страницу с паролем).
npx localtunnel --port 3000
pause
