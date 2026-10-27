@echo off
rem Starts FUT Market Radar on http://localhost:8787/ (Windows PowerShell, no installs needed).
rem -ExecutionPolicy Bypass applies to this one process only; it does not change system settings.
cd /d "%~dp0"
start "" http://localhost:8787/
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1"
