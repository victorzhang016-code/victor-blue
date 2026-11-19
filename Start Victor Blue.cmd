@echo off
setlocal
set "VICTOR_BLUE_NODE=%~dp0runtime\node.exe"
if not exist "%VICTOR_BLUE_NODE%" set "VICTOR_BLUE_NODE=node"
"%VICTOR_BLUE_NODE%" -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)" 2>nul
if errorlevel 1 (
  echo Victor Blue needs Node.js 22+ when running from the source archive.
  echo The Windows download on GitHub Releases includes Node.js.
  pause
  exit /b 1
)
"%VICTOR_BLUE_NODE%" "%~dp0scripts\launcher.mjs"
if errorlevel 1 pause
