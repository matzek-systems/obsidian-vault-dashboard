// ── INBOX (v5, SYS-485 schema 4 / SYS-395) ────────────────────────────
// Render-only: each row's Accept/Expire buttons carry `data-heading` (=
// c.title) + `data-date` (= c.date) + `data-lane`. IMPORTANT: c.title is a
// LOSSY transform of the real `### ` heading line -- dashboard_data.py's
// _parse_capture_text strips a trailing "(session N ...)"-shaped suffix and
// truncates to 110 chars before emitting `title`. operator-panel.ts's
// matcher (findCaptureHeadingIndex) applies that SAME transform to each
// candidate `### ` line rather than exact-matching the raw text -- data-date
// rides along as a cheap disambiguator for the rare case two entries clean
// to an identical title. operator-panel.ts owns the actual file read/write
// + generator re-run (Obsidian file access has no business in this
// pure-function layer, per this render/ dir's own file-header rule).

import { Any, esc } from "./common";

function inboxRowHtml(c: Any): string {
	const heading = esc(c.title);
	const date = esc(c.date || "");
	// `attributed: false` means the generator defaulted this capture item to
	// _System (no wi_refs/heading cue placed it in the lane it's shown under)
	// -- a faint tag so that default reads as a default, not a real claim.
	const unattr = c.attributed === false ? ` <span class="v5-unattr">unattributed</span>` : "";
	return `<div class="v5-irow">`
		+ `<span class="v5-itxt" title="${heading}">${heading}</span>${unattr}`
		+ `<span class="v5-iage">${esc(c.age_days)}d</span>`
		+ `<button class="v5-ibtn" data-act="inbox-accept" data-heading="${heading}" data-date="${date}" data-lane="${esc(c.lane)}">Accept</button>`
		+ `<button class="v5-ibtn" data-act="inbox-expire" data-heading="${heading}" data-date="${date}">Expire</button>`
		+ `</div>`;
}

/** `older` = lanes[].inbox_older (count of this lane's attributed items
 *  >14d, not expired) -- shown as a note, not a row (the contract: "N older
 *  · expire at sweep", nothing to click since the close sweep handles it). */
export function renderInboxSection(inbox: Any[], older: number): string {
	const rows = inbox || [];
	const body = rows.length ? rows.map(inboxRowHtml).join("") : `<div class="empty">inbox empty</div>`;
	const olderNote = older > 0 ? `<div class="v5-bnote">${older} older · expire at sweep</div>` : "";
	return `<details class="v5-inbox" data-persist="inbox"><summary>INBOX <span class="n">${rows.length}</span></summary>${body}${olderNote}</details>`;
}
