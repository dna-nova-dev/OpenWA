@echo off
:: Wrapper para el botón del escritorio. Llama al .ps1 con bypass del
:: execution policy para que doble click funcione sin tocar config global.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-openwa.ps1"
