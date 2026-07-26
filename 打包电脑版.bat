@echo off
setlocal
chcp 65001 >nul 2>&1
title BrickStudio Windows Package
cd /d "%~dp0"
echo Checking prerequisites: npm install and Inno Setup ISCC on PATH.
node tools\win-build.mjs
set "RESULT=%ERRORLEVEL%"
if not "%RESULT%"=="0" (
  echo Packaging failed. Check the messages above.
  pause
  exit /b %RESULT%
)
echo Packaging completed successfully.
pause
endlocal
