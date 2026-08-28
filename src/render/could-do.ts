import { Any, esc, wiRow } from "./common";

/** Accepts both the schema-2 bare array and the schema-3
 *  {ranked, explicit_tags, items} wrapper. `ranked=false` (fewer than 10
 *  explicit leverage tags in the roadmaps) drops the "highest leverage"
 *  claim rather than asserting a ranking the data can't back yet. */
export function renderCouldDo(couldDo: Any): string {
	const wrapped = Array.isArray(couldDo) ? { ranked: true, items: couldDo, explicit_tags: 0 } : (couldDo || { ranked: true, items: [] });
	const items: Any[] = (wrapped.items || []).filter((c: Any) => !c.error);
	const label = wrapped.ranked ? "highest leverage · no due" : "untouched · weight-5 lanes";
	const rows = items.map((c) => wiRow(c, `${String(c.lane || "").replace(" Roadmap", "")} · ${c.why}`)).join("");
	return `<div class="could-label">${esc(label)}</div>` + (rows || `<div class="empty">${esc((wrapped.items || [])[0]?.error || "nothing")}</div>`);
}
