import { Any, esc, laneList, laneListV5 } from "./common";

/** Lane tabs — the spine, near the top of the panel (operator ruling: "very
 *  important"). Default/focal tab is the lane the operator last typed in. */
export function renderTabs(data: Any, activeTab: string | null): string {
	const lanes = laneList(data);
	return lanes.map((b) =>
		`<span class="tab ${b.lane === activeTab ? "on" : ""}" data-act="tab" data-lane="${esc(b.lane)}" title="${b.focal ? "where you last typed · " : ""}${b.working} working">${b.focal ? `<span class="dot"></span>` : ""}${esc(b.lane)}<span class="n">${b.working}</span></span>`
	).join("");
}

/** v5 (SYS-485 schema 4): the badge is now `badge.overdue + badge.decisions`
 *  (per-lane, generator-computed), red, and OMITTED at 0 -- roster size is
 *  gone from the tab (contract: "roster size is gone from the tab"). Same
 *  click/tab-switch wiring (data-act="tab") as renderTabs above, so
 *  operator-panel.ts's onClick handler needs no changes. */
export function renderTabsV5(data: Any, activeTab: string | null): string {
	const lanes = laneListV5(data);
	return lanes.map((b) => {
		const n = (b.badge?.overdue ?? 0) + (b.badge?.decisions ?? 0);
		const title = b.focal ? ` title="where you last typed"` : "";
		return `<span class="tab ${b.lane === activeTab ? "on" : ""}" data-act="tab" data-lane="${esc(b.lane)}"${title}>${b.focal ? `<span class="dot"></span>` : ""}${esc(b.lane)}${n > 0 ? `<span class="v5-tabn">${n}</span>` : ""}</span>`;
	}).join("");
}
