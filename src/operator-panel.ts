// ── Dashboard (SYS-485, v5 lane view landed session 916/917) ──────────
// The dashboard view, a thin shell over src/render/*.ts (pure functions from
// dashboard-data.json to HTML strings — no roadmap parsing, no hand-fed
// state, importable from Node for tools/render-preview.mjs). This file owns
// the DOM skeleton, the refresh/regenerate lifecycle, click/hover
// delegation, and the INBOX Accept/Expire file writes; every panel's
// *content* is delegated to a render function.
//
// Shape (v5 contract, session 916/917, mock approved by the operator "sure
// build it out"): gated on `schema >= 4` -- an older payload shows one line
// ("regenerate (schema N)") + the refresh button, nothing else (paint()).
// On schema 4+: generated line -> tabs (renderTabsV5, badge = overdue +
// decisions, red, omitted at 0) -> TODAY (renderToday, cross-lane, painted
// once above the lane content, same on every tab) -> per-lane content
// (renderLaneV5, src/render/lane.ts): NOW 3/3 -> DECISIONS OWED -> THIS WEEK
// compact -> ARCS (compact per-arc rows, origin-lane filter, phase tag) ->
// NEXT(5) -> WAITING -> backlog summary -> INBOX. COULD DO, the full
// cross-lane triage board, the 9-symbol arc legend, the standalone last-
// session note, and the old PROGRESSED/NEW band chrome are all gone from
// this path (contract item 3) -- their render functions (renderLane,
// renderCouldDo, renderTriage, renderCapture, renderThisWeek, renderArcStrip)
// stay in the codebase, unused, for rollback safety (flagged to team-lead).
// Every WI id hovers a card (wi-card.ts); every arc-row session dot hovers a
// card too (session-hover.ts), and an arc's gutter label hovers the full
// untruncated label + its WIs' progress (arc-hover.ts) -- all three share
// the hover-card.ts skin, unchanged by the v5 rework.
//
// Render discipline (the s883-s911 "renders twice" bug): the skeleton is
// built ONCE in onOpen; refresh() is serialized (one in flight, at most one
// pending) and carries a generation counter so a superseded async load
// never paints. Sub-panels are repainted by replacing their own innerHTML;
// per-lane <details> open/closed state (WAITING/backlog/INBOX/decisions
// "+N") survives that wholesale replacement via wireCollapsed() + plugin
// saveData (contract item 4), same discipline the old cross-triage board
// used for its own localStorage toggle.

import { ItemView, WorkspaceLeaf, Notice, TFile } from "obsidian";
import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import type DashboardPlugin from "./main";
import { WiIndex, WiHover } from "./wi-card";
import { SessionHover } from "./session-hover";
import { ArcHover } from "./arc-hover";
import { AcceptModal, AcceptResult } from "./accept-modal";
import {
	Any, esc, laneListV5, contPrompt,
	renderHeader, renderTabsV5, renderLaneV5, renderToday,
} from "./render";

const CLAUDE_DIR = "00_System/AI/Claude";
const DATA_FILE = `${CLAUDE_DIR}/System Operations/state/dashboard-data.json`;
const GENERATOR = `${CLAUDE_DIR}/tools/dashboard/dashboard_data.py`;
const ROADMAPS_DIR = `${CLAUDE_DIR}/Roadmaps`;
const HOME_FILE = `${CLAUDE_DIR}/00_Home.md`;
const NEXT_WI_ID = `${CLAUDE_DIR}/tools/next-wi-id.py`;
const APPLY_ROADMAP_ACTION = `${CLAUDE_DIR}/tools/apply-roadmap-action.py`;
const REFRESH_MS = 60_000;      // repaint cadence while the pane is open
const REGEN_STALE_MS = 20_000;  // don't spawn the generator more often than this
const MIN_SCHEMA = 4;           // v5 lane view gate (SYS-485) -- older payloads get "regenerate" only

