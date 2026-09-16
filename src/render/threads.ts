// Thread board render (SYS-485 thread-board spec, session 923; built session 927).
// Pure string renderers over dashboard-data.json schema 5 -- no Obsidian, no
// DOM, so tools/render-preview.mjs can import this under plain Node.
//
// One object. A row per open thread (an arc from the ledger, or a live seat
// whose work joins no open arc = a "new thread"). Everything on a row is
// derived in tools/dashboard/threads.py; this file only lays it out:
//
//   label · lane                                         age  ⧉  ✕
//   917 → 921 → ●927 typed 3m
//   last event: handoff  David presses start            SOMA-20 ·7d
//
// No phase chip (session 931): "EXECUTING" was just the last mined event's
// category re-worded — stale the moment the session ended, and it read as a
// present-tense claim ("wi backlog is executing" when nothing was). The last
// event line already says what actually happened. Threads whose chain fell
// out of the ACTIVE_WINDOW fold into "older N".
//
// Live seats show as a filled node with a "typed Nm" tail; a dotted node is
// a PROBABLE join (lane match only, not yet confirmed by the close pipeline).
// ⧉ copies the pickup prompt for that thread; ✕ rules it closed (arc_ledger.py
// --close, reversible from the "closed this week" fold).
//
// WI chips carry a badge when the WI itself needs a look (session 931):
// overdue (red, days), due within 7d (yellow), every task ticked (green ✓,
// "close it?"). Waiting-on-who and age stay in the chip tooltip / hover card.
// The fields come from the per-lane WI lists already in the JSON (wiIndex);
// the thread rows themselves carry only id + status + task counts.

import { Any, esc, actTxt, sendBtn } from "./common";

export const EVENT_LABEL: Record<string, string> = {
	shipped: "shipped",
	declared_done: "declared done",
	found_broken: "found broken",
	root_caused: "root caused",
	false_alarm: "false alarm",
	handoff: "handoff",
	dead: "dead session",
	filed: "WI filed",
	decision: "decision",
	waiting_on_operator: "waiting on you",
	waiting_on_them: "waiting on them",
};

/** "2026-08-28 → 2026-08-31" (or the one date) for an arc / thread row. */
export function arcSpan(a: Any): string {
	const sessions: Any[] = a.sessions || a.chain || [];
	const first = sessions[0];
	const last = sessions[sessions.length - 1];
	if (!first) return "";
	return sessions.length === 1 || !last || first.date === last.date
		? (first.date || "")
		: `${first.date ?? "?"} → ${last.date ?? "?"}`;
}

export interface LaneTab { lane: string; n: number; live: number }

/** Lanes that have at least one open thread, with counts. `order` (the plugin's
 *  tabs setting) pins an explicit order; otherwise busiest-live first. */
export function threadLanes(data: Any, order: string[] = []): LaneTab[] {
	const rows: Any[] = data?.threads || [];
	const by = new Map<string, LaneTab>();
	for (const r of rows) {
		const lane = r.lane || "unplaced";
		const t = by.get(lane) || { lane, n: 0, live: 0 };
		t.n += 1;
		t.live += (r.live || []).length;
		by.set(lane, t);
	}
	const all = [...by.values()];
	if (order && order.length) {
		const idx = (l: string) => { const i = order.indexOf(l); return i === -1 ? 999 : i; };
		all.sort((a, b) => idx(a.lane) - idx(b.lane) || b.live - a.live || b.n - a.n || a.lane.localeCompare(b.lane));
	} else {
		all.sort((a, b) => b.live - a.live || b.n - a.n || a.lane.localeCompare(b.lane));
	}
	return all;
}

export function rowsForTab(data: Any, tab: string | null): Any[] {
	const rows: Any[] = data?.threads || [];
	if (!tab) return rows;
	if (tab === "unplaced") return rows.filter((r) => !r.lane);
	return rows.filter((r) => r.lane === tab || (r.lanes || []).includes(tab));
}

export function renderThreadTabs(data: Any, tab: string | null, order: string[] = []): string {
	const lanes = threadLanes(data, order);
	const total = (data?.threads || []).length;
	const liveTotal = lanes.reduce((s, l) => s + l.live, 0);
	const one = (label: string, lane: string, n: number, live: number) =>
		`<span class="tab${(tab || "") === lane ? " on" : ""}" data-act="tab" data-lane="${esc(lane)}">${esc(label)}`
		+ `${live ? `<span class="dot"></span>` : ""}<span class="n">${n}</span></span>`;
	return one("ALL", "", total, liveTotal) + lanes.map((l) => one(l.lane === "_System" ? "System" : l.lane, l.lane, l.n, l.live)).join("");
}

