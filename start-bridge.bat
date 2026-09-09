@echo off
cd /d "%~dp0"
python -m bridge.server --port 8791
