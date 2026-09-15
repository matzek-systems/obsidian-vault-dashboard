// SYS-518 ranking surfaces (s954 scoring model, flipped live session 975).
// Pure string renderers over `data.surfaces` -- no Obsidian, no DOM, same
// contract as the rest of src/render/. The generator emits the block only
// when leverage-config.json's model is s954 (null otherwise -> render "").
//
//   BIG ROCKS
//   9  ACME-12 Renew the domain before the registrar lapses  Acme         e1  13d overdue
//   DO NOW 16
//   9  ACME-14 ask the client for the staff seat invite      Acme         e1
//   ... (operator-hands top 5; seat-runnable rows fold below -- they are the
//        nightly queue's feed (SYS-524), not the operator's list)
//
// Ranking semantics (rendered, never recomputed here): rank = base /10
// leverage + neglect bump, capped 9; overdue pins Big rocks; a `?N` +
// `until:` row is undetermined -- the resolving fact IS its do-now, so the
// row's text shows the until-fact. Do-or-kill (spec: "at the top of a list
// the item is presented as do-or-kill"): the top row of each surface carries
// the pill when its neglect bump sits at the +3 cap.

import { Any, esc, laneOf, contPrompt, sendBtn } from "./common";

const DO_NOW_CAP = 5;

/** "System" for the `_System` tab, else the tab itself -- surfaces rows carry
 *  lane names derived from roadmap file stems with the leading `_` stripped. */
function tabLane(r: Any): string {
	return laneOf({ id: r.id, lane: null });
}

function rankBadge(r: Any): string {
	const tip = r.undetermined
		? `undetermined (?${r.base}) — resolves on: ${r.until || "?"}`
		: `base ${r.base}${r.neglect ? ` +${r.neglect} neglect` : ""}${r.client ? " · client curve" : ""}`;
	return `<i class="sf-rank${r.client ? " client" : ""}${r.undetermined ? " undet" : ""}" title="${esc(tip)}">${r.undetermined ? "?" : esc(r.rank)}</i>`;
}

function metaBits(r: Any): string {
	const bits: string[] = [];
	if (r.effort != null) bits.push(`<span class="sf-eff" title="effort band ${esc(r.effort)}/10 (operator-minutes)">e${esc(r.effort)}</span>`);
	if (r.cost) bits.push(`<span class="sf-cost">${esc(r.cost)}</span>`);
	if (r.overdue_days > 0) bits.push(`<span class="attn-since over">${esc(r.overdue_days)}d overdue</span>`);
	else if (r.past_start_by) bits.push(`<span class="sf-start" title="start_by ${esc(r.start_by || "")} has passed">start now</span>`);
	return bits.join("");
}

function surfaceRow(r: Any, tab: string | null, top: boolean): string {
	const lane = tabLane(r);
	const dim = tab && lane !== tab ? " dim" : "";
	const laneChip = tab ? "" : `<span class="thr-lane">${esc(lane === "_System" ? "System" : lane)}</span>`;
	// Undetermined rows: the resolving fact is the action; otherwise the WI's
	// first open task when the generator found one, else the title. Title in
	// the hover card (the .tid chip), never a native title= (s954 double-popup).
	const text = r.undetermined && r.until ? `until: ${r.until}` : (r.next || r.title || "");
	const dok = top && r.neglect >= 3
		? `<span class="pill flip" title="neglect at cap (+3) at the top of the list — do it or kill it">do or kill?</span>` : "";
	return `<div class="attn-row sf-row${dim}" data-kind="surface">`
		+ rankBadge(r)
		+ `<span class="tid" data-id="${esc(r.id)}" data-act="open">${esc(r.id)}</span>`
		+ `<span class="attn-txt">${esc(text)}</span>${dok}${laneChip}`
		+ `<span class="sf-meta">${metaBits(r)}</span>${sendBtn(contPrompt(r.id))}</div>`;
}

export function renderSurfaces(data: Any, tab: string | null): string {
	const s = data?.surfaces;
	if (!s) return "";                                        // legacy model or pre-flip data
	if (s.error) return `<div class="op-attn"><div class="attn-head">surfaces</div><div class="empty">${esc(s.error)}</div></div>`;
	const rocks: Any[] = s.big_rocks || [];
	const all: Any[] = s.do_now || [];
	const hands = all.filter((r) => r.actor?.who !== "seat");
	const seat = all.filter((r) => r.actor?.who === "seat");

	const rocksHtml = rocks.length
		? `<div class="attn-head">big rocks</div>` + rocks.map((r, i) => surfaceRow(r, tab, i === 0)).join("")
		: "";
	const handRows = hands.slice(0, DO_NOW_CAP).map((r, i) => surfaceRow(r, tab, i === 0)).join("");
	const more = hands.length > DO_NOW_CAP ? `<div class="attn-more">+${hands.length - DO_NOW_CAP} more</div>` : "";
	const seatFold = seat.length
		? `<details class="sf-seat"><summary>seat-runnable <span class="n">${seat.length}</span> — the nightly queue's feed</summary>`
			+ seat.map((r) => surfaceRow(r, tab, false)).join("") + `</details>`
		: "";
	const doHtml = all.length
		? `<div class="attn-head">do now <span class="n">${hands.length}</span></div>${handRows}${more}${seatFold}`
		: "";
	if (!rocksHtml && !doHtml) return "";
	return `<div class="op-attn op-surf">${rocksHtml}${doHtml}</div>`;
}
