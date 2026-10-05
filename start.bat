@echo off
rem ============================================================
rem  WordMaster launcher
rem
rem  IMPORTANT: keep this file PURE ASCII.
rem  cmd.exe parses .bat files byte-by-byte using the active code
rem  page, so non-ASCII text here can split a line in half and
rem  produce errors like:
rem      'xxx' is not recognized as an internal or external command
rem  All user-facing messages (Chinese) are printed by
rem  tools\launch.js instead - Node writes UTF-8 correctly.
rem
rem ============================================================

chcp 65001 >nul
cd /d "%~dp0"
title WordMaster

set "NODE_EXE="

rem --- 1. locate node: PATH first, then common install paths ---
where node >nul 2>nul && set "NODE_EXE=node"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE if exist "%APPDATA%\nvm\node.exe" set "NODE_EXE=%APPDATA%\nvm\node.exe"
if not defined NODE_EXE if exist "D:\wendang\node.exe" set "NODE_EXE=D:\wendang\node.exe"

if not defined NODE_EXE (
  echo.
  echo   [ERROR] Node.js not found.
  echo.
  echo   Please install Node.js 22.5 or newer: https://nodejs.org
  echo   Keep the default options, then double-click this file again.
  echo.
  pause
  exit /b 1
)

rem --- 2. this file must sit next to server.js ---
if not exist "%~dp0server.js" goto :wrongplace
if not exist "%~dp0tools\launch.js" goto :wrongplace
goto :run

:wrongplace
echo.
echo   [ERROR] Project files not found next to this file.
echo.
echo   start.bat must be inside the WordMaster folder, together with
echo   server.js and the tools folder - it can only see files that
echo   sit right next to it.
echo.
echo   Current folder:
echo     %~dp0
echo.
echo   Please copy the WHOLE WordMaster folder and run start.bat
echo   from inside it.
echo.
pause
exit /b 1

:run
rem --- 3. hand over to the Node launcher (prints all messages) ---
"%NODE_EXE%" "%~dp0tools\launch.js"
if errorlevel 1 (
  echo.
  pause
)
exit /b
