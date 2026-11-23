"""Claude Usage & Net Speed – widget nền desktop cho Windows 10/11.

Hiển thị:
  1. Giới hạn gói Claude Pro/Max (phiên 5 giờ, tuần, tuần Opus/Sonnet) – lấy từ
     endpoint OAuth mà Claude Code dùng cho lệnh /usage (token đọc từ máy đã
     đăng nhập Claude Code, chỉ đọc, không tự làm mới token).
  2. Token Claude Code tiêu thụ hôm nay / 5 giờ gần nhất – đọc log cục bộ
     %USERPROFILE%\\.claude\\projects\\**\\*.jsonl.
  3. Tốc độ download / upload Internet thời gian thực (psutil) + biểu đồ 60 giây.

Phụ thuộc: Python 3.9+ (có tkinter), psutil.
Chạy:  pythonw claude_widget.py
Chuột phải vào widget để mở menu (làm mới, luôn nổi trên cùng, độ trong suốt, thoát).
"""

from __future__ import annotations

import glob
import json
import os
import queue
import sys
import threading
import time
import tkinter as tk
import urllib.error
import urllib.request
from collections import deque
from datetime import datetime, timedelta, timezone

try:
    import psutil
except ImportError:  # pragma: no cover
    print("Thiếu thư viện psutil. Cài bằng:  pip install psutil")
    sys.exit(1)

# ----------------------------------------------------------------------------
# Cấu hình
# ----------------------------------------------------------------------------
USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
USAGE_INTERVAL_S = 120          # chu kỳ gọi API giới hạn gói (không nên < 60s)
LOG_INTERVAL_S = 30             # chu kỳ quét log Claude Code
NET_INTERVAL_MS = 1000          # chu kỳ đo tốc độ mạng
NET_HISTORY = 60                # số điểm biểu đồ (giây)
WIDTH = 300                     # pixel logic (96 DPI), tự nhân theo DPI màn hình
SC = 1.0                        # hệ số DPI, gán khi khởi tạo Tk


def px(v: float) -> int:
    return max(1, round(v * SC))


def enable_dpi_awareness() -> None:
    """Báo Windows rằng app tự vẽ theo DPI -> chữ và nét vẽ sắc, không bị phóng ảnh mờ."""
    if sys.platform != "win32":
        return
    import ctypes
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)  # Per-monitor DPI aware
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass

EXCLUDED_NIC_PREFIX = ("lo", "loopback", "vethernet", "vmware", "virtualbox",
                       "vbox", "docker", "wsl", "bluetooth", "teredo", "isatap")

LABELS = {
    "five_hour": "Phiên 5 giờ",
    "seven_day": "Tuần – tất cả model",
    "seven_day_opus": "Tuần – Opus",
    "seven_day_sonnet": "Tuần – Sonnet",
    "seven_day_oauth_apps": "Tuần – ứng dụng OAuth",
}

C = {  # bảng màu (tối)
    "bg": "#16181d", "panel": "#1f2229", "fg": "#e6e8ec", "muted": "#8b919c",
    "track": "#2c3039", "ok": "#3fb950", "warn": "#d29922", "crit": "#f85149",
    "down": "#58a6ff", "up": "#d2a8ff", "accent": "#d97757",
}
FONT = "Segoe UI" if sys.platform == "win32" else "DejaVu Sans"


def claude_dir() -> str:
    return os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")


def app_config_path() -> str:
    base = os.environ.get("APPDATA") or os.path.join(os.path.expanduser("~"), ".config")
    d = os.path.join(base, "ClaudeWidget")
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, "config.json")


def load_config() -> dict:
    cfg = {"x": None, "y": None, "topmost": False, "alpha": 0.92}
    try:
        with open(app_config_path(), encoding="utf-8") as f:
            cfg.update(json.load(f))
    except (OSError, ValueError):
        pass
    return cfg


def save_config(cfg: dict) -> None:
    try:
        with open(app_config_path(), "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2)
    except OSError:
        pass


# ----------------------------------------------------------------------------
# 1. Giới hạn gói (OAuth usage)
# ----------------------------------------------------------------------------
CRED_SERVICE_HINT = "Claude Code"
CRED_USER = "claude-code-user"


def _wincred_enumerate() -> dict[str, bytes]:
    """Đọc TẤT CẢ mục trong Windows Credential Manager của user -> {target: blob}.

    Dùng Filter=NULL + CRED_ENUMERATE_ALL_CREDENTIALS rồi lọc bằng Python, vì bộ lọc
    wildcard của Windows chỉ hỗ trợ dạng 'tiền tố*'.
    """
    import ctypes
    from ctypes import wintypes

    class FILETIME(ctypes.Structure):
        _fields_ = [("lo", wintypes.DWORD), ("hi", wintypes.DWORD)]

    class CREDENTIALW(ctypes.Structure):
        _fields_ = [("Flags", wintypes.DWORD), ("Type", wintypes.DWORD),
                    ("TargetName", wintypes.LPWSTR), ("Comment", wintypes.LPWSTR),
                    ("LastWritten", FILETIME), ("CredentialBlobSize", wintypes.DWORD),
                    ("CredentialBlob", ctypes.POINTER(ctypes.c_ubyte)), ("Persist", wintypes.DWORD),
                    ("AttributeCount", wintypes.DWORD), ("Attributes", ctypes.c_void_p),
                    ("TargetAlias", wintypes.LPWSTR), ("UserName", wintypes.LPWSTR)]

    adv = ctypes.WinDLL("advapi32", use_last_error=True)
    adv.CredEnumerateW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD),
                                   ctypes.POINTER(ctypes.POINTER(ctypes.POINTER(CREDENTIALW)))]
    adv.CredEnumerateW.restype = wintypes.BOOL
    adv.CredFree.argtypes = [ctypes.c_void_p]
    count = wintypes.DWORD()
    pcreds = ctypes.POINTER(ctypes.POINTER(CREDENTIALW))()
    if not adv.CredEnumerateW(None, 0x1, ctypes.byref(count), ctypes.byref(pcreds)):
        if not adv.CredEnumerateW(None, 0, ctypes.byref(count), ctypes.byref(pcreds)):
            return {}
    out = {}
    try:
        for i in range(count.value):
            c = pcreds[i].contents
            key = c.TargetName or ""
            if c.UserName and c.UserName not in key:
                key = f"{key}|{c.UserName}"
            blob = ctypes.string_at(c.CredentialBlob, c.CredentialBlobSize) if c.CredentialBlobSize else b""
            out[key] = blob
    finally:
        adv.CredFree(pcreds)
    return out


