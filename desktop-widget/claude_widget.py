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
WIDTH = 300

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
def read_credentials() -> dict | None:
    path = os.path.join(claude_dir(), ".credentials.json")
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f).get("claudeAiOauth")
    except (OSError, ValueError):
        return None


def fetch_plan_usage() -> dict:
    """Trả về {'plan': str, 'limits': [(key, label, pct, resets_at)], 'error': str|None}."""
    cred = read_credentials()
    if not cred or not cred.get("accessToken"):
        return {"plan": "", "limits": [], "error": "Chưa đăng nhập Claude Code (chạy 'claude' rồi /login)"}
    plan = (cred.get("subscriptionType") or "").capitalize()
    exp = cred.get("expiresAt")
    if exp and exp / 1000 < time.time():
        return {"plan": plan, "limits": [], "error": "Token hết hạn – mở Claude Code 1 lần để làm mới"}

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
class LogScanner:
    def __init__(self) -> None:
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
        for path in glob.glob(os.path.join(claude_dir(), "projects", "**", "*.jsonl"), recursive=True):
            try:
                size = os.path.getsize(path)
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
        res = {"today_tok": 0, "today_msgs": 0, "h5_tok": 0, "today_out": 0, "models": {}}
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
    """bps: bit/giây."""
    if bps >= 1e9:
        return f"{bps / 1e9:.2f} Gbps"
    if bps >= 1e6:
        return f"{bps / 1e6:.1f} Mbps"
    if bps >= 1e3:
        return f"{bps / 1e3:.0f} kbps"
    return f"{bps:.0f} bps"


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

        r = self.root = tk.Tk()
        r.title("Claude Widget")
        r.overrideredirect(True)  # không viền, không hiện trên taskbar
        r.configure(bg=C["bg"])
        r.attributes("-alpha", self.cfg["alpha"])
        r.attributes("-topmost", self.cfg["topmost"])
        x = self.cfg["x"] if self.cfg["x"] is not None else r.winfo_screenwidth() - WIDTH - 24
        y = self.cfg["y"] if self.cfg["y"] is not None else 40
        r.geometry(f"{WIDTH}x10+{x}+{y}")

        self.frame = tk.Frame(r, bg=C["bg"], padx=12, pady=10)
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
        self.plan_box.pack(fill="x", pady=(6, 0))
        self._lbl(self.plan_box, "Đang tải giới hạn gói…", 8, "muted").pack(anchor="w")

        tk.Frame(f, bg=C["track"], height=1).pack(fill="x", pady=8)
        self._lbl(f, "CLAUDE CODE (log máy này)", 7, "muted", bold=True).pack(anchor="w")
        self.log_lbl = self._lbl(f, "Đang quét log…", 9, justify="left")
        self.log_lbl.pack(anchor="w", pady=(2, 0))
        self.model_lbl = self._lbl(f, "", 8, "muted")
        self.model_lbl.pack(anchor="w")

        tk.Frame(f, bg=C["track"], height=1).pack(fill="x", pady=8)
        self._lbl(f, "INTERNET", 7, "muted", bold=True).pack(anchor="w")
        row = tk.Frame(f, bg=C["bg"])
        row.pack(fill="x", pady=(2, 4))
        self.down_lbl = self._lbl(row, "↓ –", 12, "down", bold=True)
        self.down_lbl.pack(side="left")
        self.up_lbl = self._lbl(row, "↑ –", 12, "up", bold=True)
        self.up_lbl.pack(side="right")
        self.chart = tk.Canvas(f, width=WIDTH - 24, height=46, bg=C["panel"], highlightthickness=0)
        self.chart.pack(fill="x")
        self.peak_lbl = self._lbl(f, "", 7, "muted")
        self.peak_lbl.pack(anchor="w", pady=(2, 0))

    def _render_plan(self) -> None:
        for w in self.plan_box.winfo_children():
            w.destroy()
        d = self.plan_data
        self.title_lbl.config(text=f" Claude {d['plan']}".rstrip())
        if d["error"]:
            self._lbl(self.plan_box, "⚠ " + d["error"], 8, "warn", wraplength=WIDTH - 30,
                      justify="left").pack(anchor="w")
        for _key, label, pct, resets in d["limits"]:
            top = tk.Frame(self.plan_box, bg=C["bg"])
            top.pack(fill="x", pady=(4, 1))
            self._lbl(top, label, 9).pack(side="left")
            self._lbl(top, f"{pct:.0f}%", 9, bold=True).pack(side="right")
            bar = tk.Canvas(self.plan_box, height=6, bg=C["track"], highlightthickness=0)
            bar.pack(fill="x")
            bar.update_idletasks()
            w = max(bar.winfo_width(), WIDTH - 24)
            bar.create_rectangle(0, 0, w * min(pct, 100) / 100, 6, fill=level_color(pct), width=0)
            if resets:
                self._lbl(self.plan_box, fmt_reset(resets), 7, "muted").pack(anchor="w")
        if self.last_plan_ok:
            self._lbl(self.plan_box, f"cập nhật {self.last_plan_ok:%H:%M:%S}", 7, "muted").pack(anchor="e")
        self._fit()

    def _render_log(self, s: dict) -> None:
        self.log_lbl.config(text=f"Hôm nay: {fmt_tok(s['today_tok'])} token · {s['today_msgs']} lượt"
                                 f" · out {fmt_tok(s['today_out'])}\n"
                                 f"5 giờ qua: {fmt_tok(s['h5_tok'])} token")
        models = sorted(s["models"].items(), key=lambda kv: -kv[1])
        self.model_lbl.config(text="  ".join(f"{k.capitalize()} {fmt_tok(v)}" for k, v in models) or "Chưa có hoạt động hôm nay")
        self._fit()

    def _draw_chart(self) -> None:
        c = self.chart
        c.delete("all")
        w, h = int(c.winfo_width()) or WIDTH - 24, 46
        peak = max(max(self.down), max(self.up), 1e5)
        step = w / (NET_HISTORY - 1)
        for series, color in ((self.down, C["down"]), (self.up, C["up"])):
            pts = []
            for i, v in enumerate(series):
                pts += [i * step, h - 3 - (h - 6) * v / peak]
            c.create_line(*pts, fill=color, width=1.5, smooth=True)
        self.peak_lbl.config(text=f"60 giây · thang đo đỉnh {fmt_rate(peak)}")

    def _fit(self) -> None:
        self.root.update_idletasks()
        h = self.frame.winfo_reqheight()
        self.root.geometry(f"{WIDTH}x{h}+{self.root.winfo_x()}+{self.root.winfo_y()}")

    # --- vòng lặp ------------------------------------------------------------
    def tick_net(self) -> None:
        t, rx, tx = time.monotonic(), *net_bytes()
        pt, prx, ptx = self.prev
        dt = max(t - pt, 1e-3)
        d_bps, u_bps = max(rx - prx, 0) * 8 / dt, max(tx - ptx, 0) * 8 / dt
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
    if "--install-startup" in sys.argv:
        install_startup()
    elif "--uninstall-startup" in sys.argv:
        uninstall_startup()
    else:
        Widget().run()
