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

echo [Dubline] cloudflared was not found. It gives a stable link without a password page.
choice /c YN /m "Install cloudflared via winget now"
if errorlevel 2 goto fallback
set "TRIED_INSTALL=1"
winget install --id Cloudflare.cloudflared -e --accept-source-agreements --accept-package-agreements
goto find

:run
echo.
echo [Dubline] Creating a public link for friends...
echo [Dubline] Look below for an address like https://....trycloudflare.com and send it to your friends.
echo [Dubline] Keep this window open while you play.
echo.
"%CF%" tunnel --no-autoupdate --url http://localhost:3000
pause
goto :eof

:fallback
echo.
echo [Dubline] Starting the fallback localtunnel tunnel (it may show a password page).
npx localtunnel --port 3000
pause
