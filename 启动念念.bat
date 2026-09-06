@echo off
chcp 936 >nul
setlocal
cd /d "%~dp0"
title 念念 · AI 复习规划器
if exist "%~dp0node.exe" (set "NODE=%~dp0node.exe") else (set "NODE=node")

echo.
echo   ==========================================
echo     念念 · AI 复习规划器
echo   ==========================================
echo.

rem 若服务已在运行，直接打开浏览器
powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:3000/' -TimeoutSec 2) | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
if %errorlevel%==0 (
  start "" "http://localhost:3000/"
  echo   服务已在运行，已为你打开浏览器。
  echo.
  pause
  exit /b 0
)

echo   正在启动念念，请稍候...
start "念念服务" /min cmd /c ""%NODE%" --disable-warning=ExperimentalWarning server\index.js"
timeout /t 2 /nobreak >nul
start "" "http://localhost:3000/"
echo.
echo   电脑使用：   http://localhost:3000
echo   手机使用：   http://本机IP:3000   （手机连接同一 Wi-Fi）
echo   查看本机IP： 打开命令提示符，输入 ipconfig，找到 IPv4 地址
echo   手机打不开： 在 Windows 防火墙中放行 Node.js（专用网络）
echo.
echo   关闭本窗口不会停止服务；停止服务请关闭最小化的「念念服务」窗口。
echo.
pause