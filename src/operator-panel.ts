// Operator panel v3.0.0 -- the thread board (SYS-485 thread-board spec,
// session 923; built session 927). One object on the panel: threads.
//
// Contract (the four stacked mechanics of s923 are each closed here):
//   1. Repaint only when the derived rows' hash (threads_hash + tab) changes.
//      Between repaints the only thing that moves is the "typed Nm" text on a
//      live node, updated in place.
//   2. Regenerate only when a watched file's mtime moves -- the registry, the
//      ledger, a roadmap (vault `modify`), or a live seat's JSONL (30s fs.stat
//      poll over data.watch, since JSONLs live outside the vault) -- or on ↻.
//      No clock repaint, no active-leaf-change trigger.
//   3. No ingest spawned from a render. dashboard_data.py runs WITHOUT
//      --ingest here; the ledger ingest is the explicit "mine N unmined"
//      button in the footer, spawned detached.
//   4. Ghost seats never render: threads.py excludes a seat with no JSONL or
//      idle > 7d.
//
// Rows are keyed by thread id (arc id, or seat:N for a new thread) and sorted
// by last activity in Python; the plugin never reorders. Everything shown is
// derived from disk (DL-668).

import { ItemView, WorkspaceLeaf, Notice, TFile, TAbstractFile, Menu } from "obsidian";
import { execFile, spawn } from "child_process";
import * as fs from "fs";
import type DashboardPlugin from "./main";
import { WiIndex, WiHover } from "./wi-card";
import { SessionHover } from "./session-hover";
import { ArcHover } from "./arc-hover";
import { Any, actTxt } from "./render/common";
import { renderHeader } from "./render/header";
import { renderThreadTabs, renderThreadBoard, renderClosed, renderFoot, wiIndex } from "./render/threads";
import { renderOverdue, overdueRows } from "./render/overdue";
import { renderSurfaces } from "./render/surfaces";
import { renderCalendar, calendarSig } from "./render/calendar";
import { listSeats, refusal, typeInto } from "./seat-send";

export const VIEW_TYPE = "vault-dashboard";

const CLAUDE = "00_System/AI/Claude";
const ROADMAPS_DIR = `${CLAUDE}/Roadmaps`;
const GENERATOR = `${CLAUDE}/tools/dashboard/dashboard_data.py`;
const LEDGER_CLI = `${CLAUDE}/tools/dashboard/arc_ledger.py`;
const DATA_REL = `${CLAUDE}/System Operations/state/dashboard-data.json`;
const REGISTRY_REL = `${CLAUDE}/System Operations/session-registry.json`;
const LEDGER_REL = `${CLAUDE}/System Operations/state/session-focus.json`;

const MIN_SCHEMA = 5;
const POLL_MS = 30_000;            // fs.stat poll over data.watch
const DEBOUNCE_MS = 4_000;         // vault modify -> regen (a close writes several files in a burst)
const MIN_REGEN_GAP_MS = 20_000;   // never regenerate more often than this
const LIVE_TICK_MS = 60_000;       // "typed Nm" text refresh, in place
const STALE_ON_OPEN_MS = 90_000;   // data older than this at open -> regen once

interface PyResult { ok: boolean; stdout: string; stderr: string }

export class DashboardView extends ItemView {
	private plugin: DashboardPlugin;
	private data: Any = null;
	private genError: string | null = null;
	private tab: string | null = null;
	private lastHash = "";
	private editingArc: string | null = null;   // an open note editor -> don't clobber it on a background repaint

	private wiIndex: WiIndex | null = null;
	private wiHover: WiHover | null = null;
	private sessHover: SessionHover | null = null;
	private arcHover: ArcHover | null = null;

	private watchSig = "";
	private debounceTimer: number | null = null;
	private regenAt = 0;
	private regenInFlight = false;
	private regenQueued = false;