/** Splits on \r\n | \r | \n, keeping each line's own terminator alongside it
 *  (empty string for the final line if there's no trailing one). 00_Home.md
 *  is CRLF on disk (confirmed against the live file, not assumed) -- a bare
 *  `content.split("\n")` leaves a trailing \r on every line, which silently
 *  breaks any `$`-anchored regex against that line (JS's `.` excludes \r,
 *  same CRLF-vs-LF family as the windows-tooling.md roadmap gotcha).
 *  Reconstructing via `lines.map((l,i)=>l+eols[i]).join("")` round-trips
 *  byte-identical to the original for every UNTOUCHED line -- markHeading
 *  needs that so a one-line marker append never silently renormalizes the
 *  rest of the file's line endings. */
function splitPreserveEol(content: string): { lines: string[]; eols: string[] } {
	const lines: string[] = [];
	const eols: string[] = [];
	const re = /\r\n|\r|\n/g;
	let last = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(content))) {
		lines.push(content.slice(last, m.index));
		eols.push(m[0]);
		last = re.lastIndex;
	}
	lines.push(content.slice(last));
	eols.push("");
	return { lines, eols };
}

export class DashboardView extends ItemView {
	private plugin: DashboardPlugin;
	private gen = 0;
	private inflight: Promise<void> | null = null;
	private pending = false;
	private lastGenAt = 0;
	private genError: string | null = null;
	private data: Any = null;
	private tab: string | null = null;
	private els: Record<string, HTMLElement> = {};
	private wiHover: WiHover | null = null;
	private sessHover: SessionHover | null = null;
	private arcHover: ArcHover | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: DashboardPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string { return "vault-dashboard"; }
	getDisplayText(): string { return "Dashboard"; }
	getIcon(): string { return "layout-dashboard"; }

