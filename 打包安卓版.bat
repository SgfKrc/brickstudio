@echo off
setlocal
chcp 65001 >nul 2>&1
title BrickStudio Android Package
cd /d "%~dp0"
echo Checking prerequisites: JDK 17+ and Android SDK.
node tools\android-build.mjs
set "RESULT=%ERRORLEVEL%"
if not "%RESULT%"=="0" (
  echo Packaging failed. Check the messages above.
  pause
  exit /b %RESULT%
)
echo Packaging completed successfully.
pause
endlocal
