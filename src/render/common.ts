// ── Pure render helpers (SYS-485, session 911) ───────────────────────
// No Obsidian imports here, on purpose: everything in src/render/ is a pure
// function from data to an HTML string, importable from plain Node so
// tools/render-preview.mjs can bundle + screenshot it without an Obsidian
// runtime. Obsidian-specific glue (event wiring, file reads, hover cards
// that touch a real document) stays in operator-panel.ts / wi-card.ts /
// session-hover.ts / hover-card.ts.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Any = any;

export const esc = (s: unknown): string =>
	String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

export const actTxt = (m: number): string => (m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`);

export function agoTxt(iso: string | null | undefined, now: number = Date.now()): string {
	if (!iso) return "";
	const m = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
	return m < 60 ? `${m}m` : m < 2880 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
}

export function ageBadge(a: number | null | undefined): string {
	if (a === null || a === undefined) return `<span class="age rot">90d+</span>`;
	return `<span class="age ${a > 14 ? "rot" : a > 5 ? "old" : ""}">${a}d</span>`;
}

export function dueBadge(w: Any): string {
	const d = w.due_in;
	if (d === null || d === undefined) return "";
	if (d < 0) return `<span class="due over">${-d}d overdue</span>`;
	return `<span class="due ${d <= 3 ? "soon" : ""}">due ${d === 0 ? "today" : `in ${d}d`}</span>`;
}

export function laneOf(w: Any): string {
	if (w.lane) return String(w.lane).replace(" Roadmap", "");
	const m = /^([A-Z]+)-/.exec(String(w.id || ""));
	const map: Record<string, string> = { SYS: "_System", SOMA: "SomaGuard", MM: "MatzekMedia", WI: "PKM", CH: "ContentHoarder", JANE: "Jane", LD: "Lawndash", LWP: "Local Web Pitch", WCMC: "WCMC" };
	return m ? (map[m[1]] || m[1]) : "";
}

export function contPrompt(id: string): string {
	return `Continue ${id} — read its detail section in the Roadmap, check the latest session state, and pick up the next unchecked task.`;
}

export function seatBadges(seats: Any[]): string {
	return (seats || []).map((s) =>
		`<span class="seat ${esc(s.tier)}">s${s.n} · ${s.user_min != null ? "typed " + actTxt(s.user_min) : (s.active_min == null ? "?" : actTxt(s.active_min))}</span>`
	).join("");
}

export function idCell(w: Any): string {
	return `<span class="tid c-${esc(w.status)}" data-act="open" data-id="${esc(w.id)}" data-lane="${esc(laneOf(w))}">${esc(w.id)}</span>`;
}

/** who worked/owns the row's next open task: you / them / a seat can just run it. */
export function actorTag(actor: Any): string {
	if (!actor || !actor.who) return "";
	const who = String(actor.who);
	const label = who === "you" ? "YOU" : who === "them" ? "THEM" : "SEAT";
	const title = actor.hit ? ` title="${esc(actor.hit)}"` : "";
	return `<span class="actor a-${esc(who)}"${title}>${label}</span>`;
}

/** every task checked, status never flipped — the shape-product.md nudge. */
export function flipPill(w: Any): string {
	return w && w.flip_me ? `<span class="pill flip" title="all tasks done — status never flipped">FLIP ME</span>` : "";
}

/** ready-queue rot badge: sat in ready N+ days with zero motion. */
export function rotPill(w: Any): string {
	return w && w.rot ? `<span class="pill rotpill" title="ready ${w.age_days ?? "?"}d, no motion">rot</span>` : "";
}

export function laneList(data: Any): Any[] {
	const sprints: Any[] = data.sprints || [];
	const byLane: Record<string, Any> = {};
	for (const sp of sprints) byLane[sp.lane] = sp;
	const focal = sprints.find((s) => s.focal)?.lane;
	const blocks: Any[] = (data.lanes || []).filter((b: Any) => b.working > 0 || byLane[b.lane]);
	blocks.sort((a, b) => (a.lane === focal ? -1 : b.lane === focal ? 1 : 0));
	return blocks.map((b) => ({ ...b, sprint: byLane[b.lane] || null, focal: b.lane === focal }));
}

export interface RowOpts {
	showActor?: boolean;
	showRot?: boolean;
	rowCls?: string;
}

/** One WI row: [id][title (+ sub line)][meta]. Punctuation never separates
 *  fields — the grid does. `opts` is additive so every pre-existing call
 *  site (clock, could-do, capture-adjacent, schema-2 fallback) renders
 *  byte-identically to before; only band/queue rows opt into actor + rot. */
export function wiRow(w: Any, sub?: string | null, opts?: RowOpts): string {
	const meta = [
		dueBadge(w),
		w.status ? `<span class="pill ${esc(w.status)}">${esc(w.status)}</span>` : "",
		opts?.showActor ? flipPill(w) : "",
		opts?.showActor ? actorTag(w.actor) : "",
		opts?.showRot ? rotPill(w) : "",
		w.tasks_total ? `<span>${w.tasks_done}/${w.tasks_total}</span>` : "",
		ageBadge(w.age_days),
		// No title="" -- this button's own data-id makes closest("[data-id]")
		// match itself, so it already triggers WiHover's card on hover
		// (double-popup family, s916 follow-up: triage/could-do/full-status
		// rows all render via this one wiRow()).
		`<button class="rcopy" data-act="copy" data-id="${esc(w.id)}">⧉</button>`,
	].filter(Boolean).join("");
	const cls = `row${opts?.rowCls ? ` ${opts.rowCls}` : ""}${opts?.showRot && w.rot ? " row-rot" : ""}`;
	return `<div class="${cls}">${idCell(w)}<span class="ttl">${esc(w.title)}</span><span class="meta">${meta}</span>${sub ? `<span class="sub">${esc(sub)}</span>` : ""}</div>`;
}

export function repoChip(r: Any): string {
	return `<span class="repo" title="${esc(r.last_subject)} · ${r.commits_28d} commits in 28d"><b>${esc(r.repo)}</b>${r.commits_7d}<span class="ago">${esc(agoTxt(r.last))} ago</span>${r.ahead ? `<span class="ahead">+${r.ahead} unpushed</span>` : ""}${r.dirty ? `<span class="dirty">dirty</span>` : ""}</span>`;
}