def _decode_blob(b: bytes) -> str:
    if len(b) >= 2 and b[1:2] == b"\x00":  # UTF-16LE
        return b.decode("utf-16-le", "replace").rstrip("\x00")
    return b.decode("utf-8", "replace").rstrip("\x00")


def assemble_secure_storage(entries: dict[str, str]) -> str | None:
    """Ghép dữ liệu Claude Code lưu trong Credential Manager.

    Dữ liệu nhỏ: 1 mục '<...>claude-code-user'. Dữ liệu lớn: chia mảnh
    '<...>claude-code-user#m' (JSON {n, l}) + '#0'..'#n-1' (base64).
    Hàm nhóm theo tiền tố target nên không phụ thuộc định dạng 'service/name'.
    """
    import base64
    groups: dict[str, dict[str, str]] = {}
    for target, val in entries.items():
        idx = target.rfind(CRED_USER)
        if idx < 0:
            continue
        prefix, suffix = target[:idx], target[idx + len(CRED_USER):]
        groups.setdefault(prefix, {})[suffix] = val
    # ưu tiên service không có hậu tố hash (CLAUDE_CONFIG_DIR mặc định)
    for prefix in sorted(groups, key=len):
        g = groups[prefix]
        meta = g.get("#m")
        if meta:
            try:
                m = json.loads(meta)
                data = "".join(g[f"#{i}"] for i in range(int(m["n"])))
                if len(data) == int(m["l"]):
                    return base64.b64decode(data).decode("utf-8")
            except (ValueError, KeyError, TypeError):
                pass
        if g.get(""):
            return g[""]
    return None


def _find_oauth(obj, depth: int = 0) -> dict | None:
    """Tìm dict chứa accessToken (ưu tiên khóa claudeAiOauth), kể cả khi lồng sâu."""
    if depth > 6:
        return None
    if isinstance(obj, dict):
        o = obj.get("claudeAiOauth")
        if isinstance(o, dict) and o.get("accessToken"):
            return o
        if isinstance(obj.get("accessToken"), str) and obj["accessToken"].startswith("sk-ant-o"):
            return obj
        for k, v in obj.items():
            if k == "mcpOAuth":  # token của MCP server, không phải tài khoản Claude
                continue
            r = _find_oauth(v, depth + 1)
            if r:
                return r
    elif isinstance(obj, list):
        for v in obj:
            r = _find_oauth(v, depth + 1)
            if r:
                return r
    return None


def _oauth_from_text(text: str | None) -> dict | None:
    if not text:
        return None
    try:
        return _find_oauth(json.loads(text.lstrip("\ufeff")))
    except ValueError:
        return None


def credential_files() -> list[str]:
    home = os.path.expanduser("~")
    cands = [os.path.join(claude_dir(), ".credentials.json"),
             os.path.join(home, ".claude", ".credentials.json"),
             os.path.join(home, ".claude.json")]
    out = []
    for c in cands:
        if c not in out:
            out.append(c)
    return out


def read_credentials() -> tuple[dict | None, str]:
    """Trả về (oauth, nguồn). Thứ tự: Windows Credential Manager, rồi các file credentials."""
    if sys.platform == "win32":
        try:
            raw = {k: _decode_blob(v) for k, v in _wincred_enumerate().items() if "claude" in k.lower()}
            cred = _oauth_from_text(assemble_secure_storage(raw))
            if not cred:  # dạng lưu khác: thử từng mục
                for v in raw.values():
                    cred = _oauth_from_text(v)
                    if cred:
                        break
            if cred:
                return cred, "Windows Credential Manager"
        except Exception:
            pass
    for path in credential_files():
        try:
            with open(path, encoding="utf-8-sig") as f:
                cred = _oauth_from_text(f.read())
            if cred:
                return cred, path
        except OSError:
            pass
    return None, ""


def _skeleton(obj, depth: int = 0):
    """Cấu trúc JSON đã che giá trị: chỉ giữ tên khóa, kiểu, độ dài (an toàn để gửi hỗ trợ)."""
    if depth > 4:
        return "…"
    if isinstance(obj, dict):
        return {k: _skeleton(v, depth + 1) for k, v in list(obj.items())[:40]}
    if isinstance(obj, list):
        return [f"list[{len(obj)}]"]
    if isinstance(obj, str):
        pre = obj[:10] if obj.startswith("sk-ant-") else ""
        return f"str({len(obj)}){' ' + pre + '…' if pre else ''}"
    return type(obj).__name__


