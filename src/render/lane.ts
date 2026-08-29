import { Any, esc, seatBadges, wiRow, repoChip, laneList } from "./common";
import { renderArcStrip, renderArcsV5 } from "./arc-strip";
import { renderThisWeek, renderThisWeekV5 } from "./week";
import { renderLaneTriage } from "./triage";
import { renderNow, renderDecisions, renderNext, renderWaiting, renderBacklog } from "./now-next";
import { renderInboxSection } from "./inbox";

const ACTIVE_CAP = 15; // schema-2 fallback only

/** Rows where every task is checked but status was never flipped — the
 *  shape-product.md nudge, deduped into one callout above the bands. */
function flipCallout(all: Any[]): string {
	const flips = (all || []).filter((w) => w.flip_me);
	if (!flips.length) return "";
	return `<div class="flip-callout"><b>${flips.length}</b> ready to close — every task done, status never flipped: ${flips.map((w) => esc(w.id)).join(", ")}</div>`;
}

/** One "new this week" compact chip: id + title, hover card via the same
 *  [data-id] delegation WiHover already listens on (wi-card.ts) — no new
 *  wiring needed. No title="" (operator double-popup complaint, s916
 *  follow-up: the card already carries the same text). */
function newChip(w: Any, lane: string): string {
	return `<div class="chip-wi" data-act="open" data-id="${esc(w.id)}" data-lane="${esc(lane)}">`
		+ `<span class="chip-id c-${esc(w.status)}">${esc(w.id)}</span><span class="chip-ttl">${esc(w.title)}</span></div>`;
}

function newChipsRow(fresh: Any[], lane: string): string {
	if (!fresh.length) return "";
	return `<div class="band-h">new this week <span class="n">${fresh.length}</span></div>`
		+ `<div class="chip-row">${fresh.map((w) => newChip(w, lane)).join("")}</div>`;
}

/** One line, omitted when empty (operator ruling s916): WIs the miner found
 *  progressing this lane that didn't land inside any tracked arc.
 *  sprints[].moved_outside_arcs is a NEW field (gen-deltas) -- degrades to
 *  nothing when absent, same as every other new field in this rework.
 *  Entries may be bare id strings or {id,...} objects; only the id is used
 *  (full WI info comes from the hover card's own Roadmap-file lookup). */
function movedOutsideLine(sp: Any): string {
	const raw: Any[] = sp.moved_outside_arcs || [];
	if (!raw.length) return "";
	const chips = raw.map((x: Any) => {
		const id = typeof x === "string" ? x : x?.id;
		return `<span class="tid" data-act="open" data-id="${esc(id)}" data-lane="${esc(sp.lane)}">${esc(id)}</span>`;
	}).join(", ");
	return `<div class="moved-outside">moved outside arcs: ${chips}</div>`;
}

// Common working statuses first, in operator-priority order; anything else
// (an unexpected/future status value) sorts after, alphabetically -- never
// silently dropped.
const STATUS_ORDER = ["blocked", "active", "needs-testing", "verify", "ready", "waiting", "deferred"];

function statusRank(s: string): number {
	const i = STATUS_ORDER.indexOf(s);
	return i === -1 ? STATUS_ORDER.length : i;
}

/** Item 7 (operator ruling s916): the lane's full WI roster (data.lanes[]'s
 *  complete list, NOT sprints[].wis -- that's just the small "moving this
 *  week" subset already surfaced via the arc strip + NEW chips), grouped by
 *  status, collapsed by default with per-status counts in the (still
 *  collapsed) summary so volume is scannable without opening it. Replaces
 *  the old PROGRESSED/NEW/NO-CHANGE/VERIFY/READY bandSections entirely --
 *  those facts now live in the kicker counts, arc hovers, and the
 *  moved-outside line above. */
function fullStatusList(wis: Any[]): string {
	if (!wis.length) return "";
	const byStatus = new Map<string, Any[]>();
	for (const w of wis) {
		const key = w.status || "unknown";
		if (!byStatus.has(key)) byStatus.set(key, []);
		byStatus.get(key)!.push(w);
	}
	const keys = Array.from(byStatus.keys()).sort((a, b) => statusRank(a) - statusRank(b) || a.localeCompare(b));
	const summary = keys.map((k) => `${esc(k)} <b>${byStatus.get(k)!.length}</b>`).join(" · ");
	const body = keys.map((k) => {
		const rows = byStatus.get(k)!;
		return `<div class="band"><div class="band-h">${esc(k)} <span class="n">${rows.length}</span></div>`
			+ rows.map((w) => wiRow(w, null, { showActor: true, showRot: true })).join("") + `</div>`;
	}).join("");
	return `<details class="lane-full"><summary>full list <span class="full-counts">${summary}</span></summary>${body}</details>`;
}

/** `sp` is a `sprints[]` entry. `sp.wis` is only the small "moving this
 *  week" subset (progressed/new band-classified) -- the lane's COMPLETE
 *  roster lives in `data.lanes[]` (`block.wis` below), which is why the
 *  schema-3 branch does its own `laneList(data)` lookup instead of trusting
 *  `sp` alone (same lookup the schema-2 fallback already did). In schema 2
 *  there's no band classification at all; that split is rendered as a
 *  crash-guard fallback only.
 *
 *  Below-the-strip order (operator ruling, live review, s916 -- "the old
 *  dashboard gave me better info; this version doesn't surface the things I
 *  need to do that aren't arcs"): kicker+counts, last-session note, arc
 *  strip, THIS WEEK (cross-lane, same every tab), per-lane top-4 triage,
 *  NEW chips, moved-outside-arcs line, flip callout, then the lane's full
 *  WI roster grouped by status, collapsed by default. PROGRESSED and NO
 *  CHANGE no longer render as lists -- those facts now live in the kicker
 *  counts, the arc-hover WI lists (arc-hover.ts), and the moved-outside
 *  line. */
