// Send-to-session v1 (SYS-485, session 975; shape approved by the operator):
// the ➜ action next to a thread's ⧉ and on the Do now / Big rocks / overdue
// rows types a prompt into a live workspace-shell seat.
//
//   - existing seats only; a fresh seat still has to finish /startup, so the
//     action never spawns one
//   - the text is pre-typed WITHOUT Enter: a human is in front of the seat and
//     presses it (the s925 sendText handoff pattern)
//   - a seat whose input box already holds text is refused -- pre-typing onto
//     unrun text mangles both (MEMG-19, s925); checked again at send time
//   - newlines are flattened to spaces, so nothing in the text can submit
//
// The input-box read ports tools/seat_probe.py's prompt_is_bare(): the lines
// between the last two horizontal rules are the box, and the box must hold a
// single ">" line with nothing after it. No box on screen (a dialog, a
// full-screen TUI) reads as not sendable, never as bare.

import type { App, WorkspaceLeaf } from "obsidian";

export const WS_VIEW = "workspace-shell";

export type InputState = "bare" | "text" | "nobox";

const RULE_CHARS = new Set(["─", "━", "═", "-", "–", "—", "_"]);
const SCREEN_ROWS = 60;

function norm(raw: string): string {
	return raw.replace(/ /g, " ").trim();
}

function isRule(s: string): boolean {
	if (s.length < 10) return false;
	for (const ch of s) if (!RULE_CHARS.has(ch)) return false;
	return true;
}

/** Pure: classify the input box from rendered screen lines (top to bottom). */
export function inputState(lines: string[]): InputState {
	const n = lines.map(norm);
	const rules: number[] = [];
	n.forEach((s, i) => { if (isRule(s)) rules.push(i); });
	if (rules.length < 2) return "nobox";
	const content = n.slice(rules[rules.length - 2] + 1, rules[rules.length - 1]).filter(Boolean);
	// A question dialog also draws rules; without a ">" line the region is not the input box.
	if (!content.length || !content[0].startsWith(">")) return "nobox";
	return content.length === 1 && content[0].slice(1).trim() === "" ? "bare" : "text";
}

/** Pure: the one-line form of a prompt -- CR/LF would submit or split it. */
export function flatten(text: string): string {
	return String(text || "").replace(/[\r\n]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

export function screenLines(pane: any, rows = SCREEN_ROWS): string[] | null {
	const buf = pane?.terminal?.buffer?.active;
	if (!buf) return null;
	const out: string[] = [];
	for (let y = Math.max(0, buf.length - rows); y < buf.length; y++) {
		const ln = buf.getLine(y);
		out.push(ln ? ln.translateToString(true) : "");
	}
	return out;
}

export interface SeatTarget {
	leaf: WorkspaceLeaf;
	pane: any;
	uuid: string | null;
	state: InputState | "nopty";
}

export function listSeats(app: App): SeatTarget[] {
	const out: SeatTarget[] = [];
	for (const leaf of app.workspace.getLeavesOfType(WS_VIEW)) {
		const pane = (leaf.view as any)?.pane;
		if (!pane) continue;
		const uuid = pane.sessionUuid || (leaf.view as any)?.getSessionUuid?.() || null;
		let state: SeatTarget["state"] = "nopty";
		if (pane.ptyProcess) {
			const lines = screenLines(pane);
			state = lines ? inputState(lines) : "nobox";
		}
		out.push({ leaf, pane, uuid, state });
	}
	return out;
}

export function refusal(state: SeatTarget["state"]): string | null {
	if (state === "bare") return null;
	if (state === "text") return "input has text";
	if (state === "nopty") return "no terminal";
	return "no input box on screen";
}

/** Type `text` into the seat without Enter, then reveal and focus it.
 *  Re-reads the input box first: the menu may have been open a while. */
export function typeInto(app: App, target: SeatTarget, text: string): { ok: boolean; why: string } {
	const line = flatten(text);
	if (!line) return { ok: false, why: "nothing to send" };
	const pane = target.pane;
	if (!pane?.ptyProcess) return { ok: false, why: "no terminal" };
	const lines = screenLines(pane);
	const why = refusal(lines ? inputState(lines) : "nobox");
	if (why) return { ok: false, why };
	pane.sendText(line);
	app.workspace.revealLeaf(target.leaf);
	try { const w = (target.leaf.view as any)?.containerEl?.win; if (w && w.focus) w.focus(); } catch (_) { /* pop-out closed */ }
	try { pane.focus(); } catch (_) { /* no terminal yet */ }
	return { ok: true, why: "" };
}