/** id → WI record, merged from every lane's working list (`wis`: due_in,
 *  age_days, title) and its NOW / NEXT / WAITING tiers (flip_me, waiting_on,
 *  why). Render-only: every field already ships in schema 5. Built once per
 *  paint and handed down; chips look up by id. */
export function wiIndex(data: Any): Map<string, Any> {
	const idx = new Map<string, Any>();
	for (const L of data?.lanes || []) {
		for (const key of ["wis", "now", "next", "waiting"]) {
			for (const w of (L && L[key]) || []) {
				if (!w || !w.id) continue;
				idx.set(w.id, Object.assign(idx.get(w.id) || {}, w));
			}
		}
	}
	return idx;
}

/** Visible badge + tooltip for one WI chip. Badge only when the WI needs a
 *  look; the tooltip carries title, waiting-on-who and age. */
export function chipExtra(w: Any | undefined): { badge: string; title: string; flag: boolean } {
	if (!w) return { badge: "", title: "", flag: false };
	const tips: string[] = [];
	let badge = "";
	const due = w.due_in;
	if (typeof due === "number" && due < 0) {
		badge += `<i class="tb over">${-due}d</i>`;
		tips.push(`overdue ${-due}d`);
	} else if (typeof due === "number" && due <= 7) {
		badge += `<i class="tb due">${due === 0 ? "today" : `${due}d`}</i>`;
		tips.push(due === 0 ? "due today" : `due in ${due}d`);
	}
	if (w.flip_me) {
		badge += `<i class="tb flip">✓</i>`;
		tips.push(`all ${w.tasks_done ?? "?"}/${w.tasks_total ?? "?"} ticked · close it?`);
	}
	const wo = w.waiting_on;
	if (wo && wo.who) tips.push(`waiting on ${wo.who}${wo.since_days != null ? ` · ${wo.since_days}d${wo.since_capped ? "+" : ""}` : ""}`);
	if (w.age_days != null && w.age_days >= 7) tips.push(`untouched ${w.age_days}d`);
	if (w.title) tips.unshift(w.title);
	return { badge, title: tips.join("\n"), flag: badge !== "" };
}

function liveTail(e: Any): string {
	if (e.user_min != null) return `typed ${actTxt(e.user_min)}`;
	if (e.active_min != null) return `active ${actTxt(e.active_min)}`;
	return "live";
}

function liveChip(e: Any): string {
	const why = e.join === "probable" ? "probable: joined by lane, unconfirmed until close"
		: e.join === "new" ? "no open thread in this lane yet"
		: "declared: shares a WI with this thread";
	// W3 divergence (s984): the seat's tail activity sits under another thread's
	// footprint — say so in words next to the chip, placement unchanged.
	const working = e.working
		? `<em class="thr-working" title="this seat's recent file activity sits under ${esc(e.working)}">working ${esc(e.working)}</em>`
		: "";
	return `<span class="thr-s live ${esc(e.tier || "")} ${esc(e.join || "")}" data-sess="${esc(e.n)}" title="${esc(why)}">`
		+ `<i class="thr-dot"></i>${esc(e.n)}<em class="thr-typed" data-live="${esc(e.n)}">${esc(liveTail(e))}</em></span>${working}`;
}

function chainHtml(r: Any): string {
	const nodes: string[] = [];
	for (const c of r.chain || []) {
		const evs: string[] = c.events || [];
		const cls = evs.length ? ` ev-${esc(evs[evs.length - 1])}` : "";
		nodes.push(`<span class="thr-s${cls}${c.dead ? " dead" : ""}" data-sess="${esc(c.n)}">${esc(c.n)}</span>`);
	}
	for (const e of r.live || []) nodes.push(liveChip(e));
	return nodes.join(`<span class="thr-arrow">→</span>`);
}

const CLOSERS = new Set(["shipped", "decision", "declared_done"]);
const LIVE_WI = new Set(["active", "ready", "needs-testing", "blocked", "waiting"]);

/** The live WI's next step for a thread, preferring a live wi_row that actually
 *  carries a next task. Returns null when no WI on the thread has one. */
