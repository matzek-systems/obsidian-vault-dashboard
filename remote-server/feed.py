"""Conversation feed for a Claude seat: JSONL transcript -> chat turns, with a
byte cursor so the phone polls only what's new.

read(jp, since=None) -> {"entries": [...], "offset": int, "size": int}
  since=None : the tail (TAIL bytes), first (cut) line skipped, last MAX_FIRST entries
  since=N    : everything appended after byte N, whole lines only

entry: {"k": "you|seat|tool|result|note|end", "t": text, "n": tool name, "a": arg
        summary, "ts": "HH:MM", "ms": turn ms}
"""
import html
import json
import re
from datetime import datetime

TAIL = 200_000
MAX_FIRST = 80
SEAT_MAX = 8000
YOU_MAX = 3000
RESULT_MAX = 500
THINK_MAX = 2000
ARG_MAX = 160
ARG_KEYS = ("file_path", "path", "command", "pattern", "query", "url", "skill", "description", "prompt", "text", "message")
_WANT = ('"type":"user"', '"type":"assistant"', '"type":"system"', '"type": "user"', '"type": "assistant"', '"type": "system"')
_CMD = re.compile(r"<command-name>(.*?)</command-name>(?:\s*<command-message>.*?</command-message>)?(?:\s*<command-args>(.*?)</command-args>)?", re.S)
_STDOUT = re.compile(r"<local-command-stdout>(.*?)</local-command-stdout>", re.S)


def _ts(o) -> str:
    t = o.get("timestamp") or ""
    try:
        return datetime.fromisoformat(t.replace("Z", "+00:00")).astimezone().strftime("%H:%M")
    except Exception:
        return ""


def _blocks_text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(str(b.get("text") or "") for b in content if isinstance(b, dict) and b.get("type") == "text")
    return ""


def _arg(inp) -> str:
    if not isinstance(inp, dict):
        return ""
    for k in ARG_KEYS:
        v = inp.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip().replace("\n", " ")[:ARG_MAX]
    for v in inp.values():
        if isinstance(v, str) and v.strip():
            return v.strip().replace("\n", " ")[:ARG_MAX]
    return ""


_FENCE = re.compile(r"```[A-Za-z0-9_+-]*\n(.*?)```", re.S)
_CODE = re.compile(r"`([^`\n]+)`")
_BOLD = re.compile(r"\*\*(.+?)\*\*", re.S)
_EM1 = re.compile(r"(?<![\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\w*])")
_EM2 = re.compile(r"(?<!\w)_(?!\s)([^_\n]+?)(?<!\s)_(?!\w)")
_LINK = re.compile(r"\[([^\]\n]+)\]\((https?://[^)\s]+)\)")
_HEAD = re.compile(r"^(#{1,6})\s+(.*)$")
_BULLET = re.compile(r"^(\s*)[-*]\s+(.*)$")
_TSEP = re.compile(r"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$")   # | --- | --- |


def _cells(ln: str) -> list[str]:
    ln = ln.strip().replace("\\|", "\x01")
    if ln.startswith("|"):
        ln = ln[1:]
    if ln.endswith("|"):
        ln = ln[:-1]
    return [c.strip().replace("\x01", "|") for c in ln.split("|")]


def _tables(lines: list[str]) -> list[str]:
    """A pipe table (header row, separator row, body rows) becomes one <table> line; the
    bubble is pre-wrap, so the rows must not stay as newline-separated text (s948, phone)."""
    out, i = [], 0
    while i < len(lines):
        ln = lines[i]
        if ln.lstrip().startswith("|") and i + 1 < len(lines) and _TSEP.match(lines[i + 1]):
            head = _cells(ln)
            j = i + 2
            rows = []
            while j < len(lines) and lines[j].lstrip().startswith("|"):
                rows.append(_cells(lines[j]))
                j += 1
            t = "<table class=\"md\"><thead><tr>" + "".join(f"<th>{c}</th>" for c in head) + "</tr></thead><tbody>"
            for r in rows:
                r = (r + [""] * len(head))[:len(head)]
                t += "<tr>" + "".join(f"<td>{c}</td>" for c in r) + "</tr>"
            out.append(t + "</tbody></table>")
            i = j
            continue
        out.append(ln)
        i += 1
    return out


