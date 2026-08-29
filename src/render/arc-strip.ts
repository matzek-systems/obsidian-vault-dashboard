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
// Fit-to-track floor (operator ruling s916 follow-up, axis-compression
// pass): when every column can be at least 24px wide within the track's
// available space, columns size to fill it exactly and the strip needs no
// horizontal scroll at all. Distinct from COL_MIN(56) above, which stays
// the floor for the fixed-width+SCROLL fallback used only when even 24px
// per column can't fit (narrow sidebar widths).
const COL_MIN_FIT = 24;

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

/** Hover tooltip text: full label, first→last span, and wis. Used by
 *  renderSingleNode only -- multi-row gutters dropped their title (operator
 *  double-popup complaint, s916 follow-up: ArcHover already carries this
 *  same text). No `foreign`/from-lane suffix any more: arc tabs now filter
 *  by ORIGIN lane only (renderArcStrip's laneArcs, below), so every arc this
 *  runs on already has a.lane === the tab it's rendering on. */
function arcTooltip(a: Any): string {
	const wis = a.wis && a.wis.length ? a.wis.join(", ") : "no WIs";
	return `${a.label} · ${arcSpan(a)} · ${wis}${a.open ? " · open" : " · closed"}`;
}

/** Gutter label markup (operator ruling s914): a label shaped "Name: what
 *  happened" splits into a bold name line + a muted description line (2
 *  lines total, ellipsis on line 2 if the description overflows); a label
 *  with no colon just wraps to 2 lines with an ellipsis. The FULL
 *  untruncated label always lives in the ArcHover card (arc-hover.ts) for
 *  anything long enough to clip here -- this is display-only truncation,
 *  never data loss. No title="" fallback any more (s916 follow-up:
 *  native tooltip + ArcHover card both firing was the reported double
 *  popup) -- the card is the one source of the untruncated text now. */
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

/** A singles-row node: title carries the arc's full label. Kept (unlike the
 *  multi-row gutter's title, dropped below) -- SessionHover's [data-sess]
 *  card on this same node shows the SESSION's own note/events, not the
 *  arc's label/span/wis, so the two aren't a duplicate popup pair. */
function renderSingleNode(a: Any, row: Any, x: number): string {
	const cls = ["arc-node"];
	if (!a.open) cls.push("closed-arc");
	const title = arcTooltip(a);
	if (row?.dead) {
		cls.push("dead");
		return `<div class="${cls.join(" ")}" data-sess="${esc(a.first)}" data-arc="${esc(a.id)}" style="left:${x}px" title="${esc(title)}">×</div>`;
	}
	cls.push(`nc-${lastEventBucket(row?.events)}`);
	return `<div class="${cls.join(" ")}" data-sess="${esc(a.first)}" data-arc="${esc(a.id)}" style="left:${x}px" title="${esc(title)}">${nodeMarks(row?.events)}</div>`;
}

function renderMultiRow(a: Any, colX: (n: number) => number, trackWidth: number, gutterPx: number, jumpHtml: string): string {
	const cls = ["arc-row", a.open ? "open" : "closed"].join(" ");
	const members: Any[] = a.sessions || [];
	const memberXs = members.map((s) => colX(s.n));
	const lineHtml = memberXs.length > 1
		? `<div class="arc-line" style="left:${Math.min(...memberXs)}px;width:${Math.max(2, Math.max(...memberXs) - Math.min(...memberXs))}px"></div>`
		: "";
	const nodesHtml = members.map((s) => renderNode(s, colX(s.n), !a.open)).join("");
	// No title="" on the gutter -- ArcHover's [data-arc] card (arc-hover.ts)
	// already shows this same label/span/wis text; native title + card both
	// firing was the operator's reported double-popup (s916 follow-up).
	return `<div class="${cls}">`
		+ `<div class="arc-gutter" data-arc="${esc(a.id)}" style="${gutterStyleAttr(gutterPx)}">${gutterLabelHtml(a.label)}${jumpHtml}</div>`
		+ `<div class="arc-track" style="width:${trackWidth}px">${lineHtml}${nodesHtml}</div>`
		+ `</div>`;
}

