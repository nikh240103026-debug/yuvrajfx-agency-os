@echo off
rem Double-click to run YuvrajFX Agency OS. Keep the window open while you use the app; close it to stop.
title YuvrajFX Agency OS
cd /d "%~dp0"

node -e "process.exit(+process.versions.node.split('.')[0] >= 24 ? 0 : 1)" >nul 2>nul
if errorlevel 1 (
  echo Node.js 24 or newer is required. Install it from https://nodejs.org and run this file again.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo Installing dependencies ^(first run only^)...
  call npm install
  if errorlevel 1 goto failed
)

if not exist "dist\index.html" (
  echo Building the web app ^(first run only^)...
  call npm run build
  if errorlevel 1 goto failed
)

call npm start -- --open
if errorlevel 1 goto failed
exit /b 0

:failed
echo.
echo Something went wrong above. Fix it, then run this file again.
pause
exit /b 1
