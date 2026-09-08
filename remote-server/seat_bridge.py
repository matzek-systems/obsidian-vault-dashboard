"""Reach any workspace-shell pane from outside Obsidian with zero plugin reload.

Two transports (session 942, DL-689): the vault-dashboard plugin's loopback control socket
(127.0.0.1:<port>, token in %LOCALAPPDATA%/vault-remote/control-token, a few ms per call) when
the plugin is loaded, else the Obsidian CLI's `eval`, which runs JS inside the live renderer
(~300ms round trip). Both run the same operations on the same PaneController.
A pane is addressed by a HANDLE: a Claude session uuid, or `leaf:<leafId>` for
any pane (shell seats, other agent CLIs) — leaf ids are stable while the leaf
lives. Actions: focus (revealLeaf + window focus + pane.focus), send (text then
Enter 150ms later = one prompt/command), keys (named key sequences, for
AskUserQuestion menus, Esc, Ctrl-C), screen (the pane's terminal buffer text).

Typing into a pane is the desk keyboard, not a second writer (DL-679/SYS-410).
JS is single-quoted only; text travels as base64; ids are regex-validated.
"""
import base64
import json
import os
import re
import urllib.error
import urllib.request
import shutil
import subprocess
import sys
import time
from pathlib import Path

import vaultpath

REGISTRY = vaultpath.REGISTRY
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
LEAF_RE = re.compile(r"^[0-9a-f]{8,32}$")
MAX_TEXT = 4000
DESK_TTL = 10.0
_desk = (0.0, [])
CONTROL = vaultpath.STATE_DIR / "control-token"
_ctl = {"checked": 0.0, "port": None, "token": None}

KEYS = {"up": "\x1b[A", "down": "\x1b[B", "left": "\x1b[D", "right": "\x1b[C", "enter": "\r", "esc": "\x1b",
        "tab": "\t", "shift-tab": "\x1b[Z", "ctrlc": "\x03", "ctrld": "\x04", "backspace": "\x7f", "space": " "}


def _obsidian() -> str | None:
    exe = shutil.which("obsidian")
    if exe:
        return exe
    for cand in (Path.home() / "AppData/Local/Programs/Obsidian/obsidian.exe",
                 Path.home() / "AppData/Local/Programs/Obsidian/obsidian"):
        if cand.exists():
            return str(cand)
    return None


def uuid_for(n) -> str | None:
    try:
        reg = json.loads(REGISTRY.read_text(encoding="utf-8"))
        u = ((reg.get("sessions") or {}).get(str(n)) or {}).get("uuid")
        return u if u and UUID_RE.match(u) else None
    except Exception:
        return None


def seat_numbers() -> dict:
    """uuid -> session number for every registry row not stamped closed."""
    try:
        reg = json.loads(REGISTRY.read_text(encoding="utf-8"))
    except Exception:
        return {}
    out = {}
    for n, row in (reg.get("sessions") or {}).items():
        if isinstance(row, dict) and str(n).isdigit() and "closed" not in str(row.get("status") or "").lower():
            u = row.get("uuid")
            if u and UUID_RE.match(u):
                out[u] = int(n)
    return out


def _control_cfg() -> tuple[int | None, str | None]:
    """Port + token of the plugin's control socket; re-read at most every 5 s (the plugin
    rewrites the file on every load with a fresh token, and deletes it on unload)."""
    now = time.time()
    if now - _ctl["checked"] > 5:
        _ctl["checked"] = now
        try:
            d = json.loads(CONTROL.read_text(encoding="utf-8"))
            _ctl["port"], _ctl["token"] = int(d["port"]), str(d["token"])
        except Exception:
            _ctl["port"] = _ctl["token"] = None
    return _ctl["port"], _ctl["token"]


def _control(op: str, payload: dict | None = None, timeout: float = 8.0):
    """(ok, result) through the plugin's socket, or None when it is not there (fall back to eval)."""
    port, token = _control_cfg()
    if not port:
        return None
    get = op == "panes"
    url = f"http://127.0.0.1:{port}" + ("/panes" if get else "/op")
    data = None if get else json.dumps(dict(payload or {}, op=op)).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="GET" if get else "POST",
                                 headers={"Content-Type": "application/json", "X-Control-Token": token or ""})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            o = json.loads(r.read())
        return bool(o.get("ok")), o.get("result")
    except urllib.error.HTTPError as e:
        if e.code == 403:
            _ctl["checked"] = 0.0                     # stale token: re-read the file next time
        return None
    except Exception:
        return None


def transport() -> str:
    """'socket' when the plugin's control socket answers, else 'eval'."""
    return "socket" if _control("panes") is not None else "eval"


