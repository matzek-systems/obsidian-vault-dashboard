#!/usr/bin/env python3
"""Launcher + health for the remote phone app server (serve_tailnet.py, same folder).

  python launch.py --ensure          start the server if :8378 is not answering
                                     (idempotent: the dashboard Launch button calls this)
  python launch.py --restart         stop whatever owns serve.pid / the port, start fresh
                                     (needed after any code edit: detached pythonw never reloads)
  python launch.py --stop
  python launch.py --status [--json] server + Tailscale front door + push relay in one look

The vault-dashboard plugin runs --restart when it loads and --stop when it unloads (DL-689), with
VAULT_PATH in the environment; run by hand, the vault is found by walking up from this file
(see vaultpath.py). The server is launched detached under pythonw (no console window, survives
the launching session), PID in serve.pid, stderr in serve-err.log. Both files are gitignored.

Front door: `tailscale serve --bg 8378` proxies https://<this-machine>.<tailnet>.ts.net ->
127.0.0.1:8378 (needs HTTPS certificates enabled on the tailnet). That config persists in
tailscaled's state, but the backend only runs while a frontend has started it (the tray app, or
`tailscale up`) unless "Run unattended" is on -- it once sat in NoState for 47 h after a reboot
with no GUI running. --ensure therefore also starts the tray app when the backend is not Running,
and re-adds the serve proxy if the config is missing.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

import vaultpath

sys.path.insert(0, str(vaultpath.TOOLS))
try:
    from win_console import suppress_child_windows   # DL-457: tailscale/python children stay windowless
    suppress_child_windows()
except Exception:
    pass

try:
    import psutil  # type: ignore
except Exception:  # pragma: no cover
    psutil = None

HERE = Path(__file__).resolve().parent
SERVER = HERE / "serve_tailnet.py"
PID_FILE = HERE / "serve.pid"
ERR_LOG = HERE / "serve-err.log"
PORT = 8378
BIND = "127.0.0.1"
TAILSCALE = shutil.which("tailscale") or r"C:\Program Files\Tailscale\tailscale.exe"
TAILSCALE_GUI = r"C:\Program Files\Tailscale\tailscale-ipn.exe"
STATE_DIR = vaultpath.STATE_DIR


def front_url(ts: dict | None = None) -> str:
    """https://<node>.<tailnet>.ts.net from the node's MagicDNS name ('' when Tailscale is not up)."""
    ts = ts if ts is not None else tailscale_status()
    return f"https://{ts['dns']}" if ts.get("dns") else ""


# ---------------------------------------------------------------- probes

def port_open(port: int = PORT, host: str = BIND, timeout: float = 0.4) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def _bg_python() -> str:
    if sys.platform != "win32":
        return sys.executable
    cand = Path(sys.executable).with_name("pythonw.exe")
    return str(cand) if cand.exists() else sys.executable


def server_pids() -> list[int]:
    """Every python process running serve_tailnet.py (normally one)."""
    if not psutil:
        return []
    out = []
    for p in psutil.process_iter(["pid", "name", "cmdline"]):
        try:
            name = (p.info.get("name") or "").lower()
            if not name.startswith("python"):
                continue
            cmd = " ".join(p.info.get("cmdline") or [])
            if "serve_tailnet.py" in cmd:
                out.append(p.pid)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    return out


def _pid_file() -> int | None:
    try:
        return int(PID_FILE.read_text().strip())
    except Exception:
        return None


def _proc(pid: int | None):
    if not pid or not psutil:
        return None
    try:
        p = psutil.Process(pid)
        return p if "serve_tailnet.py" in " ".join(p.cmdline()) else None
    except Exception:
        return None


