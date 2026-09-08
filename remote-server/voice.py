"""Voice mode for the phone (SYS-497, session 942): a clip recorded on the phone becomes text
on the box.

ffmpeg decodes whatever the phone recorded (audio/mp4 on iOS, webm/opus elsewhere) to 16 kHz
mono WAV; tools/dictation's transcribe_worker.py (faster-whisper on CUDA, one process per warm
window, `--idle-exit`) turns it into text. The phone primes a worker on mic press so the model
loads while the operator talks; a second dictation inside the idle window skips the load.
Audio never leaves the tailnet, clips are deleted after decoding, the WAV after transcribing.

Config: voice-config.json next to this file if present, else tools/dictation/config.json (model,
device, compute_type). Worker stderr + this module's notes go to %LOCALAPPDATA%/vault-remote/voice.log.
"""
from __future__ import annotations

import base64
import json
import os
import queue
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

import vaultpath

HERE = Path(__file__).resolve().parent
DICTATION = vaultpath.TOOLS / "dictation"      # operator-side; absent on a buyer install -> voice reports "not installed"
WORKER = DICTATION / "transcribe_worker.py"
CONFIG = HERE / "voice-config.json" if (HERE / "voice-config.json").exists() else DICTATION / "config.json"
STATE_DIR = vaultpath.STATE_DIR
CLIP_DIR = STATE_DIR / "voice"
LOG = STATE_DIR / "voice.log"
IDLE_EXIT = 90                      # seconds a loaded worker waits for another clip before exiting
MAX_CLIP = 12 * 1024 * 1024         # decoded clip bytes; ~2 min of AAC at phone bitrates is well under
JOB_TIMEOUT = 150                   # cold load (~28 s on medium.en/CUDA) + transcribe, with margin
EXT_BY_MIME = {"audio/mp4": "m4a", "audio/aac": "aac", "audio/webm": "webm", "audio/ogg": "ogg",
               "audio/wav": "wav", "audio/x-wav": "wav", "audio/mpeg": "mp3", "audio/3gpp": "3gp"}


def _log(msg: str) -> None:
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        with LOG.open("a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} voice: {msg}\n")
    except OSError:
        pass


def _python() -> str:
    # the server runs under pythonw; the worker needs a real stdout pipe, so the console sibling
    # (CREATE_NO_WINDOW comes from win_console.suppress_child_windows in the server, DL-457)
    exe = Path(sys.executable)
    cand = exe.with_name("python.exe")
    return str(cand) if cand.exists() else str(exe)


