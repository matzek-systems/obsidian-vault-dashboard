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
