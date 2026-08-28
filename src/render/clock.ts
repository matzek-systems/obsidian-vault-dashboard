import { Any, wiRow } from "./common";

/** Live, non-blocked due rows only. `blockedOverdue` (rows that are both
 *  blocked and overdue — a graveyard signal, not urgency) gets one dim
 *  summary line underneath instead of polluting the real clock. */
export function renderClock(clock: Any[], blockedOverdue?: Any[]): string {
	const rows = clock || [];
	let h = rows.length ? rows.map((w) => wiRow(w)).join("") : `<div class="empty">no deadlines inside 45d</div>`;
	if (blockedOverdue && blockedOverdue.length) {
		h += `<div class="clock-blocked-note">+ ${blockedOverdue.length} blocked &amp; overdue, not shown as live urgency</div>`;
	}
	return h;
}
