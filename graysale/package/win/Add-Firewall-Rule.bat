@echo off
rem Allows tills on other PCs to reach GraySale on this machine.
rem Needs administrator rights - it will prompt you.
setlocal
net session >nul 2>&1
if %ERRORLEVEL% neq 0 (
  echo Requesting administrator rights...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
netsh advfirewall firewall delete rule name="GraySale POS (TCP 3030)" >nul 2>&1
netsh advfirewall firewall add rule name="GraySale POS (TCP 3030)" dir=in action=allow protocol=TCP localport=3030
echo.
echo Done. Tills on other PCs can now reach GraySale on port 3030.
pause
