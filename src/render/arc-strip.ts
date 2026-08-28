import { Any, esc } from "./common";

// ── Arc strip (swimlane) ──────────────────────────────────────────────
// Operator ruling after seeing the shared-axis/floating-bar v1 in a real
// ~1980px pane ("very hard to read"): one ROW per multi-session arc plus a
// single "singles" row for every one-off arc, an INDEX-spaced session axis
// (uniform column width, never date-proportional — same-day sessions can
// never collide, so the old collision-avoidance/date-x math is gone), and
// node colour instead of a glyph cluster for state. Pure function, no DOM;
// `availableWidth` (the caller-measured `.op-lane` px width) is optional —
// omit it and columns fall back to a fixed width, still fully renderable
// for tools/render-preview.mjs callers that don't pass one.

const WINDOW_DAYS = 21;
const DAY_MS = 86_400_000;
// Gutter width scales with the panel instead of a fixed 220px (operator
// ruling, s914: "less than half of the descriptions are visible") -- min(360,
// 30% of availableWidth), floored at 200 so a narrow pane never squeezes it
// past readability. GUTTER_DEFAULT (220, the old fixed value) is used only
// when no availableWidth is supplied (e.g. a caller that never measured a
// container) and happens to already sit inside the min/max band.
const GUTTER_MIN = 200;
const GUTTER_MAX = 360;
const GUTTER_DEFAULT = 220;
const COL_MIN = 56;
const COL_MAX = 96;
const COL_DEFAULT = 64;    // used only when no availableWidth is supplied

function computeGutterPx(availableWidth?: number): number {
	if (!availableWidth) return GUTTER_DEFAULT;
	return Math.max(GUTTER_MIN, Math.min(GUTTER_MAX, Math.round(availableWidth * 0.30)));
}

/** Inline style shared by every row's .arc-gutter (header/multi/singles) so
 *  columns stay aligned -- the CSS class's 220px is now just a fallback for
 *  any caller that skips this. */
function gutterStyleAttr(px: number): string {
	return `flex:0 0 ${px}px;width:${px}px`;
}

/** Node colour bucket by the session's LAST event (spec: shipped green,
 *  found_broken red, root_caused blue, waiting amber, decision purple,
 *  filed/handoff grey). declared_done reads as a shipped-family close;
 *  false_alarm/dead-as-an-event fall into the neutral filed/handoff grey. */
const NODE_BUCKET: Record<string, string> = {
	shipped: "shipped", declared_done: "shipped",
	found_broken: "broken",
	root_caused: "caused",
	waiting_on_operator: "waiting", waiting_on_them: "waiting",
	decision: "decision",
	filed: "neutral", handoff: "neutral", false_alarm: "neutral", dead: "neutral",
};

function lastEventBucket(events: Any[] | undefined): string {
	if (!events || !events.length) return "neutral";
	const last = events[events.length - 1];
	return NODE_BUCKET[last?.type] || "neutral";
}

/** Only two glyphs survive on/under a node — everything else the old
 *  strip drew per-node now lives in the session hover-card (session-hover.ts
 *  already lists every event). ‖ (U+2016 DOUBLE VERTICAL LINE), not the
 *  ⏸ pause emoji the v1 legend used — that glyph rendered as a tofu box in
 *  Obsidian's font stack. */
function nodeMarks(events: Any[] | undefined): string {
	if (!events || !events.length) return "";
	const types = new Set(events.map((e) => e?.type));
	let out = "";
	if (types.has("found_broken")) out += `<span class="arc-mark mk-broken" title="found broken">×</span>`;
	if (types.has("waiting_on_operator")) out += `<span class="arc-mark mk-wait" title="waiting on you">‖</span>`;
	return out;
}

/** Short hint for a cross-lane arc's origin ("SomaGuard" -> "Soma"). Exported
 *  for week.ts's day-cell lane chips (same abbreviation, different context). */
export function laneAbbrev(l: string): string {
	const s = String(l || "").replace(/^_/, "");
	return s.length <= 5 ? s : s.slice(0, 4);
}

function shortDate(iso: string | undefined): string {
	const parts = String(iso || "").split("-");
	return parts.length === 3 ? `${parseInt(parts[1], 10)}/${parseInt(parts[2], 10)}` : String(iso || "");
}

/** First -> last member-session date span. Reads a.sessions (each member
 *  carries its own `date`) rather than a.first_date/a.last_date -- those
 *  fields don't exist on real schema-3 arc objects, so the previous version
 *  of this silently rendered "? -> ?" for every multi-session arc. Exported
 *  for arc-hover.ts's full-label card to share the same fix. */
export function arcSpan(a: Any): string {
	const sessions: Any[] = a.sessions || [];
	const firstRow = sessions.find((s) => s.n === a.first);
	const lastRow = sessions.find((s) => s.n === a.last);
	return a.first === a.last ? (firstRow?.date || "") : `${firstRow?.date ?? "?"} → ${lastRow?.date ?? "?"}`;
}

