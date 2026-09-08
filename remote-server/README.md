# The remote app

A phone app (and a desktop page) that shows your vault board and lets you read and message
your Claude seats from anywhere, over your own Tailscale network. Nothing is public and
there is no login inside the app: being on your tailnet is the login. The server in this
folder is started and stopped by the Vault Dashboard plugin; you never run it by hand.

## Setup

Two kinds of step. **You** do the ones that need an account, a phone, or a browser you are
signed into. **Your AI** does everything on the PC: open a Claude seat in your vault and
paste the block. About fifteen minutes end to end.

### 1. You: Tailscale

1. Install Tailscale on the PC and sign in. Install it on your phone and sign in to the
   **same** account.
2. In the admin console at login.tailscale.com, open **DNS** and turn on **MagicDNS** and
   **HTTPS Certificates**. MagicDNS gives the PC a name; HTTPS is what push notifications
   and the home-screen install need.
3. On the PC, open the Tailscale tray app and turn on **Run unattended**, so the
   connection comes back after a reboot without you signing in first.

### 2. You: Obsidian

Under Community plugins, enable **Vault Dashboard** and keep **workspace-shell** enabled:
it provides the seats the app talks to. The plugin starts the server when Obsidian loads
and stops it when Obsidian closes. There is nothing to run by hand.

Two version floors, both checked by the block in the next step: **Vault Dashboard 3.1.0**
(the first version that carries this server) and **system updates v1.10.0** (the first
release that carries `tools/dashboard/`, the generator that builds the board and the
threads the app renders). Older than either and the app has nothing to show.

### 3. Your AI: the PC

Open a Claude seat in your vault and paste this:

```
Set up the remote app's server on this PC.
1. Versions. The vault's .obsidian/plugins/vault-dashboard/manifest.json must say 3.1.0
   or newer: if not, `git pull` in the vault and tell me to restart Obsidian.
   00_System/AI/Claude/tools/system-data.json installed_version must be v1.10.0 or
   newer: if not, run `python tools/apply-update.py --apply` from 00_System/AI/Claude
   and show me anything it held for review.
2. Confirm Python 3.10 or newer is on PATH. If it is not, stop and tell me.
3. pip install psutil pywebpush cryptography pillow
4. Confirm the tailscale CLI is on PATH and `tailscale status` shows the backend Running.
   If it is not, tell me exactly what to click.
5. From <vault>/.obsidian/plugins/vault-dashboard/remote-server run
   `python launch.py --ensure`, then `python launch.py --status`.
6. Give me the https://...ts.net address from the status output. If anything is not
   RUNNING, fix it or tell me precisely what is wrong.
```

What you want back: `remote-app RUNNING`, `tailscale backend=Running`,
`front door proxy -> 127.0.0.1:8378`, and an address. The first certificate can take up
to a minute. That address is the app.

### 4. You: the phone

1. With the phone on Tailscale, open the address in Safari (iPhone) or Chrome (Android).
2. iPhone: tap Share, then **Add to Home Screen**. From now on open it from the icon;
   push notifications only work from the installed app, not from a Safari tab.
3. In the app, open **Settings** and turn on notifications. The default is to notify
   you only when you are away from the PC.

### 5. Desktop browser

The same address works in any browser on a device that is on your tailnet. From 900px
wide you get the sidebar layout: seats on the left, the conversation in the middle.

### Keeping it up to date

After a plugin update, or a reboot that left the app down, paste this into a seat:

```
Check the remote app. First versions: .obsidian/plugins/vault-dashboard/manifest.json
3.1.0 or newer (else `git pull` in the vault, then I restart Obsidian) and
tools/system-data.json installed_version v1.10.0 or newer (else
`python tools/apply-update.py --apply` from 00_System/AI/Claude). Then from
<vault>/.obsidian/plugins/vault-dashboard/remote-server run `python launch.py --status`.
If the server is not RUNNING, the tailscale backend is not Running, or it says NO serve
config, run `python launch.py --ensure` and check status again. Make sure psutil,
pywebpush, cryptography and pillow are installed and current. Report the address and
anything you could not fix.
```

## How to use it

- **Board**: what needs you, overdue work, your seats, live threads.
- **Seats**: every Claude seat open in Obsidian. Tap one to read its conversation and
  message it. Return sends; Shift+Return is a new line. **Back** takes you to Seats.
- **+ New seat**: opens a fresh Claude seat in a new Obsidian tab on the PC. It shows in
  the list once it has a session number.
- **Not on the desk** (folded under Seats): live conversations whose tab was closed.
  Resume reopens one in a seat.
- **…** in the message bar: add a photo, send Escape to the seat, confirm a prompt with
  Enter, read replies aloud.
- **Processes**: the PC's background processes, with Launch and Restart where they exist.
  The remote app's own row has Restart.
- **Settings**: notifications, the Tailscale state, where the server and the vault are.

## Troubleshooting

The commands are for your AI: paste the row into a seat.