function nextStep(r: Any, idx: Map<string, Any>): { id: string; text: string } | null {
	const ids: string[] = [];
	for (const w of r.wi_rows || []) if (w.id && LIVE_WI.has(String(w.status || ""))) ids.push(w.id);
	for (const w of r.wi_rows || []) if (w.id && !ids.includes(w.id)) ids.push(w.id);
	for (const id of r.wis || []) if (!ids.includes(id)) ids.push(id);
	for (const id of ids) {
		const w = idx.get(id);
		const nx = w && (w.next || w.next_task);
		if (nx) return { id, text: String(nx) };
	}
	return null;
}

function lastHtml(r: Any, idx: Map<string, Any>): string {
	const l = r.last || {};
	// An OPEN thread whose last mined event is a closer (shipped/decision/declared_done)
	// reads as "done" -- it is only still open because a WI is live. Show that WI's next
	// step so the row says what is LEFT, not what already shipped (session 941). The
	// closer stays visible as a small tag on the right.
	if (r.open && CLOSERS.has(String(l.type || ""))) {
		const ns = nextStep(r, idx);
		if (ns) {
			const was = EVENT_LABEL[l.type] || l.type;
			return `<b class="thr-ev next">next</b><span class="thr-txt">${esc(ns.text)}</span>`
				+ `<span class="thr-was" title="last mined event on this thread">${esc(was)}</span>`;
		}
	}
	if (!l.n) return `<span class="thr-none">not yet mined</span>`;
	const ev = l.type ? `<b class="thr-ev ${esc(l.type)}">${esc(EVENT_LABEL[l.type] || l.type)}</b>` : `<b class="thr-ev">s${esc(l.n)}</b>`;
	const txt = l.text || l.note || "";
	return `${ev}<span class="thr-txt">${esc(txt)}</span>`;
}

/** The operator note area: the saved note (click to edit) + a hidden editor
 *  carrying the fuller mined summary and a textarea. New-thread rows (no arc
 *  id yet) get nothing -- a note needs an arc id to key on in the ledger. */
function noteHtml(r: Any): string {
	if (r.kind === "new") return "";
	const note = r.op_note && r.op_note.text ? String(r.op_note.text) : "";
	const summary = r.summary ? String(r.summary) : "";
	const display = note
		? `<div class="thr-note" data-act="note-edit" title="click to edit">📝 <span class="thr-note-txt">${esc(note)}</span></div>`
		: "";
	const editor = `<div class="thr-note-editor" hidden>`
		+ (summary ? `<div class="thr-summary" title="the mined session summary">${esc(summary)}</div>` : "")
		+ `<textarea class="thr-note-input" rows="3" placeholder="add a note — call outcomes, next moves, context…">${esc(note)}</textarea>`
		+ `<div class="thr-note-btns"><button class="thr-btn note-save" data-act="note-save">save</button>`
		+ `<button class="thr-btn note-cancel" data-act="note-cancel">cancel</button></div>`
		+ `</div>`;
	return display + editor;
}

/** Up to 4 chips. A badged chip (overdue / due-soon / all-ticked) sorts ahead
 *  of the rest so the cap never hides the one that needs a look. */
function wiChips(r: Any, idx: Map<string, Any>): string {
	const rows: Any[] = r.wi_rows || [];
	const seen = new Set<string>();
	const out: { html: string; flag: boolean }[] = [];
	const push = (id: string, status: string) => {
		const x = chipExtra(idx.get(id));
		const html = `<span class="tid c-${esc(status)}" data-id="${esc(id)}" data-act="open"${x.title ? ` title="${esc(x.title)}"` : ""}>${esc(id)}${x.badge}</span>`;
		out.push({ html, flag: x.flag });
	};
	for (const w of rows) {
		if (!w.id || seen.has(w.id)) continue;
		seen.add(w.id);
		push(w.id, w.status || "");
	}
	for (const id of r.wis || []) {
		if (seen.has(id)) continue;
		seen.add(id);
		const w = idx.get(id);
		push(id, (w && w.status) || "");
	}
	out.sort((a, b) => Number(b.flag) - Number(a.flag));
	return out.slice(0, 4).map((c) => c.html).join("");
}

