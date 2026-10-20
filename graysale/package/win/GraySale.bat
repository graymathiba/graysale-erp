@echo off
setlocal
chcp 65001 >nul
set "ROOT=%~dp0"
set "APP=%ROOT%app"
set "NODEEXE=%ROOT%runtime\node\node.exe"
set "DATA=%ROOT%data"

if not defined PORT set "PORT=3030"
set "NODE_ENV=production"
set "GRAYSTORAGE_ROOT=%DATA%"

title GraySale POS

if not exist "%NODEEXE%" (
  echo ERROR: missing runtime\node\node.exe - the package was not unpacked correctly.
  echo Unpack the FULL zip first, then double-click GraySale.bat again.
  pause
  exit /b 1
)
if not exist "%APP%\web\dist\index.html" (
  echo ERROR: missing app\web\dist - the package was not unpacked correctly.
  echo Unpack the FULL zip first, then double-click GraySale.bat again.
  pause
  exit /b 1
)
if not exist "%DATA%" mkdir "%DATA%"

echo ============================================================
echo    GraySale POS {{VERSION}}  -  {{CHANNEL}}
echo ============================================================
echo.
echo    Server on this PC :  http://localhost:%PORT%/
echo    Data folder       :  %DATA%
echo    Stopping          :  press Ctrl+C in this window
echo.
echo    Tills on OTHER PCs:  use http://^<this PC's IP^>:%PORT%/
echo    (the server prints those addresses below when it starts)
echo.
echo    First run? Complete the setup wizard in the browser,
echo    then log in with the bootstrap user printed below.
echo    If other PCs cannot reach this one, run
echo    Add-Firewall-Rule.bat ^(right-click -^> Run as administrator^).
echo ============================================================
echo.

rem Open the browser once the server answers /health (see open-browser.bat).
start "GraySale - opening browser" /min cmd /c "%ROOT%open-browser.bat" "http://localhost:%PORT%/" "%PORT%"

"%NODEEXE%" "%APP%\src\server.js"
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" (
  echo GraySale stopped unexpectedly (exit code %RC%).
  echo Check the messages above. Common fix: another program already uses
  echo port %PORT% - close it or start with:  set PORT=3031  then run again.
) else (
  echo GraySale stopped.
)
pause
exit /b %RC%
