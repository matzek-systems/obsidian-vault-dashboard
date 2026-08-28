import { Any, esc, ageBadge } from "./common";

export function renderCapture(cap: Any[]): string {
	const rows = cap || [];
	const body = rows.map((c) => `<div class="crow"><span>${esc(c.title)}</span>${c.age_days !== null && c.age_days !== undefined ? ageBadge(c.age_days) : ""}</div>`).join("");
	return body || `<div class="empty">capture zone empty</div>`;
}
