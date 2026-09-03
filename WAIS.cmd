@echo off
setlocal
rem The first launch asks once for Windows approval to enable automatic startup
rem and local-network sharing. WAIS still opens if that approval is postponed.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\ensure-wais-service.ps1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-pdias.ps1"
if errorlevel 1 pause
