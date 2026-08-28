#!/usr/bin/env node
// Static screenshot-QA harness for src/render/*.ts (SYS-485, session 911).
// Bundles the pure render layer to a temp CJS module with esbuild's Node
// API, imports it under plain Node (no Obsidian runtime needed — that's
// the whole point of keeping src/render/ import-free), and renders one
// lane tab + triage into a standalone HTML page embedding styles.css.
//
// Usage: node tools/render-preview.mjs <dashboard-data.json> <out.html> [lane]
//
// The output page defines Obsidian's CSS custom properties itself (light
// under :root, dark under .theme-dark) since there's no real Obsidian
// runtime supplying them here. Append ?dark=1 to the file:// URL when
// screenshotting to render the dark variant — a small inline script flips
// the class before paint.

import esbuild from "esbuild";
import { readFileSync, writeFileSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { pathToFileURL } from "url";
import process from "process";

const [, , dataPath, outPath, laneArg] = process.argv;
if (!dataPath || !outPath) {
	console.error("usage: node tools/render-preview.mjs <dashboard-data.json> <out.html> [lane]");
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
body { width: 460px; }
.preview-frame { width: 460px; border: 0; }
`;
}

async function main() {
	const R = await bundleRenderLayer();
	const data = JSON.parse(readFileSync(dataPath, "utf8"));
	const css = readFileSync(path.join(REPO, "styles.css"), "utf8");

	const lanes = R.laneList(data);
	const tab = laneArg || lanes.find((b) => b.focal)?.lane || lanes[0]?.lane || null;
	const laneBlock = lanes.find((b) => b.lane === tab);
	const sp = laneBlock?.sprint ?? (laneBlock ? { lane: laneBlock.lane, weight: laneBlock.weight, wis: [], seats: [], moving_count: 0 } : null);

	const header = R.renderHeader(data, null);
	const tabs = R.renderTabs(data, tab);
	const laneHtml = R.renderLane(sp, data);
	const clock = R.renderClock(data.clock || [], data.blocked_overdue || []);
	const triage = data.triage ? R.renderTriage(data.triage, data) : `<div class="empty">no schema-3 triage in this fixture</div>`;
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
    document.querySelectorAll(".arc-strip").forEach((el) => { el.scrollLeft = el.scrollWidth; });
  });
</script>
<div class="preview-page">
  <div class="vault-dashboard op-panel">
    <div class="op-wrap">
      <div class="op-top"><span class="op-gen">${header}</span><button class="op-btn">↻</button></div>
      <div class="op-tabs">${tabs}</div>
      <div class="op-lane">${laneHtml}</div>
      <div class="op-grid op-grid-top">
        <section><h2>clock</h2><div class="op-clock">${clock}</div></section>
        <section class="op-triage-sec"><h2>triage</h2><div class="op-triage">${triage}</div></section>
      </div>
      <div class="op-grid op-grid-bottom">
        <section><h2>could do</h2><div class="op-could">${could}</div></section>
        <section><h2>capture zone <span class="n">${data.capture_total ?? (data.capture || []).length}</span></h2><div class="op-cap">${capture}</div></section>
      </div>
    </div>
  </div>
</div>
</body>
</html>`;

	writeFileSync(outPath, html, "utf8");
	console.log(`wrote ${outPath} (lane=${tab}, ${html.length} bytes)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