def _run(argv: list[str], timeout: float = 8.0) -> tuple[int, str]:
    try:
        r = subprocess.run(argv, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
        return r.returncode, (r.stdout or "") + (r.stderr or "")
    except Exception as e:
        return -1, f"{e.__class__.__name__}: {e}"


def tailscale_status() -> dict:
    """Backend state, this node's tailnet identity, and whether the serve proxy to :8378 exists."""
    out: dict = {"backend": "unknown", "online": False, "dns": "", "ip": "", "serve": False,
                 "serve_text": "", "gui": False, "health": []}
    if not Path(TAILSCALE).exists():
        out["backend"] = "not installed"
        return out
    rc, txt = _run([TAILSCALE, "status", "--json"])
    try:
        j = json.loads(txt[txt.index("{"):]) if "{" in txt else {}
    except Exception:
        j = {}
    out["backend"] = j.get("BackendState") or ("error" if rc else "unknown")
    self_ = j.get("Self") or {}
    out["online"] = bool(self_.get("Online"))
    out["dns"] = (self_.get("DNSName") or "").rstrip(".")
    ips = self_.get("TailscaleIPs") or []
    out["ip"] = ips[0] if ips else ""
    out["health"] = [x for x in (j.get("Health") or []) if "starting" not in x.lower()][:3]
    rc, stxt = _run([TAILSCALE, "serve", "status"])
    out["serve_text"] = stxt.strip()
    out["serve"] = f"127.0.0.1:{PORT}" in stxt
    if psutil:
        out["gui"] = any((p.info.get("name") or "").lower() == "tailscale-ipn.exe"
                         for p in psutil.process_iter(["name"]))
    return out


def push_status() -> dict:
    def _load(name, default):
        try:
            return json.loads((STATE_DIR / name).read_text(encoding="utf-8"))
        except Exception:
            return default
    prefs = _load("notify-prefs.json", {}) or {}
    return {"devices": len(_load("subscriptions.json", []) or []),
            "level": prefs.get("level", "away"), "cooldown_min": prefs.get("cooldown_min", 20)}


def status() -> dict:
    pid = _pid_file()
    p = _proc(pid)
    pids = server_pids()
    if not p and pids:
        p = _proc(pids[0])
    up = None
    if p:
        try:
            up = int(time.time() - p.create_time())
        except Exception:
            up = None
    ts = tailscale_status()
    return {"running": bool(p) and port_open(),
            "pid": p.pid if p else None,
            "extra_pids": [x for x in pids if not p or x != p.pid],
            "port": PORT, "port_open": port_open(), "uptime_s": up,
            "url": front_url(ts), "tailscale": ts, "push": push_status(),
            "server": str(SERVER), "vault": str(vaultpath.VAULT),
            "checked": time.strftime("%Y-%m-%dT%H:%M:%S")}


# ---------------------------------------------------------------- actions

def start(wait_s: float = 10.0) -> tuple[bool, str]:
    if port_open():
        return True, f"already answering on :{PORT} (pid {_pid_file()})"
    kwargs: dict = {"close_fds": True}
    if sys.platform == "win32":
        kwargs["creationflags"] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    err = open(ERR_LOG, "ab")
    proc = subprocess.Popen([_bg_python(), str(SERVER), "--bind", BIND, "--port", str(PORT)],
                            cwd=str(HERE), stdout=subprocess.DEVNULL, stderr=err, **kwargs)
    PID_FILE.write_text(str(proc.pid))
    t0 = time.time()
    while time.time() - t0 < wait_s:
        if port_open():
            return True, f"started pid {proc.pid}, answering on :{PORT}"
        if proc.poll() is not None:
            tail = ""
            try:
                tail = ERR_LOG.read_text(encoding="utf-8", errors="replace")[-600:]
            except Exception:
                pass
            return False, f"server exited rc={proc.returncode} before binding; serve-err.log tail:\n{tail}"
        time.sleep(0.25)
    return False, f"pid {proc.pid} launched but :{PORT} not answering after {wait_s:.0f}s"


def stop(wait_s: float = 6.0) -> tuple[bool, str]:
    targets = []
    p = _proc(_pid_file())
    if p:
        targets.append(p)
    for pid in server_pids():
        q = _proc(pid)
        if q and all(q.pid != t.pid for t in targets):
            targets.append(q)
    if not targets:
        try:
            PID_FILE.unlink()
        except FileNotFoundError:
            pass
        return True, "not running"
    for t in targets:
        try:
            t.terminate()
        except Exception:
            pass
    t0 = time.time()
    while time.time() - t0 < wait_s and (port_open() or any(t.is_running() for t in targets)):
        time.sleep(0.2)
    for t in targets:
        if t.is_running():
            try:
                t.kill()
            except Exception:
                pass
    try:
        PID_FILE.unlink()
    except FileNotFoundError:
        pass
    return True, "stopped " + ", ".join(str(t.pid) for t in targets)


def ensure_front_door() -> list[str]:
    """Tailscale backend up + serve proxy present. Returns notes for the operator."""
    notes = []
    ts = tailscale_status()
    if ts["backend"] == "not installed":
        return ["tailscale not installed"]
    if ts["backend"] != "Running":
        if Path(TAILSCALE_GUI).exists() and not ts["gui"]:
            try:
                subprocess.Popen([TAILSCALE_GUI], close_fds=True)
                notes.append("tailscale backend was %s; started the tray app" % ts["backend"])
            except Exception as e:
                notes.append(f"tailscale backend {ts['backend']}; tray app launch failed: {e}")
        else:
            notes.append(f"tailscale backend {ts['backend']}; tray app already running, giving it a moment")
        for _ in range(24):
            time.sleep(0.5)
            ts = tailscale_status()
            if ts["backend"] == "Running":
                break
        notes.append(f"tailscale backend now {ts['backend']}")
    if ts["backend"] == "Running" and not ts["serve"]:
        rc, txt = _run([TAILSCALE, "serve", "--bg", str(PORT)], timeout=15)
        notes.append("re-added serve proxy -> :%d" % PORT if rc == 0 else f"serve --bg failed rc={rc}: {txt.strip()[:200]}")
    return notes


def ensure() -> tuple[bool, str]:
    notes = ensure_front_door()
    ok, msg = start()
    return ok, "; ".join(notes + [msg])


def restart() -> tuple[bool, str]:
    _, m1 = stop()
    ok, m2 = start()
    return ok, f"{m1}; {m2}"


# ---------------------------------------------------------------- cli

def _print_status(s: dict) -> None:
    ts, push = s["tailscale"], s["push"]
    run = "RUNNING" if s["running"] else ("port open, pid unknown" if s["port_open"] else "STOPPED")
    print(f"remote-app  {run}  pid={s['pid']}  :{s['port']}  up={s['uptime_s']}s  {s['url'] or '(no tailnet URL yet)'}")
    print(f"vault       {s['vault']}")
    print(f"tailscale   backend={ts['backend']} online={ts['online']} ip={ts['ip']} dns={ts['dns']} gui={ts['gui']}")
    print(f"front door  {'proxy -> 127.0.0.1:%d' % PORT if ts['serve'] else 'NO serve config'}")
    for hmsg in ts.get("health") or []:
        print(f"  health: {hmsg}")
    print(f"push        devices={push['devices']} level={push['level']} quiet={push['cooldown_min']}m")
    if s["extra_pids"]:
        print(f"extra server pids: {s['extra_pids']}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--ensure", action="store_true")
    g.add_argument("--restart", action="store_true")
    g.add_argument("--stop", action="store_true")
    g.add_argument("--status", action="store_true")
    ap.add_argument("--json", action="store_true", help="with --status: JSON to stdout")
    a = ap.parse_args()
    if sys.stdout:
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    if a.status:
        s = status()
        print(json.dumps(s, indent=1)) if a.json else _print_status(s)
        return 0 if s["running"] else 1
    ok, msg = ensure() if a.ensure else restart() if a.restart else stop()
    print(msg)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
