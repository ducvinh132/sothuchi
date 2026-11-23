@echo off
REM Kiem tra widget co doc duoc token Claude Code khong (khong in token)
cd /d "%~dp0"
chcp 65001 >nul
python "%~dp0claude_widget.py" --diagnose
pause