def _eval(js: str, timeout: float = 25) -> tuple[bool, str]:
    exe = _obsidian()
    if not exe:
        return False, "obsidian CLI not found"
    try:
        r = subprocess.run([exe, "eval", "code=" + js], capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=timeout)
    except subprocess.TimeoutExpired:
        return False, "obsidian eval timed out"
    except Exception as e:
        return False, f"eval failed: {e.__class__.__name__}"
    out = (r.stdout or "") + "\n" + (r.stderr or "")
    for ln in out.splitlines():
        if ln.startswith("=>"):
            return True, ln[2:].strip()
    return False, out.strip()[-300:] or "no result"


def _b64(s: str) -> str:
    return base64.b64encode(s.encode("utf-8")).decode("ascii")


_DECODE = ("function dec(b){return decodeURIComponent(Array.prototype.map.call(atob(b),function(c){"
           "return '%'+('00'+c.charCodeAt(0).toString(16)).slice(-2);}).join(''));}")

# find the leaf by handle: uuid match on pane.sessionUuid, or leaf id
_FIND = ("var H='@H@';var ls=app.workspace.getLeavesOfType('workspace-shell');var L=null;"
         "for(var i=0;i<ls.length;i++){var p=ls[i].view&&ls[i].view.pane;"
         "if(!p){continue;}if((H.indexOf('leaf:')===0&&ls[i].id===H.slice(5))||(p.sessionUuid&&p.sessionUuid===H)){L=ls[i];break;}}"
         "if(!L){return 'no leaf';}var P=L.view.pane;")


def valid_handle(h: str) -> bool:
    return bool(h) and (bool(UUID_RE.match(h)) or (h.startswith("leaf:") and bool(LEAF_RE.match(h[5:]))))


def desk_panes(force: bool = False) -> list[dict]:
    """Every workspace-shell pane on the desk: leaf id, session uuid (Claude only),
    profile, label, cwd, cols."""
    global _desk
    if not force and time.time() - _desk[0] < DESK_TTL:
        return _desk[1]
    c = _control("panes")
    if c is not None:
        ok, lst = c
        panes = [p for p in (lst if ok and isinstance(lst, list) else []) if LEAF_RE.match(str(p.get("leaf") or ""))]
        _desk = (time.time(), panes)
        return panes
    ok, res = _eval("(function(){var ls=app.workspace.getLeavesOfType('workspace-shell');var o=[];"
                    "for(var i=0;i<ls.length;i++){var p=ls[i].view&&ls[i].view.pane;if(!p){continue;}"
                    "o.push({leaf:ls[i].id,uuid:p.sessionUuid||null,profile:(p.getProfileId?p.getProfileId():null),"
                    "label:(p.seatLabel?p.seatLabel():null),cwd:(p.getCwd?p.getCwd():null),"
                    "cols:(p.terminal?p.terminal.cols:null),pty:!!p.ptyProcess});}return JSON.stringify(o);})()")
    panes = []
    if ok:
        try:
            panes = [p for p in json.loads(res) if LEAF_RE.match(str(p.get("leaf") or ""))]
        except Exception:
            panes = []
    _desk = (time.time(), panes)
    return panes


def desk_seats(force: bool = False) -> list[str]:
    return [p["uuid"] for p in desk_panes(force) if p.get("uuid")]


def resume(uuid: str) -> tuple[bool, str]:
    """Reopen a session in a workspace-shell seat on the desk (the plugin's own
    openResumedSeat, the same call the desk dashboard's resume button makes)."""
    global _desk
    if not uuid or not UUID_RE.match(uuid):
        return False, "bad uuid"
    if uuid in desk_seats(force=True):
        return False, "already on the desk"
    c = _control("resume", {"uuid": uuid})
    if c is not None:
        _desk = (0, [])
        return c[0], str(c[1])
    js = ("(function(){var ws=app.plugins.getPlugin('workspace-shell');"
          "if(!ws||!ws.openResumedSeat){return 'workspace-shell not enabled';}"
          "ws.openResumedSeat('" + uuid + "');return 'ok';})()")
    ok, res = _eval(js)
    _desk = (0, [])                                   # the pane list just changed
    return (ok and res == "ok"), res


def new_seat(profile: str = "claude", cwd: str | None = None) -> tuple[bool, str]:
    """Open a fresh Claude seat in a new tab on the desk (s948, "New seat" on the phone and the
    desktop sidebar). The pane shows under "Other panes" until its session number registers."""
    global _desk
    payload: dict = {"profile": profile or "claude"}
    if cwd:
        payload["cwd"] = cwd
    c = _control("new", payload)
    if c is not None:
        _desk = (0, [])
        return c[0], str(c[1])
    js = ("(function(){var ws=app.plugins.getPlugin('workspace-shell');"
          "if(!ws||!ws.openNewSeat){return 'workspace-shell not enabled';}"
          "ws.openNewSeat(" + json.dumps(profile or "claude") + ", undefined, 'tab');return 'ok';})()")
    ok, res = _eval(js)
    _desk = (0, [])
    return (ok and res == "ok"), res


