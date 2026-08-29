// ── NOW / DECISIONS / NEXT / WAITING / BACKLOG (v5, SYS-485 schema 4) ──
// The lane's ranked WI pool, entirely generator-derived: tier/why/score/
// leverage/waiting_on/next_task all arrive pre-computed on each row (the
// contract's row shape). This file does no ranking or tiering -- it only
// lays the rows out. Every id uses common.ts's idCell() (the existing
// [data-id]/[data-act=open] WiHover hook -- no new wiring needed).

import { Any, esc, idCell } from "./common";

/** Shared `waiting_on` chip text for NOW rows and WAITING rows (team-lead
 *  shape note, s917): `who` is null for status-derived waiting (blocked/
 *  waiting with no named party) -- render from `status` instead ("blocked"/
 *  "waiting", no "waiting on" prefix). `since_capped` means since_days is
 *  the 28d walk-window floor -- render "28d+" not "28d". `since_days` null
 *  omits the "· Nd" suffix entirely, in both shapes. Confirmed live: SYS-482
 *  (who=null, since_days=12) was rendering the bare "waiting on · 12d" bug
 *  before this fix. Escapes `who` (plain names today -- "David"/"client"/
 *  "Jer" -- but still untrusted data). */
function waitingChipHtml(status: string | undefined, wo: Any): string {
	const days = wo.since_days;
	const suffix = days != null ? ` · ${esc(String(days))}${wo.since_capped ? "d+" : "d"}` : "";
	if (wo.who) return `waiting on ${esc(wo.who)}${suffix}`;
	const word = status === "blocked" ? "blocked" : "waiting";
	return `${word}${suffix}`;
}

/** `flip_me` rows already have the nudge text baked into `why` ("all N/N
 *  ticked · close it?") -- style as a muted-blue nudge, not red/urgent. */
function whyClass(w: Any): string {
	return w.flip_me ? " v5-flip" : "";
}

// ---------- NOW 3/3 ----------

function nowRowHtml(w: Any): string {
	let meta = `<span class="v5-why${whyClass(w)}">${esc(w.why)}</span>`;
	if (w.tasks_total != null) meta += ` <span class="v5-prog">${w.tasks_done ?? 0}/${w.tasks_total}</span>`;
	if (w.waiting_on) {
		meta += ` <span class="v5-chip-wait">${waitingChipHtml(w.status, w.waiting_on)}</span>`;
	}
	const nextTask = w.next_task || w.next;
	const sub = nextTask ? `<div class="v5-sub">${esc(nextTask)}</div>` : "";
	return `<div class="v5-now-row">`
		+ `<div class="v5-row-top">${idCell(w)}<span class="v5-ttl">${esc(w.title)}</span><span class="v5-row-meta">${meta}</span></div>`
		+ sub
		+ `</div>`;
}

/** `ranking.provisional` (fewer than 10 explicit `leverage:` tags in the
 *  roadmaps, generator-computed, same rule as the old could_do.ranked) adds
 *  the "(provisional ranking)" hint instead of asserting a ranking the data
 *  can't back yet. */
export function renderNow(now: Any[], provisional: boolean): string {
	const hint = provisional ? ` <span class="hint">(provisional ranking)</span>` : "";
	const head = `<h2>NOW 3/3${hint}</h2>`;
	if (!now || !now.length) return head + `<div class="empty">nothing ranked — lane is clear or blocked/waiting only</div>`;
	return head + now.map(nowRowHtml).join("");
}

// ---------- DECISIONS OWED ----------

/** WI-derived rows show `id · hit`; capture-derived rows (id is always null
 *  -- a decision-kind capture item has no WI yet) show `hit` alone. `d.hit`
 *  for a capture row is built from the Capture Zone heading text, which
 *  already carries its own leading emoji (e.g. "⚖️ One ruling for the
 *  dashboard rework...") -- a plugin-added glyph on top of that double-
 *  glyphs (confirmed live: rendered as literal "⚖ ⚖️ One ruling..."). Team-
 *  lead's fix: drop the plugin's own glyph entirely, one glyph max. */
function decisionRowHtml(d: Any): string {
	if (d.source === "capture") {
		return `<div class="v5-drow">${esc(d.hit)}</div>`;
	}
	const idHtml = d.id ? `<span class="tid" data-act="open" data-id="${esc(d.id)}" data-lane="${esc(d.lane)}">${esc(d.id)}</span> · ` : "";
	return `<div class="v5-drow">${idHtml}${esc(d.hit)}</div>`;
}

/** 3-row cap + a "+N ▸" <details> expander for the rest. `data-persist` lets
 *  operator-panel.ts restore/save this lane's open-state via plugin saveData
 *  (contract item 4) -- see wireCollapsed() there. */
export function renderDecisions(decisions: Any[]): string {
	if (!decisions || !decisions.length) return "";
	const top = decisions.slice(0, 3);
	const rest = decisions.slice(3);
	const more = rest.length
		? `<details class="v5-more" data-persist="decisions-more"><summary>+${rest.length} ▸</summary>${rest.map(decisionRowHtml).join("")}</details>`
		: "";
	return `<h2>DECISIONS OWED <span class="n">${decisions.length}</span></h2>${top.map(decisionRowHtml).join("")}${more}`;
}