| Symptom | Fix |
|---|---|
| The phone shows the connecting screen forever | The phone is not on Tailscale, or the PC's Tailscale is down. Check the phone's Tailscale app, then `python launch.py --status` on the PC. |
| Status says `tailscale backend=NoState` after a reboot | Open the Tailscale tray app, or turn on Run unattended. `python launch.py --ensure` also starts it. |
| Status says `NO serve config` | `python launch.py --ensure` re-adds the front door. |
| Server not running after a plugin reload | `python launch.py --restart`. Errors are in `remote-server/serve-err.log`. |
| Seats page is empty but seats exist in Obsidian | workspace-shell is off, or the plugin's control socket is not up. Reload the Vault Dashboard plugin. |
| Push never arrives | Notifications need the installed home-screen app and the HTTPS front door. Turn them on again in Settings after reinstalling the app. |
| The mic says voice is not installed | Voice is optional. It needs `ffmpeg` and a local dictation worker on the PC. |

Keep the app tailnet-only. Never expose port 8378 with `tailscale funnel` or another
public proxy: its routes type straight into live Claude seats.

---

## Reference

Everything below is for when something is missing or you want to know what the server
touches. Nothing here is a setup step.

### Requirements at a glance

| Item | Notes |
|---|---|
| Windows 10 or 11 | The launcher uses `pythonw.exe` and the Tailscale Windows paths. |
| Obsidian with vault-dashboard 3.1.0+ and workspace-shell | 3.1.0 is the first version carrying this server; workspace-shell provides the seats. |
| System updates v1.10.0+ | The first release carrying `tools/dashboard/`: the generator, the threads, seat state. `python tools/apply-update.py` from `00_System/AI/Claude` brings it in. |
| Python 3.10+ | Plus `psutil`, `pywebpush`, `cryptography`, `pillow`. |
| Tailscale | Both devices, same account, MagicDNS and HTTPS certificates on. |
| The vault system | The server renders the vault's dashboard data and runs its generator (`tools/dashboard/`); `git` and the `claude` CLI are used by that generator and are part of every vault-system install. |

### Modules in this folder

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

### The vault it runs against

The server does not hold data. It renders what the vault's dashboard layer derives, and it
**runs that layer itself** on every page refresh:

| Vault path (under `00_System/AI/Claude/`) | Who uses it | Required? |
|---|---|---|
| `tools/dashboard/dashboard_data.py` | `serve_tailnet.refresh()` executes it (`python dashboard_data.py`) to regenerate the data file; it is the data source, not a viewer detail. | **Yes.** Without it the app shows stale or no data. |
| `tools/dashboard/seat_state.py` (+ `threads.py`, `arcs.py`, `deltas.py`, `triage.py`, `v5.py`, `arc_ledger.py`, `actors.py`) | Imported by the generator; `seat_state` also directly by the server for live seat state. | **Yes** (they ship with `tools/dashboard/`). |
| `tools/dashboard/actors.json`, `repos.json` | Names that route board rows to THEM / ASK; your dev repos per lane for repo motion. | Optional, operator-local: not shipped. The generator runs with empty defaults; add your own to get those two features. |
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

### Obsidian plugins

| Plugin | Role | Without it |
|---|---|---|
| **vault-dashboard** (this repo) | Starts and stops the server; the loopback control socket (`127.0.0.1:8379`, token in `%LOCALAPPDATA%\vault-remote\control-token`) that every desk operation goes through. | Nothing starts. Run `launch.py --ensure` by hand and the desk falls back to the `obsidian` CLI. |
| **workspace-shell** | The seats: Claude terminals in Obsidian tabs. Send, keys, screen, focus, resume and New seat all act on its panes. | Pages render, but the Seats tab has no desk seats to act on: every live transcript folds under "Not on the desk" and messaging is impossible. |

### Programs on PATH

| Program | Used by | Required? |
|---|---|---|
| `python` 3.10+ (Windows: `pythonw.exe` beside it) | Everything; the server runs under `pythonw` so it has no console. | **Yes.** |
| `tailscale` | `launch.py`: backend state, `tailscale serve --bg 8378`, the app's URL. | **Yes** for any device other than the PC itself. The server still answers on loopback without it. |
| `git` | The generator: repo activity per seat, arc ledger, roadmap history. | **Yes** for the generator (it is on every vault-system install). |
| `claude` (Claude Code CLI) | `arc_ledger.py` mines a closed session with `claude -p` when the board first sees it. | Present on every vault-system install; a missing binary makes that one ingest fail and log, the board still renders. |
| `obsidian` (Obsidian CLI) | `seat_bridge` fallback when the control socket is down. | Optional. |
| `node` | `/desk` render. | Optional, operator-only. |
| `ffmpeg` | Voice: decodes the phone's clip to 16 kHz WAV. | Optional. |

### Python packages

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

### Runtime state (never in the vault)

`%LOCALAPPDATA%\vault-remote\`: push subscriptions, VAPID private key, notification
preferences, the plugin's control token, voice clips and logs. In this folder, gitignored
and excluded from the buyer channel: `serve.pid`, `serve-err.log`, `shots/`,
`voice-config.json`, `index.html`, `__pycache__/`.

### Posture

Loopback bind only, HTTPS and tailnet identity from `tailscale serve`, no auth inside the
app. Never expose the port with `tailscale funnel` or another public proxy; the routes type
straight into live Claude seats.
