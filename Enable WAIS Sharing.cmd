@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\enable-pdias-sharing.ps1"
if errorlevel 1 pause
