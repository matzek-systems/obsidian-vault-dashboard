import type { App } from "obsidian";
import { esc } from "./render/common";
import { showCard, hideCard } from "./hover-card";

// WI hover card for the dashboard — same shape as workspace-shell's wi-links.ts
// (lazy index over Roadmaps/*.md, 30s stale-while-revalidate, card near the
// pointer clamped to the owning window). Any element carrying data-id gets it.
// Card DOM/positioning is shared with session-hover.ts via hover-card.ts.

// esbuild here externalizes fs but not path — join with forward slashes by hand.
const fs = require("fs") as typeof import("fs");
const join = (...parts: string[]): string => parts.join("/").replace(/\\/g, "/").replace(/\/+/g, "/");

export interface WiInfo {
	id: string;
	fileBase: string;
	lane: string;
	heading: string;
	statusLine: string;
	body: string;
	done: number;
	total: number;
}

export class WiIndex {
	private map = new Map<string, WiInfo>();
	private builtAt = 0;
	private static TTL_MS = 30_000;

	constructor(private app: App, private roadmapsRel: string) {}

	lookup(id: string): WiInfo | null {
		this.ensure();
		return this.map.get(id) ?? null;
	}

	private dir(): string | null {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const base = (this.app.vault.adapter as any).basePath as string | undefined;
		return base ? join(base, this.roadmapsRel) : null;
	}

	/** Stale-while-revalidate: serve the current map instantly; a TTL-expired
	 *  lookup kicks an async rebuild (never parse on the UI thread). */
	private ensure(): void {
		if (Date.now() - this.builtAt < WiIndex.TTL_MS) return;
		this.builtAt = Date.now();
		void this.rebuild();
	}

	private async rebuild(): Promise<void> {
		const dir = this.dir();
		if (!dir) return;
		const next = new Map<string, WiInfo>();
		let files: string[] = [];
		try {
			files = (await fs.promises.readdir(dir)).filter((f) => f.endsWith(".md"));
		} catch {
			return;
		}
		for (const f of files) {
			let content = "";
			try {
				content = await fs.promises.readFile(join(dir, f), "utf8");
			} catch {
				continue;
			}
			this.parseFile(f.replace(/\.md$/, ""), content, next);
		}
		this.map = next;
	}

	private parseFile(fileBase: string, content: string, out: Map<string, WiInfo>): void {
		const lines = content.split(/\r?\n/);
		const lane = fileBase.replace(/ Roadmap$/, "");
		for (let i = 0; i < lines.length; i++) {
			const m = lines[i].match(/^### ([A-Z]{2,10}-\d{1,4}):\s*(.*)$/);
			if (!m) continue;
			const id = m[1];
			const heading = lines[i].slice(4).trim();
			let statusLine = "";
			const bodyLines: string[] = [];
			let done = 0, total = 0;
			for (let j = i + 1; j < lines.length && j <= i + 40; j++) {
				const l = lines[j];
				if (/^###? /.test(l)) break;
				const t = l.trim();
				if (!statusLine && t.startsWith("`status:")) statusLine = t;
				else if (/^- \[[ xX]\]/.test(t)) {
					total++;
					if (/^- \[[xX]\]/.test(t)) done++;
				} else if (t && bodyLines.length < 4 && !t.startsWith("|")) {
					bodyLines.push(t);
				}
			}
			out.set(id, { id, fileBase, lane, heading, statusLine, body: bodyLines.join(" "), done, total });
		}
	}
}

export class WiHover {
	private cardEl: HTMLElement | null = null;
	private timer: number | null = null;
	private cur: HTMLElement | null = null;

	constructor(private index: WiIndex) {}

	/** Delegated: hovering any descendant with data-id shows the card after a short delay. */
	attach(root: HTMLElement): void {
		root.addEventListener("mouseover", (e: MouseEvent) => {
			const t = (e.target as HTMLElement).closest("[data-id]") as HTMLElement | null;
			if (!t || t === this.cur) return;
			this.cur = t;
			this.hide();
			const info = this.index.lookup(t.dataset.id || "");
			if (!info) return;
			this.timer = window.setTimeout(() => this.show(info, e), 160);
		});
		root.addEventListener("mouseout", (e: MouseEvent) => {
			const t = (e.target as HTMLElement).closest("[data-id]") as HTMLElement | null;
			const to = (e.relatedTarget as HTMLElement | null)?.closest?.("[data-id]") as HTMLElement | null;
			if (t && to === t) return;
			this.cur = null;
			this.hide();
		});
	}

	private show(info: WiInfo, event: MouseEvent): void {
		this.hide();
		const statusLine = info.statusLine ? `<div class="op-wi-card-status">${esc(info.statusLine.replace(/`/g, ""))}</div>` : "";
		const body = info.body ? `<div class="op-wi-card-body">${esc(info.body.slice(0, 280))}</div>` : "";
		const html = `<div class="op-wi-card-title">${esc(info.heading)}</div>${statusLine}${body}`
			+ `<div class="op-wi-card-foot"><span>${info.total > 0 ? `☑ ${info.done}/${info.total}` : ""}</span><span>${esc(info.fileBase)}</span></div>`;
		this.cardEl = showCard(html, event);
	}

	hide(): void {
		if (this.timer !== null) { window.clearTimeout(this.timer); this.timer = null; }
		hideCard(this.cardEl);
		this.cardEl = null;
	}

	dispose(): void { this.hide(); }
}
