# Vault Dashboard

An Obsidian plugin for the vault system: the operator board (attention, threads, seats,
overdue work), a Processes view, and the **remote app**, a phone-sized web app that shows
the same board and lets you read and message your Claude seats from anywhere on your
tailnet. The plugin ships to vault buyers through the vault update channel; this README
is the setup guide for the remote app.

## What the remote app is

- A small Python server (`remote-server/` inside this plugin's folder) that the plugin
  starts when Obsidian loads and stops when it unloads. It listens on `127.0.0.1:8378`.
- Tailscale puts an HTTPS front door on it: `https://<your-pc>.<your-tailnet>.ts.net`.
  Only devices signed in to **your** Tailscale account can reach it. Nothing is public.
- On the phone it installs as a home-screen app (PWA) with push notifications when a
  seat needs you.
- Desktop browsers get a sidebar layout (seats list, New seat, Board / Processes /
  Settings); phones get the tab bar.

There is no login inside the app. The tailnet **is** the login, so never expose the port
with `tailscale funnel` or any other public proxy.

## Requirements (the PC that runs Obsidian)

| Item | Notes |
|---|---|
| Windows 10/11 | The launcher uses `pythonw.exe` and the Tailscale Windows paths. |
| Obsidian with **vault-dashboard 3.1.0+** and **workspace-shell** | workspace-shell provides the seats (Claude terminals in Obsidian tabs); the remote app reads and drives those. |
| Python 3.10+ on PATH | `python --version` in a terminal must work. |
| Python packages | `pip install psutil pywebpush cryptography pillow` |
| Tailscale | Desktop app on the PC, mobile app on the phone, same account. |

Optional: `ffmpeg` on PATH plus a dictation worker enables voice messages. Without them
the microphone button reports that voice is not installed and everything else works.

## Setup

### 1. Tailscale

1. Install Tailscale on the PC and sign in. Install it on your phone and sign in to the
   **same** account.
2. In the Tailscale admin console (login.tailscale.com), open **DNS** and make sure
   **MagicDNS** is on and **HTTPS Certificates** is enabled. The app needs both: MagicDNS
   gives the PC a name, and HTTPS is required for push notifications and the home-screen
   install.
3. Recommended: in the PC's Tailscale tray app, turn on **Run unattended**, so the
   backend comes back after a reboot even before you sign in to Windows.

### 2. Python packages

```
pip install psutil pywebpush cryptography pillow
```

### 3. Turn the plugin on

Enable **Vault Dashboard** in Obsidian's Community plugins. In its settings:

- **Remote server** is on by default. Turning it off stops the server.
- **Python command** is `python` by default. Set it to a full path if your Python is not
  on PATH.

When the plugin loads it starts the server about two seconds later. The first start also
runs `tailscale serve --bg 8378` for you, which registers the HTTPS front door. The first
certificate can take up to a minute to issue.

### 4. Check it

Open a terminal in the plugin folder
(`<your vault>/.obsidian/plugins/vault-dashboard/remote-server`) and run:

```
python launch.py --status
```

You should see `remote-app RUNNING`, your `https://...ts.net` URL, `tailscale
backend=Running`, and `front door proxy -> 127.0.0.1:8378`. If the backend is not
Running, open the Tailscale tray app; `python launch.py --ensure` starts it for you when
it can.

### 5. The phone

1. Open the URL from step 4 in Safari (iPhone) or Chrome (Android) while the phone is on
   Tailscale.
2. iPhone: Share, then **Add to Home Screen**. Open the app from the icon from now on.
   Push notifications only work from the installed app, not from the Safari tab.
3. In the app, open **Settings** and turn on notifications. Pick when you want to be
   pushed (only when away from the PC is the default).

### 6. Desktop browser

The same URL works in any browser on a tailnet device. At 900px and wider you get the
sidebar layout.

## Using it

- **Board**: what needs you, overdue work, your seats, live threads.
- **Seats**: every Claude seat open on the desk. Tap one to read its transcript and
  message it. **Back** returns to Seats. **+ New seat** opens a fresh Claude seat in a new
  Obsidian tab on the PC; it appears in the list once it has a session number.
- **Not on the desk** (folded under Seats): live transcripts whose tab was closed. Resume
  reopens one in a seat.
- **Processes**: the PC's background processes, with Launch / Restart where a launcher
  exists. The remote app's own row has Restart.
- **Settings**: notifications, the Tailscale state, the server's path and vault.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Phone shows the connecting screen forever | Phone not on Tailscale, or the PC's Tailscale backend is down. Check the phone's Tailscale app, then `python launch.py --status` on the PC. |
| `tailscale backend=NoState` after a reboot | Open the Tailscale tray app (or enable Run unattended). `python launch.py --ensure` also starts it. |
| `NO serve config` in status | `python launch.py --ensure` re-adds the proxy. Or run `tailscale serve --bg 8378` yourself. |
| Server not running after a plugin reload | `python launch.py --restart`. Errors go to `remote-server/serve-err.log`. |
| Seats page empty, seats exist in Obsidian | workspace-shell is not enabled, or the plugin's control socket is off. Reload the Vault Dashboard plugin. |
| Push never arrives | Notifications need the installed home-screen app and the HTTPS front door. Re-enable in Settings after reinstalling the app. |
| Voice button says not installed | Voice is optional. It needs `ffmpeg` on PATH and a local dictation worker. |

## Dependencies, in full

The server renders what the vault's dashboard layer derives and runs that layer itself
(`tools/dashboard/dashboard_data.py`) on every refresh, so it depends on the vault system,
two Obsidian plugins, four programs and four Python packages. The complete map, with what
each piece is for and what degrades without it, is `remote-server/README.md` (it ships in
the installed plugin folder). The short version:

| Needed | Why |
|---|---|
| The vault system (`00_System/AI/Claude/tools/dashboard/`, `session-registry.json`, `Roadmaps/`) | The data. Ships in the system update channel. |
| vault-dashboard + workspace-shell | Lifecycle and control socket; the seats themselves. |
| `python`, `tailscale`, `git`, `claude` | Runtime, front door, the generator's repo reads, session mining. |
| `psutil`, `pywebpush` (+ `cryptography`), `pillow` | Process control (required), push (optional), icon fallback (optional). |

Optional and absent on a buyer install by design: `node` + `tools/render-preview.mjs`
(the `/desk` render), `ffmpeg` + `tools/dictation` (voice), `tools/graph_client.py`
(Outlook week). Each degrades to a message, never a crash.

## Where things live

- Server code: `<vault>/.obsidian/plugins/vault-dashboard/remote-server/`
- Runtime state (never in the vault): `%LOCALAPPDATA%\vault-remote\`
  (push subscriptions, VAPID key, notification prefs, the plugin's control token, logs)
- Data the app renders: `<vault>/00_System/AI/Claude/System Operations/state/dashboard-data.json`,
  generated by `tools/dashboard/dashboard_data.py` from your roadmaps and session transcripts.

## Building from source

```
npm install
VAULT_PATH="C:/path/to/your vault" npm run build
```

The build writes `main.js`, `manifest.json`, `styles.css` and copies `remote-server/`
into `<VAULT_PATH>/.obsidian/plugins/vault-dashboard/`. Reload the plugin in Obsidian to
pick it up; the phone server restarts with it.
