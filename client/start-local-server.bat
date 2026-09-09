@echo off
setlocal
cd /d "%~dp0"

set "PYTHON_EXE=C:\Program Files\Python313\python.exe"

echo Starting MindChat Canvas at http://127.0.0.1:8000/index.html
echo Keep this window open while using the app.
echo.

if exist "%PYTHON_EXE%" (
  "%PYTHON_EXE%" -m http.server 8000 --bind 127.0.0.1
) else (
  py -3 -m http.server 8000 --bind 127.0.0.1
)

echo.
echo Server stopped.
pause
