@echo off
REM Dang nhap Claude Code CLI bang tai khoan Pro/Max de widget doc duoc usage
chcp 65001 >nul
cd /d "%~dp0"
where claude >/dev/null 2>&1
if errorlevel 1 if not exist "%USERPROFILE%\.local\bin\claude.exe" (
  echo Chua co Claude Code CLI. Dang cai dat bang trinh cai chinh thuc cua Anthropic...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://claude.ai/install.ps1 | iex"
)
set "CLAUDE=claude"
where claude >/dev/null 2>&1 || set "CLAUDE=%USERPROFILE%\.local\bin\claude.exe"
echo.
echo Trinh duyet se mo trang dang nhap. Chon tai khoan Claude Pro/Max cua anh.
"%CLAUDE%" auth login --claudeai
echo.
echo ===== Kiem tra lai =====
python "%~dp0claude_widget.py" --diagnose
pause
