import { Any, esc, wiRow } from "./common";

const REASON_LABEL: Record<string, string> = {
	overdue: "overdue", owed: "owed", decision: "decision", verify: "verify", stalled: "stalled",
};

function reasonPills(reasons: string[] | undefined, hit?: string | null): string {
	if (!reasons || !reasons.length) return "";
	const title = hit ? ` title="${esc(hit)}"` : "";
	return `<div class="tri-reasons">${reasons.map((r) => `<span class="pill reason r-${esc(r)}"${title}>${esc(REASON_LABEL[r] || r)}</span>`).join("")}</div>`;
}

/** Cross-lane triage: YOUR MOVE (uncapped) / THEM (waiting room, aged) /
 *  SEAT (counts + stalled tripwire only, per lane) / DECISIONS. Replaces
 *  the old "swept under the rug" panel — same underlying signal
 *  (stalled/owed/rot), reorganized by WHO acts next instead of by kind. */
export function renderTriage(triage: Any, _data?: Any): string {
	if (!triage) return `<div class="empty">no triage data</div>`;
	let h = `<div class="tri-cols">`;

	const you: Any[] = triage.you || [];
	h += `<div class="tri-col tri-you"><h3>your move <span class="n">${you.length}</span></h3>`;
	h += you.length
		? you.map((w) => wiRow(w, null, { showActor: false }) + reasonPills(w.reason, w.hit)).join("")
		: `<div class="empty">nothing waiting on you</div>`;
	h += `</div>`;

	const them: Any[] = triage.them || [];
	h += `<div class="tri-col tri-them"><h3>them <span class="n">${them.length}</span></h3>`;
	h += them.length
		? them.map((w) => wiRow(w, w.hit || null)).join("")
		: `<div class="empty">nothing waiting on someone else</div>`;
	h += `</div>`;

	const seat: Record<string, Any> = triage.seat || {};
	const seatRows = Object.entries(seat).filter(([, v]: [string, Any]) => v && (v.count || (v.stalled || []).length));
	h += `<div class="tri-col tri-seat"><h3>seat</h3>`;
	h += seatRows.length
		? seatRows.map(([lane, v]: [string, Any]) =>
			`<div class="tri-seat-row"><b>${esc(lane)}</b><span>${v.count} untouched</span>${(v.stalled || []).length ? `<span class="tri-stalled">stalled: ${v.stalled.map((s: string) => esc(s)).join(", ")}</span>` : ""}</div>`
		).join("")
		: `<div class="empty">nothing stalled</div>`;
	h += `</div>`;

	const decisions: Any[] = triage.decisions || [];
	h += `<div class="tri-col tri-dec"><h3>decisions <span class="n">${decisions.length}</span></h3>`;
	h += decisions.length
		? decisions.map((d) => `<div class="tri-dec-row"><span>${esc(d.title)}</span>${d.age_days != null ? `<span class="age">${d.age_days}d</span>` : ""}</div>`).join("")
		: `<div class="empty">no open decisions</div>`;
	h += `</div>`;

	h += `</div>`;
	return h;
}

/** Total items across YOUR MOVE + THEM — used for the collapsed cross-lane
 *  board's summary badge (operator-panel.ts) so its count is visible
 *  without opening it. */
export function triageTotal(triage: Any): number {
	if (!triage) return 0;
	return (triage.you || []).length + (triage.them || []).length;
}

const LANE_TRI_TOP = 4;

/** Per-lane triage (SYS-485, s916 operator ruling): YOUR MOVE top 4 + THEM
 *  top 4 for THIS lane only (triage.you/them filtered by lane, order kept
 *  as given — already priority-sorted upstream), with a native <details>
 *  "+N more" expander revealing the rest inline. The full cross-lane board
 *  (renderTriage, above, unfiltered) moves to a collapsed section at the
 *  panel's very bottom instead of living per-tab. */
export function renderLaneTriage(triage: Any, lane: string): string {
	if (!triage) return "";
	const you: Any[] = (triage.you || []).filter((w: Any) => w.lane === lane);
	const them: Any[] = (triage.them || []).filter((w: Any) => w.lane === lane);
	if (!you.length && !them.length) return "";

	const col = (title: string, cls: string, all: Any[], rowFn: (w: Any) => string): string => {
		const top = all.slice(0, LANE_TRI_TOP);
		const rest = all.slice(LANE_TRI_TOP);
		const moreHtml = rest.length
			? `<details class="tri-more"><summary>+${rest.length} more</summary>${rest.map(rowFn).join("")}</details>`
			: "";
		return `<div class="tri-col ${cls}"><h3>${esc(title)} <span class="n">${all.length}</span></h3>`
			+ (top.length ? top.map(rowFn).join("") : `<div class="empty">nothing</div>`)
			+ moreHtml
			+ `</div>`;
	};

	return `<div class="lane-tri">`
		+ col("your move", "tri-you", you, (w) => wiRow(w, null, { showActor: false }) + reasonPills(w.reason, w.hit))
		+ col("them", "tri-them", them, (w) => wiRow(w, w.hit || null))
		+ `</div>`;
}
