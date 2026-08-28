// Full-label hover card for a swimlane arc's gutter (SYS-485, s914). The
// gutter label clamps to 2 lines (arc-strip.ts's gutterLabelHtml +
// styles.css) -- this card shows the FULL untruncated label + span/WIs/
// status, same skin as session-hover.ts, triggered on a multi-row's
// [data-arc] .arc-gutter (singles-row gutters carry no data-arc; their
// nodes already have their own [data-sess] session card). The gutter's
// native title="" attribute still carries the same text for anyone who
// prefers a plain OS tooltip -- this is the richer/faster-to-read version.

import { Any, esc } from "./render/common";
import { arcSpan } from "./render/arc-strip";
import { showCard, hideCard } from "./hover-card";

export class ArcHover {
	private cardEl: HTMLElement | null = null;
	private timer: number | null = null;
	private cur: HTMLElement | null = null;
	private arcs: Map<string, Any> = new Map();

	setData(arcs: Any[]): void {
		this.arcs = new Map((arcs || []).map((a) => [a.id, a]));
	}

	attach(root: HTMLElement): void {
		root.addEventListener("mouseover", (e: MouseEvent) => {
			const t = (e.target as HTMLElement).closest(".arc-gutter[data-arc]") as HTMLElement | null;
			if (!t || t === this.cur) return;
			this.cur = t;
			this.hide();
			const a = this.arcs.get(t.dataset.arc || "");
			if (!a) return;
			this.timer = window.setTimeout(() => this.show(a, e), 160);
		});
		root.addEventListener("mouseout", (e: MouseEvent) => {
			const t = (e.target as HTMLElement).closest(".arc-gutter[data-arc]") as HTMLElement | null;
			const to = (e.relatedTarget as HTMLElement | null)?.closest?.(".arc-gutter[data-arc]") as HTMLElement | null;
			if (t && to === t) return;
			this.cur = null;
			this.hide();
		});
	}

	private show(a: Any, event: MouseEvent): void {
		this.hide();
		const wis = a.wis && a.wis.length ? a.wis.join(", ") : "no WIs";
		const html = `<div class="op-wi-card-title">${esc(a.label)}</div>`
			+ `<div class="op-wi-card-body">${esc(arcSpan(a))} · ${esc(wis)}</div>`
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
