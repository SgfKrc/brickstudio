@echo off
chcp 65001 >nul
title BrickStudio 安装包分发
cd /d "%~dp0"

rem Node 23.6+ 原生支持直接运行 .ts;22.6~23.5 需要 --experimental-strip-types;更老的用 esbuild 先编译
node tools\dist-server.ts 2>nul
if %errorlevel%==0 goto :eof

node --experimental-strip-types tools\dist-server.ts 2>nul
if %errorlevel%==0 goto :eof

echo 当前 Node 不支持直接运行 TypeScript,改用 esbuild 编译后运行...
npx esbuild tools\dist-server.ts --outfile=tools\dist-server.mjs --platform=node --format=esm --target=node18
if errorlevel 1 (
  echo.
  echo 编译失败:请确认已执行过 npm install(需要 esbuild^)。
  pause
  exit /b 1
)
node tools\dist-server.mjs
pause
