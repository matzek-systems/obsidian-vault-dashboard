// OVERDUE strip (session 931, operator ruling: "an active threads area ...
// and then overdue items is optimal"). One row per working WI whose `due:`
// has passed, most overdue first, from the per-lane WI lists already in the
// JSON (wiIndex). Deterministic: a date and a status, no score. The signal
// test (Scratchpad/dashboard-signal-test-s931.md) showed overdue rows are
// only as honest as the due dates; the fix for a stale date is on the WI,
// not here.
//
//   OVERDUE 7
//   !  MM-32   Detector upgrades from the s792 audit ...     MatzekMedia  16d
//   !  SOMA-6  Bulk stock reality: 5 bulk ASINs ...          SomaGuard    15d
//
// Row text is the WI's own `next:` line (its first unchecked task) when it
// has one, else the title; the title sits in the tooltip. Capped at 6 rows
// plus "+N more". Renders nothing when nothing is overdue.

import { Any, esc } from "./common";

const CAP = 6;
const TERMINAL = new Set(["done", "killed", "superseded", "dormant", "deferred"]);

export function overdueRows(idx: Map<string, Any>): Any[] {
	const rows: Any[] = [];
	for (const w of idx.values()) {
		if (typeof w.due_in !== "number" || w.due_in >= 0) continue;
		if (TERMINAL.has(String(w.status || ""))) continue;
		rows.push(w);
	}
	rows.sort((a, b) => a.due_in - b.due_in || String(a.id).localeCompare(String(b.id)));
	return rows;
}

export function renderOverdue(data: Any, tab: string | null, idx: Map<string, Any>): string {
	const rows = overdueRows(idx);
	if (!rows.length) return "";
	const items = rows.slice(0, CAP).map((w) => {
		const lane = w.lane ? `<span class="thr-lane">${esc(w.lane === "_System" ? "System" : w.lane)}</span>` : "";
		const dim = tab && w.lane && w.lane !== tab ? " dim" : "";
		const text = w.next || w.next_task || w.title || "";
		// No native `title=` here: the `.tid` chip already carries data-id, which
		// WiHover turns into the rich WI card. A native title on the same element
		// (and on .attn-txt) rendered a second OS tooltip on top of that card —
		// two overlays at once, neither readable (operator report, session 954).
		return `<div class="attn-row rule${dim}" data-kind="overdue">`
			+ `<i class="attn-k">!</i>`
			+ `<span class="tid c-${esc(w.status || "")}" data-id="${esc(w.id)}" data-act="open">${esc(w.id)}</span>`
			+ `<span class="attn-txt">${esc(text)}</span>${lane}`
			+ `<span class="attn-since over">${-w.due_in}d</span></div>`;
	}).join("");
	const more = rows.length > CAP ? `<div class="attn-more">+${rows.length - CAP} more</div>` : "";
	return `<div class="op-attn"><div class="attn-head">overdue <span class="n">${rows.length}</span></div>${items}${more}</div>`;
}