// ---------- NEXT (5) ----------

function nextRowHtml(w: Any): string {
	return `<div class="v5-next-row">${idCell(w)}<span class="v5-ttl">${esc(w.title)}</span><span class="v5-why${whyClass(w)}">${esc(w.why)}</span></div>`;
}

/** WCMC-shaped case (now=0, next=0, 1 backlog row): an empty NEXT must read
 *  cleanly, matching renderNow's own empty-state pattern, rather than
 *  vanishing entirely (team-lead shape note, s917). */
export function renderNext(next: Any[]): string {
	const head = `<h2>NEXT</h2>`;
	if (!next || !next.length) return head + `<div class="empty">nothing ranked</div>`;
	return `<h2>NEXT <span class="n">${next.length}</span></h2>${next.map(nextRowHtml).join("")}`;
}

// ---------- WAITING (collapsed) ----------

function waitingRowHtml(w: Any): string {
	const wo = w.waiting_on || {};
	return `<div class="v5-waitrow">${idCell(w)}<span class="v5-ttl">${esc(w.title)}</span> · <span class="v5-waitname">${waitingChipHtml(w.status, wo)}</span></div>`;
}

export function renderWaiting(waiting: Any[]): string {
	if (!waiting || !waiting.length) return "";
	return `<details class="v5-waiting" data-persist="waiting"><summary>WAITING <span class="n">${waiting.length}</span></summary>${waiting.map(waitingRowHtml).join("")}</details>`;
}

// ---------- Backlog summary + expander ----------

/** `why` is server-pre-formatted per status (tier 8 rows: "deferred · <trigger>"
 *  or "dormant"; confirmed live -- see WCMC-06) -- render it directly rather
 *  than reconstructing trigger text client-side, which also silently dropped
 *  dormant rows entirely (no trigger field to key off). No `waiting_on` chip
 *  here: the handful of backlog rows that still carry a stale waiting_on
 *  object (e.g. deferred rows that were once blocked) are already covered by
 *  `why`'s own text -- a separate chip would be redundant/confusing since
 *  WAITING is the section that actually owns that semantics. */
function backlogRowHtml(w: Any): string {
	const whyHtml = w.why ? ` <span class="v5-bnote${whyClass(w)}">${esc(w.why)}</span>` : "";
	return `<div class="v5-brow">${idCell(w)}<span class="v5-ttl">${esc(w.title)}</span>${whyHtml}</div>`;
}

/** `counts.active` (a real bucket the generator returns, e.g. _System=6,
 *  SomaGuard=9) is deliberately excluded from the contract's literal summary
 *  line ("N READY · N NEEDS-TESTING · N BLOCKED · N DEFERRED/DORMANT" -- no
 *  ACTIVE term) -- but the overflow "active"-status rows the generator DOES
 *  put in backlog.rows (5 live across lanes: SYS-443/SYS-313/SYS-325/MM-20/
 *  MM-47) need a group to render into or they vanish from the ENTIRE lane
 *  view (not in NOW/NEXT's top-N, not in WAITING, and previously not here
 *  either -- a real content-loss gap, not just a cosmetic one). "Blocked" is
 *  never populated here in practice (blocked rows all live in the WAITING
 *  section instead), kept for shape-completeness / future generator changes. */
const BACKLOG_GROUPS: [string, string][] = [
	["active", "Active"], ["ready", "Ready"], ["needs-testing", "Needs-testing"], ["blocked", "Blocked"],
	["deferred", "Deferred"], ["dormant", "Dormant"],
];

/** Summary line combines deferred+dormant into one "N DEFERRED/DORMANT"
 *  count (contract's literal wording); the expanded body still splits them
 *  into separate groups so deferred rows can carry their `trigger` line
 *  without dormant rows (which don't have one) muddying the group. */
export function renderBacklog(backlog: Any): string {
	const counts = backlog?.counts || {};
	const rows: Any[] = backlog?.rows || [];
	const ready = counts.ready ?? 0;
	const nt = counts["needs-testing"] ?? 0;
	const blocked = counts.blocked ?? 0;
	const defdorm = (counts.deferred ?? 0) + (counts.dormant ?? 0);

	const byStatus = new Map<string, Any[]>();
	for (const w of rows) {
		const key = w.status || "unknown";
		if (!byStatus.has(key)) byStatus.set(key, []);
		byStatus.get(key)!.push(w);
	}
	const body = BACKLOG_GROUPS.map(([key, label]) => {
		const grp = byStatus.get(key) || [];
		if (!grp.length) return "";
		return `<div class="v5-bgroup"><div class="v5-bgroup-h">${esc(label)} <span class="n">${grp.length}</span></div>${grp.map(backlogRowHtml).join("")}</div>`;
	}).join("");

	const summary = `${ready} READY · ${nt} NEEDS-TESTING · ${blocked} BLOCKED · ${defdorm} DEFERRED/DORMANT`;
	return `<details class="v5-backlog" data-persist="backlog"><summary>${esc(summary)}</summary>${body || `<div class="empty">nothing</div>`}</details>`;
}
