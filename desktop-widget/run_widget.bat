@echo off
REM Chay widget khong hien cua so console
cd /d "%~dp0"
start "" pythonw "%~dp0claude_widget.py"