	constructor(leaf: WorkspaceLeaf, plugin: DashboardPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string { return VIEW_TYPE; }
	getDisplayText(): string { return "Threads"; }
	getIcon(): string { return "layout-dashboard"; }

	async onOpen(): Promise<void> {
		const el = this.contentEl;
		el.empty();
		el.addClass("vault-dashboard", "op-panel");
		el.innerHTML = `<div class="op-wrap">`
			+ `<div class="op-top"><span class="op-gen"></span><button class="op-btn" data-act="refresh" title="regenerate now">↻</button></div>`
			+ `<div class="op-cal-wrap"></div>`
			+ `<div class="op-tabs"></div>`
			+ `<div class="op-board"></div>`
			+ `<div class="op-surf-wrap"></div>`
			+ `<div class="op-attn-wrap"></div>`
			+ `<div class="op-closed"></div>`
			+ `<footer class="op-foot"><span class="op-stats"></span></footer>`
			+ `</div>`;

		this.wiIndex = new WiIndex(this.app, ROADMAPS_DIR);
		this.wiHover = new WiHover(this.wiIndex);
		this.wiHover.attach(el);
		this.sessHover = new SessionHover();
		this.sessHover.attach(el);
		this.arcHover = new ArcHover();
		this.arcHover.attach(el);
		el.addEventListener("click", (e) => this.onClick(e));

		this.tab = ((this.plugin.settings as Any).threadTab as string | undefined) || null;

		this.registerEvent(this.app.vault.on("modify", (f: TAbstractFile) => this.onVaultModify(f)));
		this.registerInterval(window.setInterval(() => this.poll(), POLL_MS));
		this.registerInterval(window.setInterval(() => this.tickLive(), LIVE_TICK_MS));

		await this.loadData();
		this.paint(true);
		this.poll();                                   // seed the watch signature
		const gen = Date.parse(this.data?.generated || "") || 0;
		if (!this.data || (this.data.schema || 0) < MIN_SCHEMA || Date.now() - gen > STALE_ON_OPEN_MS) {
			void this.regen("open");
		}
	}

	async onClose(): Promise<void> {
		if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
		this.wiHover?.dispose(); this.wiHover = null;
		this.sessHover?.dispose(); this.sessHover = null;
		this.arcHover?.dispose(); this.arcHover = null;
	}

	/** main.ts's saveSettings() calls this on every open dashboard leaf. */
	render(): void { this.paint(true); }

	// ------------------------------------------------------------ triggers

	private onVaultModify(f: TAbstractFile): void {
		const p = f.path;
		if (p === DATA_REL) {                              // another session generated -> just re-read
			void this.loadData().then(() => this.paint());
			return;
		}
		if (p === REGISTRY_REL || p === LEDGER_REL || (p.startsWith(ROADMAPS_DIR + "/") && p.endsWith(".md"))) {
			this.scheduleRegen(`vault:${p}`);
		}
	}

	private scheduleRegen(why: string): void {
		if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
		this.debounceTimer = window.setTimeout(() => { this.debounceTimer = null; void this.regen(why); }, DEBOUNCE_MS);
	}

	/** mtime signature over data.watch (registry, ledger, live JSONLs). A moved
	 *  mtime means something a row derives from changed -> regenerate. */
	private poll(): void {
		// Midnight: the calendar's "today" is a date, and nothing in the watch
		// list moves when the day rolls over -- regenerate on the first poll of
		// a new local day.
		const calDay = this.data?.calendar?.days?.[0]?.date;
		if (calDay) {
			const n = new Date();
			const local = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
			if (local !== calDay) void this.regen("date");
		}
		const paths: string[] = this.data?.watch || [];
		if (!paths.length) return;
		let sig = "";
		for (const p of paths) {
			try { sig += `${p}:${fs.statSync(p).mtimeMs};`; } catch (_) { sig += `${p}:x;`; }
		}
		if (this.watchSig && sig !== this.watchSig) void this.regen("watch");
		this.watchSig = sig;
	}

	private async regen(why: string): Promise<void> {
		if (this.regenInFlight) { this.regenQueued = true; return; }
		const wait = MIN_REGEN_GAP_MS - (Date.now() - this.regenAt);
		if (wait > 0) {
			if (this.debounceTimer === null) {
				this.debounceTimer = window.setTimeout(() => { this.debounceTimer = null; void this.regen(why); }, wait);
			}
			return;
		}
		this.regenInFlight = true;
		this.regenAt = Date.now();
		this.setGen("regenerating…");
		const res = await this.runPy(GENERATOR, []);
		this.regenInFlight = false;
		if (!res.ok) {
			this.genError = (res.stderr || res.stdout || "generator failed").trim().split("\n").slice(-1)[0].slice(0, 200);
			this.paintHeader();
		} else {
			this.genError = null;
			await this.loadData();
			this.paint();
			this.poll();
		}
		if (this.regenQueued) { this.regenQueued = false; this.scheduleRegen("queued"); }
	}

	private runPy(scriptRel: string, args: string[]): Promise<PyResult> {
		const base = (this.app.vault.adapter as Any).basePath as string;
		const py = this.plugin.settings.pythonCmd || "python";
		return new Promise((resolve) => {
			execFile(py, [`${base}/${scriptRel}`, ...args], { cwd: base, windowsHide: true, timeout: 150_000, maxBuffer: 8 * 1024 * 1024 },
				(err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ""), stderr: String(stderr || (err ? err.message : "")) }));
		});
	}

	private async loadData(): Promise<void> {
		try {
			const raw = await this.app.vault.adapter.read(DATA_REL);
			this.data = JSON.parse(raw);
		} catch (e: Any) {
			this.genError = `read: ${String(e?.message || e).slice(0, 120)}`;
		}
	}

	// ------------------------------------------------------------ paint

	private setGen(text: string): void {
		const g = this.contentEl.querySelector(".op-gen");
		if (g) g.textContent = text;
	}

	private paintHeader(): void {
		const g = this.contentEl.querySelector(".op-gen");
		if (g) g.innerHTML = renderHeader(this.data, this.genError);
	}

	private paint(force = false): void {
		// A note editor is open and mid-edit -- a background regen/poll repaint would
		// rebuild innerHTML and wipe the textarea. Skip it; save/cancel clears the flag
		// and repaints. A forced repaint (tab switch, ↻) still wins.
		if (this.editingArc && !force) return;
		const el = this.contentEl;
		const cal = el.querySelector(".op-cal-wrap") as HTMLElement | null;
		const board = el.querySelector(".op-board") as HTMLElement | null;
		const tabs = el.querySelector(".op-tabs") as HTMLElement | null;
		const surf = el.querySelector(".op-surf-wrap") as HTMLElement | null;
		const attn = el.querySelector(".op-attn-wrap") as HTMLElement | null;
		const closed = el.querySelector(".op-closed") as HTMLElement | null;
		const foot = el.querySelector(".op-stats") as HTMLElement | null;
		if (!cal || !board || !tabs || !surf || !attn || !closed || !foot) return;
		this.paintHeader();
		if (!this.data) { board.innerHTML = `<div class="empty">no data — ↻ to generate</div>`; return; }
		const schema = this.data.schema || 0;
		if (schema < MIN_SCHEMA) { board.innerHTML = `<div class="empty">regenerate (schema ${schema}, need ${MIN_SCHEMA})</div>`; return; }
		const order: string[] = this.plugin.settings.tabs || [];
		// The overdue strip reads due_in off lanes[].wis, which threads_hash does
		// not cover -- fold a fingerprint of it in so a pure due-date change (no
		// WI status flip) still repaints the strip.
		const idx = wiIndex(this.data);
		const odSig = overdueRows(idx).map((w) => `${w.id}:${w.due_in}`).join(",");
		// surfaces re-rank without any thread changing (a touch moves a neglect
		// bump, a score edit) -- fingerprint them like the overdue strip.
		const sf = this.data.surfaces;
		const sfSig = sf ? [...(sf.big_rocks || []), ...(sf.do_now || [])].map((r: Any) => `${r.id}:${r.rank}:${r.effort}`).join(",") : "";
		// The calendar changes with the date and with Outlook, neither of which a
		// thread or a WI status covers -- fingerprint it too.
		const hash = `${this.data.threads_hash || ""}|${this.tab || ""}|${order.join(",")}|${(this.data.threads_unmined || []).length}|${odSig}|${sfSig}|${calendarSig(this.data)}`;
		if (!force && hash === this.lastHash) { this.tickLive(); return; }
		cal.innerHTML = renderCalendar(this.data, this.tab);
		tabs.innerHTML = renderThreadTabs(this.data, this.tab, order);
		board.innerHTML = renderThreadBoard(this.data, this.tab);
		surf.innerHTML = renderSurfaces(this.data, this.tab);
		attn.innerHTML = renderOverdue(this.data, this.tab, idx);
		closed.innerHTML = renderClosed(this.data, this.tab);
		foot.innerHTML = renderFoot(this.data);
		this.sessHover?.setData(this.data.sessions_log || []);
		this.arcHover?.setData([...(this.data.threads || []), ...(this.data.threads_closed || [])]);
		this.lastHash = hash;
		this.tickLive();
	}

	/** Refresh every live node's "typed Nm" from the latest data plus the time
	 *  elapsed since it was generated -- text only, no repaint. */
	private tickLive(): void {
		if (!this.data) return;
		const gen = Date.parse(this.data.generated || "") || Date.now();
		const drift = Math.max(0, Math.floor((Date.now() - gen) / 60000));
		const seats = new Map<number, Any>();
		for (const r of this.data.threads || []) for (const e of r.live || []) seats.set(e.n, e);
		this.contentEl.querySelectorAll<HTMLElement>("[data-live]").forEach((el) => {
			const e = seats.get(Number(el.dataset.live));
			if (!e) return;
			const txt = e.user_min != null ? `typed ${actTxt(e.user_min + drift)}`
				: e.active_min != null ? `active ${actTxt(e.active_min + drift)}` : "live";
			if (el.textContent !== txt) el.textContent = txt;
		});
	}

	// ------------------------------------------------------------ actions

	private onClick(e: MouseEvent): void {
		const t = (e.target as HTMLElement).closest("[data-act]") as HTMLElement | null;
		if (!t) return;
		const act = t.dataset.act;
		const row = t.closest("[data-thr]") as HTMLElement | null;
		if (act === "refresh") { this.regenAt = 0; void this.regen("manual"); }
		else if (act === "tab") { this.setTab(t.dataset.lane || null); }
		else if (act === "pickup" && row) { void this.copy(row.dataset.pickup || ""); }
		else if (act === "send") { void this.sendMenu(e, t.dataset.send || row?.dataset.pickup || ""); }
		else if (act === "close" && row) { void this.closeThread(row.dataset.thr || ""); }
		else if (act === "reopen" && row) { void this.reopenThread(row.dataset.thr || ""); }
		else if (act === "mine") { this.mine(); }
		else if ((act === "note" || act === "note-edit") && row) { this.toggleNote(row); }
		else if (act === "note-save" && row) { void this.saveNote(row); }
		else if (act === "note-cancel" && row) { this.cancelNote(row); }
		else if (act === "open") { this.wiHover?.hide(); void this.openRoadmap(t.dataset.id || ""); }
	}

	// ------------------------------------------------------------ notes

	private toggleNote(row: HTMLElement): void {
		const ed = row.querySelector(".thr-note-editor") as HTMLElement | null;
		if (!ed) return;
		const opening = ed.hidden;
		ed.hidden = !opening;
		this.editingArc = opening ? (row.dataset.thr || null) : null;
		if (opening) {
			const ta = ed.querySelector(".thr-note-input") as HTMLTextAreaElement | null;
			if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
		}
	}

	private cancelNote(row: HTMLElement): void {
		const ed = row.querySelector(".thr-note-editor") as HTMLElement | null;
		if (ed) ed.hidden = true;
		this.editingArc = null;
	}

	/** Persist the note via arc_ledger.py --note (empty text clears it), then regen so
	 *  the saved note re-renders from the ledger like every other derived field. */
	private async saveNote(row: HTMLElement): Promise<void> {
		const id = row.dataset.thr || "";
		const ta = row.querySelector(".thr-note-input") as HTMLTextAreaElement | null;
		this.editingArc = null;                                   // clear before regen so the repaint lands
		if (!id || id.startsWith("seat:") || !ta) return;
		const text = ta.value.trim();
		const res = await this.runPy(LEDGER_CLI, ["--note", id, "--text", text]);
		if (!res.ok) { new Notice(`note failed: ${(res.stderr || res.stdout).slice(0, 200)}`); return; }
		new Notice(text ? "note saved" : "note cleared");
		this.regenAt = 0;
		void this.regen("note");
	}

	private setTab(lane: string | null): void {
		this.tab = lane;
		(this.plugin.settings as Any).threadTab = lane || "";
		void this.plugin.saveData(this.plugin.settings);      // not saveSettings(): that re-renders every leaf
		this.paint(true);
	}

	private async copy(text: string): Promise<void> {
		if (!text) return;
		try { await navigator.clipboard.writeText(text); new Notice("pickup prompt copied — paste into a seat"); }
		catch (_) { new Notice(`clipboard unavailable — ${text}`); }
	}

	/** Seat picker for send-to-session: every open workspace-shell seat, labeled from
	 *  the registry + the thread board's seat rows; a seat that can't take the text
	 *  stays in the list, disabled, with the reason. */
	private async sendMenu(e: MouseEvent, text: string): Promise<void> {
		if (!text) return;
		const seats = listSeats(this.app);
		const menu = new Menu();
		if (!seats.length) {
			menu.addItem((i) => i.setTitle("no open seat on the desk").setDisabled(true));
			menu.showAtMouseEvent(e);
			return;
		}
		let reg: Any = null;
		try { reg = JSON.parse(await this.app.vault.adapter.read(REGISTRY_REL)); } catch (_) { /* unlabeled seats still send */ }
		const byUuid = new Map<string, [string, Any]>();
		for (const [num, s] of Object.entries((reg?.sessions || {}) as Record<string, Any>)) {
			if (s && s.uuid) byUuid.set(s.uuid, [num, s]);
		}
		const board = new Map<string, Any>();
		for (const s of this.data?.threads_seats || []) board.set(String(s.n), s);
		const rows = seats.map((seat) => {
			const hit = seat.uuid ? byUuid.get(seat.uuid) : undefined;
			const num = hit ? hit[0] : null;
			const b = num ? board.get(num) : null;
			const focus = String(b?.focus || hit?.[1]?.focus || seat.pane.seatLabel?.() || "").trim();
			const label = `${num ? `s${num}` : "no session yet"}${focus ? ` · ${focus.slice(0, 48)}` : ""}${b?.state ? ` · ${b.state}` : ""}`;
			return { seat, num: Number(num || 0), label, why: refusal(seat.state) };
		});
		rows.sort((a, b) => Number(!!a.why) - Number(!!b.why) || b.num - a.num);
		for (const r of rows) {
			menu.addItem((i) => {
				i.setTitle(r.why ? `${r.label} — ${r.why}` : r.label).setDisabled(!!r.why);
				if (!r.why) i.onClick(() => {
					const res = typeInto(this.app, r.seat, text);
					new Notice(res.ok ? `typed into ${r.num ? `s${r.num}` : "the seat"} — review, then Enter` : `not sent: ${res.why}`);
				});
			});
		}
		menu.showAtMouseEvent(e);
	}

	private async closeThread(id: string): Promise<void> {
		if (!id || id.startsWith("seat:")) return;
		const res = await this.runPy(LEDGER_CLI, ["--close", id, "--reason", "closed from the thread board"]);
		if (!res.ok) { new Notice(`close failed: ${(res.stderr || res.stdout).slice(0, 200)}`); return; }
		new Notice(`closed ${id} — ↺ in "closed this week" to undo`);
		this.regenAt = 0;
		void this.regen("close");
	}

	private async reopenThread(id: string): Promise<void> {
		if (!id) return;
		const res = await this.runPy(LEDGER_CLI, ["--reopen", id]);
		if (!res.ok) { new Notice(`reopen failed: ${(res.stderr || res.stdout).slice(0, 200)}`); return; }
		new Notice(`reopened ${id}`);
		this.regenAt = 0;
		void this.regen("reopen");
	}

	/** Explicit ledger ingest -- the ONLY path that mines closed sessions.
	 *  Detached: a mine runs `claude -p` per session and can take minutes; the
	 *  ledger file's vault `modify` event regenerates the board when it lands. */
	private mine(): void {
		const n = (this.data?.threads_unmined || []).length;
		if (!n) return;
		const base = (this.app.vault.adapter as Any).basePath as string;
		const py = this.plugin.settings.pythonCmd || "python";
		try {
			const child = spawn(py, [`${base}/${LEDGER_CLI}`, "--ingest", "--max", String(n)],
				{ cwd: base, detached: true, stdio: "ignore", windowsHide: true });
			child.unref();
			new Notice(`mining ${n} closed session${n === 1 ? "" : "s"} in the background — the board updates when the ledger changes`);
		} catch (e: Any) {
			new Notice(`mine failed to start: ${String(e?.message || e).slice(0, 160)}`);
		}
	}

	private async openRoadmap(id: string): Promise<void> {
		const info = this.wiIndex?.lookup(id);
		if (!info) { new Notice(`no roadmap entry for ${id}`); return; }
		const path = `${ROADMAPS_DIR}/${info.fileBase}.md`;
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) { new Notice(`no roadmap file at ${path}`); return; }
		let line = 0;
		try {
			const lines = (await this.app.vault.cachedRead(file)).split(/\r?\n/);
			const i = lines.findIndex((l) => l.startsWith(`### ${id}:`));
			if (i >= 0) line = i;
		} catch (_) { /* open at top */ }
		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.openFile(file, { eState: { line } });
	}
}
