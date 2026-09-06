@echo off
chcp 936 >nul
setlocal
cd /d "%~dp0"
title 安装念念到桌面

set "DESKTOP=%USERPROFILE%\Desktop"
if not exist "%DESKTOP%" set "DESKTOP=%USERPROFILE%\OneDrive\Desktop"
if not exist "%DESKTOP%" (
  echo 未找到桌面文件夹，请手动把下面的文件复制到桌面。
  goto :SHOWFILES
)

echo.
if exist "%~dp0念念.lnk" (
  copy /Y "%~dp0念念.lnk" "%DESKTOP%\念念.lnk" >nul
  echo [OK] 已把「念念」快捷方式放到桌面
) else (
  echo [错误] 未找到 念念.lnk
)

if exist "%~dp0dist\念念-手机版.zip" (
  copy /Y "%~dp0dist\念念-手机版.zip" "%DESKTOP%\念念-手机版.zip" >nul
  echo [OK] 已把「念念-手机版.zip」放到桌面
) else (
  echo [错误] 未找到 dist\念念-手机版.zip
)

:SHOWFILES
echo.
echo 完成！双击桌面的「念念」图标即可启动复习规划器。
echo 手机版 zip 解压后可直接发给朋友使用。
echo.
pause