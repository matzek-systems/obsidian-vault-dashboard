import { Any, esc, seatBadges, wiRow, repoChip, laneList } from "./common";
import { renderArcStrip } from "./arc-strip";

const ACTIVE_CAP = 15; // schema-2 fallback only; schema-3 bands are never capped

function bandSection(title: string, wis: Any[], opts: { showDelta?: boolean; showAge?: boolean; showRot?: boolean }): string {
	if (!wis || !wis.length) return "";
	const rows = wis.map((w) => {
		let sub: string | null = null;
		if (opts.showDelta && w.delta && w.delta.summary) sub = w.delta.summary;
		else if (opts.showAge) {
			sub = w.delta && w.delta.days != null
				? `no change in ${w.delta.days}d`
				: (w.age_days != null ? `${w.age_days}d since last touch` : null);
		}
		return wiRow(w, sub, { showActor: true, showRot: opts.showRot });
	}).join("");
	return `<div class="band"><div class="band-h">${esc(title)} <span class="n">${wis.length}</span></div>${rows}</div>`;
}

/** Rows where every task is checked but status was never flipped — the
 *  shape-product.md nudge, deduped into one callout above the bands. */
function flipCallout(all: Any[]): string {
	const flips = (all || []).filter((w) => w.flip_me);
	if (!flips.length) return "";
	return `<div class="flip-callout"><b>${flips.length}</b> ready to close — every task done, status never flipped: ${flips.map((w) => esc(w.id)).join(", ")}</div>`;
}

/** `sp` is a `sprints[]` entry. In schema 3 it already carries the lane's
 *  COMPLETE WI set (band-classified) plus counts/queue/last_session — no
 *  more artificial 6-item cap. In schema 2 it's still just the capped
 *  "sprint" and the full list lives in `data.lanes[].wis`; that split is
 *  rendered as a crash-guard fallback only. */
export function renderLane(sp: Any, data: Any): string {
	if (!sp) return `<div class="empty">no lane has motion, a live seat, or working WIs</div>`;
	const schema = data?.schema || 2;
	let h = "";

	if ((sp.seats && sp.seats.length) || sp.moving_count) {
		h += `<div class="kicker"><b>${esc(sp.lane)}</b><span>${sp.moving_count ?? 0} moving this week</span>${seatBadges(sp.seats || [])}</div>`;
	}

	if (schema >= 3) {
		if (sp.counts) {
			const c = sp.counts;
			h += `<div class="lane-counts">closed <b>${c.closed_7d ?? 0}</b> · progressed <b>${c.progressed_7d ?? 0}</b> · new <b>${c.new_7d ?? 0}</b></div>`;
		}
		if (sp.last_session) {
			const ls = sp.last_session;
			h += `<div class="last-sess"><span class="lsn-hd"><b>s${esc(ls.n)}</b><span class="lsn-date">${esc(ls.date)}</span></span><div class="lsn-note" data-act="togglenote">${esc(ls.note)}</div></div>`;
		}

		h += renderArcStrip(sp.lane, data.arcs || [], data.sessions_log || [], Date.now());

		const wis: Any[] = sp.wis || [];
		h += flipCallout(wis);
		const progressed = wis.filter((w) => w.band === "progressed");
		const fresh = wis.filter((w) => w.band === "new");
		const none = wis.filter((w) => w.band === "none");
		const useQueue = !!(sp.queue && (sp.queue.ready || []).length > 12);

		h += bandSection("PROGRESSED · 7D", progressed, { showDelta: true });
		h += bandSection("NEW · 7D", fresh, { showDelta: true });
		if (useQueue) {
			h += bandSection("VERIFY", sp.queue.verify || [], { showAge: true });
			h += bandSection("READY", sp.queue.ready || [], { showAge: true, showRot: true });
		} else {
			h += bandSection("NO CHANGE", none, { showAge: true });
		}
		if (!wis.length) h += `<div class="empty">nothing working in this lane</div>`;
		return h;
	}

	// ── schema-2 fallback: never crash on old data ──
	const block: Any = (laneList(data) || []).find((b: Any) => b.lane === sp.lane) || {};
	const inSprint = new Set<string>((sp.wis || []).map((w: Any) => w.id));
	if ((sp.wis || []).length) {
		h += `<div class="sprint"><div class="kicker"><b>SPRINT</b><span>${sp.moving_count ?? 0} moving this week</span>${seatBadges(sp.seats || [])}</div>`
			+ sp.wis.map((w: Any) => wiRow(w, w.next ? `next: ${w.next}` : null)).join("") + `</div>`;
	}
	if ((block.repos || []).length) h += `<div class="repos">${block.repos.map(repoChip).join("")}</div>`;
	const rows: Any[] = (block.wis || []).filter((w: Any) => !inSprint.has(w.id));
	const shown = rows.slice(0, ACTIVE_CAP);
	h += `<h2>active <span class="n">${rows.length}${inSprint.size ? ` · ${inSprint.size} in the sprint above` : ""}</span></h2>`;
	h += rows.length
		? shown.map((w) => wiRow(w)).join("") + (rows.length > ACTIVE_CAP ? `<div class="more">${rows.length - ACTIVE_CAP} older hidden</div>` : "")
		: `<div class="empty">nothing else working</div>`;
	return h;
}
