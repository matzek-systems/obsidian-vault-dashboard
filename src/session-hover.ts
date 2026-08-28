// Generic session card for the arc strip (SYS-485, session 911) — hovering
// any [data-sess] node shows the session's miner note + events, via the
// same showCard() skin as wi-card.ts's WI cards. Delegated on the panel
// root, same pattern as WiHover: short hover delay, dispose on mouseout.

import { Any, esc } from "./render/common";
import { showCard, hideCard } from "./hover-card";

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

export class SessionHover {
	private cardEl: HTMLElement | null = null;
	private timer: number | null = null;
	private cur: HTMLElement | null = null;
	private rows: Map<number, Any> = new Map();

	setData(sessionsLog: Any[]): void {
		this.rows = new Map((sessionsLog || []).map((r) => [r.n, r]));
	}

	attach(root: HTMLElement): void {
		root.addEventListener("mouseover", (e: MouseEvent) => {
			const t = (e.target as HTMLElement).closest("[data-sess]") as HTMLElement | null;
			if (!t || t === this.cur) return;
			this.cur = t;
			this.hide();
			const n = Number(t.dataset.sess);
			const row = this.rows.get(n);
			if (!row) return;
			this.timer = window.setTimeout(() => this.show(row, e), 160);
		});
		root.addEventListener("mouseout", (e: MouseEvent) => {
			const t = (e.target as HTMLElement).closest("[data-sess]") as HTMLElement | null;
			const to = (e.relatedTarget as HTMLElement | null)?.closest?.("[data-sess]") as HTMLElement | null;
			if (t && to === t) return;
			this.cur = null;
			this.hide();
		});
	}

	private show(row: Any, event: MouseEvent): void {
		this.hide();
		const events = (row.events || []).map((ev: Any) =>
			`<div class="op-sess-card-ev"><b>${esc(EVENT_LABEL[ev.type] || ev.type)}</b>${ev.wi ? ` <span class="op-sess-card-wi">${esc(ev.wi)}</span>` : ""}<div>${esc(ev.text)}</div></div>`
		).join("");
		const html = `<div class="op-wi-card-title">s${esc(row.n)}${row.dead ? " (dead)" : ""} · ${esc(row.date)}</div>`
			+ `<div class="op-wi-card-body">${esc(row.note || "")}</div>`
			+ (events ? `<div class="op-sess-card-evs">${events}</div>` : "")
			+ `<div class="op-wi-card-foot"><span>${esc((row.lanes || [row.lane]).join(", "))}</span>${row.arc ? `<span>${esc(row.arc)}</span>` : ""}</div>`;
		this.cardEl = showCard(html, event, "op-sess-card");
	}

	hide(): void {
		if (this.timer !== null) { window.clearTimeout(this.timer); this.timer = null; }
		hideCard(this.cardEl);
		this.cardEl = null;
	}

	dispose(): void { this.hide(); }
}