/** Gutter + hover tooltip text: full label, first→last span, and wis. */
function arcTooltip(a: Any, lane: string): string {
	const wis = a.wis && a.wis.length ? a.wis.join(", ") : "no WIs";
	const foreign = a.lane && a.lane !== lane;
	return `${a.label} · ${arcSpan(a)} · ${wis}${a.open ? " · open" : " · closed"}${foreign ? ` · from ${a.lane}` : ""}`;
}

/** Gutter label markup (operator ruling s914): a label shaped "Name: what
 *  happened" splits into a bold name line + a muted description line (2
 *  lines total, ellipsis on line 2 if the description overflows); a label
 *  with no colon just wraps to 2 lines with an ellipsis. The FULL
 *  untruncated label always lives in the gutter's title="" tooltip
 *  (arcTooltip, above) and the ArcHover card (arc-hover.ts) for anything
 *  long enough to clip here -- this is display-only truncation, never data
 *  loss. */
function gutterLabelHtml(label: string): string {
	const idx = label.indexOf(":");
	if (idx === -1) {
		return `<span class="arc-gutter-lbl arc-gutter-lbl-wrap">${esc(label)}</span>`;
	}
	const name = label.slice(0, idx).trim();
	const rest = label.slice(idx + 1).trim();
	return `<span class="arc-gutter-lbl arc-gutter-lbl-split">`
		+ `<span class="arc-gutter-name">${esc(name)}</span>`
		+ `<span class="arc-gutter-desc">${esc(rest)}</span>`
		+ `</span>`;
}

function renderNode(row: Any, x: number, closedArc: boolean): string {
	const cls = ["arc-node"];
	if (closedArc) cls.push("closed-arc");
	if (row?.dead) {
		cls.push("dead");
		return `<div class="${cls.join(" ")}" data-sess="${esc(row.n)}" style="left:${x}px" title="s${esc(row.n)} · ${esc(row.date)} (dead)">×</div>`;
	}
	cls.push(`nc-${lastEventBucket(row?.events)}`);
	return `<div class="${cls.join(" ")}" data-sess="${esc(row?.n)}" style="left:${x}px" title="s${esc(row?.n)} · ${esc(row?.date)}">${nodeMarks(row?.events)}</div>`;
}

/** A singles-row node: title carries the arc's full label (the "label on
 *  hover only" requirement) — plain native tooltip, no extra plumbing. */
function renderSingleNode(a: Any, row: Any, x: number, lane: string): string {
	const cls = ["arc-node"];
	if (!a.open) cls.push("closed-arc");
	const title = arcTooltip(a, lane);
	if (row?.dead) {
		cls.push("dead");
		return `<div class="${cls.join(" ")}" data-sess="${esc(a.first)}" data-arc="${esc(a.id)}" style="left:${x}px" title="${esc(title)}">×</div>`;
	}
	cls.push(`nc-${lastEventBucket(row?.events)}`);
	return `<div class="${cls.join(" ")}" data-sess="${esc(a.first)}" data-arc="${esc(a.id)}" style="left:${x}px" title="${esc(title)}">${nodeMarks(row?.events)}</div>`;
}

function renderMultiRow(a: Any, lane: string, colX: (n: number) => number, trackWidth: number, gutterPx: number): string {
	const foreign = !!(a.lane && a.lane !== lane);
	const cls = ["arc-row", a.open ? "open" : "closed", foreign ? "foreign" : ""].filter(Boolean).join(" ");
	const originChip = foreign ? `<span class="arc-row-origin" title="from ${esc(a.lane)}">${esc(laneAbbrev(a.lane))}</span>` : "";
	const members: Any[] = a.sessions || [];
	const memberXs = members.map((s) => colX(s.n));
	const lineHtml = memberXs.length > 1
		? `<div class="arc-line" style="left:${Math.min(...memberXs)}px;width:${Math.max(2, Math.max(...memberXs) - Math.min(...memberXs))}px"></div>`
		: "";
	const nodesHtml = members.map((s) => renderNode(s, colX(s.n), !a.open)).join("");
	return `<div class="${cls}">`
		+ `<div class="arc-gutter" data-arc="${esc(a.id)}" style="${gutterStyleAttr(gutterPx)}" title="${esc(arcTooltip(a, lane))}">${originChip}${gutterLabelHtml(a.label)}</div>`
		+ `<div class="arc-track" style="width:${trackWidth}px">${lineHtml}${nodesHtml}</div>`
		+ `</div>`;
}

/** lane = the lane this strip is scoped to; arcs/sessionsLog are the
 *  top-level (all-lane) schema-3 arrays, filtered here. An arc shows on a
 *  lane tab when the tab's lane is IN arc.lanes (the union of every lane
 *  any member session touched), not just arc.lane (its origin lane) —
 *  missing `lanes` on older/mock data falls back to [lane]. Only OPEN arcs
 *  render (operator ruling s914: "he doesn't want inactive arcs on the
 *  strip") — a lane with zero open arcs renders a one-line empty state
 *  instead of an axis with nothing on it, regardless of recent session
 *  activity. `availableWidth` is the caller-measured px width of the
 *  strip's container (`.op-lane` in the real plugin, an arithmetic estimate
 *  in render-preview.mjs); when given, column width fills it (capped 56-96px,
 *  index count permitting) instead of using the fixed default — see
 *  COL_MIN/COL_MAX above — and the gutter scales off it too (GUTTER_MIN/MAX). */
