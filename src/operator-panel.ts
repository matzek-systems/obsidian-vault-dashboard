// ── Dashboard (SYS-485, session 911) ─────────────────────────────────
// The dashboard view, a thin shell over src/render/*.ts (pure functions from
// dashboard-data.json to HTML strings — no roadmap parsing, no hand-fed
// state, importable from Node for tools/render-preview.mjs). This file owns
// the DOM skeleton, the refresh/regenerate lifecycle, and click/hover
// delegation; every panel's *content* is delegated to a render function.
//
// Shape (operator verdicts, s911): lane tabs are the spine and sit at the
// top; the default tab is the lane the operator last typed in. Each tab
// holds: a kicker (who's moving this lane), the arc strip (session-level
// history), then PROGRESSED/NEW/NO-CHANGE (or VERIFY/READY for a
// high-volume lane) bands — no more artificial 6-item sprint cap. Below the
// tabs: CLOCK + TRIAGE (replaces the old "swept" panel), then COULD DO +
// CAPTURE ZONE, then WEEK. No title bar, no infra dots, no open-seats panel
// (Processes covers seats). Every WI id hovers a card (wi-card.ts); every
// arc-strip session node hovers a card too (session-hover.ts), and a
// multi-row's gutter label hovers the full untruncated arc label
// (arc-hover.ts) -- all three share the hover-card.ts skin.
//
// Render discipline (the s883-s911 "renders twice" bug): the skeleton is
// built ONCE in onOpen; refresh() is serialized (one in flight, at most one
// pending) and carries a generation counter so a superseded async load
// never paints. Sub-panels are repainted by replacing their own innerHTML.

import { ItemView, WorkspaceLeaf, Notice } from "obsidian";
import { execFile } from "child_process";
import type DashboardPlugin from "./main";
import { WiIndex, WiHover } from "./wi-card";
import { SessionHover } from "./session-hover";
import { ArcHover } from "./arc-hover";
import {
	Any, esc, laneList, contPrompt,
	renderHeader, renderTabs, renderLane, renderTriage, renderClock, renderCouldDo, renderCapture, renderWeek, weekNote,
} from "./render";

const CLAUDE_DIR = "00_System/AI/Claude";
const DATA_FILE = `${CLAUDE_DIR}/System Operations/state/dashboard-data.json`;
const GENERATOR = `${CLAUDE_DIR}/tools/dashboard/dashboard_data.py`;
const ROADMAPS_DIR = `${CLAUDE_DIR}/Roadmaps`;
const REFRESH_MS = 60_000;      // repaint cadence while the pane is open
const REGEN_STALE_MS = 20_000;  // don't spawn the generator more often than this

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

	private buildSkeleton(): void {
		const c = this.contentEl;
		c.empty();
		c.innerHTML = `
		<div class="op-wrap">
			<div class="op-top"><span class="op-gen">loading…</span><button class="op-btn" data-act="refresh" title="regenerate now">↻</button></div>
			<div class="op-tabs"></div>
			<div class="op-lane"></div>
			<div class="op-grid op-grid-top">
				<section><h2>clock</h2><div class="op-clock"></div></section>
				<section class="op-triage-sec"><h2>triage</h2><div class="op-triage"></div></section>
			</div>
			<div class="op-grid op-grid-bottom">
				<section><h2>could do</h2><div class="op-could"></div></section>
				<section><h2>capture zone <span class="n op-cap-n"></span></h2><div class="op-cap"></div></section>
			</div>
			<section><h2>week <span class="n op-week-n"></span></h2><div class="op-week"></div><div class="op-weeknote"></div></section>
			<footer class="op-foot"><span class="op-stats"></span></footer>
		</div>`;
		const q = (sel: string): HTMLElement => c.querySelector(sel) as HTMLElement;
		this.els = {
			gen: q(".op-gen"), tabs: q(".op-tabs"), lane: q(".op-lane"),
			clock: q(".op-clock"), triage: q(".op-triage"), could: q(".op-could"),
			capN: q(".op-cap-n"), cap: q(".op-cap"),
			weekN: q(".op-week-n"), week: q(".op-week"), weeknote: q(".op-weeknote"),
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

	// ── paint ──────────────────────────────────────────────────────

	private paint(): void {
		const d = this.data;
		const E = this.els;
		E.gen.innerHTML = renderHeader(d, this.genError);

		const lanes = laneList(d);
		if (!this.tab || !lanes.find((b) => b.lane === this.tab)) this.tab = lanes[0]?.lane ?? null;
		this.paintTabs();
		this.paintLane();

		E.clock.innerHTML = renderClock(d.clock || [], d.blocked_overdue || []);
		E.triage.innerHTML = d.triage ? renderTriage(d.triage, d) : `<div class="empty">triage needs schema 3 data</div>`;
		E.could.innerHTML = renderCouldDo(d.could_do);

		const cap: Any[] = d.capture || [];
		E.capN.textContent = `${d.capture_total ?? cap.length}`;
		E.cap.innerHTML = renderCapture(cap);

		const wk = d.week;
		E.weekN.textContent = wk?.error ? "calendar read failed" : "";
		E.week.innerHTML = renderWeek(wk);
		E.weeknote.textContent = weekNote(wk);

		const st = d.stats || {};
		E.stats.textContent = `${st.open_working ?? "?"} working · ${st.waiting ?? "?"} waiting · ${st.deferred ?? "?"} deferred`;
	}

	private paintTabs(): void {
		this.els.tabs.innerHTML = renderTabs(this.data, this.tab);
	}

	private paintLane(): void {
		const b = laneList(this.data).find((x) => x.lane === this.tab);
		if (!b) { this.els.lane.innerHTML = `<div class="empty">no lane has motion, a live seat, or working WIs</div>`; return; }
		// A lane can have working WIs (data.lanes[]) with no sprints[] entry
		// (schema 2 always for non-busiest lanes; schema 3 only if the
		// generator hasn't caught up yet). Synthesize just enough of a
		// sprint shape so renderLane's schema-2 fallback can still look the
		// lane's full WI list back up by name, without faking a fake "sprint".
		const sp = b.sprint ?? { lane: b.lane, weight: b.weight, wis: [], seats: [], moving_count: 0 };
		// availableWidth: the swimlane's column width fills this (capped
		// 56-96px per column, see arc-strip.ts) instead of squeezing/scaling
		// with session count. .op-lane is a persistent skeleton element (built
		// once in buildSkeleton()), so its clientWidth is already correct
		// before this first paint -- it's a block child of .op-wrap, not
		// itself the thing being replaced.
		this.els.lane.innerHTML = renderLane(sp, this.data, this.els.lane.clientWidth || undefined);
		// The swimlane's label gutter is CSS `position: sticky; left: 0`
		// (styles.css .arc-gutter) -- it stays pinned as the strip scrolls,
		// so no JS measurement/clamp pass is needed for labels any more (the
		// old .lbl-out class + post-layout clamp is gone along with the
		// floating-bar design that needed it). Only the right-anchor default
		// remains: the operator cares about "what just happened," not
		// day-1-of-the-window; older history is a scroll-left away.
		const strip = this.els.lane.querySelector(".arc-strip") as HTMLElement | null;
		if (strip) strip.scrollLeft = strip.scrollWidth;
	}
}
