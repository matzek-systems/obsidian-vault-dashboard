import { Any, esc, laneList } from "./common";

/** Lane tabs — the spine, near the top of the panel (operator ruling: "very
 *  important"). Default/focal tab is the lane the operator last typed in. */
export function renderTabs(data: Any, activeTab: string | null): string {
	const lanes = laneList(data);
	return lanes.map((b) =>
		`<span class="tab ${b.lane === activeTab ? "on" : ""}" data-act="tab" data-lane="${esc(b.lane)}" title="${b.focal ? "where you last typed · " : ""}${b.working} working">${b.focal ? `<span class="dot"></span>` : ""}${esc(b.lane)}<span class="n">${b.working}</span></span>`
	).join("");
}
