// ── TODAY (v5, SYS-485 schema 4) ──────────────────────────────────────
// Cross-lane, one wrapping line, painted ONCE above the lane content (same
// on every tab -- operator-panel.ts paints it into its own skeleton slot,
// not per-lane). Reads the new top-level `data.today` object directly;
// nothing here is derived -- the generator already picked the AM/Q2 block,
// the tier/why phrase, and the day's real calendar events.

import { Any, esc, truncate } from "./common";

/** date -> 3-letter weekday, for the "Wed Q2: ..." label when q2.date isn't
 *  today (q2 shows every day per the contract, "even on Wed itself" --
 *  display-only formatting, not business logic). Parsed at noon to dodge a
 *  UTC-midnight rollback into the previous day. */
function dowShort(dateStr: string | undefined): string {
	if (!dateStr) return "";
	const d = new Date(`${dateStr}T12:00:00`);
	if (Number.isNaN(d.getTime())) return "";
	return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
}

export function renderToday(today: Any): string {
	if (!today) return "";
	const parts: string[] = [];
	parts.push(`<b>TODAY</b> ${esc(today.dow)} ${esc(String(today.date || "").slice(5))}`);

	if (today.weekend) {
		parts.push(today.dow === "Sat" ? "open day" : "free");
	} else if (today.am) {
		const am = today.am;
		const idHtml = `<span class="tid" data-act="open" data-id="${esc(am.id)}" data-lane="${esc(am.lane)}">${esc(am.id)}</span>`;
		parts.push(`AM block: ${esc(am.title)} (${idHtml}) · ${esc(am.why)} · lev ${esc(am.leverage)}`);
	} else {
		parts.push("no AM block planned");
	}

	for (const ev of today.events || []) {
		parts.push(`${esc(ev.all_day ? "all day" : ev.start)} ${esc(ev.subject)}`);
	}

	if (today.q2) {
		const q2 = today.q2;
		const dow = dowShort(q2.date) || "Wed";
		// `.tid` is styled monospace/colored for short WI-IDs -- wrapping the
		// full TITLE in it (the previous code) rendered the whole title in
		// code font. Mirror the AM block's own "title (id-chip)" shape above:
		// plain body text for the title (truncated -- team-lead spec, ~60
		// chars), the clickable id chip on its own.
		const idHtml = `<span class="tid" data-act="open" data-id="${esc(q2.id)}" data-lane="${esc(q2.lane)}">${esc(q2.id)}</span>`;
		parts.push(`${dow} Q2: ${esc(truncate(q2.title, 60))} (${idHtml})`);
	}

	return `<div class="v5-today">${parts.join(" · ")}</div>`;
}
