// ── Dashboard (SYS-485, session 911) ─────────────────────────────────
// The dashboard view, a pure renderer of dashboard-data.json. Everything on
// screen is DERIVED by tools/dashboard/dashboard_data.py from state that
// already exists (git, roadmaps, registry, dev repos, Outlook read-only);
// this file holds no roadmap parsing and no hand-fed state.
//
// Shape (operator verdicts, s911): lane tabs are the spine and sit at the top;
// the default tab is the lane the operator last typed in; the tab holds that
// lane's sprint, its dev-repo motion, then its active list. Cross-lane panels
// (clock, swept, could-do, capture, week) sit below. No title bar, no infra
// dots, no open-seats panel (Processes covers seats). Every WI id hovers a
// card (wi-card.ts, same skin as workspace-shell) and click-opens the roadmap.
//
// Render discipline (the s883-s911 "renders twice" bug): the skeleton is built
// ONCE in onOpen; refresh() is serialized (one in flight, at most one pending)
// and carries a generation counter so a superseded async load never paints.
// Sub-panels are repainted by replacing their own innerHTML.

import { ItemView, WorkspaceLeaf, Notice } from "obsidian";
import { execFile } from "child_process";
import type DashboardPlugin from "./main";
import { WiIndex, WiHover } from "./wi-card";

const CLAUDE_DIR = "00_System/AI/Claude";
const DATA_FILE = `${CLAUDE_DIR}/System Operations/state/dashboard-data.json`;
const GENERATOR = `${CLAUDE_DIR}/tools/dashboard/dashboard_data.py`;
const ROADMAPS_DIR = `${CLAUDE_DIR}/Roadmaps`;
const REFRESH_MS = 60_000;      // repaint cadence while the pane is open
const REGEN_STALE_MS = 20_000;  // don't spawn the generator more often than this
const ACTIVE_CAP = 15;          // rows per lane tab before "show all"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const esc = (s: unknown): string =>
	String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