def focus(handle: str) -> tuple[bool, str]:
    if not valid_handle(handle):
        return False, "bad handle"
    c = _control("focus", {"handle": handle})
    if c is not None:
        return c[0], str(c[1])
    js = ("(function(){" + _FIND.replace("@H@", handle) +
          "app.workspace.revealLeaf(L);try{var w=L.view.containerEl.win;if(w&&w.focus){w.focus();}}catch(e){}"
          "try{P.focus();}catch(e){}return 'ok';})()")
    ok, res = _eval(js)
    return (ok and res == "ok"), res


def clean_text(text: str) -> str:
    text = (text or "")[:MAX_TEXT]
    text = re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "", text)
    return " ".join(text.replace("\r\n", "\n").replace("\r", "\n").split("\n")).strip()


def send(handle: str, text: str, dry_run: bool = False, enter: bool = True) -> tuple[bool, str]:
    """Type `text` into the pane; press Enter 150ms later unless enter=False."""
    if not valid_handle(handle):
        return False, "bad handle"
    text = clean_text(text)
    if not text:
        return False, "empty"
    if dry_run:
        return True, f"dry {len(text)}"
    c = _control("send", {"handle": handle, "text": text, "enter": bool(enter)})
    if c is not None:
        return c[0], str(c[1])
    tail = "setTimeout(function(){P.sendText(String.fromCharCode(13));},150);" if enter else ""
    body = ("if(!P.ptyProcess){return 'no pty';}var t=dec('@B@');" +
            ("return 'dry '+t.length;" if dry_run else "P.sendText(t);" + tail + "return 'ok';"))
    js = "(function(){" + _DECODE + _FIND.replace("@H@", handle) + body.replace("@B@", _b64(text)) + "})()"
    ok, res = _eval(js)
    return (ok and (res == "ok" or res.startswith("dry "))), res


def keys(handle: str, key: str) -> tuple[bool, str]:
    """Named key (see KEYS) or `char:<one printable character>`."""
    if not valid_handle(handle):
        return False, "bad handle"
    if key in KEYS:
        seq = KEYS[key]
    elif key.startswith("char:") and len(key) == 6 and key[5].isprintable():
        seq = key[5]
    else:
        return False, "unknown key"
    c = _control("keys", {"handle": handle, "seq": seq})
    if c is not None:
        return c[0], str(c[1])
    body = "if(!P.ptyProcess){return 'no pty';}P.sendKey(dec('@B@'));return 'ok';"
    js = "(function(){" + _DECODE + _FIND.replace("@H@", handle) + body.replace("@B@", _b64(seq)) + "})()"
    ok, res = _eval(js)
    return (ok and res == "ok"), res


def screen(handle: str, rows: int = 45) -> tuple[bool, str]:
    """The last `rows` lines of the pane's terminal buffer, trailing blanks trimmed."""
    if not valid_handle(handle):
        return False, "bad handle"
    rows = max(5, min(200, int(rows)))
    c = _control("screen", {"handle": handle, "rows": rows})
    if c is not None:
        return (c[0], str(c[1])) if c[0] else (False, str(c[1]))
    js = ("(function(){" + _FIND.replace("@H@", handle) +
          "var b=P.terminal&&P.terminal.buffer&&P.terminal.buffer.active;if(!b){return 'no buffer';}"
          "var o=[];var y=Math.max(0,b.length-" + str(rows) + ");for(;y<b.length;y++){var ln=b.getLine(y);"
          "o.push(ln?ln.translateToString(true):'');}while(o.length&&!o[o.length-1].trim()){o.pop();}"
          "return btoa(unescape(encodeURIComponent(o.join(String.fromCharCode(10)))));})()")
    ok, res = _eval(js)
    if not ok or res in ("no leaf", "no buffer"):
        return False, res
    try:
        return True, base64.b64decode(res).decode("utf-8", "replace")
    except Exception:
        return False, "decode failed"


if __name__ == "__main__":
    if sys.stdout:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    a = sys.argv[1:]
    if not a or a[0] == "list":
        print(json.dumps(desk_panes(force=True), indent=1))
    elif a[0] == "focus":
        print(focus(uuid_for(a[1]) or a[1]))
    elif a[0] == "dry":
        print(send(uuid_for(a[1]) or a[1], " ".join(a[2:]), dry_run=True))
    elif a[0] == "send":
        print(send(uuid_for(a[1]) or a[1], " ".join(a[2:])))
    elif a[0] == "keys":
        print(keys(uuid_for(a[1]) or a[1], a[2]))
    elif a[0] == "screen":
        ok, s = screen(uuid_for(a[1]) or a[1], int(a[2]) if len(a) > 2 else 45)
        print(s if ok else f"ERR {s}")
