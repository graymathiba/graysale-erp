@echo off
rem Waits until the GraySale server answers /health, then opens the browser.
rem %1 = URL to open   %2 = port
setlocal
set "URL=%~1"
set "PORT=%~2"
set /a TRIES=0

:wait
curl -s -o nul "http://127.0.0.1:%PORT%/api/v1/health"
if %ERRORLEVEL%==0 goto :open
set /a TRIES+=1
if %TRIES% geq 60 goto :open
timeout /t 1 /nobreak >nul
goto :wait

:open
start "" "%URL%"
exit /b 0