def diagnose() -> None:
    """In thông tin chẩn đoán (KHÔNG in token)."""
    print("Python:", sys.version.split()[0], "| Thư mục Claude:", claude_dir())
    print("CLAUDE_CONFIG_DIR =", os.environ.get("CLAUDE_CONFIG_DIR"))
    if sys.platform == "win32":
        raw = _wincred_enumerate()
        hits = [t for t in raw if "claude" in t.lower() or "anthropic" in t.lower()]
        print(f"\n[Credential Manager] tổng {len(raw)} mục, {len(hits)} mục Claude/Anthropic:")
        for t in hits:
            print("   ", t, f"({len(raw[t])} byte)")
    for p in credential_files():
        print(f"\n[File] {p}: ", end="")
        if not os.path.exists(p):
            print("không có")
            continue
        try:
            with open(p, "rb") as f:
                data = f.read()
            bom = "có" if data.startswith(b"\xef\xbb\xbf") else "không"
            print(f"{len(data)} byte, BOM={bom}")
            try:
                obj = json.loads(data.decode("utf-8-sig"))
                print("   Các khóa cấp 1:", ", ".join(obj.keys()) if isinstance(obj, dict) else type(obj).__name__)
            except ValueError as e:
                print("   Không phải JSON hợp lệ:", e, "| 12 byte đầu:", data[:12])
        except OSError as e:
            print("lỗi đọc:", e)
    try:
        with open(os.path.join(claude_dir(), ".credentials.json"), encoding="utf-8-sig") as f:
            o = json.load(f).get("claudeAiOauth")
        st = ("KHÔNG CÓ (Claude Code chưa đăng nhập tài khoản trên máy này)" if not isinstance(o, dict) else
              "có nhưng accessToken rỗng (đã đăng xuất/hết phiên)" if not o.get("accessToken") else "có token")
    except (OSError, ValueError, AttributeError):
        st = "không đọc được"
    print("\n[Tài khoản Claude trong .credentials.json] claudeAiOauth:", st)
    print("[Claude Code CLI] ứng viên:", cli_candidates() or "không có")
    print("[Claude Code CLI] dùng:", find_claude_cli() or "KHÔNG tìm thấy (chạy login.bat)")
    pk = glob.glob(os.path.join(os.environ.get("LOCALAPPDATA", ""), "Packages", "*Claude*"))
    desk = os.path.join(os.environ.get("APPDATA", ""), "Claude")
    for pkgdir in pk:
        lc = os.path.join(pkgdir, "LocalCache")
        for sub in ("Roaming", "Local"):
            d = os.path.join(lc, sub)
            if os.path.isdir(d):
                print(f"   {sub}:", ", ".join(sorted(os.listdir(d))[:15]))
                cd = os.path.join(d, "Claude")
                if os.path.isdir(cd):
                    print(f"   {sub}\\Claude:", ", ".join(sorted(os.listdir(cd))[:25]))
    print("[Claude Desktop]", "bản Store/MSIX: " + ", ".join(os.path.basename(x) for x in pk) if pk else
          ("bản thường: " + desk if os.path.isdir(desk) else "không thấy"))
    print("\n[Log Claude Code] các thư mục quét:")
    for root, files in find_log_files(log_roots()).items():
        newest = max(files, key=os.path.getmtime, default=None)
        nt = datetime.fromtimestamp(os.path.getmtime(newest)).strftime("%d/%m %H:%M") if newest else "-"
        print(f"   {root}: {len(files)} file .jsonl, sửa gần nhất {nt}")
        if newest:
            print("      ", newest)
    sc = LogScanner()
    st = sc.scan()
    print(f"   => hôm nay {st['today_tok']:,} token, {st['today_msgs']} lượt; lượt cuối:",
          st["last_entry"].astimezone().strftime("%d/%m %H:%M") if st["last_entry"] else "-")
    cred, src = read_credentials()
    if cred:
        exp = cred.get("expiresAt")
        print("\n=> Đọc được token OAuth từ:", src, "| gói:", cred.get("subscriptionType"),
              "| hết hạn:", datetime.fromtimestamp(exp / 1000) if exp else "?")
        r = fetch_plan_usage()
        print("=> Gọi API usage:", r["error"] or f"OK, {len(r['limits'])} mục giới hạn")
    else:
        print("\n=> Không tìm thấy token OAuth. Hãy chụp toàn bộ màn hình này gửi hỗ trợ.")


