@echo off
REM (Tuy chon) Dong goi thanh 1 file ClaudeWidget.exe, khong can cai Python tren may dich
cd /d "%~dp0"
python -m pip install --user pyinstaller psutil
python -m PyInstaller --onefile --noconsole --name ClaudeWidget claude_widget.py
echo File exe nam tai: %~dp0dist\ClaudeWidget.exe
pause