def _esc(s: str) -> str:
    return html.escape(s, quote=False)


def _inline(s: str) -> str:
    s = _esc(s)
    codes: list[str] = []

    def _keep(m):
        codes.append("<code>" + m.group(1) + "</code>")
        return f"\x00{len(codes) - 1}\x00"
    s = _CODE.sub(_keep, s)
    s = _BOLD.sub(r"<strong>\1</strong>", s)
    s = _EM1.sub(r"<em>\1</em>", s)
    s = _EM2.sub(r"<em>\1</em>", s)
    s = _LINK.sub(r'<a href="\2" target="_blank" rel="noopener">\1</a>', s)
    lines = []
    for ln in s.split("\n"):
        m = _HEAD.match(ln)
        if m:
            ln = f'<strong class="hd">{m.group(2)}</strong>'
        else:
            m = _BULLET.match(ln)
            if m:
                ln = f"{m.group(1)}\u2022 {m.group(2)}"
        lines.append(ln)
    s = "\n".join(_tables(lines))
    return re.sub("\x00(\\d+)\x00", lambda m: codes[int(m.group(1))], s)


def md(text: str) -> str:
    """Markdown-lite -> safe HTML for a seat turn (the phone renders it in a pre-wrap bubble):
    fences, inline code, bold, italic, links, headings as bold lines, bullets as dots."""
    parts, pos = [], 0
    for m in _FENCE.finditer(text):
        parts.append(_inline(text[pos:m.start()].rstrip("\n")))
        parts.append('<pre class="code">' + _esc(m.group(1).rstrip("\n")) + "</pre>")
        pos = m.end()
        if text[pos:pos + 1] == "\n":
            pos += 1
    parts.append(_inline(text[pos:]))
    return "".join(parts)


def _first_line(s: str, n: int = 90) -> str:
    for ln in s.splitlines():
        if ln.strip():
            return ln.strip()[:n]
    return ""


def _tool_name(name: str) -> str:
    if name.startswith("mcp__"):
        parts = name.split("__")
        return f"{parts[1]}:{parts[-1]}" if len(parts) >= 3 else name
    return name


def _ask(inp) -> list[dict]:
    """AskUserQuestion input -> [{q, h, multi, o: [{l, d}]}], capped (s942: the phone renders
    the choices as buttons; a tap becomes key presses into the pane)."""
    out = []
    qs = inp.get("questions") if isinstance(inp, dict) else None
    for q in (qs or [])[:4]:
        if not isinstance(q, dict):
            continue
        opts = [{"l": str(o.get("label") or "")[:80], "d": str(o.get("description") or "")[:200]}
                for o in (q.get("options") or [])[:6] if isinstance(o, dict)]
        out.append({"q": str(q.get("question") or "")[:400], "h": str(q.get("header") or "")[:24],
                    "multi": bool(q.get("multiSelect")), "o": opts})
    return out


