// ── THIS WEEK (SYS-485, s916) ─────────────────────────────────────────
// Operator ruling from a live review of the below-the-strip rework ("the
// old dashboard gave me better info; this version doesn't surface the
// things I need to do that aren't arcs"): a cross-lane 7-day strip now sits
// directly under each lane's arc strip (same content regardless of which
// tab is open -- a WI belonging to a different lane still needs to be
// visible, hence the lane chip on every row). Supersedes the old standalone
// CLOCK section entirely -- its blocked-overdue note survives only as a
// footnote inside the TODAY cell (see renderThisWeek's blockedOverdue arg).
//
// week.overdue (global, no per-day slot -- nothing already overdue has a
// future date to live under) only ever renders in the TODAY cell, first in
// the array. Everything else (day.clock = due that specific day, day.events,
// day.plan) is genuinely per-day. day.plan is a NEW field (wi_calendar's AM/
// Q2 block, {id,title,kind,score}) -- degrades to nothing when absent/null,
// same as every other new field this rework touches.

import { Any, esc, laneOf } from "./common";
import { laneAbbrev } from "./arc-strip";

/** One WI row inside a day cell: lane chip + id + title, single-line
 *  ellipsis (CSS, not JS truncation -- title="" and the WiHover card both
 *  already carry the untruncated text). `overdueDays` present -> red +
 *  "-Nd"; absent -> the plain "due" tint. */
function weekWiRow(w: Any, overdueDays?: number): string {
	const lane = laneOf(w);
	const over = overdueDays != null ? `<span class="wk-over">-${esc(overdueDays)}d</span>` : "";
	return `<div class="wk-wi${overdueDays != null ? " wk-wi-over" : ""}" data-act="open" data-id="${esc(w.id)}" data-lane="${esc(lane)}" title="${esc(w.title)}">`
		+ `<span class="wk-lane">${esc(laneAbbrev(lane))}</span><span class="tid">${esc(w.id)}</span><span class="wk-ttl">${esc(w.title)}</span>${over}`
		+ `</div>`;
}

/** AM/Q2 planned-block pill (wi_calendar's per-day pick). Omitted entirely
 *  when day.plan is null/absent -- most days have no protected block. */
function planHtml(plan: Any): string {
	if (!plan) return "";
	const kind = plan.kind === "q2" ? "q2" : "deep";
	const label = kind === "q2" ? "Q2" : "AM";
	return `<div class="wk-plan wk-plan-${kind}" data-act="open" data-id="${esc(plan.id)}" data-lane="${esc(laneOf(plan))}" title="${esc(plan.title)}">`
		+ `<span class="wk-plan-tag">${label}</span><span class="wk-plan-ttl">${esc(plan.title)}</span></div>`;
}

function renderDay(day: Any, weekOverdue: Any[], blockedOverdue?: Any[]): string {
	const isToday = !!day.today;
	const overdueRows = isToday ? weekOverdue.map((o) => weekWiRow(o, o.days)) : [];
	const dueRows: Any[] = day.clock || [];
	const evRows: Any[] = day.events || [];
	const body = [
		...overdueRows,
		...dueRows.map((w) => weekWiRow(w)),
		...evRows.map((e) => `<div class="wk-ev"><span class="wk-ev-time">${esc(e.all_day ? "all day" : e.start)}</span>${esc(e.subject)}</div>`),
		planHtml(day.plan),
	].filter(Boolean);
	const footnote = isToday && blockedOverdue && blockedOverdue.length
		? `<div class="wk-blocked-note">+${blockedOverdue.length} blocked &amp; overdue, not shown as live urgency</div>`
		: "";
	// day-items wraps everything except the label -- a no-op grouping div in
	// the default (>560px) 7-column grid, but load-bearing below it: the
	// vertical-list breakpoint (styles.css, s916 operator follow-up) turns
	// .day into a flex row with .dh as a fixed-width label column and this
	// div as the wrapped items area to its right. The footnote stays a
	// sibling, not part of the wrap -- it's a full-width caption, not an item.
	return `<div class="day ${isToday ? "today" : ""}">`
		+ `<div class="dh"><span>${esc(day.dow)}</span><span>${esc(String(day.date).slice(5))}</span></div>`
		+ `<div class="day-items">${body.length ? body.join("") : `<div class="none">—</div>`}</div>`
		+ footnote
		+ `</div>`;
}

/** Calendar-health line -- read-only + hidden-block count. The old
 *  "overdue: id, id, ..." suffix is gone: overdue WIs now render properly
 *  (lane + title + days) inside the TODAY cell instead of a bare id list. */
export function weekNote(week: Any): string {
	if (!week || !week.days) return "";
	if (week.error) return `calendar read failed · ${esc(week.error)}`;
	return `outlook read-only · ${esc(week.managed_hidden ?? 0)} auto-pushed wi_calendar blocks hidden`;
}

export function renderThisWeek(week: Any, blockedOverdue?: Any[]): string {
	if (!week || !week.days) return `<div class="band-h">this week</div><div class="empty">calendar off</div>`;
	const days = (week.days as Any[]).map((d) => renderDay(d, week.overdue || [], blockedOverdue)).join("");
	const note = weekNote(week);
	return `<div class="band-h">this week</div><div class="op-week">${days}</div>${note ? `<div class="op-weeknote">${note}</div>` : ""}`;
}