export function renderLane(sp: Any, data: Any, availableWidth?: number): string {
	if (!sp) return `<div class="empty">no lane has motion, a live seat, or working WIs</div>`;
	const schema = data?.schema || 2;
	let h = "";

	if ((sp.seats && sp.seats.length) || sp.moving_count) {
		h += `<div class="kicker"><b>${esc(sp.lane)}</b><span>${sp.moving_count ?? 0} moving this week</span>${seatBadges(sp.seats || [])}</div>`;
	}

	if (schema >= 3) {
		if (sp.counts) {
			const c = sp.counts;
			h += `<div class="lane-counts">closed <b>${c.closed_7d ?? 0}</b> · progressed <b>${c.progressed_7d ?? 0}</b> · new <b>${c.new_7d ?? 0}</b></div>`;
		}
		if (sp.last_session) {
			const ls = sp.last_session;
			h += `<div class="last-sess"><span class="lsn-hd"><b>s${esc(ls.n)}</b><span class="lsn-date">${esc(ls.date)}</span></span><div class="lsn-note" data-act="togglenote">${esc(ls.note)}</div></div>`;
		}

		h += renderArcStrip(sp.lane, data.arcs || [], data.sessions_log || [], Date.now(), availableWidth);
		h += renderThisWeek(data.week, data.blocked_overdue);
		h += renderLaneTriage(data.triage, sp.lane);

		const wis: Any[] = sp.wis || [];
		const fresh = wis.filter((w) => w.band === "new");
		h += newChipsRow(fresh, sp.lane);
		h += movedOutsideLine(sp);
		h += flipCallout(wis);

		const block: Any = (laneList(data) || []).find((b: Any) => b.lane === sp.lane) || {};
		h += fullStatusList(block.wis || []);

		if (!wis.length && !(block.wis || []).length) h += `<div class="empty">nothing working in this lane</div>`;
		return h;
	}

	// ── schema-2 fallback: never crash on old data ──
	// (renderLane's own fallback, unrelated to renderLaneV5 below.)
	const block: Any = (laneList(data) || []).find((b: Any) => b.lane === sp.lane) || {};
	const inSprint = new Set<string>((sp.wis || []).map((w: Any) => w.id));
	if ((sp.wis || []).length) {
		h += `<div class="sprint"><div class="kicker"><b>SPRINT</b><span>${sp.moving_count ?? 0} moving this week</span>${seatBadges(sp.seats || [])}</div>`
			+ sp.wis.map((w: Any) => wiRow(w, w.next ? `next: ${w.next}` : null)).join("") + `</div>`;
	}
	if ((block.repos || []).length) h += `<div class="repos">${block.repos.map(repoChip).join("")}</div>`;
	const rows: Any[] = (block.wis || []).filter((w: Any) => !inSprint.has(w.id));
	const shown = rows.slice(0, ACTIVE_CAP);
	h += `<h2>active <span class="n">${rows.length}${inSprint.size ? ` · ${inSprint.size} in the sprint above` : ""}</span></h2>`;
	h += rows.length
		? shown.map((w) => wiRow(w)).join("") + (rows.length > ACTIVE_CAP ? `<div class="more">${rows.length - ACTIVE_CAP} older hidden</div>` : "")
		: `<div class="empty">nothing else working</div>`;
	return h;
}

// ── v5 lane composer (SYS-485 schema 4) ───────────────────────────────
// `b` is a laneList(data) block -- the raw data.lanes[] entry (now/next/
// waiting/decisions/backlog/inbox/inbox_older/ranking/badge all live there
// per the v5 contract), spread with sprint/focal by laneList(). No `sp`
// (sprints[] entry) needed any more -- every v5 field is lane-scoped on `b`
// directly, unlike the old renderLane(sp, data, width) which had to fall
// back to laneList(data) internally to find the lane's full roster.
//
// Exact contract order: NOW 3/3 -> DECISIONS OWED -> THIS WEEK compact ->
// ARCS -> NEXT(5) -> WAITING -> backlog summary -> INBOX. TODAY (cross-lane)
// and the tabs sit OUTSIDE this function, in operator-panel.ts's own
// skeleton slots -- they're painted once, not per lane, since their content
// doesn't change when the operator switches tabs.
//
// Dropped entirely from this path (contract item 3, "remove from the
// render"): COULD DO, the full cross-lane triage board, the 9-symbol arc
// legend (renderArcsV5 already carries its own 2-item legend), the session
// note (sp.last_session -- SessionHover's card on an arc's last dot already
// has it), and the PROGRESSED/NEW/full-roster band chrome. Those functions
// (renderLane, renderCouldDo, renderTriage, renderCapture, the old
// renderThisWeek/renderArcStrip) are left in the codebase, just uncalled
// from here -- same rollback-safety judgment call as renderArcsV5's doc
// comment above, flagged to team-lead together.
export function renderLaneV5(b: Any, data: Any): string {
	if (!b) return `<div class="empty">no lane has motion, a live seat, or working WIs</div>`;
	let h = "";
	h += renderNow(b.now || [], !!(b.ranking && b.ranking.provisional));
	h += renderDecisions(b.decisions || []);
	h += renderThisWeekV5(data.week);
	h += renderArcsV5(b.lane, data.arcs || []);
	h += renderNext(b.next || []);
	h += renderWaiting(b.waiting || []);
	h += renderBacklog(b.backlog);
	h += renderInboxSection(b.inbox || [], b.inbox_older || 0);
	return h;
}
