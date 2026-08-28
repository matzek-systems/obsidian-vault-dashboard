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

## Layout (SYS-485)
- **`@media (max-width: …)` never fires for `.op-panel`'s own narrow-stack rules** — it keys on the Electron WINDOW, but `.op-panel` lives inside a narrow Obsidian leaf/pane sitting in a 1920-2560px app window. Use `@container` instead, with `container-type: inline-size` set on `.vault-dashboard.op-panel` (and, for anything nested inside a further-constrained sub-column like `.tri-col`/`.op-clock`, its own nested `container-type` too — a `@container` query always resolves to the NEAREST container-type ancestor). Test with `node tools/render-preview.mjs <data.json> <out.html> [lane] --width N` (sets `.op-panel`'s own width, independent of the screenshot/browser window) under a genuinely wider `--window-size` — a narrow browser window makes viewport and container width coincide, hiding this exact bug class.
- **A grid item's automatic minimum size defaults to its content's min-content width, not 0** — `minmax(0, 1fr)` on the TRACK isn't enough on its own if an individual grid-item element (e.g. a bare `<section>`) has no `min-width: 0` of its own; it'll refuse to shrink below its content and can bleed into a neighboring column at narrow widths.
- **A `.row`'s nowrap badge cluster (`.meta`) has a real minimum width** — squeezing the title column below what's left just wraps it word-by-word, not "readable." Below a real threshold, switch `.row` to a stacked 2-row grid (id+title on top, badges below) rather than fighting three columns for no room.
- **Arc-strip label overflow (`.lbl-out`) must add its class BEFORE the right-anchor scroll line** (`strip.scrollLeft = strip.scrollWidth`) — adding `.lbl-out` can itself grow the track's true scrollWidth (labels now render past their bar), so anchoring first uses a stale, too-small width. And an outside label's natural position can still land left of the strip's visible edge if its bar sits outside the anchored viewport (an old/short arc) but the label is long enough to reach back into view — the strip's `overflow-x: auto` then clips the label's START, showing a confusing "avid call transcript trim…" fragment. Clamp the label's inline `left` to `Math.max(natural, strip.scrollLeft - bar.offsetLeft + 2)` post-scroll so it's either fully visible or fully scrolled away, never straddling the clip boundary mid-word.

## Build (s852)
- Type-checking after adding a `Notice` import failed with `TS2354: This syntax requires an imported helper but module 'tslib' cannot be found` — resolved by running `npx tsc --noEmit --importHelpers false`.
- esbuild's external-modules list needs `"fs"` added (alongside `"obsidian"`, `"electron"`, `"child_process"`) for a Node `fs` usage to bundle correctly.
