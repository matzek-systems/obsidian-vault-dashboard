#!/usr/bin/env node
// Static screenshot-QA harness for src/render/*.ts (SYS-485, session 911).
// Bundles the pure render layer to a temp CJS module with esbuild's Node
// API, imports it under plain Node (no Obsidian runtime needed — that's
// the whole point of keeping src/render/ import-free), and renders one
// lane tab + triage into a standalone HTML page embedding styles.css.
//
// Usage: node tools/render-preview.mjs <dashboard-data.json> <out.html> [lane] [--width N] [--hover]
//
// --hover additionally bundles+wires the real ArcHover class (arc-hover.ts)
// so a headless-Playwright .hover() on a real .arc-gutter[data-arc] element
// exercises the actual mouseover -> show() path, not just static markup.
//
// The output page defines Obsidian's CSS custom properties itself (light
// under :root, dark under .theme-dark) since there's no real Obsidian
// runtime supplying them here. Append ?dark=1 to the file:// URL when
// screenshotting to render the dark variant — a small inline script flips
// the class before paint.
//
// --width N (default 460) sets the .vault-dashboard.op-panel element's own
// width -- NOT the page/body width. .op-panel is a CSS container
// (container-type: inline-size), so its @container rules key off this
// number regardless of how wide the browser window/screenshot viewport is.
// Screenshot at --window-size bigger than --width to prove the narrow-stack
// rules fire from the panel's own size, not the window's (a real Obsidian
// pane sits narrow inside a 1920-2560px app window).