export function renderArcStrip(lane: string, arcs: Any[], sessionsLog: Any[], now: number = Date.now(), availableWidth?: number): string {
	const windowStart = now - WINDOW_DAYS * DAY_MS;
	const all: Any[] = sessionsLog || [];
	const inLane = (r: Any) => (r.lanes && r.lanes.length ? r.lanes : [r.lane]).includes(lane);

	const laneArcs = (arcs || []).filter((a) => (a.lanes && a.lanes.length ? a.lanes : [a.lane]).includes(lane));
	const openArcs = laneArcs.filter((a) => a.open);

	if (!openArcs.length) {
		return `<div class="arc-empty">no open arcs in the last ${WINDOW_DAYS}d</div>`;
	}

	const baseCols = all.filter((r) => inLane(r) && new Date(`${r.date}T12:00:00`).getTime() >= windowStart).map((r) => r.n);

	// One column per session that touched this lane inside the window, PLUS
	// any open-arc member session missing from that set (an arc reaching
	// further back than WINDOW_DAYS, or a session that lived entirely in
	// another lane) — appended so the arc's line/node never drops mid-track.
	const rowByN = new Map<number, Any>(all.map((r) => [r.n, r]));
	const colSet = new Set<number>(baseCols);
	for (const a of openArcs) {
		for (const s of a.sessions || []) {
			colSet.add(s.n);
			if (!rowByN.has(s.n)) rowByN.set(s.n, s);
		}
	}
	const colNs = Array.from(colSet).sort((x, y) => x - y);
	const numCols = colNs.length || 1;

	const gutterPx = computeGutterPx(availableWidth);
	const colW = availableWidth
		? Math.max(COL_MIN, Math.min(COL_MAX, Math.floor((availableWidth - gutterPx) / numCols)))
		: COL_DEFAULT;
	const colIndex = new Map<number, number>(colNs.map((n, i) => [n, i]));
	const colX = (n: number): number => (colIndex.get(n) ?? 0) * colW + colW / 2;
	const trackWidth = numCols * colW;

	// Date ticks: first column of each 7-day bucket since the window start,
	// plus any 1st-of-month column — the only time cue on an index-spaced axis.
	let lastWeek = NaN;
	const ticks = new Set<number>();
	for (const n of colNs) {
		const row = rowByN.get(n);
		if (!row?.date) continue;
		const d = new Date(`${row.date}T12:00:00`);
		const week = Math.floor((d.getTime() - windowStart) / (7 * DAY_MS));
		if (d.getDate() === 1 || week !== lastWeek) { ticks.add(n); lastWeek = week; }
	}

	const hdrCols = colNs.map((n) => {
		const row = rowByN.get(n);
		const tick = ticks.has(n);
		return `<div class="arc-col-lbl" style="left:${colX(n)}px">s${esc(n)}${tick ? `<span class="arc-col-date">${esc(shortDate(row?.date))}</span>` : ""}</div>`;
	}).join("");
	const hdrRow = `<div class="arc-row arc-row-hdr"><div class="arc-gutter" style="${gutterStyleAttr(gutterPx)}"></div><div class="arc-track" style="width:${trackWidth}px">${hdrCols}</div></div>`;

	const multi = openArcs.filter((a) => a.first !== a.last).slice().sort((a, b) => (b.last ?? 0) - (a.last ?? 0));
	const singles = openArcs.filter((a) => a.first === a.last);

	const multiRows = multi.map((a) => renderMultiRow(a, lane, colX, trackWidth, gutterPx)).join("");

	const singlesNodes = singles.map((a) => renderSingleNode(a, rowByN.get(a.first) || (a.sessions && a.sessions[0]), colX(a.first), lane)).join("");
	const singlesRow = singles.length
		? `<div class="arc-row arc-row-singles"><div class="arc-gutter" style="${gutterStyleAttr(gutterPx)}">singles <span class="arc-row-n">${singles.length}</span></div><div class="arc-track" style="width:${trackWidth}px">${singlesNodes}</div></div>`
		: "";

	const NODE_LEGEND: [string, string][] = [
		["nc-shipped", "shipped"], ["nc-broken", "found broken"], ["nc-caused", "root caused"],
		["nc-waiting", "waiting"], ["nc-decision", "decision"], ["nc-neutral", "filed / handoff"],
	];
	const legend = NODE_LEGEND.map(([cls, label]) => `<span class="lg"><span class="lg-dot ${cls}"></span>${esc(label)}</span>`).join("")
		+ `<span class="lg"><span class="lg-dot dead"></span>dead session</span>`
		+ `<span class="lg"><span class="lg-mark">×</span>found broken</span>`
		+ `<span class="lg"><span class="lg-mark">‖</span>waiting on you</span>`;

	return `<div class="arc-strip">${hdrRow}${multiRows}${singlesRow}</div><div class="arc-legend">${legend}</div>`;
}
