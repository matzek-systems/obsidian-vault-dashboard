// Full-label hover card for a thread row's label (SYS-485; s914/s916 arc
// gutter card, retargeted to the thread board in v3.0.0, session 927). The
// label ellipsis-clamps to one line -- this card shows the FULL label + the
// session span + per-WI progress + open/closed, same skin as
// session-hover.ts, triggered on any `.thr-lbl[data-arc]`.
//
// Data: setData() takes the thread rows (open + closed) -- each carries
// wi_rows ({id,status,tasks_done,tasks_total,band,delta}), wis, chain, lane,
// label, open -- and degrades to the plain wis id list when wi_rows is empty.

import { Any, esc } from "./render/common";
import { arcSpan } from "./render/threads";
import { showCard, hideCard } from "./hover-card";

/** One WI progress line inside the card, reusing the session-card's own
 *  .op-sess-card-ev skin (session-hover.ts) so the two card bodies read as
 *  one system. `.c-${status}` (styles.css status-color rules) wins over the
 *  skin's own <b> color by specificity, so the id reads in its status color. */
function wiRowLine(w: Any): string {
	const prog = w.tasks_total ? ` <span class="op-sess-card-wi">${esc(w.tasks_done ?? 0)}/${esc(w.tasks_total)}</span>` : "";
	const delta = w.delta && w.delta.summary ? `<div>${esc(w.delta.summary)}</div>` : "";
	return `<div class="op-sess-card-ev"><b class="c-${esc(w.status || "")}">${esc(w.id)}</b>${prog}${delta}</div>`;
}

const SEL = ".thr-lbl[data-arc]";

export class ArcHover {
	private cardEl: HTMLElement | null = null;
	private timer: number | null = null;
	private cur: HTMLElement | null = null;
	private arcs: Map<string, Any> = new Map();

	setData(rows: Any[]): void {
		this.arcs = new Map((rows || []).map((a) => [a.id, a]));
	}

	attach(root: HTMLElement): void {
		root.addEventListener("mouseover", (e: MouseEvent) => {
			const t = (e.target as HTMLElement).closest(SEL) as HTMLElement | null;
			if (!t || t === this.cur) return;
			this.cur = t;
			this.hide();
			const a = this.arcs.get(t.dataset.arc || "");
			if (!a) return;
			this.timer = window.setTimeout(() => this.show(a, e), 160);
		});
		root.addEventListener("mouseout", (e: MouseEvent) => {
			const t = (e.target as HTMLElement).closest(SEL) as HTMLElement | null;
			const to = (e.relatedTarget as HTMLElement | null)?.closest?.(SEL) as HTMLElement | null;
			if (t && to === t) return;
			this.cur = null;
			this.hide();
		});
	}

	private show(a: Any, event: MouseEvent): void {
		this.hide();
		const wiRows: Any[] = a.wi_rows || [];
		const wisHtml = wiRows.length
			? `<div class="op-sess-card-evs">${wiRows.map(wiRowLine).join("")}</div>`
			: (a.wis && a.wis.length ? `<div class="op-wi-card-body">${esc(a.wis.join(", "))}</div>` : `<div class="op-wi-card-body">no WIs</div>`);
		const closed = a.closed ? `<div class="op-wi-card-note">closed — ${esc(a.closed.by === "wis" ? "every WI on the thread is terminal" : (a.closed.reason || a.closed.by || "closed"))}</div>` : "";
		const html = `<div class="op-wi-card-title">${esc(a.label)}</div>`
			+ `<div class="op-wi-card-body">${esc(arcSpan(a))}${a.phase && a.phase !== "open" ? ` · ${esc(a.phase)}` : ""}</div>`
			+ wisHtml
			+ closed
			+ `<div class="op-wi-card-foot"><span>${a.open ? "open" : "closed"}</span>${a.lane ? `<span>${esc(a.lane)}</span>` : ""}</div>`;
		this.cardEl = showCard(html, event, "op-sess-card");
	}

	hide(): void {
		if (this.timer !== null) { window.clearTimeout(this.timer); this.timer = null; }
		hideCard(this.cardEl);
		this.cardEl = null;
	}

	dispose(): void { this.hide(); }
}