/** lane = the lane this strip is scoped to; arcs/sessionsLog are the
 *  top-level (all-lane) schema-3 arrays, filtered here. An arc shows on a
 *  lane tab only when the tab IS the arc's ORIGIN lane (arc.lane) -- s916
 *  follow-up, operator ruling ("why is SomaGuard on the System page?"):
 *  session-touch was too loose (a single member session filing an
 *  off-lane WI put e.g. somaguard/shopify-rebuild-soma17@872 on _System via
 *  arc.lanes' cross-lane union). `lanes` stays in the JSON/generator
 *  untouched -- this is a render-layer filter change only. Only OPEN arcs
 *  render (operator ruling s914: "he doesn't want inactive arcs on the
 *  strip") — a lane with zero open arcs renders a one-line empty state
 *  instead of an axis with nothing on it, regardless of recent session
 *  activity. `availableWidth` is the caller-measured px width of the
 *  strip's container (`.op-lane` in the real plugin, an arithmetic estimate
 *  in render-preview.mjs); when given, columns fit the track exactly with no
 *  scroll if every column clears 24px (COL_MIN_FIT), else fall back to a
 *  fixed 56-96px width with horizontal scroll (COL_MIN/COL_MAX) — see the
 *  fitsNoScroll block below — and the gutter scales off it too (GUTTER_MIN/MAX). */
