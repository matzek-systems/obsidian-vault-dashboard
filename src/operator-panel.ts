// ── Operator Panel (SYS-485, session 911) ────────────────────────────
// The dashboard view, rebuilt as a pure renderer of dashboard-data.json.
// Everything on screen is DERIVED by tools/dashboard/dashboard_data.py from
// state that already exists (git, roadmaps, registry, board, Outlook read-only);
// this file holds no roadmap parsing and no hand-fed state.
//
// Render discipline (the s883-s911 "renders twice" bug): the skeleton is built
// ONCE in onOpen; refresh() is serialized (one in flight, at most one pending)
// and carries a generation counter so a superseded async load never paints.
// Sub-panels are repainted by replacing their own innerHTML — never empty()+append
// on the root while another render is in flight.

import { ItemView, WorkspaceLeaf, Notice } from "obsidian";
import { execFile } from "child_process";
import type DashboardPlugin from "./main";

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

function ageBadge(a: number | null | undefined): string {
	if (a === null || a === undefined) return `<span class="age rot">90d+</span>`;
	return `<span class="age ${a > 14 ? "rot" : a > 5 ? "old" : ""}">${a}d</span>`;
}
function dueBadge(w: Any): string {
	if (w.due_in === null || w.due_in === undefined) return "";
	return w.due_in < 0
		? `<span class="age rot">${-w.due_in}d overdue</span>`
		: `<span class="age ${w.due_in <= 3 ? "old" : ""}">in ${w.due_in}d</span>`;
}
const actTxt = (m: number): string => (m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`);
function agoTxt(iso: string | null | undefined): string {
	if (!iso) return "";
	const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
	return m < 60 ? `${m}m` : m < 2880 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
}
// Delivered work that never got a WI still leaves commits in a dev repo (s911 miners: 22 of 63 real
// sessions shipped under no WI). repos.json maps repo dirs to lanes; the generator reads them directly.
function repoRow(r: Any): string {
	const flags = [r.ahead ? `<span class="age old">+${r.ahead} unpushed</span>` : "", r.dirty ? `<span class="age">dirty</span>` : ""].filter(Boolean).join(" ");
	return `<div class="repo" title="${esc(r.repo)} · ${r.commits_28d} commits/28d"><span class="rname">${esc(r.repo)}</span><b>${r.commits_7d}</b><span class="dim">/7d</span><span class="dim">${esc(agoTxt(r.last))} ago</span><span class="rsub">${esc(r.last_subject)}</span>${flags}</div>`;
}
function seatBadges(seats: Any[]): string {
	return (seats || []).map((s) =>
		`<span class="seat ${esc(s.tier)}" title="seat activity ${s.active_min == null ? "?" : actTxt(s.active_min)} ago">s${s.n} · ${s.user_min != null ? "typed " + actTxt(s.user_min) : (s.active_min == null ? "?" : actTxt(s.active_min))}</span>`
	).join("");
}
function contPrompt(id: string): string {
	return `Continue ${id} — read its detail section in the Roadmap, check the latest session state, and pick up the next unchecked task.`;
}
function laneOf(w: Any): string {
	if (w.lane) return String(w.lane).replace(" Roadmap", "");
	const m = /^([A-Z]+)-/.exec(String(w.id || ""));
	const map: Record<string, string> = { SYS: "_System", SOMA: "SomaGuard", MM: "MatzekMedia", WI: "PKM", CH: "ContentHoarder", JANE: "Jane", LD: "Lawndash", LWP: "Local Web Pitch", WCMC: "WCMC" };
	return m ? (map[m[1]] || m[1]) : "";
}
function wiRow(w: Any, cls: string): string {
	return `<div class="${cls} ${esc(w.status)}">
		<div><span class="tid" data-act="open" data-id="${esc(w.id)}" data-lane="${esc(laneOf(w))}" title="open roadmap">${esc(w.id)}</span><span class="ttl">${esc(w.title)}</span><span class="st ${esc(w.status)}">${esc(w.status)}</span><button class="rcopy" data-act="copy" data-id="${esc(w.id)}" title="copy continue-prompt">⧉</button></div>
		${cls === "frow" && w.next ? `<div class="next">${esc(w.next)}</div>` : ""}
	</div>
	<div class="right">${w.tasks_done}/${w.tasks_total} · ${ageBadge(w.age_days)}${w.due ? " · " + dueBadge(w) : ""}</div>`;
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

	constructor(leaf: WorkspaceLeaf, plugin: DashboardPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string { return "vault-dashboard"; }
	getDisplayText(): string { return "Operator Panel"; }
	getIcon(): string { return "layout-dashboard"; }

	async onOpen(): Promise<void> {
		this.navigation = false;
		this.contentEl.addClass("vault-dashboard", "op-panel");
		this.buildSkeleton();
		this.contentEl.addEventListener("click", (e) => this.onClick(e));
		this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
			if (leaf === this.leaf) void this.refresh(false);
		}));
		this.registerInterval(window.setInterval(() => void this.refresh(false), REFRESH_MS));
		await this.refresh(true);
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
				this.els.gen.textContent = `data unavailable — ${msg.slice(0, 160)}`;
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
			<header class="op-head">
				<div class="op-brand"><b>ALL VAULT</b> · OPERATOR PANEL</div>
				<div class="op-infra"></div>
				<div class="op-stamp"><span class="op-pulse"></span><span class="op-gen">loading…</span><button class="op-btn" data-act="refresh" title="regenerate now">↻</button></div>
			</header>
			<div class="op-focal"></div>
			<div class="op-others"></div>
			<div class="op-mix"></div>
			<div class="op-main">
				<section><h2>active list <span class="n op-lanes-n"></span></h2><div class="op-tabs"></div><div class="op-lane-rows"></div></section>
				<div class="op-rail">
					<section><h2>clock</h2><div class="op-clock"></div></section>
					<section><h2>swept under the rug</h2><div class="op-swept"></div></section>
					<section><h2>could do <span class="n">(no deadline, highest leverage)</span></h2><div class="op-could"></div></section>
				</div>
			</div>
			<section><h2>week <span class="n op-week-n"></span></h2><div class="op-week"></div><div class="op-weeknote"></div></section>
			<div class="op-lower">
				<section><h2>open seats <span class="n op-sess-n"></span></h2><div class="op-sess"></div></section>
				<section><h2>capture zone <span class="n op-cap-n"></span></h2><div class="op-cap"></div></section>
			</div>
			<footer class="op-foot"><span>every panel derived · sprint = declared seats + git motion + active status · nothing hand-maintained</span><span class="op-stats"></span></footer>
		</div>`;
		const q = (sel: string): HTMLElement => c.querySelector(sel) as HTMLElement;
		this.els = {
			infra: q(".op-infra"), gen: q(".op-gen"), focal: q(".op-focal"), others: q(".op-others"), mix: q(".op-mix"),
			lanesN: q(".op-lanes-n"), tabs: q(".op-tabs"), laneRows: q(".op-lane-rows"),
			clock: q(".op-clock"), swept: q(".op-swept"), could: q(".op-could"),
			weekN: q(".op-week-n"), week: q(".op-week"), weeknote: q(".op-weeknote"),
			sessN: q(".op-sess-n"), sess: q(".op-sess"), capN: q(".op-cap-n"), cap: q(".op-cap"), stats: q(".op-stats"),
		};
	}

	// ── actions ────────────────────────────────────────────────────

	private onClick(e: MouseEvent): void {
		const t = (e.target as HTMLElement).closest("[data-act]") as HTMLElement | null;
		if (!t) return;
		const act = t.dataset.act;
		if (act === "refresh") void this.refresh(true);
		else if (act === "tab") { this.tab = t.dataset.lane || null; this.paintLanes(); }
		else if (act === "copy") void this.copyPrompt(t.dataset.id || "");
		else if (act === "showall") { this.showAll[t.dataset.lane || ""] = t.dataset.v === "1"; this.paintLanes(); }
		else if (act === "open") void this.openRoadmap(t.dataset.lane || "", t.dataset.id || "");
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
		// Jump to the WI heading when the editor is up.
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
		E.gen.textContent = "generated " + String(d.generated || "").slice(0, 16).replace("T", " ") + ` · ${d.gen_ms}ms` + (this.genError ? ` · generator: ${this.genError}` : "");
		const inf = d.infra;
		E.infra.innerHTML = inf ? (inf.procs || []).filter((p: Any) => !String(p.label).startsWith("other")).map((p: Any) => `<span class="d ${p.ok ? "" : "bad"}"><i></i>${esc(p.label)}</span>`).join("") : "";

		const sprints: Any[] = d.sprints || [];
		const focal = sprints.find((s) => s.focal) || sprints[0];
		this.paintFocal(focal, d.sessions || []);
		E.others.innerHTML = sprints.filter((s) => s !== focal).map((sp) => `
			<div class="other" data-act="tab" data-lane="${esc(sp.lane)}">
				<div class="lane">${esc(sp.lane)} ${seatBadges(sp.seats)}</div>
				<div class="sub">${sp.moving_count} moving · ${sp.wis.filter((w: Any) => w.status === "active").length} active</div>
				<div class="ids">${sp.wis.slice(0, 4).map((w: Any) => esc(w.id)).join(" · ")}</div>
			</div>`).join("");
		this.paintMix(d.lane_mix || []);
		this.paintLanes();

		E.clock.innerHTML = (d.clock || []).length
			? d.clock.map((w: Any) => `<div class="rrow"><span class="tid" data-act="open" data-id="${esc(w.id)}" data-lane="${esc(laneOf(w))}">${esc(w.id)}</span><span class="ttl">${esc(w.title)}</span>${dueBadge(w)}</div>`).join("")
			: `<div class="empty">no deadlines inside 45d</div>`;
		this.paintSwept(d.swept || {});
		const could: Any[] = (d.could_do || []).filter((c: Any) => !c.error);
		E.could.innerHTML = could.map((c) => `
			<div class="could"><span class="tid" data-act="open" data-id="${esc(c.id)}" data-lane="${esc(laneOf(c))}">${esc(c.id)}</span><span class="ttl">${esc(c.title)}</span><button class="rcopy" data-act="copy" data-id="${esc(c.id)}">⧉</button>
				<div class="why">${esc(String(c.lane || "").replace(" Roadmap", ""))} · ${esc(c.why)}</div></div>`).join("")
			|| `<div class="empty">${esc((d.could_do || [])[0]?.error || "nothing")}</div>`;

		const wk = d.week;
		if (wk && wk.days) {
			E.weekN.textContent = wk.error ? "(calendar read failed)" : "";
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

		const ss: Any[] = d.sessions || [];
		E.sessN.textContent = `(${ss.length})`;
		E.sess.innerHTML = ss.map((s) => {
			const tier = s.tier === "idle" ? "" : s.tier;
			const right = tier ? `<span class="sact">${s.user_min != null ? "typed " + actTxt(s.user_min) : actTxt(s.active_min)}</span>` : `<span class="age ${s.age_days > 3 ? "old" : ""}">${s.age_days ?? "?"}d</span>`;
			return `<div class="srow"><span class="sdot ${esc(tier)}"></span><span class="sn">s${s.n}</span><span class="sf">${s.lane ? `<i>${esc(s.lane)} · </i>` : ""}${s.focus ? esc(s.focus) : "<i>no focus set</i>"}</span>${right}</div>`;
		}).join("") || `<div class="empty">registry unreadable</div>`;

		const cap: Any[] = d.capture || [];
		E.capN.textContent = `(${d.capture_total ?? cap.length})`;
		E.cap.innerHTML = cap.map((c) => `<div class="crow"><span class="ttl">${esc(c.title)}</span>${c.age_days !== null && c.age_days !== undefined ? `<span class="age ${c.age_days > 7 ? "rot" : c.age_days > 3 ? "old" : ""}">${c.age_days}d</span>` : ""}</div>`).join("") || `<div class="empty">capture zone empty</div>`;
		const st = d.stats || {};
		E.stats.textContent = `${st.open_working ?? "?"} working · ${st.waiting ?? "?"} waiting · ${st.deferred ?? "?"} deferred`;
	}

	private paintFocal(sp: Any, sessions: Any[]): void {
		const E = this.els;
		if (!sp) { E.focal.innerHTML = `<div class="empty">no lane has motion or a live seat</div>`; return; }
		// Thread rows: what each seat in this lane is actually doing (registry focus).
		// Seats with no WI at all still get a row — the s911 miners found two of the
		// week's heaviest sessions touched no WI, and a WI-only block showed them empty.
		const byN: Record<string, Any> = {};
		for (const s of sessions) byN[String(s.n)] = s;
		const threads = (sp.seats || []).map((st: Any) => {
			const s = byN[String(st.n)] || {};
			const txt = s.focus || "(no focus set — SYS-489 will declare it from the prompt)";
			return `<div class="thread"><span class="sn">s${st.n}</span><span class="tx">${esc(txt)}</span><span class="tm">${st.user_min != null ? "typed " + actTxt(st.user_min) : (st.active_min != null ? actTxt(st.active_min) : "")}</span></div>`;
		}).join("");
		E.focal.innerHTML = `
			<div class="kicker"><span>sprint — ${esc(sp.lane)}</span>${seatBadges(sp.seats)}<span class="dim">${sp.moving_count} moving this week</span></div>
			<h1>${esc(sp.lane)}<small>${sp.wis.length} in the sprint</small></h1>
			${threads ? `<div class="threads">${threads}</div>` : ""}
			${sp.wis.map((w: Any) => `<div class="frow-wrap">${wiRow(w, "frow")}</div>`).join("")}`;
	}

	private paintMix(m: Any[]): void {
		const rows = (m || []).filter((r) => r.wis_7d || r.commits_7d || r.files_7d);
		this.els.mix.innerHTML = rows.length
			? `<span class="k">worked · 7d</span>` + rows.map((r) =>
				`<span class="item" title="${esc(r.lane)}: ${r.wis_28d} WIs, ${r.commits_28d || 0} commits in 28d${(r.repos || []).length ? ` · ${esc(r.repos.join(", "))}` : ""}"><span class="lane">${esc(r.lane)}</span> <b>${r.wis_7d}</b><span class="dim"> WIs</span>${r.commits_7d ? ` <b>${r.commits_7d}</b><span class="dim"> commits</span>` : ""}${r.files_7d ? ` <b>${r.files_7d}</b><span class="dim"> files</span>` : ""}</span>`).join("")
			: "";
	}

	private paintLanes(): void {
		const d = this.data;
		const E = this.els;
		if (!d) return;
		const lanes: Any[] = (d.lanes || []).filter((b: Any) => b.working > 0);
		if (!this.tab || !lanes.find((b) => b.lane === this.tab)) this.tab = lanes[0]?.lane ?? null;
		E.lanesN.textContent = `(${d.stats?.open_working ?? "?"} working across ${lanes.length} lanes)`;
		E.tabs.innerHTML = lanes.map((b) => `<span class="tab ${b.lane === this.tab ? "on" : ""}" data-act="tab" data-lane="${esc(b.lane)}">${esc(b.lane)}<span class="n">${b.working}</span></span>`).join("");
		const b = lanes.find((x) => x.lane === this.tab);
		const rows: Any[] = b ? b.wis : [];
		const all = !!this.showAll[this.tab || ""];
		const shown = (all || rows.length <= ACTIVE_CAP) ? rows : rows.slice(0, ACTIVE_CAP);
		const more = rows.length > ACTIVE_CAP
			? (all ? `<div class="more" data-act="showall" data-lane="${esc(this.tab)}" data-v="0">show ${ACTIVE_CAP}</div>`
				: `<div class="more" data-act="showall" data-lane="${esc(this.tab)}" data-v="1">show all ${rows.length} · ${rows.length - ACTIVE_CAP} older hidden</div>`)
			: "";
		const repoH = b && (b.repos || []).length ? `<div class="repos">${b.repos.map(repoRow).join("")}</div>` : "";
		E.laneRows.innerHTML = repoH + (rows.length
			? shown.map((w) => `<div class="lrow-wrap">${wiRow(w, "lrow")}</div>`).join("") + more
			: `<div class="empty">nothing working</div>`);
	}

	private paintSwept(s: Any): void {
		let h = "";
		if ((s.stalled_active || []).length) {
			h += `<div class="kind bad">claimed active, untouched ${s.stalled_days}d+</div>`;
			h += s.stalled_active.map((w: Any) => `<div class="rrow"><span class="tid" data-act="open" data-id="${esc(w.id)}" data-lane="${esc(laneOf(w))}">${esc(w.id)}</span><span class="ttl">${esc(w.title)}</span>${ageBadge(w.age_days)}</div>`).join("");
		}
		if ((s.owed || []).length) {
			h += `<div class="kind">waiting on you</div>`;
			h += s.owed.slice(0, 5).map((w: Any) => `<div class="box"><b data-act="open" data-id="${esc(w.id)}" data-lane="${esc(laneOf(w))}">${esc(w.id)}</b> ${ageBadge(w.age_days)} — ${esc(w.box)}</div>`).join("");
		}
		if ((s.rot || []).length) {
			h += `<div class="kind">blocked longest</div>`;
			h += s.rot.slice(0, 3).map((w: Any) => `<div class="rrow"><span class="tid" data-act="open" data-id="${esc(w.id)}" data-lane="${esc(laneOf(w))}">${esc(w.id)}</span><span class="ttl">${esc(w.title)}${(w.depends || []).length ? ` <span class="dep">← ${w.depends.map(esc).join(",")}</span>` : ""}</span>${ageBadge(w.age_days)}</div>`).join("");
		}
		if ((s.unpushed || []).length) {
			h += `<div class="kind">commits nobody can see</div>`;
			h += s.unpushed.map((r: Any) => `<div class="rrow"><span class="tid">${esc(r.repo)}</span><span class="ttl">${r.ahead} unpushed${r.lane ? ` · ${esc(r.lane)}` : ""}</span><span class="age">${esc(agoTxt(r.last))}</span></div>`).join("");
		}
		h += `<div class="sum"><b>${s.survivors ?? "?"}</b> capture survivors never landed · <b>${s.capture_old_count ?? "?"}</b> capture-zone entries older than 7d${(s.capture_oldest || []).length ? ` (oldest ${s.capture_oldest[0].age_days}d)` : ""}${(s.expired_deferred || []).length ? ` · <b>${s.expired_deferred.length}</b> deferrals past review` : ""}</div>`;
		this.els.swept.innerHTML = h || `<div class="empty">nothing swept</div>`;
	}
}