	async onOpen(): Promise<void> {
		this.navigation = false;
		this.contentEl.addClass("vault-dashboard", "op-panel");
		this.buildSkeleton();
		this.contentEl.addEventListener("click", (e) => this.onClick(e));
		this.wiHover = new WiHover(new WiIndex(this.app, ROADMAPS_DIR));
		this.wiHover.attach(this.contentEl);
		this.sessHover = new SessionHover();
		this.sessHover.attach(this.contentEl);
		this.arcHover = new ArcHover();
		this.arcHover.attach(this.contentEl);
		this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
			if (leaf === this.leaf) void this.refresh(false);
		}));
		this.registerInterval(window.setInterval(() => void this.refresh(false), REFRESH_MS));
		await this.refresh(true);
	}

	async onClose(): Promise<void> {
		this.wiHover?.dispose();
		this.wiHover = null;
		this.sessHover?.dispose();
		this.sessHover = null;
		this.arcHover?.dispose();
		this.arcHover = null;
	}

	/** Kept for DashboardPlugin.saveSettings(), which calls render() on open leaves. */
	render(): void { void this.refresh(true); }

	// ── data ───────────────────────────────────────────────────────

	private async refresh(regenerate: boolean): Promise<void> {
		if (this.inflight) { this.pending = true; return; }
		const my = ++this.gen;
		this.inflight = (async () => {
			try {
				if (regenerate || Date.now() - this.lastGenAt > REGEN_STALE_MS) {
					this.els.gen.textContent = "regenerating…";
					await this.runGenerator();
					this.lastGenAt = Date.now();
				}
				const raw = await this.app.vault.adapter.read(DATA_FILE);
				const d = JSON.parse(raw);
				if (my !== this.gen) return;   // a newer refresh owns the screen
				this.data = d;
				this.sessHover?.setData(d.sessions_log || []);
				this.arcHover?.setData(d.arcs || []);
				this.paint();
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				this.els.gen.innerHTML = `<span class="bad">data unavailable — ${esc(msg.slice(0, 160))}</span>`;
			}
		})();
		try { await this.inflight; }
		finally {
			this.inflight = null;
			if (this.pending) { this.pending = false; void this.refresh(false); }
		}
	}

	private runGenerator(): Promise<void> {
		const base = (this.app.vault.adapter as Any).basePath as string;
		const py = this.plugin.settings.pythonCmd || "python";
		return new Promise((resolve) => {
			execFile(py, [`${base}/${GENERATOR}`], { cwd: base, windowsHide: true, timeout: 150_000, maxBuffer: 8 * 1024 * 1024 },
				(err, _stdout, stderr) => {
					this.genError = err ? ((stderr || "").trim() || err.message).slice(0, 200) : null;
					resolve();
				});
		});
	}

	// ── skeleton ───────────────────────────────────────────────────

	// v5 (SYS-485 schema 4): COULD DO, CAPTURE ZONE (superseded by per-lane
	// INBOX -- the contract: "only `inbox` is rendered"), and the FULL TRIAGE
	// BOARD are all gone from the skeleton, not just unpainted -- the
	// schema<4 fallback is "one line + the refresh button, nothing else," and
	// schema>=4's own lane order (renderLaneV5) never calls their render
	// functions either. .op-today is new: TODAY is cross-lane (contract, "one
	// wrapping line"), so it's painted once here, not per lane, same as
	// .op-top/.op-tabs.
	private buildSkeleton(): void {
		const c = this.contentEl;
		c.empty();
		c.innerHTML = `
		<div class="op-wrap">
			<div class="op-top"><span class="op-gen">loading…</span><button class="op-btn" data-act="refresh" title="regenerate now">↻</button></div>
			<div class="op-tabs"></div>
			<div class="op-today"></div>
			<div class="op-lane"></div>
			<footer class="op-foot"><span class="op-stats"></span></footer>
		</div>`;
		const q = (sel: string): HTMLElement => c.querySelector(sel) as HTMLElement;
		this.els = {
			gen: q(".op-gen"), tabs: q(".op-tabs"), today: q(".op-today"), lane: q(".op-lane"),
			stats: q(".op-stats"),
		};
	}

	// ── actions ────────────────────────────────────────────────────

	private onClick(e: MouseEvent): void {
		const t = (e.target as HTMLElement).closest("[data-act]") as HTMLElement | null;
		if (!t) return;
		const act = t.dataset.act;
		if (act === "refresh") void this.refresh(true);
		else if (act === "tab") { this.tab = t.dataset.lane || null; this.paintTabs(); this.paintLane(); }
		else if (act === "copy") void this.copyPrompt(t.dataset.id || "");
		else if (act === "togglenote") t.classList.toggle("expanded");
		else if (act === "open") { this.wiHover?.hide(); void this.openRoadmap(t.dataset.lane || "", t.dataset.id || ""); }
		else if (act === "inbox-expire") void this.inboxExpire(t.dataset.heading || "", t.dataset.date);
		else if (act === "inbox-accept") this.openAcceptModal(t.dataset.heading || "", t.dataset.date, t.dataset.lane || "");
	}

	private async copyPrompt(id: string): Promise<void> {
		try { await navigator.clipboard.writeText(contPrompt(id)); new Notice(`${id} prompt copied — paste into a seat`); }
		catch (_) { new Notice(`clipboard unavailable — ${contPrompt(id)}`); }
	}

	private async openRoadmap(lane: string, id: string): Promise<void> {
		if (!lane) return;
		const path = `${ROADMAPS_DIR}/${lane} Roadmap.md`;
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!file) { new Notice(`no roadmap file for ${lane}`); return; }
		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.openFile(file as Any);
		const view = leaf.view as Any;
		const editor = view?.editor;
		if (editor && id) {
			const lines: string[] = editor.getValue().split("\n");
			const ln = lines.findIndex((l) => l.startsWith(`### ${id}:`));
			if (ln >= 0) { editor.setCursor({ line: ln, ch: 0 }); editor.scrollIntoView({ from: { line: ln, ch: 0 }, to: { line: ln, ch: 0 } }, true); }
		}
	}

	// ── INBOX actions (v5, SYS-485 schema 4 / SYS-395) ───────────────
	// File access + subprocess plumbing stay here, not in src/render/ (that
	// dir is pure functions, no Obsidian imports, importable from Node for
	// render-preview.mjs -- see operator-panel.ts's own file-header rule).

	/** Same execFile shape as runGenerator() above, generalized to any
	 *  vault-relative script + args, returning ok/stdout/stderr instead of
	 *  resolving void -- next-wi-id.py and apply-roadmap-action.py both need
	 *  their actual output, unlike the generator (which just writes the data
	 *  file as a side effect). */
	private execPy(scriptRel: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
		const base = (this.app.vault.adapter as Any).basePath as string;
		const py = this.plugin.settings.pythonCmd || "python";
		return new Promise((resolve) => {
			execFile(py, [`${base}/${scriptRel}`, ...args], { cwd: base, windowsHide: true, timeout: 150_000, maxBuffer: 8 * 1024 * 1024 },
				(err, stdout, stderr) => {
					resolve({ ok: !err, stdout: (stdout || "").trim(), stderr: ((stderr || "").trim() || (err ? err.message : "")) });
				});
		});
	}

	/** Mirrors dashboard_data.py's _parse_capture_text clean-title transform
	 *  EXACTLY (`clean = re.sub(r"\s*[—(-]*\s*\(?session \d+[^)]*\)?\s*$", "",
	 *  heading).strip()` then `[:110]`) -- collect_capture's `title` field is
	 *  a LOSSY transform of the real `### ` heading line (a trailing
	 *  "(session N ...)"-shaped suffix is stripped, then the result is
	 *  truncated to 110 chars), so relocating that heading for Expire/Accept
	 *  needs the SAME transform applied to each candidate line, not a naive
	 *  exact-text match against the raw heading (which silently fails for
	 *  the majority of real entries -- confirmed against the live
	 *  00_Home.md/dashboard-data.json, not assumed). */
	private static readonly CAPTURE_CLEAN_RE = /\s*[—(-]*\s*\(?session \d+[^)]*\)?\s*$/;
	private static cleanCaptureTitle(heading: string): string {
		const clean = heading.replace(DashboardView.CAPTURE_CLEAN_RE, "").trim();
		// Array.from() iterates by Unicode CODE POINT (a surrogate pair counts
		// as one element), matching Python's `clean[:110]` (code-point
		// indexed). A bare `.slice(0, 110)` counts UTF-16 code UNITS instead --
		// silently diverges from the generator whenever an astral-plane emoji
		// (🛠 U+1F6E0 and several of the Capture Zone's other heading emoji
		// are supplementary-plane, needing 2 JS units each) sits before the
		// truncation point AND truncation actually triggers. Confirmed as a
		// real live miss, not a theoretical one: 1 of 9 real inbox entries on
		// the live 00_Home.md failed to resolve under the naive .slice(0,110).
		return Array.from(clean).slice(0, 110).join("");
	}

	/** Finds the `### ` line whose generator-cleaned title matches `title`.
	 *  `date` (the row's own c.date, embedded verbatim somewhere in the real
	 *  heading per _parse_capture_text's own `(20\d\d-\d\d-\d\d)` scan) is a
	 *  cheap disambiguator for the rare case two entries clean to the same
	 *  title -- prefers whichever candidate line contains that date
	 *  substring. Returns -1 if nothing matches. */
	private findCaptureHeadingIndex(lines: string[], title: string, date?: string): number {
		const candidates: number[] = [];
		for (let i = 0; i < lines.length; i++) {
			const m = /^###\s+(.*)$/.exec(lines[i]);
			if (m && DashboardView.cleanCaptureTitle(m[1]) === title) candidates.push(i);
		}
		if (candidates.length <= 1) return candidates.length ? candidates[0] : -1;
		if (date) {
			const withDate = candidates.find((i) => lines[i].includes(date));
			if (withDate !== undefined) return withDate;
		}
		return candidates[0];
	}

	/** collect_capture reads each `### ` entry's BODY until the next `### `
	 *  or `## ` (contract) -- read fresh here rather than threading the body
	 *  through the rendered HTML (a data-attribute is no place for multi-
	 *  paragraph prose). */
	private async readCaptureBody(heading: string, date?: string): Promise<string> {
		const file = this.app.vault.getAbstractFileByPath(HOME_FILE);
		if (!(file instanceof TFile)) return "";
		const content = await this.app.vault.cachedRead(file);
		const { lines } = splitPreserveEol(content);
		const idx = this.findCaptureHeadingIndex(lines, heading, date);
		if (idx === -1) return "";
		let end = lines.length;
		for (let i = idx + 1; i < lines.length; i++) {
			if (/^#{2,3}\s/.test(lines[i])) { end = i; break; }
		}
		return lines.slice(idx + 1, end).join("\n").trim();
	}

	/** Appends ` <!-- <tag> YYYY-MM-DD -->` to the matched `### ` heading
	 *  line in 00_Home.md via vault.process (contract: Expire -> "expired",
	 *  Accept -> "filed <ID>"). Nothing is deleted -- the close sweep drops
	 *  marked entries later. Throws (caller Notices) if the heading can't be
	 *  found, so a stale/renamed entry never silently no-ops. */
	private async markHeading(heading: string, date: string | undefined, tag: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(HOME_FILE);
		if (!(file instanceof TFile)) throw new Error("00_Home.md not found");
		const today = new Date().toISOString().slice(0, 10);
		let found = false;
		await this.app.vault.process(file, (content: string) => {
			const { lines, eols } = splitPreserveEol(content);
			const idx = this.findCaptureHeadingIndex(lines, heading, date);
			if (idx === -1) return content;
			found = true;
			lines[idx] = `${lines[idx]} <!-- ${tag} ${today} -->`;
			return lines.map((l, i) => l + eols[i]).join("");
		});
		if (!found) throw new Error("heading not found in 00_Home.md");
	}

	private async inboxExpire(heading: string, date?: string): Promise<void> {
		if (!heading) return;
		try {
			await this.markHeading(heading, date, "expired");
			new Notice(`Expired: ${heading}`);
			void this.refresh(true);
		} catch (e: any) {
			new Notice(`Expire failed: ${String(e?.message || e)}`);
		}
	}

	/** Best-effort WI-ID prefix for a roadmap file, read straight from its
	 *  own content (the first `### PREFIX-N:` block) rather than guessing
	 *  from the lane name -- PKM's roadmap uses `WI-`, not `PKM-`, so a
	 *  lane-name-shaped guess would be wrong for exactly the case that
	 *  matters most. */
	private async prefixForRoadmap(basename: string): Promise<string | null> {
		const file = this.app.vault.getAbstractFileByPath(`${ROADMAPS_DIR}/${basename}`);
		if (!(file instanceof TFile)) return null;
		const content = await this.app.vault.cachedRead(file);
		const m = /^### ([A-Z]+)-\d+:/m.exec(content);
		return m ? m[1] : null;
	}

	private openAcceptModal(heading: string, date: string | undefined, lane: string): void {
		if (!heading) return;
		const roadmaps = this.plugin.discoverRoadmaps().map((f) => f.name);
		const defaultRoadmap = `${lane} Roadmap.md`;
		new AcceptModal(this.app, roadmaps, defaultRoadmap, heading, (r) => void this.doAccept(heading, date, r)).open();
	}

	/** next-wi-id.py -> apply-roadmap-action.py --action new_wi, per the
	 *  contract's exact sequence. Non-zero exit from either step Notices the
	 *  stderr and leaves the heading unmarked (no marker on failure, per the
	 *  contract). */
	private async doAccept(heading: string, date: string | undefined, r: AcceptResult): Promise<void> {
		let tmpPath: string | null = null;
		try {
			const prefix = await this.prefixForRoadmap(r.roadmapFile);
			if (!prefix) { new Notice(`can't determine a WI prefix for ${r.roadmapFile}`); return; }

			const idRes = await this.execPy(NEXT_WI_ID, [prefix]);
			if (!idRes.ok) { new Notice(`next-wi-id.py failed: ${idRes.stderr.slice(0, 300)}`); return; }
			const newId = idRes.stdout.trim();
			if (!newId) { new Notice("next-wi-id.py returned no id"); return; }

			const body = await this.readCaptureBody(heading, date);
			tmpPath = `${os.tmpdir()}/${newId.replace(/[^A-Za-z0-9_-]/g, "_")}-body-${Date.now()}.txt`;
			await fs.writeFile(tmpPath, body, "utf-8");

			const applyRes = await this.execPy(APPLY_ROADMAP_ACTION, [
				"--wi", newId, "--action", "new_wi",
				"--roadmap", r.roadmapFile,
				"--title", r.title,
				"--done-when", r.doneWhen,
				"--status", "ready",
				"--body-file", tmpPath,
			]);
			if (!applyRes.ok) { new Notice(`apply-roadmap-action.py failed: ${applyRes.stderr.slice(0, 300)}`); return; }

			await this.markHeading(heading, date, `filed ${newId}`);
			new Notice(`Filed ${newId}`);
			void this.refresh(true);
		} catch (e: any) {
			new Notice(`Accept failed: ${String(e?.message || e)}`);
		} finally {
			if (tmpPath) await fs.unlink(tmpPath).catch(() => { /* best-effort cleanup */ });
		}
	}

	// ── collapsed-section persistence (v5, contract item 4) ──────────
	// `<details data-persist="...">` inside .op-lane (WAITING / backlog /
	// INBOX / decisions "+N") remember open/closed PER LANE via
	// plugin.saveData -- NOT plugin.saveSettings(), which re-renders every
	// open dashboard leaf (a repaint on every collapse/expand click would be
	// janky and could fight the very <details> being toggled). Re-run after
	// every paintLane() since that replaces .op-lane's innerHTML wholesale
	// (including on the 60s auto-refresh) -- same "paint never touches
	// `open` again after this runs" discipline as the old cross-triage board
	// had (s916), now per-section instead of one global toggle.
	private wireCollapsed(): void {
		const lane = this.tab;
		if (!lane) return;
		const nodes = this.els.lane.querySelectorAll<HTMLDetailsElement>("details[data-persist]");
		nodes.forEach((details) => {
			const section = details.dataset.persist;
			const key = `${lane}::${section}`;
			if (this.plugin.settings.collapsed[key]) details.open = true;
			details.addEventListener("toggle", () => {
				this.plugin.settings.collapsed[key] = details.open;
				void this.plugin.saveData(this.plugin.settings);
			});
		});
	}

	// ── paint ──────────────────────────────────────────────────────

	/** Gate on schema >= 4 (v5, SYS-485): an older payload gets one line +
	 *  the refresh button, nothing else -- no tabs, no TODAY, no lane
	 *  content. The literal contract example is 'regenerate (schema 3)';
	 *  this shows the ACTUAL detected schema number instead of hardcoding 3,
	 *  since a stale future payload (schema 5+ before this plugin catches
	 *  up) would otherwise print a misleading "(schema 3)". */
	private paint(): void {
		const d = this.data;
		const E = this.els;
		const schema = d?.schema || 0;

		if (schema < MIN_SCHEMA) {
			E.gen.innerHTML = `regenerate (schema ${esc(String(schema))})`;
			E.tabs.innerHTML = "";
			E.today.innerHTML = "";
			E.lane.innerHTML = "";
			E.stats.textContent = "";
			return;
		}

		E.gen.innerHTML = renderHeader(d, this.genError);
		E.today.innerHTML = renderToday(d.today);

		const lanes = laneListV5(d);
		if (!this.tab || !lanes.find((b) => b.lane === this.tab)) this.tab = lanes[0]?.lane ?? null;
		this.paintTabs();
		this.paintLane();

		const st = d.stats || {};
		E.stats.textContent = `${st.open_working ?? "?"} working · ${st.waiting ?? "?"} waiting · ${st.deferred ?? "?"} deferred`;
	}

	private paintTabs(): void {
		this.els.tabs.innerHTML = renderTabsV5(this.data, this.tab);
	}

	private paintLane(): void {
		const b = laneListV5(this.data).find((x) => x.lane === this.tab);
		this.els.lane.innerHTML = renderLaneV5(b, this.data);
		// Restore/wire this lane's per-section <details> open state (contract
		// item 4) -- must run AFTER the innerHTML assignment above, since it
		// replaces .op-lane wholesale (including on the 60s auto-refresh) and
		// a fresh render never carries an `open` attribute of its own.
		this.wireCollapsed();
	}
}
