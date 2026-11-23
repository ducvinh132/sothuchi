@echo off
REM Dang nhap Claude Code bang tai khoan Pro/Max de widget doc duoc usage
chcp 65001 >nul
cd /d "%~dp0"
python "%~dp0claude_widget.py" --login
pause