export function renderThreadRow(r: Any, showLane: boolean, idx: Map<string, Any> = new Map()): string {
	const isNew = r.kind === "new";
	const live = (r.live || []).length > 0;
	const lane = showLane && r.lane ? `<span class="thr-lane">${esc(r.lane === "_System" ? "System" : r.lane)}</span>` : "";
	const stream = r.stream ? `<span class="thr-stream" title="stream (Threads.md)">${esc(r.stream)}</span>` : "";
	const recur = r.recurring
		? `<span class="thr-recur" title="3+ sessions inside 10 days outside every declared thread">recurring — declare a thread?</span>`
		: "";
	const label = isNew
		? `<span class="thr-lbl new">new thread</span><span class="thr-focus">${esc(r.label || "")}</span>`
		: `<span class="thr-lbl" data-arc="${esc(r.id)}">${esc(r.label || r.id)}</span>${stream}${recur}`;
	const age = r.age_days != null ? `<span class="thr-age${r.age_days >= 10 ? " old" : ""}">${esc(r.age_days)}d</span>` : "";
	const btns = sendBtn()
		+ `<button class="thr-btn" data-act="pickup" title="copy the pickup prompt">⧉</button>`
		+ (isNew ? "" : `<button class="thr-btn" data-act="note" title="add / edit a note">✎</button>`)
		+ (isNew ? "" : `<button class="thr-btn" data-act="close" title="close this thread">✕</button>`);
	return `<div class="thr-row${live ? " live" : ""}${isNew ? " new" : ""}" data-thr="${esc(r.id)}" data-pickup="${esc(r.pickup || "")}">`
		+ `<div class="thr-main">${label}${lane}</div>`
		+ `<div class="thr-meta">${wiChips(r, idx)}${age}${btns}</div>`
		+ `<div class="thr-chain">${chainHtml(r)}</div>`
		+ `<div class="thr-last">${lastHtml(r, idx)}</div>`
		+ (isNew ? "" : `<div class="thr-note-wrap">${noteHtml(r)}</div>`)
		+ `</div>`;
}

/** ACTIVE window. Day-based since s984 (W4: a window counted in session NUMBERS
 *  shrank to ~5.7 real days at ~3.5 sessions/day and buried date-ranked work).
 *  A row is ACTIVE when a live seat sits on it or its last touch is within
 *  ACTIVE_DAYS. Everything else folds — still there, no longer ambient.
 *  ACTIVE_WINDOW/latestSessionN stay exported for the schema<spine fallback. */
export const ACTIVE_DAYS = 10;
export const ACTIVE_WINDOW = 20;

export function latestSessionN(data: Any): number {
	let n = 0;
	for (const s of data?.threads_seats || []) n = Math.max(n, s.n || 0);
	for (const r of data?.threads || []) for (const c of r.chain || []) n = Math.max(n, c.n || 0);
	return n;
}

function rowActive(r: Any): boolean {
	return (r.live || []).length > 0 || (r.age_days != null && r.age_days <= ACTIVE_DAYS);
}

/** One live seat as a single line (session 975; the shape renderSeatStrip used
 *  inline before the spine sections needed it too). */
function seatLine(r: Any, showLane: boolean, idx: Map<string, Any>): string {
	const e = (r.live || [])[0] || { n: String(r.id || "").replace("seat:", ""), join: "new" };
	const lane = showLane && r.lane ? `<span class="thr-lane">${esc(r.lane === "_System" ? "System" : r.lane)}</span>` : "";
	const decl = r.declared_thread
		? `<em class="thr-working" title="the seat's declared WI belongs to ${esc(r.declared_thread)}; placement follows its real file activity">declared ${esc(r.declared_thread)}</em>`
		: "";
	return `<div class="thr-srow" data-thr="${esc(r.id)}" data-pickup="${esc(r.pickup || "")}">`
		+ liveChip(e) + lane
		+ `<span class="thr-focus">${esc(r.label || "")}</span>${decl}`
		+ `<span class="thr-smeta">${wiChips(r, idx)}${sendBtn()}`
		+ `<button class="thr-btn" data-act="pickup" title="copy the pickup prompt">⧉</button></span></div>`;
}

/** Live seats whose work joins no open thread, one line each (session 975). */
export function renderSeatStrip(rows: Any[], showLane: boolean, idx: Map<string, Any>): string {
	if (!rows.length) return "";
	const lines = rows.map((r) => seatLine(r, showLane, idx)).join("");
	return `<div class="thr-seats"><div class="thr-seats-h">live · no thread <span class="n">${rows.length}</span></div>${lines}</div>`;
}