const actTxt = (m: number): string => (m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`);
function agoTxt(iso: string | null | undefined): string {
	if (!iso) return "";
	const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
	return m < 60 ? `${m}m` : m < 2880 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
}
function ageBadge(a: number | null | undefined): string {
	if (a === null || a === undefined) return `<span class="age rot">90d+</span>`;
	return `<span class="age ${a > 14 ? "rot" : a > 5 ? "old" : ""}">${a}d</span>`;
}
function dueBadge(w: Any): string {
	const d = w.due_in;
	if (d === null || d === undefined) return "";
	if (d < 0) return `<span class="due over">${-d}d overdue</span>`;
	return `<span class="due ${d <= 3 ? "soon" : ""}">due ${d === 0 ? "today" : `in ${d}d`}</span>`;
}
function laneOf(w: Any): string {
	if (w.lane) return String(w.lane).replace(" Roadmap", "");
	const m = /^([A-Z]+)-/.exec(String(w.id || ""));
	const map: Record<string, string> = { SYS: "_System", SOMA: "SomaGuard", MM: "MatzekMedia", WI: "PKM", CH: "ContentHoarder", JANE: "Jane", LD: "Lawndash", LWP: "Local Web Pitch", WCMC: "WCMC" };
	return m ? (map[m[1]] || m[1]) : "";
}
function contPrompt(id: string): string {
	return `Continue ${id} — read its detail section in the Roadmap, check the latest session state, and pick up the next unchecked task.`;
}
function seatBadges(seats: Any[]): string {
	return (seats || []).map((s) =>
		`<span class="seat ${esc(s.tier)}">s${s.n} · ${s.user_min != null ? "typed " + actTxt(s.user_min) : (s.active_min == null ? "?" : actTxt(s.active_min))}</span>`
	).join("");
}
function idCell(w: Any): string {
	return `<span class="tid c-${esc(w.status)}" data-act="open" data-id="${esc(w.id)}" data-lane="${esc(laneOf(w))}">${esc(w.id)}</span>`;
}
/** One WI row: [id][title (+ sub line)][meta]. Punctuation never separates fields — the grid does. */
function wiRow(w: Any, sub?: string | null): string {
	const meta = [
		dueBadge(w),
		w.status ? `<span class="pill ${esc(w.status)}">${esc(w.status)}</span>` : "",
		w.tasks_total ? `<span>${w.tasks_done}/${w.tasks_total}</span>` : "",
		ageBadge(w.age_days),
		`<button class="rcopy" data-act="copy" data-id="${esc(w.id)}" title="copy continue-prompt">⧉</button>`,
	].filter(Boolean).join("");
	return `<div class="row">${idCell(w)}<span class="ttl">${esc(w.title)}</span><span class="meta">${meta}</span>${sub ? `<span class="sub">${esc(sub)}</span>` : ""}</div>`;
}
function repoChip(r: Any): string {
	return `<span class="repo" title="${esc(r.last_subject)} · ${r.commits_28d} commits in 28d"><b>${esc(r.repo)}</b>${r.commits_7d}<span class="ago">${esc(agoTxt(r.last))} ago</span>${r.ahead ? `<span class="ahead">+${r.ahead} unpushed</span>` : ""}${r.dirty ? `<span class="dirty">dirty</span>` : ""}</span>`;
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
	private showAll: Record<string, boolean> = {};
	private els: Record<string, HTMLElement> = {};
	private hover: WiHover | null = null;

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
		this.hover = new WiHover(new WiIndex(this.app, ROADMAPS_DIR));
		this.hover.attach(this.contentEl);
		this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
			if (leaf === this.leaf) void this.refresh(false);
		}));
		this.registerInterval(window.setInterval(() => void this.refresh(false), REFRESH_MS));
		await this.refresh(true);
	}

	async onClose(): Promise<void> {
		this.hover?.dispose();
		this.hover = null;
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
			<div class="op-grid">
				<section><h2>clock</h2><div class="op-clock"></div></section>
				<section><h2>swept under the rug</h2><div class="op-swept"></div></section>
				<section><h2>could do <span class="n">no deadline · highest leverage</span></h2><div class="op-could"></div></section>
				<section><h2>capture zone <span class="n op-cap-n"></span></h2><div class="op-cap"></div></section>
			</div>
			<section><h2>week <span class="n op-week-n"></span></h2><div class="op-week"></div><div class="op-weeknote"></div></section>
			<footer class="op-foot"><span class="op-stats"></span></footer>
		</div>`;
		const q = (sel: string): HTMLElement => c.querySelector(sel) as HTMLElement;
		this.els = {
			gen: q(".op-gen"), tabs: q(".op-tabs"), lane: q(".op-lane"),
			clock: q(".op-clock"), swept: q(".op-swept"), could: q(".op-could"),
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
		else if (act === "showall") { this.showAll[t.dataset.lane || ""] = t.dataset.v === "1"; this.paintLane(); }
		else if (act === "open") { this.hover?.hide(); void this.openRoadmap(t.dataset.lane || "", t.dataset.id || ""); }
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

	/** Tab order: the focal lane first, then the generator's lane order (working desc). */
	private laneList(): Any[] {
		const d = this.data;
		const sprints: Any[] = d.sprints || [];
		const byLane: Record<string, Any> = {};
		for (const sp of sprints) byLane[sp.lane] = sp;
		const blocks: Any[] = (d.lanes || []).filter((b: Any) => b.working > 0 || byLane[b.lane]);
		const focal = sprints.find((s) => s.focal)?.lane;
		blocks.sort((a, b) => (a.lane === focal ? -1 : b.lane === focal ? 1 : 0));
		return blocks.map((b) => ({ ...b, sprint: byLane[b.lane] || null, focal: b.lane === focal }));
	}

	private paint(): void {
		const d = this.data;
		const E = this.els;
		E.gen.innerHTML = `generated ${esc(String(d.generated || "").slice(11, 16))} · ${(d.gen_ms / 1000).toFixed(1)}s`
			+ (this.genError ? ` · <span class="bad">generator: ${esc(this.genError)}</span>` : "");

		const lanes = this.laneList();
		if (!this.tab || !lanes.find((b) => b.lane === this.tab)) this.tab = lanes[0]?.lane ?? null;
		this.paintTabs();
		this.paintLane();

		E.clock.innerHTML = (d.clock || []).length
			? d.clock.map((w: Any) => wiRow(w)).join("")
			: `<div class="empty">no deadlines inside 45d</div>`;
		this.paintSwept(d.swept || {});
		const could: Any[] = (d.could_do || []).filter((c: Any) => !c.error);
		E.could.innerHTML = could.map((c) => wiRow(c, `${String(c.lane || "").replace(" Roadmap", "")} · ${c.why}`)).join("")
			|| `<div class="empty">${esc((d.could_do || [])[0]?.error || "nothing")}</div>`;

		const cap: Any[] = d.capture || [];
		E.capN.textContent = `${d.capture_total ?? cap.length}`;
		E.cap.innerHTML = cap.map((c) => `<div class="crow"><span>${esc(c.title)}</span>${c.age_days !== null && c.age_days !== undefined ? ageBadge(c.age_days) : ""}</div>`).join("") || `<div class="empty">capture zone empty</div>`;

		const wk = d.week;
		if (wk && wk.days) {
			E.weekN.textContent = wk.error ? "calendar read failed" : "";
			E.week.innerHTML = wk.days.map((day: Any) => `
				<div class="day ${day.today ? "today" : ""}">
					<div class="dh"><span>${esc(day.dow)}</span><span>${esc(String(day.date).slice(5))}</span></div>
					${(day.clock || []).map((c: Any) => `<div class="ck">⏱ ${esc(c.id)} due</div>`).join("")}
					${(day.events || []).map((e: Any) => `<div class="ev"><i>${e.all_day ? "all day" : esc(e.start)}</i>${esc(e.subject)}</div>`).join("")}
					${!(day.events || []).length && !(day.clock || []).length ? `<div class="none">—</div>` : ""}
				</div>`).join("");
			E.weeknote.textContent = `outlook read-only · ${wk.managed_hidden} auto-pushed wi_calendar blocks hidden`
				+ ((wk.overdue || []).length ? ` · overdue: ${wk.overdue.map((o: Any) => o.id).join(", ")}` : "")
				+ (wk.error ? ` · ${wk.error}` : "");
		} else {
			E.week.innerHTML = `<div class="empty">calendar off</div>`;
			E.weeknote.textContent = "";
		}
		const st = d.stats || {};
		E.stats.textContent = `${st.open_working ?? "?"} working · ${st.waiting ?? "?"} waiting · ${st.deferred ?? "?"} deferred`;
	}

	private paintTabs(): void {
		const lanes = this.laneList();
		this.els.tabs.innerHTML = lanes.map((b) =>
			`<span class="tab ${b.lane === this.tab ? "on" : ""}" data-act="tab" data-lane="${esc(b.lane)}" title="${b.focal ? "where you last typed · " : ""}${b.working} working">${b.focal ? `<span class="dot"></span>` : ""}${esc(b.lane)}<span class="n">${b.working}</span></span>`
		).join("");
	}

	private paintLane(): void {
		const b = this.laneList().find((x) => x.lane === this.tab);
		if (!b) { this.els.lane.innerHTML = `<div class="empty">no lane has motion, a live seat, or working WIs</div>`; return; }
		let h = "";
		const sp = b.sprint;
		const inSprint = new Set<string>();
		if (sp && (sp.wis || []).length) {
			for (const w of sp.wis) inSprint.add(w.id);
			h += `<div class="sprint"><div class="kicker"><b>SPRINT</b><span>${sp.moving_count} moving this week</span>${seatBadges(sp.seats)}</div>`
				+ sp.wis.map((w: Any) => wiRow(w, w.next ? `next: ${w.next}` : null)).join("") + `</div>`;
		}
		if ((b.repos || []).length) h += `<div class="repos">${b.repos.map(repoChip).join("")}</div>`;
		const rows: Any[] = (b.wis || []).filter((w: Any) => !inSprint.has(w.id));
		const all = !!this.showAll[b.lane];
		const shown = (all || rows.length <= ACTIVE_CAP) ? rows : rows.slice(0, ACTIVE_CAP);
		const more = rows.length > ACTIVE_CAP
			? (all ? `<div class="more" data-act="showall" data-lane="${esc(b.lane)}" data-v="0">show ${ACTIVE_CAP}</div>`
				: `<div class="more" data-act="showall" data-lane="${esc(b.lane)}" data-v="1">show all ${rows.length} · ${rows.length - ACTIVE_CAP} older hidden</div>`)
			: "";
		h += `<h2>active <span class="n">${rows.length}${inSprint.size ? ` · ${inSprint.size} in the sprint above` : ""}</span></h2>`;
		h += rows.length ? shown.map((w) => wiRow(w)).join("") + more : `<div class="empty">nothing else working</div>`;
		this.els.lane.innerHTML = h;
	}

	private paintSwept(s: Any): void {
		let h = "";
		if ((s.stalled_active || []).length) {
			h += `<div class="kind bad">claimed active, untouched ${s.stalled_days}d+</div>`;
			h += s.stalled_active.map((w: Any) => wiRow(w)).join("");
		}
		if ((s.owed || []).length) {
			h += `<div class="kind">waiting on you</div>`;
			h += s.owed.slice(0, 5).map((w: Any) => wiRow(w, w.box)).join("");
		}
		if ((s.rot || []).length) {
			h += `<div class="kind">blocked longest</div>`;
			h += s.rot.slice(0, 3).map((w: Any) => wiRow(w, (w.depends || []).length ? `waits on ${w.depends.join(", ")}` : null)).join("");
		}
		if ((s.unpushed || []).length) {
			h += `<div class="kind">commits nobody can see</div>`;
			h += `<div class="repos">${s.unpushed.map((r: Any) => `<span class="repo"><b>${esc(r.repo)}</b><span class="ahead">+${r.ahead} unpushed</span><span class="ago">${esc(agoTxt(r.last))} ago</span></span>`).join("")}</div>`;
		}
		h += `<div class="sum"><b>${s.survivors ?? "?"}</b> capture survivors never landed · <b>${s.capture_old_count ?? "?"}</b> capture entries older than 7d${(s.capture_oldest || []).length ? ` (oldest ${s.capture_oldest[0].age_days}d)` : ""}${(s.expired_deferred || []).length ? ` · <b>${s.expired_deferred.length}</b> deferrals past review` : ""}</div>`;
		this.els.swept.innerHTML = h || `<div class="empty">nothing swept</div>`;
	}
}