class Worker:
    """At most one transcribe_worker.py alive; jobs are serialised."""

    def __init__(self) -> None:
        self.proc: subprocess.Popen | None = None
        self.ready = threading.Event()
        self.results: queue.Queue = queue.Queue()
        self.load_sec: float | None = None
        self.started = 0.0
        self.spawn_lock = threading.Lock()
        self.job_lock = threading.Lock()

    def alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def state(self) -> str:
        if not self.alive():
            return "cold"
        return "ready" if self.ready.is_set() else "loading"

    def prime(self) -> str:
        with self.spawn_lock:
            if not self.alive():
                self._spawn()
            return self.state()

    def _spawn(self) -> None:
        if not WORKER.exists():
            raise FileNotFoundError(str(WORKER))
        self.ready.clear()
        self.results = queue.Queue()
        self.load_sec = None
        self.started = time.time()
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        err = open(LOG, "ab")
        self.proc = subprocess.Popen(
            [_python(), str(WORKER), "--config", str(CONFIG), "--idle-exit", str(IDLE_EXIT)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=err, cwd=str(DICTATION))
        _log(f"worker spawned pid={self.proc.pid} config={CONFIG.name}")
        threading.Thread(target=self._read, args=(self.proc, self.results), daemon=True).start()

    def _read(self, proc: subprocess.Popen, out: queue.Queue) -> None:
        for raw in proc.stdout:                          # type: ignore[union-attr]
            try:
                o = json.loads(raw.decode("utf-8", "replace"))
            except Exception:
                continue
            if o.get("ready"):
                self.load_sec = o.get("load_sec")
                self.ready.set()
            else:
                out.put(o)
        out.put(None)
        _log(f"worker pid={proc.pid} exited rc={proc.poll()}")

    def transcribe(self, wav: Path, timeout: float = JOB_TIMEOUT) -> dict:
        with self.job_lock:
            with self.spawn_lock:
                if not self.alive():
                    self._spawn()
                proc, results = self.proc, self.results
            t0 = time.time()
            if not self.ready.wait(timeout):
                return {"ok": False, "error": "the speech model is still loading"}
            try:
                proc.stdin.write((json.dumps({"audio": str(wav)}) + "\n").encode("utf-8"))   # type: ignore[union-attr]
                proc.stdin.flush()                                                           # type: ignore[union-attr]
            except Exception as e:
                return {"ok": False, "error": f"worker pipe: {e.__class__.__name__}"}
            try:
                o = results.get(timeout=max(5.0, timeout - (time.time() - t0)))
            except queue.Empty:
                return {"ok": False, "error": "transcription timed out"}
            if o is None:
                return {"ok": False, "error": "the speech worker exited"}
            o.setdefault("load_sec", self.load_sec)
            return o


WORKER_PROC = Worker()


def transcribe_clip(body: dict) -> dict:
    """{data_b64, mime} from the phone -> {ok, text, secs, load_sec} (or {ok: False, error})."""
    if not WORKER.exists():
        return {"ok": False, "error": "voice not installed on the desk (tools/dictation is missing)"}
    raw_b64 = str(body.get("data_b64") or "").split(",", 1)[-1]
    try:
        raw = base64.b64decode(raw_b64)
    except Exception:
        return {"ok": False, "error": "bad audio data"}
    if not raw:
        return {"ok": False, "error": "empty clip"}
    if len(raw) > MAX_CLIP:
        return {"ok": False, "error": "clip too large"}
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return {"ok": False, "error": "ffmpeg not on PATH"}
    mime = str(body.get("mime") or "").split(";", 1)[0].strip().lower()
    ext = EXT_BY_MIME.get(mime, "bin")
    CLIP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S") + f"-{int(time.time() * 1000) % 1000:03d}"
    clip = CLIP_DIR / f"{stamp}.{ext}"
    wav = CLIP_DIR / f"{stamp}.wav"
    t0 = time.time()
    try:
        clip.write_bytes(raw)
        r = subprocess.run([ffmpeg, "-y", "-loglevel", "error", "-i", str(clip), "-ac", "1", "-ar", "16000",
                            "-f", "wav", str(wav)], capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=60)
        if r.returncode != 0 or not wav.exists():
            _log(f"ffmpeg failed on {clip.name} ({mime}): {(r.stderr or '').strip()[-200:]}")
            return {"ok": False, "error": "could not decode the recording"}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "decode timed out"}
    finally:
        try:
            clip.unlink()
        except OSError:
            pass
    res = WORKER_PROC.transcribe(wav)          # the worker deletes the wav after loading it
    try:
        if wav.exists():
            wav.unlink()
    except OSError:
        pass
    res["secs"] = round(time.time() - t0, 1)
    _log(f"{len(raw)} bytes {mime or '?'} -> ok={res.get('ok')} in {res['secs']}s"
         + (f" text={str(res.get('text'))[:80]!r}" if res.get("ok") else f" error={res.get('error')}"))
    return res


if __name__ == "__main__":                      # python voice.py clip.m4a  -> transcript
    p = Path(sys.argv[1])
    b64 = base64.b64encode(p.read_bytes()).decode("ascii")
    print(json.dumps(transcribe_clip({"data_b64": b64, "mime": "audio/" + ("mp4" if p.suffix in (".m4a", ".mp4") else p.suffix[1:])}), indent=1))