def _is_claude_code(exe: str) -> bool:
    """Xác nhận file thực thi là Claude Code CLI (không phải app Electron Claude Desktop)."""
    import subprocess
    try:
        r = subprocess.run([exe, "--version"], capture_output=True, text=True, timeout=30,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return "claude code" in (r.stdout + r.stderr).lower()
    except (OSError, subprocess.SubprocessError):
        return False


_cli_cache: list = []


def cli_candidates() -> list[str]:
    """Các vị trí có thể có Claude Code CLI, kể cả bản kèm trong Claude Desktop (thường/Store)."""
    import shutil
    home = os.path.expanduser("~")
    appdata, local = os.environ.get("APPDATA", ""), os.environ.get("LOCALAPPDATA", "")
    c = [shutil.which(n) for n in ("claude", "claude.exe", "claude.cmd")]
    c += [os.path.join(home, ".local", "bin", "claude.exe"), os.path.join(appdata, "npm", "claude.cmd")]
    # Claude Code kèm theo Claude Desktop: bản thường và bản Microsoft Store (MSIX ảo hóa AppData)
    roots = [os.path.join(appdata, "Claude"), os.path.join(local, "Claude")]
    for pkg in glob.glob(os.path.join(local, "Packages", "Claude_*")):
        roots += [os.path.join(pkg, "LocalCache", "Roaming", "Claude"),
                  os.path.join(pkg, "LocalCache", "Local", "Claude")]
    found = []
    for r in roots:
        if os.path.isdir(r):
            found += glob.glob(os.path.join(r, "**", "claude.exe"), recursive=True)
    found.sort(key=lambda f: os.path.getmtime(f), reverse=True)  # bản mới nhất trước
    out = []
    for f in c + found:
        if f and os.path.isfile(f) and f not in out:
            out.append(f)
    return out


def find_claude_cli() -> str | None:
    if _cli_cache:
        return _cli_cache[0]
    for exe in cli_candidates():
        if _is_claude_code(exe):
            _cli_cache.append(exe)
            return exe
    return None


def install_cli_from_npm() -> str | None:
    """Cài Claude Code CLI bản Windows bằng Python (không cần PowerShell/Node):
    tải gói chính thức @anthropic-ai/claude-code-win32-<arch> từ registry.npmjs.org,
    kiểm tra SHA-512, giải nén claude.exe vào %USERPROFILE%\\.local\\bin."""
    import base64
    import hashlib
    import platform
    import tarfile
    import tempfile
    arch = "arm64" if platform.machine().lower() in ("arm64", "aarch64") else "x64"
    pkg = f"@anthropic-ai/claude-code-win32-{arch}"
    ua = {"User-Agent": "claude-usage-widget/1.0"}
    print(f"Lấy thông tin gói {pkg} từ registry.npmjs.org ...")
    with urllib.request.urlopen(urllib.request.Request(
            f"https://registry.npmjs.org/{pkg}/latest", headers=ua), timeout=30) as r:
        meta = json.loads(r.read().decode("utf-8"))
    url, integrity = meta["dist"]["tarball"], meta["dist"].get("integrity", "")
    print(f"Phiên bản {meta['version']} – đang tải (~180 MB) ...")
    h = hashlib.sha512()
    fd, tmp = tempfile.mkstemp(suffix=".tgz")
    try:
        with os.fdopen(fd, "wb") as out, urllib.request.urlopen(
                urllib.request.Request(url, headers=ua), timeout=60) as r:
            total = int(r.headers.get("Content-Length") or 0)
            done = last = 0
            while True:
                buf = r.read(1 << 20)
                if not buf:
                    break
                out.write(buf)
                h.update(buf)
                done += len(buf)
                if total and done * 10 // total != last:
                    last = done * 10 // total
                    print(f"   {done / 1e6:.0f}/{total / 1e6:.0f} MB")
        if integrity.startswith("sha512-") and base64.b64decode(integrity[7:]) != h.digest():
            raise RuntimeError("Sai mã kiểm tra SHA-512 – hủy cài đặt")
        print("   Đã kiểm tra SHA-512: khớp.")
        dest_dir = os.path.join(os.path.expanduser("~"), ".local", "bin")
        os.makedirs(dest_dir, exist_ok=True)
        dest = os.path.join(dest_dir, "claude.exe")
        with tarfile.open(tmp, "r:gz") as t:
            src = t.extractfile("package/claude.exe")
            with open(dest + ".part", "wb") as f:
                while True:
                    buf = src.read(1 << 20)
                    if not buf:
                        break
                    f.write(buf)
        os.replace(dest + ".part", dest)
        print("Đã cài Claude Code CLI vào:", dest)
        return dest
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass


def login() -> None:
    """Đăng nhập Claude Code bằng tài khoản Pro/Max để widget đọc được usage."""
    import subprocess
    exe = find_claude_cli()
    if not exe:
        print("Không thấy Claude Code CLI (kể cả bản kèm Claude Desktop).")
        try:
            exe = install_cli_from_npm()
        except Exception as e:
            print("   Tải từ npm thất bại:", e)
        _cli_cache.clear()
        exe = find_claude_cli()
    if not exe:
        print("Thử trình cài PowerShell chính thức (tối đa 5 phút)...")
        try:
            r = subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
                                "irm https://claude.ai/install.ps1 | iex"], timeout=300)
            print("Mã kết thúc trình cài:", r.returncode)
        except (OSError, subprocess.SubprocessError) as e:
            print("   PowerShell thất bại:", e)
        _cli_cache.clear()
        exe = find_claude_cli()
    if not exe:
        print("\nVẫn chưa có Claude Code CLI. Cách cài thủ công: mở PowerShell, chạy\n"
              "   irm https://claude.ai/install.ps1 | iex\n"
              "(nếu máy công ty chặn script, nhờ IT hoặc dùng: npm install -g @anthropic-ai/claude-code)")
        return
    print("Dùng Claude Code tại:", exe)
    print("Trình duyệt sẽ mở trang đăng nhập. Chọn tài khoản Claude Pro/Max, đồng ý cấp quyền.\n")
    subprocess.run([exe, "auth", "login", "--claudeai"])


_last_refresh = [0.0]


