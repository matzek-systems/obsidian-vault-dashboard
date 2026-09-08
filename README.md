# Vault Dashboard

The dashboard plugin for the vault system, and the **remote app** that comes with it: a
phone app (and a desktop page) that shows your board and lets you read and message your
Claude seats from anywhere, over your own Tailscale network. Nothing is public and there
is no login inside the app: being on your tailnet is the login.

## Setup

You need the PC that runs Obsidian, your phone, and about fifteen minutes.

### 1. Tailscale

1. Install Tailscale on the PC and sign in. Install it on your phone and sign in to the
   **same** account.
2. Open the Tailscale admin console at login.tailscale.com, go to **DNS**, and turn on
   **MagicDNS** and **HTTPS Certificates**. Both are required: MagicDNS gives the PC a
   name, HTTPS is what push notifications and the home-screen install need.
3. On the PC, open the Tailscale tray app and turn on **Run unattended**, so the
   connection comes back after a reboot without you signing in first.

### 2. The PC

1. Make sure Python 3.10 or newer is installed and `python --version` works in a
   terminal.
2. Install the packages the server uses:

   ```
   pip install psutil pywebpush cryptography pillow
   ```

3. In Obsidian, enable **Vault Dashboard** under Community plugins. Keep **workspace-shell**
   enabled too: it provides the seats the app talks to.
4. That is it for the server. The plugin starts it when Obsidian loads, stops it when
   Obsidian closes, and on first start registers the HTTPS front door with Tailscale
   (`tailscale serve --bg 8378`). The first certificate can take up to a minute.

To confirm, open a terminal in
`<your vault>/.obsidian/plugins/vault-dashboard/remote-server` and run:

```
python launch.py --status
```

You want to see `remote-app RUNNING`, an `https://...ts.net` address, `tailscale
backend=Running` and `front door proxy -> 127.0.0.1:8378`. That address is the app.

### 3. The phone

1. With the phone on Tailscale, open the address from the status check in Safari
   (iPhone) or Chrome (Android).
2. iPhone: tap Share, then **Add to Home Screen**. From now on open it from the icon;
   push notifications only work from the installed app, not from a Safari tab.
3. In the app, open **Settings** and turn on notifications. The default is to notify
   you only when you are away from the PC.

### 4. Desktop browser

The same address works in any browser on a device that is on your tailnet. From 900px
wide you get the sidebar layout: seats on the left, the conversation in the middle.

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

### Requirements at a glance

| Item | Notes |
|---|---|
| Windows 10 or 11 | The launcher uses `pythonw.exe` and the Tailscale Windows paths. |
| Obsidian with vault-dashboard 3.1.0+ and workspace-shell | workspace-shell provides the seats. |
| Python 3.10+ | Plus `psutil`, `pywebpush`, `cryptography`, `pillow`. |
| Tailscale | Both devices, same account, MagicDNS and HTTPS certificates on. |
| The vault system | The server renders the vault's dashboard data and runs its generator (`tools/dashboard/`); `git` and the `claude` CLI are used by that generator and are part of every vault-system install. |

Optional, and absent on a buyer install by design: `node` with `tools/render-preview.mjs`
(the `/desk` render), `ffmpeg` with `tools/dictation` (voice), `tools/graph_client.py`
(the Outlook week). Each degrades to a message.

### Dependencies in full

`remote-server/README.md` is the complete map: every vault file the server reads or
runs, both plugins, every program and package, and what happens without each. It ships in
the installed plugin folder.

### Where things live

- Server code: `<vault>/.obsidian/plugins/vault-dashboard/remote-server/`
- Runtime state, never in the vault: `%LOCALAPPDATA%\vault-remote\` (push subscriptions,
  VAPID key, notification preferences, the plugin's control token, logs)
- The data the app renders:
  `<vault>/00_System/AI/Claude/System Operations/state/dashboard-data.json`, generated by
  `tools/dashboard/dashboard_data.py` from your roadmaps and session transcripts.

### Building from source

```
npm install
VAULT_PATH="C:/path/to/your vault" npm run build
```

The build writes `main.js`, `manifest.json` and `styles.css` and copies `remote-server/`
into `<VAULT_PATH>/.obsidian/plugins/vault-dashboard/`. Reload the plugin in Obsidian; the
phone server restarts with it.
