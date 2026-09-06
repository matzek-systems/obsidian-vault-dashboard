#!/usr/bin/env node
// Static screenshot-QA harness for src/render/*.ts (SYS-485; thread board,
// v3.0.0 session 927; chip badges + active-window fold + OVERDUE strip
// session 931). Bundles the pure render layer to a temp CJS module with
// esbuild's Node API, imports it under plain Node (no Obsidian runtime
// needed -- that's the whole point of keeping src/render/ import-free), and
// renders the generated line + tabs + the thread board (active + older fold)
// + the overdue strip + the closed fold + footer into a standalone HTML page
// embedding styles.css. A schema<5 fixture renders the plugin's own
// "regenerate" fallback instead, mirroring operator-panel.ts's paint() gate
// exactly.
//
// Usage: node tools/render-preview.mjs <dashboard-data.json> <out.html> [lane] [--width N] [--hover]
//
//   lane      "" / omitted = ALL; a lane name filters like the plugin's tab.
//   --width N sets the .vault-dashboard.op-panel element's own width (default
//             460) -- NOT the page width. .op-panel is a CSS container, so its
//             @container rules key off this number regardless of the window.
//   --hover   also bundles + wires the real ArcHover class (arc-hover.ts) so a
//             headless-Playwright .hover() on a real .thr-lbl[data-arc]
//             exercises the actual mouseover -> show() path.
//
// The page defines Obsidian's CSS custom properties itself (light under
// :root, dark under .theme-dark). Append ?dark=1 to the file:// URL when
// screenshotting to render the dark variant.

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
	return await import(pathToFileURL(outfile).href + `?t=${Date.now()}`);
}

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
  --background-primary: #0c0c0c;
  --background-secondary: #111111;
  --background-modifier-border: #232323;
  --background-modifier-hover: #1c1c1c;
  --text-normal: #d4d4d4;
  --text-muted: #8a8a8a;
  --text-faint: #6b6b6b;
  --text-on-accent: #ffffff;
  --interactive-accent: #5a8ec7;
  --interactive-accent-hover: #6a9bd0;
  --color-red: #c77e7e;
  --color-orange: #c08a4a;
  --color-purple: #8a82b0;
  --color-yellow: #d6b25e;
  --color-green: #7ec77e;
  --color-blue: #5a8ec7;
  --font-text: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  --font-monospace: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
}
body.theme-dark {
  --background-primary: #0c0c0c;
  --background-secondary: #111111;
  --background-modifier-border: #232323;
  --background-modifier-hover: #1c1c1c;
  --text-normal: #d4d4d4;
  --text-muted: #8a8a8a;
  --text-faint: #6b6b6b;
  --text-on-accent: #ffffff;
  --interactive-accent: #5a8ec7;
  --interactive-accent-hover: #6a9bd0;
  --color-red: #c77e7e;
  --color-orange: #c08a4a;
  --color-purple: #8a82b0;
  --color-yellow: #d6b25e;
  --color-green: #7ec77e;
  --color-blue: #5a8ec7;
}
html, body { margin: 0; padding: 0; background: var(--background-primary); }
`;
}

async function main() {
	const R = await bundleRenderLayer();
	const arcHoverJs = hover ? await bundleArcHover() : "";
	const data = JSON.parse(readFileSync(dataPath, "utf8"));
	const css = readFileSync(path.join(REPO, "styles.css"), "utf8");

	const schema = data.schema || 0;
	const tab = laneArg || null;
	const genLine = schema < 5 ? `regenerate (schema ${schema}, need 5)` : R.renderHeader(data, null);
	const overdueHtml = schema < 5 || typeof R.renderOverdue !== "function" ? "" : R.renderOverdue(data, tab, R.wiIndex(data));
	const tabsHtml = schema < 5 ? "" : R.renderThreadTabs(data, tab, []);
	const boardHtml = schema < 5 ? "" : R.renderThreadBoard(data, tab);
	const closedHtml = schema < 5 ? "" : R.renderClosed(data, tab);
	const footHtml = schema < 5 ? "" : R.renderFoot(data);

	const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>vault-dashboard thread board preview — ${R.esc(tab || "ALL")}</title>
<style>${styleVars()}</style>
<style>${css}</style>
<style> .preview-page { padding: 8px; } </style>
</head>
<body>
<script>
  if (new URLSearchParams(location.search).get("dark") === "1") document.body.classList.add("theme-dark");
</script>
${hover ? `<script>${arcHoverJs.replace(/<\/script>/g, "<\\/script>")}</script>
<script>
  window.addEventListener("DOMContentLoaded", () => {
    const ah = new VDArcHover.ArcHover();
    ah.attach(document.querySelector(".op-panel"));
    ah.setData(${JSON.stringify([...(data.threads || []), ...(data.threads_closed || [])])});
  });
</script>` : ""}
<div class="preview-page">
  <div class="vault-dashboard op-panel" style="width:${width}px">
    <div class="op-wrap">
      <div class="op-top"><span class="op-gen">${genLine}</span><button class="op-btn">↻</button></div>
      <div class="op-tabs">${tabsHtml}</div>
      <div class="op-board">${boardHtml}</div>
      <div class="op-attn-wrap">${overdueHtml}</div>
      <div class="op-closed">${closedHtml}</div>
      <footer class="op-foot"><span class="op-stats">${footHtml}</span></footer>
    </div>
  </div>
</div>
</body>
</html>`;

	writeFileSync(outPath, html, "utf8");
	console.log(`wrote ${outPath} (tab=${tab || "ALL"}, schema=${schema}, width=${width}px, rows=${(data.threads || []).length}, overdue=${overdueHtml ? (overdueHtml.match(/data-kind="overdue"/g) || []).length : 0}, ${html.length} bytes)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
