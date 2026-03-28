@echo off
cd /d "%~dp0"
REM Bypass PowerShell script restriction so npm works
powershell -NoProfile -ExecutionPolicy Bypass -Command "npm start"