import esbuild from "esbuild";
import { readFileSync, writeFileSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { pathToFileURL } from "url";
import process from "process";

const rawArgv = process.argv.slice(2);
let width = 460;
const wIdx = rawArgv.indexOf("--width");
if (wIdx !== -1) {
	width = parseInt(rawArgv[wIdx + 1], 10) || 460;
	rawArgv.splice(wIdx, 2);
}
let hover = false;
const hIdx = rawArgv.indexOf("--hover");
if (hIdx !== -1) {
	hover = true;
	rawArgv.splice(hIdx, 1);
}
const [dataPath, outPath, laneArg] = rawArgv;
if (!dataPath || !outPath) {
	console.error("usage: node tools/render-preview.mjs <dashboard-data.json> <out.html> [lane] [--width N] [--hover]");
	process.exit(2);
}

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");

async function bundleRenderLayer() {
	const outdir = mkdtempSync(path.join(tmpdir(), "vd-render-"));
	const outfile = path.join(outdir, "render.cjs");
	await esbuild.build({
		entryPoints: [path.join(REPO, "src", "render", "index.ts")],
		bundle: true,
		platform: "node",
		format: "cjs",
		target: "node18",
		outfile,
		logLevel: "warning",
	});
	// esbuild writes CJS with `module.exports.x = ...` — a plain require() works.
	const mod = await import(pathToFileURL(outfile).href + `?t=${Date.now()}`);
	return mod;
}

// Bundles the browser-side interactive bits (ArcHover's mouseover hover
// card) as an inline IIFE, for headless-Playwright verification that the
// real hover wiring -- not just the static markup -- behaves. Distinct from
// bundleRenderLayer() above: this targets platform:"browser" (arc-hover.ts
// and its hover-card.ts dependency use `document`/`window` directly, not
// Node-importable) and its output gets embedded as inline <script> text in
// the page rather than require()'d from this Node process. Opt-in via
// --hover since most callers only need the static markup/CSS.
async function bundleArcHover() {
	const result = await esbuild.build({
		entryPoints: [path.join(REPO, "src", "arc-hover.ts")],
		bundle: true,
		platform: "browser",
		format: "iife",
		globalName: "VDArcHover",
		target: "es2020",
		write: false,
		logLevel: "warning",
	});
	return result.outputFiles[0].text;
}

function styleVars() {
	return `
:root {
  --background-primary: #ffffff;
  --background-secondary: #f2f3f5;
  --background-modifier-border: #e3e3e3;
  --background-modifier-hover: rgba(0,0,0,0.04);
  --text-normal: #2e3338;
  --text-muted: #5c5c5c;
  --text-faint: #888888;
  --text-on-accent: #ffffff;
  --interactive-accent: #4c8bf5;
  --font-text: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  --font-monospace: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
}
body.theme-dark {
  --background-primary: #1e1e1e;
  --background-secondary: #161616;
  --background-modifier-border: #333333;
  --background-modifier-hover: rgba(255,255,255,0.05);
  --text-normal: #dcddde;
  --text-muted: #a3a3a3;
  --text-faint: #6c6c6c;
  --text-on-accent: #ffffff;
  --interactive-accent: #5b8ff0;
}
html, body { margin: 0; padding: 0; background: var(--background-primary); }
`;
}

async function main() {
	const R = await bundleRenderLayer();
	const arcHoverJs = hover ? await bundleArcHover() : "";
	const data = JSON.parse(readFileSync(dataPath, "utf8"));
	const css = readFileSync(path.join(REPO, "styles.css"), "utf8");

	const lanes = R.laneList(data);
	const tab = laneArg || lanes.find((b) => b.focal)?.lane || lanes[0]?.lane || null;
	const laneBlock = lanes.find((b) => b.lane === tab);
	const sp = laneBlock?.sprint ?? (laneBlock ? { lane: laneBlock.lane, weight: laneBlock.weight, wis: [], seats: [], moving_count: 0 } : null);

	const header = R.renderHeader(data, null);
	const tabs = R.renderTabs(data, tab);
	// Mirrors the real plugin's .op-lane.clientWidth measurement (see
	// operator-panel.ts paintLane()) with arithmetic instead of a live DOM:
	// .op-wrap caps content at max-width:1180px with 16px side padding
	// (styles.css), so the arc strip's real available width is never just
	// the raw --width past that cap.
	const availableWidth = Math.max(200, Math.min(width, 1180) - 32);
	const laneHtml = R.renderLane(sp, data, availableWidth);
	const triage = data.triage ? R.renderTriage(data.triage, data) : `<div class="empty">no schema-3 triage in this fixture</div>`;
	const triageN = data.triage ? R.triageTotal(data.triage) : "";
	const could = R.renderCouldDo(data.could_do);
	const capture = R.renderCapture(data.capture || []);

	const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>vault-dashboard render preview — ${R.esc(tab || "")}</title>
<style>${styleVars()}</style>
<style>${css}</style>
<style>
  .preview-page { padding: 8px; }
  .preview-page h1 { font: 700 11px var(--font-text); color: var(--text-faint); text-transform: uppercase; letter-spacing: .08em; margin: 14px 4px 4px; }
</style>
</head>
<body>
<script>
  if (new URLSearchParams(location.search).get("dark") === "1") document.body.classList.add("theme-dark");
  window.addEventListener("DOMContentLoaded", () => {
    // mirrors operator-panel.ts paintLane() -- the swimlane's label gutter
    // is CSS position:sticky;left:0 (styles.css .arc-gutter), so the only
    // JS left is the right-anchor scroll default (most recent sessions
    // visible without a manual scroll) plus the "<- earlier" jump-marker
    // click delegation (arc-strip.ts jumpMarker, s916 follow-up) -- kept
    // here too so a headless-Playwright .click() on .arc-jump exercises the
    // real behaviour, not just static markup.
    document.querySelectorAll(".arc-strip").forEach((el) => {
      el.scrollLeft = el.scrollWidth;
      el.addEventListener("click", (ev) => {
        const jump = ev.target.closest(".arc-jump");
        if (!jump) return;
        const to = parseInt(jump.dataset.jumpTo || "", 10);
        if (!Number.isNaN(to)) el.scrollLeft = to;
      });
    });
  });
</script>
${hover ? `<script>${arcHoverJs.replace(/<\/script>/g, "<\\/script>")}</script>
<script>
  // --hover wiring: mirrors operator-panel.ts's real init (new ArcHover(),
  // .attach(root), .setData(d.arcs)) so a headless-Playwright .hover() on a
  // real .arc-gutter[data-arc] element exercises the actual show() path,
  // not just the static markup.
  window.addEventListener("DOMContentLoaded", () => {
    const ah = new VDArcHover.ArcHover();
    ah.attach(document.querySelector(".op-lane"));
    ah.setData(${JSON.stringify(data.arcs || [])});
  });
</script>` : ""}
<div class="preview-page">
  <div class="vault-dashboard op-panel" style="width:${width}px">
    <div class="op-wrap">
      <div class="op-top"><span class="op-gen">${header}</span><button class="op-btn">↻</button></div>
      <div class="op-tabs">${tabs}</div>
      <div class="op-lane">${laneHtml}</div>
      <div class="op-grid op-grid-bottom">
        <section><h2>could do</h2><div class="op-could">${could}</div></section>
        <section><h2>capture zone <span class="n">${data.capture_total ?? (data.capture || []).length}</span></h2><div class="op-cap">${capture}</div></section>
      </div>
      <details class="op-cross-triage"><summary>full triage board <span class="n">${triageN}</span></summary><div class="op-triage">${triage}</div></details>
    </div>
  </div>
</div>
</body>
</html>`;

	writeFileSync(outPath, html, "utf8");
	console.log(`wrote ${outPath} (lane=${tab}, width=${width}px, ${html.length} bytes)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
