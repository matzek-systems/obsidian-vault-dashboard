# remote-server

The phone app's server. Python, stdlib HTTP, one detached process on `127.0.0.1:8378`
that the vault-dashboard plugin starts on load and stops on unload (`launch.py`). The
buyer setup guide is the repo's top-level `README.md`; this file is the dependency map:
everything the server needs, what each piece is for, and what happens without it.

## Modules in this folder

| File | Role |
|---|---|
| `serve_tailnet.py` | The HTTP server: routes, service worker, push, uploads, voice, restart. |
| `phone_render.py` | Every page (board, seats, seat chat, pane, thread, WI, processes, settings) from `dashboard-data.json`; phone layout plus the desktop sidebar layout. |
| `feed.py` | A session transcript (JSONL) to chat turns, with a byte cursor for polling; markdown-lite. |
| `seat_bridge.py` | Desk operations (panes, focus, send, keys, screen, resume, new seat) through the plugin's control socket, falling back to the `obsidian` CLI. |
| `launch.py` | Lifecycle (`--ensure / --restart / --stop / --status`), Tailscale front door, push status. |
| `voice.py` | Optional voice clip to text through a local dictation worker. |
| `vaultpath.py` | The one place the vault is resolved: `VAULT_PATH` env, else walk up from this file. Every other module imports it. |
| `shot.py` | Dev only: phone-viewport screenshots (Playwright). Not needed at runtime. |

## The vault it runs against

The server does not hold data. It renders what the vault's dashboard layer derives, and it
**runs that layer itself** on every page refresh:

| Vault path (under `00_System/AI/Claude/`) | Who uses it | Required? |
|---|---|---|
| `tools/dashboard/dashboard_data.py` | `serve_tailnet.refresh()` executes it (`python dashboard_data.py`) to regenerate the data file; it is the data source, not a viewer detail. | **Yes.** Without it the app shows stale or no data. |
| `tools/dashboard/seat_state.py` (+ `threads.py`, `arcs.py`, `deltas.py`, `triage.py`, `v5.py`, `arc_ledger.py`, `actors.py`, `actors.json`, `repos.json`) | Imported by the generator; `seat_state` also directly by the server for live seat state. | **Yes** (they ship with `tools/dashboard/`). |
| `tools/win_console.py` | Keeps child processes windowless under `pythonw` (DL-457). | Soft: `try` import, silently skipped. |
| `tools/registry_lock.py` | The arc ledger's registry writes. | Yes, via the generator. |
| `tools/wi_calendar.py` | Leverage scores and the Q2 pool on the board. | Yes, via the generator. |
| `tools/graph_client.py` | Outlook week on the board. | Optional, operator-only: lazy import inside `try`; the week panel is empty without it. |
| `tools/process-status-collector.py` | Writes `process-status.json`, which the Processes page reads. Run it from the plugin's Processes view (`--daemon`). | Optional: Processes page says the status file is missing. |
| `tools/render-preview.mjs` (repo source tree only) | The `/desk` board render, via `node`. | Optional, operator-only: `/desk` says "no render yet". |
| `tools/dictation/` | Voice (`transcribe_worker.py`, faster-whisper). | Optional, operator-only: the mic reports "voice not installed". |
| `System Operations/state/dashboard-data.json` | The rendered data file (generator output). | Created by the generator. |
| `System Operations/state/process-status.json` | Processes page. | Optional (collector). |
| `System Operations/session-registry.json` | Seat number to session UUID mapping (`seat_bridge`), transcript paths for `feed.py`. | **Yes.** The vault system's `/startup` maintains it. |
| `Roadmaps/*.md` | Read by the generator for WIs, overdue, threads. | Yes. |
| `01_Inbox/phone-uploads/` | Photos from the phone land here. | Created on first upload. |

Also read: the Claude Code session transcripts (`~/.claude/projects/**/*.jsonl`), located
through the session registry, for the seat chat and live seat state.

## Obsidian plugins

| Plugin | Role | Without it |
|---|---|---|
| **vault-dashboard** (this repo) | Starts and stops the server; the loopback control socket (`127.0.0.1:8379`, token in `%LOCALAPPDATA%\vault-remote\control-token`) that every desk operation goes through. | Nothing starts. Run `launch.py --ensure` by hand and the desk falls back to the `obsidian` CLI. |
| **workspace-shell** | The seats: Claude terminals in Obsidian tabs. Send, keys, screen, focus, resume and New seat all act on its panes. | Pages render, but the Seats tab has no desk seats to act on: every live transcript folds under "Not on the desk" and messaging is impossible. |

## Programs on PATH

| Program | Used by | Required? |
|---|---|---|
| `python` 3.10+ (Windows: `pythonw.exe` beside it) | Everything; the server runs under `pythonw` so it has no console. | **Yes.** |
| `tailscale` | `launch.py`: backend state, `tailscale serve --bg 8378`, the app's URL. | **Yes** for any device other than the PC itself. The server still answers on loopback without it. |
| `git` | The generator: repo activity per seat, arc ledger, roadmap history. | **Yes** for the generator (it is on every vault-system install). |
| `claude` (Claude Code CLI) | `arc_ledger.py` mines a closed session with `claude -p` when the board first sees it. | Present on every vault-system install; a missing binary makes that one ingest fail and log, the board still renders. |
| `obsidian` (Obsidian CLI) | `seat_bridge` fallback when the control socket is down. | Optional. |
| `node` | `/desk` render. | Optional, operator-only. |
| `ffmpeg` | Voice: decodes the phone's clip to 16 kHz WAV. | Optional. |

## Python packages

```
pip install psutil pywebpush cryptography pillow
```

| Package | Used by | Without it |
|---|---|---|
| `psutil` | `launch.py`: find, stop and report the server process; Tailscale tray detection. | `--stop` and `--restart` cannot find the process and `--status` reports it unknown. Treat as required. |
| `pywebpush` (pulls `py-vapid`, `cryptography`) | Push notifications: VAPID key, sending. Imported lazily. | Pages work; enabling notifications fails. |
| `pillow` | Generates `icon-180.png` / `icon-192.png` when they are absent. Both ship in this folder, so it is only needed after deleting them. | Nothing, as long as the PNGs are present. |
| `playwright` + Chromium | `shot.py` only (dev). | Nothing at runtime. |

The generator (`tools/dashboard/`) is stdlib plus `git`; the vault system's own `tools/`
requirements cover it.

## Runtime state (never in the vault)

`%LOCALAPPDATA%\vault-remote\`: push subscriptions, VAPID private key, notification
preferences, the plugin's control token, voice clips and logs. In this folder, gitignored
and excluded from the buyer channel: `serve.pid`, `serve-err.log`, `shots/`,
`voice-config.json`, `index.html`, `__pycache__/`.

## Posture

Loopback bind only, HTTPS and tailnet identity from `tailscale serve`, no auth inside the
app. Never expose the port with `tailscale funnel` or another public proxy; the routes type
straight into live Claude seats.
