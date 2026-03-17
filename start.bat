@echo off
echo ================================
echo   Starting Interview Mentor AI
echo ================================
echo.

docker compose up -d --build

echo.
echo Waiting for services to start...
timeout /t 10 >nul

echo Opening browser...
start http://127.0.0.1:5002
echo.
echo App is running at http://localhost:5002
echo To stop the app, run stop.bat
echo.
pause