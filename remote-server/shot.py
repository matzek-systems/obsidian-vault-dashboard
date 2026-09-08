"""Phone-viewport screenshots of the remote app (iPhone 14, 390x844, light + dark).

  python shot.py                 all pages below -> shots/<name>-<scheme>.png
  python shot.py shell home      a subset

The three "shell" captures exercise the connecting screen's states by intercepting /health:
  shell-noroute  -> /health aborted (tunnel down)      shell-gateway -> /health 502 (server down)
  shell-swap     -> /shell loads, fetches the real page, document.write swaps it in (proves the swap)
Output dir is gitignored (shots/). Needs playwright + chromium, and the server on :8378.
"""
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
OUT = HERE / "shots"
BASE = "http://127.0.0.1:8378"
PAGES = {
    "home": "/", "seats": "/seats", "processes": "/processes", "settings": "/setup", "desk": "/desk",
    "shell-noroute": "/shell", "shell-gateway": "/shell", "shell-swap": "/shell",
}


def main(names):
    OUT.mkdir(exist_ok=True)
    with sync_playwright() as p:
        b = p.chromium.launch()
        for name in names:
            path = PAGES.get(name) or (name if name.startswith("/") else None)   # any /path works too
            if not path:
                raise SystemExit(f"unknown page {name}")
            name = PAGES.get(name) and name or "p" + path.strip("/").replace("/", "-")
            for scheme in ("light", "dark"):
                ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, color_scheme=scheme)
                pg = ctx.new_page()
                if name == "shell-noroute":
                    pg.route("**/health", lambda r: r.abort("connectionfailed"))
                elif name == "shell-gateway":
                    pg.route("**/health", lambda r: r.fulfill(status=502, body="bad gateway"))
                pg.goto(BASE + path, wait_until="load")
                if name.startswith("shell-") and name != "shell-swap":
                    time.sleep(3.2)                      # into try 2 so the hint text is showing
                elif name == "shell-swap":
                    pg.wait_for_selector(".top h1", timeout=20000)   # the real page replaced the shell
                    time.sleep(0.4)
                else:
                    time.sleep(0.6)
                pg.screenshot(path=str(OUT / f"{name}-{scheme}.png"), full_page=False)
                ctx.close()
        b.close()
    print("shots ->", OUT, ":", ", ".join(names))


if __name__ == "__main__":
    main(sys.argv[1:] or list(PAGES))