def refresh_via_cli() -> dict | None:
    """Token sắp/đã hết hạn: gọi 'claude auth status' (ẩn) để Claude Code tự làm mới
    và tự lưu token theo cách của nó, rồi đọc lại. Widget không tự ghi token.
    Tối đa 1 lần / 10 phút."""
    if time.time() - _last_refresh[0] < 600:
        return None
    _last_refresh[0] = time.time()
    exe = find_claude_cli()
    if not exe:
        return None
    import subprocess
    try:
        subprocess.run([exe, "auth", "status"], capture_output=True, timeout=90,
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except (OSError, subprocess.SubprocessError):
        return None
    cred, _ = read_credentials()
    return cred


def fetch_plan_usage() -> dict:
    """Trả về {'plan': str, 'limits': [(key, label, pct, resets_at)], 'error': str|None}."""
    cred, _src = read_credentials()
    if not cred or not cred.get("accessToken"):
        return {"plan": "", "limits": [], "error": "Chưa có token tài khoản Claude. Mở Terminal, chạy: "
                "claude auth login (chi tiết: login.bat / diagnose.bat)"}
    exp = cred.get("expiresAt")
    if exp and exp / 1000 < time.time() + 60:
        cred = refresh_via_cli() or cred
        exp = cred.get("expiresAt")
    plan = (cred.get("subscriptionType") or "").capitalize()
    if exp and exp / 1000 < time.time():
        return {"plan": plan, "limits": [], "error": "Token hết hạn và chưa tự làm mới được – "
                "mở Terminal chạy 'claude' 1 lần"}

    req = urllib.request.Request(USAGE_URL, headers={
        "Authorization": f"Bearer {cred['accessToken']}",
        "anthropic-beta": "oauth-2025-04-20",
        "Content-Type": "application/json",
        "User-Agent": "claude-usage-widget/1.0",
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        msg = {401: "Token không hợp lệ – đăng nhập lại Claude Code",
               429: "Bị giới hạn tần suất – sẽ thử lại sau"}.get(e.code, f"Lỗi HTTP {e.code}")
        return {"plan": plan, "limits": [], "error": msg}
    except (urllib.error.URLError, TimeoutError, ValueError) as e:
        return {"plan": plan, "limits": [], "error": f"Không kết nối được: {getattr(e, 'reason', e)}"}

    limits = []
    for key, val in data.items():
        if isinstance(val, dict) and isinstance(val.get("utilization"), (int, float)):
            limits.append((key, LABELS.get(key, key.replace("_", " ")),
                           float(val["utilization"]), val.get("resets_at")))
    order = list(LABELS)
    limits.sort(key=lambda t: order.index(t[0]) if t[0] in order else 99)
    return {"plan": plan, "limits": limits, "error": None}


# ----------------------------------------------------------------------------
# 2. Token từ log Claude Code (đọc tăng dần, chống trùng)
# ----------------------------------------------------------------------------
SKIP_DIRS = {"cache", "code cache", "gpucache", "dawncache", "dawnwebgpucache", "blob_storage", "crashpad",
             "node_modules", "indexeddb", "service worker", "shared_proto_db", "vm_bundles", "logs",
             "local storage", "session storage", "webstorage", "git", ".git"}


def log_roots() -> list[str]:
    """Nơi Claude Code ghi log hội thoại (*.jsonl): CLI và Claude Code chạy trong Claude Desktop/Cowork
    (bản thường %APPDATA%\\Claude, bản Store ảo hóa trong %LOCALAPPDATA%\\Packages\\Claude_*)."""
    home = os.path.expanduser("~")
    appdata, local = os.environ.get("APPDATA", ""), os.environ.get("LOCALAPPDATA", "")
    roots = [os.path.join(claude_dir(), "projects"), os.path.join(home, ".claude", "projects")]
    if appdata:
        roots.append(os.path.join(appdata, "Claude"))
    if local:
        roots.append(os.path.join(local, "Claude"))
        for pkg in glob.glob(os.path.join(local, "Packages", "Claude_*")):
            roots.append(os.path.join(pkg, "LocalCache"))
    out = []
    for r in roots:
        r = os.path.normcase(os.path.abspath(r))
        if os.path.isdir(r) and r not in out:
            out.append(r)
    return out


def find_log_files(roots: list[str]) -> dict[str, list[str]]:
    res: dict[str, list[str]] = {}
    for root in roots:
        files = []
        for dp, dns, fns in os.walk(root):
            dns[:] = [d for d in dns if d.lower() not in SKIP_DIRS]
            files += [os.path.join(dp, f) for f in fns if f.endswith(".jsonl")]
        res[root] = files
    return res


class LogScanner:
    def __init__(self) -> None:
        self.files: list[str] = []
        self.walked_at = 0.0
        self.sources: dict[str, list[str]] = {}
        self.offsets: dict[str, int] = {}
        self.seen: set[str] = set()
        self.entries: deque = deque()  # (datetime_utc, model, in, out, cache_w, cache_r)
        self.first = True

    def _parse_line(self, line: str) -> None:
        try:
            o = json.loads(line)
        except ValueError:
            return
        msg = o.get("message") if isinstance(o, dict) else None
        if not isinstance(msg, dict) or not isinstance(msg.get("usage"), dict):
            return
        key = f"{msg.get('id')}:{o.get('requestId')}"
        if key in self.seen:
            return
        self.seen.add(key)
        try:
            ts = datetime.fromisoformat(o["timestamp"].replace("Z", "+00:00"))
        except (KeyError, ValueError, AttributeError):
            return
        u = msg["usage"]
        self.entries.append((ts, msg.get("model") or "?",
                             u.get("input_tokens", 0) or 0, u.get("output_tokens", 0) or 0,
                             u.get("cache_creation_input_tokens", 0) or 0,
                             u.get("cache_read_input_tokens", 0) or 0))

    def scan(self) -> dict:
        cutoff_mtime = time.time() - 2 * 86400
        if time.time() - self.walked_at > 300 or not self.files:  # quét lại cây thư mục mỗi 5 phút
            self.sources = find_log_files(log_roots())
            seen_real, self.files = set(), []
            for fl in self.sources.values():
                for f in fl:
                    rp = os.path.normcase(os.path.realpath(f))
                    if rp not in seen_real:
                        seen_real.add(rp)
                        self.files.append(f)
            self.walked_at = time.time()
        newest = 0.0
        for path in self.files:
            try:
                size = os.path.getsize(path)
                newest = max(newest, os.path.getmtime(path))
                if self.first and path not in self.offsets and os.path.getmtime(path) < cutoff_mtime:
                    self.offsets[path] = size  # file cũ: bỏ qua nội dung, chỉ theo dõi phần ghi thêm
                    continue
                off = self.offsets.get(path, 0)
                if size < off:
                    off = 0
                if size == off:
                    continue
                with open(path, "rb") as f:
                    f.seek(off)
                    chunk = f.read()
                end = chunk.rfind(b"\n")
                if end < 0:
                    continue
                for line in chunk[:end].decode("utf-8", "replace").splitlines():
                    if '"usage"' in line:
                        self._parse_line(line)
                self.offsets[path] = off + end + 1
            except OSError:
                continue
        self.first = False

        now = datetime.now(timezone.utc)
        while self.entries and self.entries[0][0] < now - timedelta(days=2):
            self.entries.popleft()
        today = datetime.now().astimezone().date()
        t5 = now - timedelta(hours=5)
        res = {"today_tok": 0, "today_msgs": 0, "h5_tok": 0, "today_out": 0, "models": {},
               "files": len(self.files), "newest": newest,
               "last_entry": max((e[0] for e in self.entries), default=None)}
        for ts, model, i, o, cw, cr in self.entries:
            total = i + o + cw + cr
            if ts >= t5:
                res["h5_tok"] += total
            if ts.astimezone().date() == today:
                res["today_tok"] += total
                res["today_out"] += o
                res["today_msgs"] += 1
                fam = next((f for f in ("opus", "sonnet", "haiku", "fable") if f in model.lower()), "khác")
                res["models"][fam] = res["models"].get(fam, 0) + total
        return res


# ----------------------------------------------------------------------------
# 3. Tốc độ mạng
# ----------------------------------------------------------------------------
def net_bytes() -> tuple[int, int]:
    rx = tx = 0
    for name, c in psutil.net_io_counters(pernic=True).items():
        if name.lower().startswith(EXCLUDED_NIC_PREFIX):
            continue
        rx += c.bytes_recv
        tx += c.bytes_sent
    return rx, tx


def fmt_rate(bps: float) -> str:
    """bps: byte/giây -> chuỗi kB/s (1 kB = 1000 byte), kiểu số Việt Nam: 1.234,5 kB/s."""
    k = bps / 1000
    txt = f"{k:,.1f}" if k < 100 else f"{k:,.0f}"
    return txt.replace(",", "§").replace(".", ",").replace("§", ".") + " kB/s"


def fmt_tok(n: int) -> str:
    if n >= 1e9:
        return f"{n / 1e9:.2f}B"
    if n >= 1e6:
        return f"{n / 1e6:.1f}M"
    if n >= 1e3:
        return f"{n / 1e3:.1f}K"
    return str(n)


def fmt_reset(iso: str | None) -> str:
    if not iso:
        return ""
    try:
        t = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return ""
    d = t - datetime.now(timezone.utc)
    secs = int(d.total_seconds())
    if secs <= 0:
        return "đã reset"
    h, m = divmod(secs // 60, 60)
    left = f"{h // 24}n {h % 24}g" if h >= 24 else (f"{h}g {m:02d}p" if h else f"{m}p")
    return f"reset {t.astimezone():%H:%M %d/%m} · còn {left}"


def level_color(pct: float) -> str:
    return C["ok"] if pct < 60 else (C["warn"] if pct < 85 else C["crit"])


# ----------------------------------------------------------------------------
# Giao diện
# ----------------------------------------------------------------------------
class Widget:
    def __init__(self) -> None:
        self.cfg = load_config()
        self.q: queue.Queue = queue.Queue()
        self.scanner = LogScanner()
        self.down = deque([0.0] * NET_HISTORY, maxlen=NET_HISTORY)
        self.up = deque([0.0] * NET_HISTORY, maxlen=NET_HISTORY)
        self.prev = (time.monotonic(), *net_bytes())
        self.plan_data = None
        self.last_plan_ok = None

        global SC
        enable_dpi_awareness()
        r = self.root = tk.Tk()
        SC = r.winfo_fpixels("1i") / 96.0
        r.title("Claude Widget")
        r.overrideredirect(True)  # không viền, không hiện trên taskbar
        r.configure(bg=C["bg"])
        r.attributes("-alpha", self.cfg["alpha"])
        r.attributes("-topmost", self.cfg["topmost"])
        x = self.cfg["x"] if self.cfg["x"] is not None else r.winfo_screenwidth() - px(WIDTH) - px(24)
        y = self.cfg["y"] if self.cfg["y"] is not None else px(40)
        r.geometry(f"{px(WIDTH)}x10+{x}+{y}")

        self.frame = tk.Frame(r, bg=C["bg"], padx=px(12), pady=px(10))
        self.frame.pack(fill="both", expand=True)
        self._build()
        self._bind_drag(r)
        self._menu()

        self.tick_net()
        self.start_worker(self._plan_job, USAGE_INTERVAL_S)
        self.start_worker(self._log_job, LOG_INTERVAL_S)
        self.pump()
        self.tick_clock()

    # --- dựng giao diện ------------------------------------------------------
    def _lbl(self, parent, text="", size=9, color="fg", bold=False, **kw):
        return tk.Label(parent, text=text, bg=kw.pop("bg", C["bg"]), fg=C[color],
                        font=(FONT, size, "bold" if bold else "normal"), anchor="w", **kw)

    def _build(self) -> None:
        f = self.frame
        head = tk.Frame(f, bg=C["bg"])
        head.pack(fill="x")
        self._lbl(head, "●", 10, "accent").pack(side="left")
        self.title_lbl = self._lbl(head, " Claude", 11, bold=True)
        self.title_lbl.pack(side="left")
        self.clock_lbl = self._lbl(head, "", 8, "muted")
        self.clock_lbl.pack(side="right")

        self.plan_box = tk.Frame(f, bg=C["bg"])
        self.plan_box.pack(fill="x", pady=(px(6), 0))
        self._lbl(self.plan_box, "Đang tải giới hạn gói…", 8, "muted").pack(anchor="w")

        tk.Frame(f, bg=C["track"], height=px(1)).pack(fill="x", pady=px(8))
        self.log_head = self._lbl(f, "CLAUDE CODE (log máy này)", 7, "muted", bold=True)
        self.log_head.pack(anchor="w")
        self.log_lbl = self._lbl(f, "Đang quét log…", 9, justify="left")
        self.log_lbl.pack(anchor="w", pady=(px(2), 0))
        self.model_lbl = self._lbl(f, "", 8, "muted")
        self.model_lbl.pack(anchor="w")

        tk.Frame(f, bg=C["track"], height=px(1)).pack(fill="x", pady=px(8))
        self._lbl(f, "INTERNET", 7, "muted", bold=True).pack(anchor="w")
        row = tk.Frame(f, bg=C["bg"])
        row.pack(fill="x", pady=(px(2), px(4)))
        self.down_lbl = self._lbl(row, "↓ –", 12, "down", bold=True)
        self.down_lbl.pack(side="left")
        self.up_lbl = self._lbl(row, "↑ –", 12, "up", bold=True)
        self.up_lbl.pack(side="right")
        self.chart = tk.Canvas(f, width=px(WIDTH - 24), height=px(46), bg=C["panel"], highlightthickness=0)
        self.chart.pack(fill="x")
        self.peak_lbl = self._lbl(f, "", 7, "muted")
        self.peak_lbl.pack(anchor="w", pady=(px(2), 0))

    def _render_plan(self) -> None:
        for w in self.plan_box.winfo_children():
            w.destroy()
        d = self.plan_data
        self.title_lbl.config(text=f" Claude {d['plan']}".rstrip())
        if d["error"]:
            self._lbl(self.plan_box, "⚠ " + d["error"], 8, "warn", wraplength=px(WIDTH - 30),
                      justify="left").pack(anchor="w")
        for _key, label, pct, resets in d["limits"]:
            top = tk.Frame(self.plan_box, bg=C["bg"])
            top.pack(fill="x", pady=(px(4), px(1)))
            self._lbl(top, label, 9).pack(side="left")
            self._lbl(top, f"{pct:.0f}%", 9, bold=True).pack(side="right")
            bar = tk.Canvas(self.plan_box, height=px(6), bg=C["track"], highlightthickness=0)
            bar.pack(fill="x")
            bar.update_idletasks()
            w = max(bar.winfo_width(), px(WIDTH - 24))
            bar.create_rectangle(0, 0, w * min(pct, 100) / 100, px(6), fill=level_color(pct), width=0)
            if resets:
                self._lbl(self.plan_box, fmt_reset(resets), 7, "muted").pack(anchor="w")
        if self.last_plan_ok:
            self._lbl(self.plan_box, f"cập nhật {self.last_plan_ok:%H:%M:%S}", 7, "muted").pack(anchor="e")
        self._fit()

    def _render_log(self, s: dict) -> None:
        last = s.get("last_entry")
        last_txt = f" · lượt cuối {last.astimezone():%H:%M}" if last else ""
        self.log_head.config(text=f"CLAUDE CODE (log máy này · {s.get('files', 0)} file{last_txt})")
        self.log_lbl.config(text=f"Hôm nay: {fmt_tok(s['today_tok'])} token · {s['today_msgs']} lượt"
                                 f" · out {fmt_tok(s['today_out'])}\n"
                                 f"5 giờ qua: {fmt_tok(s['h5_tok'])} token")
        models = sorted(s["models"].items(), key=lambda kv: -kv[1])
        self.model_lbl.config(text="  ".join(f"{k.capitalize()} {fmt_tok(v)}" for k, v in models) or "Chưa có hoạt động hôm nay")
        self._fit()

    def _draw_chart(self) -> None:
        c = self.chart
        c.delete("all")
        w, h = int(c.winfo_width()) or px(WIDTH - 24), px(46)
        peak = max(max(self.down), max(self.up), 12_500)
        step = w / (NET_HISTORY - 1)
        for series, color in ((self.down, C["down"]), (self.up, C["up"])):
            pts = []
            for i, v in enumerate(series):
                pts += [i * step, h - px(3) - (h - px(6)) * v / peak]
            c.create_line(*pts, fill=color, width=max(1.5, 1.6 * SC), smooth=True)
        self.peak_lbl.config(text=f"60 giây · thang đo đỉnh {fmt_rate(peak)}")

    def _fit(self) -> None:
        self.root.update_idletasks()
        h = self.frame.winfo_reqheight()
        self.root.geometry(f"{px(WIDTH)}x{h}+{self.root.winfo_x()}+{self.root.winfo_y()}")

    # --- vòng lặp ------------------------------------------------------------
    def tick_net(self) -> None:
        t, rx, tx = time.monotonic(), *net_bytes()
        pt, prx, ptx = self.prev
        dt = max(t - pt, 1e-3)
        d_bps, u_bps = max(rx - prx, 0) / dt, max(tx - ptx, 0) / dt
        self.prev = (t, rx, tx)
        self.down.append(d_bps)
        self.up.append(u_bps)
        self.down_lbl.config(text=f"↓ {fmt_rate(d_bps)}")
        self.up_lbl.config(text=f"↑ {fmt_rate(u_bps)}")
        self._draw_chart()
        self.root.after(NET_INTERVAL_MS, self.tick_net)

    def tick_clock(self) -> None:
        self.clock_lbl.config(text=datetime.now().strftime("%H:%M  %d/%m"))
        if self.plan_data and self.plan_data["limits"]:  # cập nhật đếm ngược reset
            self._render_plan()
        self.root.after(30_000, self.tick_clock)

    def start_worker(self, job, interval: int) -> None:
        ev = threading.Event()

        def loop():
            while True:
                try:
                    self.q.put(job())
                except Exception as e:  # không để luồng nền chết
                    self.q.put(("err", str(e)))
                ev.wait(interval)
                ev.clear()

        setattr(self, f"_ev_{job.__name__}", ev)
        threading.Thread(target=loop, daemon=True).start()

    def _plan_job(self):
        return ("plan", fetch_plan_usage())

    def _log_job(self):
        return ("log", self.scanner.scan())

    def pump(self) -> None:
        try:
            while True:
                kind, payload = self.q.get_nowait()
                if kind == "plan":
                    if payload["error"] and self.plan_data and self.plan_data["limits"]:
                        payload = {**self.plan_data, "error": payload["error"]}  # giữ số liệu cũ
                    elif not payload["error"]:
                        self.last_plan_ok = datetime.now()
                    self.plan_data = payload
                    self._render_plan()
                elif kind == "log":
                    self._render_log(payload)
        except queue.Empty:
            pass
        self.root.after(300, self.pump)

    # --- tương tác -----------------------------------------------------------
    def _bind_drag(self, w) -> None:
        def start(e):
            self._dx, self._dy = e.x_root - self.root.winfo_x(), e.y_root - self.root.winfo_y()

        def move(e):
            self.root.geometry(f"+{e.x_root - self._dx}+{e.y_root - self._dy}")

        def stop(_e):
            self.cfg["x"], self.cfg["y"] = self.root.winfo_x(), self.root.winfo_y()
            save_config(self.cfg)

        w.bind_all("<ButtonPress-1>", start)
        w.bind_all("<B1-Motion>", move)
        w.bind_all("<ButtonRelease-1>", stop)

    def _menu(self) -> None:
        m = self.menu = tk.Menu(self.root, tearoff=0)
        m.add_command(label="Làm mới ngay", command=self.refresh)
        self.top_var = tk.BooleanVar(value=self.cfg["topmost"])
        m.add_checkbutton(label="Luôn nổi trên cùng", variable=self.top_var, command=self.toggle_top)
        sub = tk.Menu(m, tearoff=0)
        for a in (1.0, 0.92, 0.8, 0.65):
            sub.add_command(label=f"{int(a * 100)}%", command=lambda a=a: self.set_alpha(a))
        m.add_cascade(label="Độ trong suốt", menu=sub)
        m.add_separator()
        m.add_command(label="Thoát", command=self.root.destroy)
        self.root.bind_all("<Button-3>", lambda e: m.tk_popup(e.x_root, e.y_root))

    def refresh(self) -> None:
        for name in ("_ev__plan_job", "_ev__log_job"):
            getattr(self, name).set()

    def toggle_top(self) -> None:
        self.cfg["topmost"] = self.top_var.get()
        self.root.attributes("-topmost", self.cfg["topmost"])
        save_config(self.cfg)

    def set_alpha(self, a: float) -> None:
        self.cfg["alpha"] = a
        self.root.attributes("-alpha", a)
        save_config(self.cfg)

    def run(self) -> None:
        self.root.mainloop()


def startup_launcher_path() -> str:
    return os.path.join(os.environ.get("APPDATA", ""), "Microsoft", "Windows", "Start Menu",
                        "Programs", "Startup", "ClaudeWidget.pyw")


def install_startup() -> None:
    """Tạo file .pyw trong thư mục Startup (Windows chạy bằng pythonw, không hiện console)."""
    script = os.path.abspath(__file__)
    with open(startup_launcher_path(), "w", encoding="utf-8") as f:
        f.write(f"import runpy\nrunpy.run_path({script!r}, run_name='__main__')\n")
    print("Đã bật tự khởi động:", startup_launcher_path())


def uninstall_startup() -> None:
    try:
        os.remove(startup_launcher_path())
        print("Đã gỡ tự khởi động.")
    except OSError:
        print("Không có mục tự khởi động.")


if __name__ == "__main__":
    if "--diagnose" in sys.argv:
        diagnose()
    elif "--login" in sys.argv:
        login()
        print("\n===== Kiểm tra lại =====")
        diagnose()
    elif "--install-startup" in sys.argv:
        install_startup()
    elif "--uninstall-startup" in sys.argv:
        uninstall_startup()
    else:
        Widget().run()