def entries_from(o: dict) -> list[dict]:
    t = o.get("type")
    ts = _ts(o)
    out = []
    if t == "user":
        if o.get("isSidechain"):
            return out
        msg = o.get("message") or {}
        content = msg.get("content")
        if isinstance(content, str):
            content = [{"type": "text", "text": content}]
        for b in content or []:
            if not isinstance(b, dict):
                continue
            if b.get("type") == "tool_result":
                txt = _blocks_text(b.get("content"))
                if txt.strip():
                    out.append({"k": "result", "t": txt.strip()[:RESULT_MAX], "s": _first_line(txt), "ts": ts, "more": len(txt) > RESULT_MAX,
                                "for": b.get("tool_use_id")})
            elif b.get("type") == "text":
                txt = str(b.get("text") or "").strip()
                if not txt:
                    continue
                if txt.startswith("This session is being continued"):
                    out.append({"k": "note", "t": "context compacted", "ts": ts})
                elif txt.startswith("<command-name>"):
                    m = _CMD.search(txt)
                    if m:
                        out.append({"k": "you", "t": (m.group(1) + " " + (m.group(2) or "")).strip()[:YOU_MAX], "ts": ts, "cmd": True})
                elif txt.startswith("<local-command-stdout>"):
                    m = _STDOUT.search(txt)
                    if m and m.group(1).strip():
                        out.append({"k": "result", "t": m.group(1).strip()[:RESULT_MAX], "s": _first_line(m.group(1)), "ts": ts})
                elif txt.startswith("<") or o.get("isMeta"):
                    continue                      # system reminders, injected context, hook output
                elif txt.startswith("Another Claude session") or txt.startswith("[teammate"):
                    out.append({"k": "note", "t": txt[:200], "ts": ts})
                else:
                    out.append({"k": "you", "t": txt[:YOU_MAX], "ts": ts})
    elif t == "assistant":
        if o.get("isSidechain"):
            return out
        for b in (o.get("message") or {}).get("content") or []:
            if not isinstance(b, dict):
                continue
            if b.get("type") == "text" and str(b.get("text") or "").strip():
                txt = str(b["text"]).strip()[:SEAT_MAX]
                out.append({"k": "seat", "t": txt, "h": md(txt), "ts": ts})
            elif b.get("type") == "tool_use":
                e = {"k": "tool", "n": _tool_name(str(b.get("name") or "")), "a": _arg(b.get("input")), "ts": ts, "id": b.get("id")}
                if b.get("name") == "AskUserQuestion":
                    e["ask"] = _ask(b.get("input"))
                out.append(e)
            elif b.get("type") == "thinking" and str(b.get("thinking") or "").strip():
                txt = str(b["thinking"]).strip()[:THINK_MAX]      # empty/redacted thinking blocks are skipped
                out.append({"k": "think", "t": txt, "h": md(txt), "s": _first_line(txt), "ts": ts})
    elif t == "system" and o.get("subtype") == "turn_duration":
        out.append({"k": "end", "ms": o.get("durationMs"), "ts": ts})
    return out


def _parse(text: str, skip_first: bool) -> list[dict]:
    out = []
    lines = text.split("\n")
    if skip_first:
        lines = lines[1:]
    for ln in lines:
        if not ln.startswith("{") or not any(w in ln for w in _WANT):
            continue
        try:
            o = json.loads(ln)
        except Exception:
            continue
        out.extend(entries_from(o))
    return out


TAIL_STEPS = (TAIL, 2_000_000, 8_000_000)
MIN_FIRST = 20


def _read_span(jp: str, start: int) -> tuple[bytes, int]:
    with open(jp, "rb") as f:
        f.seek(0, 2)
        size = f.tell()
        f.seek(min(start, size))
        return f.read(), size


def read(jp: str, since=None) -> dict:
    if since is not None and since >= 0:
        raw, size = _read_span(jp, since)
        if since > size:                      # file shrank/rotated: restart from the tail
            return read(jp, None)
        cut = raw.rfind(b"\n")
        if cut < 0:
            return {"entries": [], "offset": since, "size": size}
        return {"entries": _parse(raw[:cut + 1].decode("utf-8", "replace"), False), "offset": since + cut + 1, "size": size}
    # first load: widen the tail until enough turns are in view (image blocks in
    # tool results can make 200KB hold a handful of entries)
    entries, offset, size = [], 0, 0
    for tail in TAIL_STEPS:
        with open(jp, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
        start = max(0, size - tail)
        raw, size = _read_span(jp, start)
        cut = raw.rfind(b"\n")
        if cut < 0:
            return {"entries": [], "offset": start, "size": size}
        entries = _parse(raw[:cut + 1].decode("utf-8", "replace"), start > 0)
        offset = start + cut + 1
        if len(entries) >= MIN_FIRST or start == 0:
            break
    return {"entries": entries[-MAX_FIRST:], "offset": offset, "size": size}