/** A single-session arc as one line (s984): label · last event · age. Confetti
 *  earns a line, not three. ✕ still works so a one-off can be ruled closed. */
function renderMiniRow(r: Any, idx: Map<string, Any>): string {
	const l = r.last || {};
	const ev = l.type ? `<b class="thr-ev ${esc(l.type)}">${esc(EVENT_LABEL[l.type] || l.type)}</b>` : "";
	const recur = r.recurring
		? `<span class="thr-recur" title="3+ sessions inside 10 days outside every declared thread">recurring</span>` : "";
	const age = r.age_days != null ? `<span class="thr-age${r.age_days >= 10 ? " old" : ""}">${esc(r.age_days)}d</span>` : "";
	return `<div class="thr-mini" data-thr="${esc(r.id)}" data-pickup="${esc(r.pickup || "")}">`
		+ `<span class="thr-lbl" data-arc="${esc(r.id)}">${esc(r.label || r.id)}</span>${recur}`
		+ `<span class="thr-mtxt">${ev}${esc(l.text || "")}</span>`
		+ `<span class="thr-smeta">${age}${sendBtn()}`
		+ `<button class="thr-btn" data-act="pickup" title="copy the pickup prompt">⧉</button>`
		+ `<button class="thr-btn" data-act="close" title="close this thread">✕</button></span></div>`;
}

const laneEq = (a: Any, b: Any) =>
	String(a || "").replace(/^_/, "").toLowerCase() === String(b || "").replace(/^_/, "").toLowerCase();

/** One spine section: header (name · lane · focus · next · cold) + full rows for
 *  moving streams, mini lines for one-offs, a fold for the quiet rest, and the
 *  section's own live-but-arcless seats. */
function renderSection(block: Any, rows: Any[], seats: Any[], showLane: boolean, idx: Map<string, Any>): string {
	const full = rows.filter((r) => !r.single && rowActive(r));
	const mini = rows.filter((r) => r.single && rowActive(r));
	const fold = rows.filter((r) => !rowActive(r));
	const liveN = rows.reduce((s, r) => s + (r.live || []).length, 0) + seats.length;
	const cold = block.cold
		? `<span class="thr-cold" title="no live seat and nothing mined for ${esc(block.newest_age_days ?? "7+")}d">cold${block.newest_age_days != null ? ` ${esc(block.newest_age_days)}d` : ""}</span>`
		: "";
	const next = block.next ? `<span class="thr-next" title="declared next in Threads.md">next: ${esc(block.next)}</span>` : "";
	const head = `<div class="thr-sec-h"><span class="thr-sec-name">${esc(block.name)}</span>`
		+ (showLane && block.lane ? `<span class="thr-lane">${esc(block.lane)}</span>` : "")
		+ (block.focus ? `<span class="thr-sec-focus">${esc(block.focus)}</span>` : "")
		+ `${next}${cold}`
		+ (liveN ? `<span class="thr-sec-live"><i class="thr-dot"></i>${liveN}</span>` : "")
		+ `</div>`;
	const foldHtml = fold.length
		? `<details class="thr-older"><summary>quiet <span class="n">${fold.length}</span></summary>${fold.map((r) => (r.single ? renderMiniRow(r, idx) : renderThreadRow(r, false, idx))).join("")}</details>`
		: "";
	return `<div class="thr-sec${block.cold ? " cold" : ""}">${head}`
		+ full.map((r) => renderThreadRow(r, false, idx)).join("")
		+ mini.map((r) => renderMiniRow(r, idx)).join("")
		+ seats.map((r) => seatLine(r, false, idx)).join("")
		+ foldHtml + `</div>`;
}

