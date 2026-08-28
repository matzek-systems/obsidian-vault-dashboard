import { Any, esc } from "./common";

// ── Arc strip ──────────────────────────────────────────────────────
// A horizontal time axis over the last WINDOW_DAYS days, one node per
// session that touched this lane (sessions_log), arc bars connecting
// same-arc sessions (stacked when more than one arc overlaps in time on
// this lane), event glyphs on nodes from the closed vocabulary in
// build-plan-s911.md §2. Positioned by real elapsed days (not sequence
// slot) so a discontinuous arc (e.g. s906 -> s910 with unrelated sessions
// in between) reads as a bar spanning real time, not adjacent cells.
// Scrolls horizontally inside its own track rather than squeezing to fit
// a ~420px pane — legibility over compression.

const WINDOW_DAYS = 21;
const DAY_MS = 86_400_000;
const DAY_PX = 26;
const MIN_NODE_GAP_PX = 30; // enough for "sNNN" + dot + glyphs not to collide
const BAR_ROW_PX = 15;

export const EVENT_GLYPH: Record<string, string> = {
	shipped: "✓",
	declared_done: "⚑",
	found_broken: "✗",
	root_caused: "●",
	false_alarm: "~",
	handoff: "→",
	dead: "×",
	filed: "+",
	decision: "◆",
	waiting_on_operator: "⏸",
	waiting_on_them: "⏸",
};

const EVENT_LABEL: Record<string, string> = {
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

function dayOffset(dateStr: string, windowStart: number): number {
	const t = new Date(`${dateStr}T12:00:00`).getTime();
	if (Number.isNaN(t)) return 0;
	return Math.max(0, (t - windowStart) / DAY_MS);
}

function nodeGlyphs(events: Any[]): string {
	if (!events || !events.length) return "";
	const seen = new Set<string>();
	const out: string[] = [];
	for (const e of events) {
		if (!e || seen.has(e.type) || !EVENT_GLYPH[e.type]) continue;
		seen.add(e.type);
		out.push(`<span class="ev-g ev-${esc(e.type)}" title="${esc(EVENT_LABEL[e.type] || e.type)}">${EVENT_GLYPH[e.type]}</span>`);
	}
	return out.join("");
}

/** lane = the lane this strip is scoped to; arcs/sessionsLog are the
 *  top-level (all-lane) schema-3 arrays, filtered here. */
export function renderArcStrip(lane: string, arcs: Any[], sessionsLog: Any[], now: number = Date.now()): string {
	const windowStart = now - WINDOW_DAYS * DAY_MS;
	const rows: Any[] = (sessionsLog || [])
		.filter((r) => (r.lanes && r.lanes.length ? r.lanes : [r.lane]).includes(lane))
		.slice()
		.sort((a, b) => (a.n ?? 0) - (b.n ?? 0));
	if (!rows.length) {
		return `<div class="arc-empty">no sessions touched this lane in the last ${WINDOW_DAYS}d</div>`;
	}

	const laneArcs = (arcs || []).filter((a) => a.lane === lane);

	// Position by real elapsed time, but enforce a minimum gap between
	// consecutive nodes so same-day sessions (common — see s892/893/894)
	// don't render exactly on top of each other. Bars read from this same
	// map so a bar endpoint never drifts from the node it's meant to touch.
	const posByN = new Map<number, number>();
	let prevX = -Infinity;
	for (const r of rows) {
		let x = dayOffset(r.date, windowStart) * DAY_PX;
		if (x < prevX + MIN_NODE_GAP_PX) x = prevX + MIN_NODE_GAP_PX;
		posByN.set(r.n, x);
		prevX = x;
	}
	const trackWidth = Math.max(220, prevX + 70);

	const nodes = rows.map((r) => {
		const x = posByN.get(r.n) ?? 0;
		const label = r.dead ? "×" : `s${r.n}`;
		return `<div class="arc-node${r.dead ? " dead" : ""}" style="left:${x}px" data-sess="${esc(r.n)}" title="s${esc(r.n)} · ${esc(r.date)}">`
			+ `<span class="arc-node-dot"></span>`
			+ `<span class="arc-node-lbl">${esc(label)}</span>`
			+ `<span class="arc-node-evs">${nodeGlyphs(r.events)}</span>`
			+ `</div>`;
	}).join("");

	const barRows = laneArcs.map((a, i) => {
		const first = rows.find((r) => r.n === a.first);
		const last = rows.find((r) => r.n === a.last);
		if (!first || !last) return "";
		const x1 = posByN.get(first.n) ?? 0;
		const x2 = posByN.get(last.n) ?? 0;
		const span = a.first === a.last ? "" : `${first.date} → ${last.date}`;
		const title = `${a.label}${span ? " · " + span : ""}${a.open ? " · open" : " · closed"}`;
		return `<div class="arc-bar${a.open ? " open" : ""}" style="left:${x1}px;width:${Math.max(6, x2 - x1)}px;top:${i * BAR_ROW_PX}px" title="${esc(title)}" data-arc="${esc(a.id)}">`
			+ `<span class="arc-bar-lbl">${esc(a.label)}</span>`
			+ `</div>`;
	}).join("");

	const legend = Object.keys(EVENT_GLYPH)
		.filter((k) => k !== "waiting_on_them") // dedupe the shared "waiting" glyph
		.map((k) => `<span class="lg" title="${esc(EVENT_LABEL[k])}">${EVENT_GLYPH[k]} ${esc(EVENT_LABEL[k])}</span>`)
		.join("");

	return `
	<div class="arc-strip">
		<div class="arc-strip-track" style="width:${trackWidth}px;height:${44 + laneArcs.length * BAR_ROW_PX}px">
			<div class="arc-bars" style="height:${laneArcs.length * BAR_ROW_PX}px">${barRows}</div>
			<div class="arc-nodes">${nodes}</div>
		</div>
	</div>
	<div class="arc-legend">${legend}</div>`;
}
