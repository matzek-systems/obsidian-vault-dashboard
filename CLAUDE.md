# Vault Dashboard (Tauri) — Operational Gotchas

Routed from vault MEMORY.md (SYS-326 compression, session 520).

## Tauri
1. **Folder rename:** clear BOTH `target/debug/build/` AND `target/release/build/` — partial clear leaves stale absolute paths. Use PowerShell `Remove-Item -Recurse` (vault sandbox hook blocks Bash rm outside vault).
2. **App icon:** use `include_image!` + `set_icon` at startup; build-cache embed is fragile. After icon update: clear Windows icon cache + restart Explorer.
3. **Frameless windows** (`decorations: false`): set `center: true` (position not auto-corrected), add a resize-hit overlay (edge-resize may drop), Aero Snap may fail.
4. **tauri-plugin-dialog** requires a capabilities entry in `src-tauri/capabilities/default.json` AND Cargo.toml — missing capabilities silently blocks at runtime.
5. **WebView2 zoom:** `zoom: 1.2` on root with `height: 100vh` renders 20% taller than the window — bottom elements fall below the fold; fix with flex-fill on `#root`.
6. **Sidebar footer:** `flex: 1; min-height: 0` on the scroll body + `flex-shrink: 0` on the footer — `overflow-y: auto` without height bounding lets the body grow past the viewport.
7. **Stale HMR bundle:** Ctrl+R doesn't always re-fetch from Vite; reliable fix = touch a Rust source file to force a full Tauri relaunch.
8. **Context menu position:** normalize coordinates against the CSS zoom factor before clamping.
9. **CRLF:** JS parsers splitting on `\n` leave `\r` on every line; `$`-anchored regex never matches — normalize `\r\n` → `\n` at parse entry.
10. **PowerShell screenshot capture returns an 18×18 handle for Tauri windows** — frameless windows don't register with standard Win32 enumeration; use persisted-settings audit + code analysis instead.

## CodeMirror
- `basicSetup` includes `defaultHighlightStyle` (bold+underline headings, token colors). Pass `syntaxHighlighting: false` to basicSetup to disable — omitting the theme is not enough.