export function renderThreadBoard(data: Any, tab: string | null): string {
	if (data?.threads_error) return `<div class="empty">threads: ${esc(data.threads_error)}</div>`;
	const spine: Any[] = data?.threads_spine || [];
	const rows = rowsForTab(data, tab);
	const idx = wiIndex(data);

	if (spine.length) {
		// Thread → stream → work (s984): sections in Threads.md order. Rows carry a
		// `thread` stamp from the generator; unclaimed work and threadless live seats
		// keep their own surfaces at the bottom — grouped, never hidden.
		const parts: string[] = [];
		for (const b of spine) {
			if (tab && !laneEq(b.lane, tab)) {
				const hasRows = rows.some((r) => r.thread === b.name);
				if (!hasRows) continue;
			}
			const secRows = rows.filter((r) => r.kind !== "new" && r.thread === b.name);
			const secSeats = rows.filter((r) => r.kind === "new" && r.thread === b.name);
			if (!secRows.length && !secSeats.length && tab) continue;
			parts.push(renderSection(b, secRows, secSeats, !tab, idx));
		}
		const claimed = new Set(spine.map((b: Any) => b.name));
		const loose = rows.filter((r) => r.kind !== "new" && (!r.thread || !claimed.has(r.thread)));
		const looseSeats = rows.filter((r) => r.kind === "new" && (!r.thread || !claimed.has(r.thread)));
		if (loose.length) {
			const block = { name: "unclaimed", lane: null, focus: null, next: null, cold: false, newest_age_days: null };
			parts.push(renderSection(block, loose, [], !tab, idx));
		}
		const body = parts.join("") + renderSeatStrip(looseSeats, !tab, idx);
		return body || `<div class="empty">no open threads${tab ? ` in ${esc(tab)}` : ""}</div>`;
	}

	// No spine (Threads.md absent/empty): the flat pre-s984 board, unchanged.
	if (!rows.length) return `<div class="empty">no open threads${tab ? ` in ${esc(tab)}` : ""}</div>`;
	const floor = latestSessionN(data) - ACTIVE_WINDOW;
	const seatRows = rows.filter((r) => r.kind === "new");
	const active: Any[] = [], older: Any[] = [];
	for (const r of rows) {
		if (r.kind === "new") continue;                       // -> the seat strip below
		const lastN = Math.max(0, ...(r.chain || []).map((c: Any) => c.n || 0));
		((r.live || []).length || lastN >= floor ? active : older).push(r);
	}
	const activeHtml = active.length
		? active.map((r) => renderThreadRow(r, !tab, idx)).join("")
		: seatRows.length ? ""
		: `<div class="empty">nothing touched in the last ${ACTIVE_WINDOW} sessions${tab ? ` in ${esc(tab)}` : ""}</div>`;
	const olderHtml = older.length
		? `<details class="thr-older"><summary>older <span class="n">${older.length}</span></summary>${older.map((r) => renderThreadRow(r, !tab, idx)).join("")}</details>`
		: "";
	return activeHtml + renderSeatStrip(seatRows, !tab, idx) + olderHtml;
}

export function renderClosed(data: Any, tab: string | null): string {
	let rows: Any[] = data?.threads_closed || [];
	if (tab) rows = rows.filter((r) => r.lane === tab || (r.lanes || []).includes(tab));
	if (!rows.length) return "";
	const items = rows.map((r) => {
		const c = r.closed || {};
		const why = c.by === "operator" ? `closed${c.session ? ` s${esc(c.session)}` : ""}${c.reason ? `: ${esc(c.reason)}` : ""}`
			: c.by === "wis" ? "WIs all terminal"
			: `ledger: ${esc(c.reason || "closed")}`;
		const reopen = c.by === "operator" ? `<button class="thr-btn" data-act="reopen" title="reopen this thread">↺</button>` : "";
		return `<div class="thr-crow" data-thr="${esc(r.id)}"><span class="thr-lbl" data-arc="${esc(r.id)}">${esc(r.label || r.id)}</span>`
			+ `<span class="thr-lane">${esc(r.lane === "_System" ? "System" : (r.lane || ""))}</span><span class="thr-why">${why}</span>${reopen}</div>`;
	}).join("");
	return `<details class="thr-closed"><summary>closed this week <span class="n">${rows.length}</span></summary>${items}</details>`;
}

export function renderFoot(data: Any): string {
	const n = (data?.threads || []).length;
	const seats = (data?.threads_seats || []).length;
	const unmined: number[] = data?.threads_unmined || [];
	const mine = unmined.length
		? ` · <button class="thr-btn mine" data-act="mine" title="mine ${unmined.length} closed session(s) into the ledger: ${esc(unmined.join(", "))}">mine ${unmined.length} unmined</button>`
		: "";
	return `${n} thread${n === 1 ? "" : "s"} · ${seats} live seat${seats === 1 ? "" : "s"}${mine}`;
}
