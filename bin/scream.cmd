@echo off
set "_prog=%~dp0..\apps\scream-code\dist\main.mjs"
where /q node.exe 2>nul
if not errorlevel 1 (
  node "%_prog%" %*
) else if exist "C:\Program Files\nodejs\node.exe" (
  "C:\Program Files\nodejs\node.exe" "%_prog%" %*
) else if exist "%~dp0..\..\node.exe" (
  "%~dp0..\..\node.exe" "%_prog%" %*
) else (
  echo [scream] ERROR: node not found in PATH or common locations
  exit /b 1
)