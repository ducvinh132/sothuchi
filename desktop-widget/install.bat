@echo off
REM Cai thu vien psutil, bat tu khoi dong cung Windows va chay widget
cd /d "%~dp0"
echo [1/3] Cai thu vien psutil...
python -m pip install --user -r requirements.txt
if errorlevel 1 (
  echo Loi: chua cai Python hoac chua them Python vao PATH.
  pause
  exit /b 1
)
echo [2/3] Bat tu khoi dong cung Windows...
python "%~dp0claude_widget.py" --install-startup
echo [3/3] Chay widget...
start "" pythonw "%~dp0claude_widget.py"
echo Hoan tat.
pause