export function renderArcStrip(lane: string, arcs: Any[], sessionsLog: Any[], now: number = Date.now(), availableWidth?: number): string {
	const windowStart = now - WINDOW_DAYS * DAY_MS;
	const all: Any[] = sessionsLog || [];

	const laneArcs = (arcs || []).filter((a) => a.lane === lane);
	const openArcs = laneArcs.filter((a) => a.open);

	if (!openArcs.length) {
		return `<div class="arc-empty">no open arcs in the last ${WINDOW_DAYS}d</div>`;
	}

	// Column set = every member session of every OPEN arc rendered on this
	// strip (multi-row AND singles) -- NOT every session that merely touched
	// the lane in the window. That distinction is the actual fix for a
	// reported "row renders with no nodes" defect (s916 follow-up): the
	// prior version unioned in `baseCols` (every lane-touching session
	// inside WINDOW_DAYS, node-bearing or not) BEFORE adding arc members --
	// on a lane with heavy session traffic that's a lot of columns that can
	// never draw a node (measured live: 28 lane-touch sessions vs 23 real
	// arc-member sessions for _System, i.e. 11 pure-filler columns once
	// de-duplicated against the 23 that matter). Diagnosis correction: every
	// arc member session WAS already getting a column and a node -- the
	// original bug report's symptom (rows reading empty to the operator) was
	// real, but its cause was axis-space dilution pushing genuine nodes far
	// enough apart that neither scroll extreme (default right-anchor or
	// hard-left) showed every row at once, not a missing-column bug.
	// Dropping the filler columns narrows the track (measured: 34 -> 23
	// columns for the same _System render, ~32% less to scroll through) --
	// it does not shrink the true span when an open arc's own founding
	// session is genuinely old (Teardown fleet's s842, 32 days back): that
	// residual scroll distance is real activity, not waste, and compressing
	// it further would be a visual redesign, not a bugfix -- left for the
	// operator/team-lead to weigh in on separately if it's still a problem.
	const rowByN = new Map<number, Any>(all.map((r) => [r.n, r]));
	const colSet = new Set<number>();
	for (const a of openArcs) {
		for (const s of a.sessions || []) {
			colSet.add(s.n);
			if (!rowByN.has(s.n)) rowByN.set(s.n, s);
		}
	}
	const colNs = Array.from(colSet).sort((x, y) => x - y);
	const numCols = colNs.length || 1;

	const gutterPx = computeGutterPx(availableWidth);
	// trackAvail = the strip's visible width minus the sticky gutter -- the
	// actual horizontal space columns have to work with. fitsNoScroll: can
	// every column get at least COL_MIN_FIT(24px) inside that space? If so,
	// colW fills trackAvail exactly (capped at COL_MAX so a lane with only a
	// couple of columns doesn't stretch to absurd spacing) and the strip
	// needs no scroll. Otherwise, unchanged fixed-width(56-96px)+scroll
	// fallback from before this pass.
	const trackAvail = availableWidth ? Math.max(0, availableWidth - gutterPx) : undefined;
	const fitsNoScroll = !!trackAvail && numCols * COL_MIN_FIT <= trackAvail;
	const colW = trackAvail
		? (fitsNoScroll
			? Math.max(COL_MIN_FIT, Math.min(COL_MAX, Math.floor(trackAvail / numCols)))
			: Math.max(COL_MIN, Math.min(COL_MAX, Math.floor(trackAvail / numCols))))
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

	// Thinned session labels (operator ruling s916 follow-up): a compressed
	// fit-to-track column can drop below the ~44px an "s914"-shaped label
	// needs to avoid overlapping its neighbours -- label every column at
	// full width, every 2nd once it's tight, every 3rd once it's very tight,
	// but the first column, the last column, and any date-tick column are
	// ALWAYS labelled regardless of stride (a reader needs the axis's start,
	// end, and week markers even on the narrowest render).
	const labelStride = colW >= 44 ? 1 : colW >= 30 ? 2 : 3;
	const hdrCols = colNs.map((n, i) => {
		const row = rowByN.get(n);
		const tick = ticks.has(n);
		const show = tick || i === 0 || i === colNs.length - 1 || i % labelStride === 0;
		return `<div class="arc-col-lbl" style="left:${colX(n)}px">${show ? `s${esc(n)}` : ""}${tick ? `<span class="arc-col-date">${esc(shortDate(row?.date))}</span>` : ""}</div>`;
	}).join("");
	const hdrRow = `<div class="arc-row arc-row-hdr"><div class="arc-gutter" style="${gutterStyleAttr(gutterPx)}"></div><div class="arc-track" style="width:${trackWidth}px">${hdrCols}</div></div>`;

	// "<- earlier" jump markers (fallback scroll case only, operator
	// complaint "rows read empty" -- s916 follow-up): the strip default-
	// scrolls to its right edge (operator-panel.ts paintLane(), mirrored in
	// render-preview.mjs), so the default-visible window in TRACK-relative
	// x-coordinates (the same space colX() already uses) is exactly
	// [trackWidth - viewportTrackW, trackWidth] -- viewportTrackW being the
	// space available to the track once the sticky gutter is excluded, same
	// quantity as trackAvail above (falls back to trackWidth itself, i.e. a
	// window covering the whole track, when availableWidth was never
	// measured -- correctly produces zero markers rather than guessing).
	// A row whose nodes are ALL to the left of that window reads as empty on
	// first paint; a muted, clickable marker at its gutter names what's
	// hidden. Naturally inert in the fit-to-track case: trackWidth <=
	// viewportTrackW there by construction, so defaultVisibleLeft clamps to
	// 0 and no node position (always >= 0) is ever "before" it.
	const viewportTrackW = trackAvail ?? trackWidth;
	const defaultVisibleLeft = Math.max(0, trackWidth - viewportTrackW);
	function jumpMarker(items: { id: string; x: number }[]): string {
		if (!items.length) return "";
		const hidden = items.filter((it) => it.x < defaultVisibleLeft);
		if (!hidden.length || hidden.length < items.length) return "";
		const jumpTo = Math.max(0, Math.min(...hidden.map((h) => h.x)) - 40);
		const label = hidden.length <= 2 ? `← ${hidden.map((h) => `s${h.id}`).join("·")}` : `← ${hidden.length} earlier`;
		const title = `scroll to ${hidden.map((h) => `s${h.id}`).join(", ")}`;
		return `<span class="arc-jump" data-jump-to="${jumpTo}" title="${esc(title)}">${esc(label)}</span>`;
	}

	const multi = openArcs.filter((a) => a.first !== a.last).slice().sort((a, b) => (b.last ?? 0) - (a.last ?? 0));
	const singles = openArcs.filter((a) => a.first === a.last);

	const multiRows = multi.map((a) => {
		const members: Any[] = a.sessions || [];
		const items = members.map((s) => ({ id: String(s.n), x: colX(s.n) }));
		return renderMultiRow(a, colX, trackWidth, gutterPx, jumpMarker(items));
	}).join("");

	const singlesNodes = singles.map((a) => renderSingleNode(a, rowByN.get(a.first) || (a.sessions && a.sessions[0]), colX(a.first))).join("");
	// Singles share ONE row across every one-off arc, so the "all nodes
	// hidden" check runs over the whole set at once -- a partially-visible
	// singles row already satisfies "no row reads as empty."
	const singlesJump = jumpMarker(singles.map((a) => ({ id: String(a.first), x: colX(a.first) })));
	const singlesRow = singles.length
		? `<div class="arc-row arc-row-singles"><div class="arc-gutter" style="${gutterStyleAttr(gutterPx)}">singles <span class="arc-row-n">${singles.length}</span>${singlesJump}</div><div class="arc-track" style="width:${trackWidth}px">${singlesNodes}</div></div>`
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

// ── ARCS compact (v5, SYS-485 schema 4) ───────────────────────────────
// A different visual shape from renderArcStrip above -- one ROW per arc
// (gutter label | meta text | inline flex-wrapped session dots), no
// index-spaced axis and no horizontal scroll, matching the approved mock's
// arcRowHtml. Added alongside renderArcStrip rather than replacing it: the
// axis-strip machinery above (fit-to-track sizing, jump markers, the sticky
// gutter) was purpose-built and verified over two prior rounds (s916), and
// nothing in the v5 contract asks for it to be deleted -- only for the ARCS
// PANEL to render the mock's compact shape. Left in place, unused by the v5
// path, for rollback safety; flagged to team-lead as a judgment call.
//
// `arc.phase` is now generator-computed (contract: derived from the arc's
// most-recent session's last 1-2 events) -- no client-side phaseOf() needed,
// unlike the mock's own placeholder version of this function.
//
// The gutter carries BOTH .agutter (v5 layout) and the pre-existing
// .arc-gutter[data-arc] (arc-hover.ts's exact delegation selector) so
// ArcHover's card keeps working with zero new wiring ("hover unchanged" per
// the contract). Each dot carries data-sess (SessionHover's delegation
// selector) plus a short title -- same judgment call as renderNode/
// renderSingleNode above (s916 follow-up): SessionHover's card shows the
// session's own note/events, genuinely different content from a bare
// "s842 · date" tooltip, so this isn't the native-title/card duplicate-text
// pair the double-popup fix targeted elsewhere.

function phaseClass(phase: string): string {
	return `v5-phase-${String(phase || "open").replace(/\s+/g, "-")}`;
}

function arcRowV5Html(a: Any): string {
	const sessions: Any[] = a.sessions || [];
	const n = sessions.length;
	const span = arcSpan(a);
	const lastSess = sessions[sessions.length - 1];
	const lastGlyph = nodeMarks(lastSess?.events);
	const dots = sessions.map((s) => {
		const b = lastEventBucket(s.events);
		return `<span class="v5-adot nc-${b}" data-sess="${esc(s.n)}" title="s${esc(s.n)} · ${esc(s.date)}">${nodeMarks(s.events)}</span>`;
	}).join("");
	const phase = a.phase || "open";
	// Date range wrapped in its own span (`.v5-adate`) and hidden below the
	// 560px ARCS-stack breakpoint (team-lead, s918): the meta line was
	// truncating from the right at 460px and cutting the phase tag, which
	// must always stay visible -- dates are the least important token here.
	return `<div class="v5-arow">`
		+ `<div class="v5-agutter arc-gutter" data-arc="${esc(a.id)}">${gutterLabelHtml(a.label)}</div>`
		+ `<div class="v5-ameta">${n} sess<span class="v5-adate"> · ${esc(span)}</span>${lastGlyph ? ` <span class="v5-lastglyph">${lastGlyph}</span>` : ""} · <span class="v5-phase ${phaseClass(phase)}">${esc(phase)}</span></div>`
		+ `<div class="v5-atrack">${dots}</div>`
		+ `</div>`;
}

/** Origin-lane filter, open only, cap 5, most-recent session first (contract
 *  "Unchanged but load-bearing" arcs[] rules -- same laneArcs semantics as
 *  renderArcStrip's, s916 follow-up: `a.lane === lane`, not the wider
 *  `a.lanes` union). Only two glyphs survive in the legend now (× found
 *  broken, ‖ waiting) -- the 9-symbol node-colour legend is gone. */
export function renderArcsV5(lane: string, arcs: Any[]): string {
	const laneArcs = (arcs || []).filter((a) => a.lane === lane && a.open)
		.slice().sort((a, b) => (b.last ?? 0) - (a.last ?? 0)).slice(0, 5);
	const head = `<h2>ARCS <span class="n">${laneArcs.length}</span></h2>`;
	if (!laneArcs.length) return head + `<div class="empty">no open arcs</div>`;
	const rows = laneArcs.map(arcRowV5Html).join("");
	// Reuses the existing .arc-legend/.lg/.lg-mark skin (renderArcStrip's own
	// legend below) verbatim -- just two entries instead of the old 9-glyph
	// node-colour spread.
	const legend = `<div class="arc-legend"><span class="lg"><span class="lg-mark">×</span>found broken</span><span class="lg"><span class="lg-mark">‖</span>waiting</span></div>`;
	return head + rows + legend;
}
