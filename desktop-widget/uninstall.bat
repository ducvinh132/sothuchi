@echo off
REM Go tu khoi dong. De tat widget dang chay: chuot phai vao widget, chon Thoat.
cd /d "%~dp0"
python "%~dp0claude_widget.py" --uninstall-startup
echo Co the xoa thu muc nay va %%APPDATA%%\ClaudeWidget neu muon.
pause
