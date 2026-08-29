import { Plugin, ItemView, WorkspaceLeaf, TFile, setIcon, Notice, PluginSettingTab, Setting, App } from "obsidian";
import { execFile } from "child_process";
import { DashboardView } from "./operator-panel";

const VIEW_TYPE = "vault-dashboard";
const ICON = "layout-dashboard";

const PROCESS_VIEW_TYPE = "vault-process-status";
const PROCESS_ICON = "activity";

const CALLDAY_VIEW_TYPE = "lwp-call-day";
const CALLDAY_ICON = "phone-call";

const ROADMAPS_FOLDER = "00_System/AI/Claude/Roadmaps";
const SYSTEM_HOME = "00_System/AI/Claude/00_Home.md";
const SESSION_RAM_FOLDER = "00_System/AI/Claude/Scratchpad";
const PROCESS_STATUS_FILE = "00_System/AI/Claude/System Operations/state/process-status.json";
const PROCESS_STATUS_REFRESH_MS = 3000;
const SESSION_REGISTRY_FILE = "00_System/AI/Claude/System Operations/session-registry.json";

interface ProcessEntry {
	label: string;
	pid: number | null;
	ram_mb: number | null;
	uptime_seconds: number | null;
	port: number | null;
	port_listening: boolean | null;
	cmd_short: string | null;
	status: "running" | "stopped";
	instance_count?: number;
}

interface ProcessStatusPayload {
	collected_at: number;
	collector_pid?: number;
	total_ram_mb?: number;
	error?: string;
	processes: ProcessEntry[];
}

interface SessionEntry {
	uuid: string;
	jsonl?: string;
	date?: string;
	focus?: string;
	write_zone?: string;
	status?: string;
}

interface SessionRegistry {
	next_session?: number;
	last_close?: string;
	sessions: Record<string, SessionEntry>;
}

/** workspace-shell's own view type. Used to tell an "attached" session (a seat
 *  in this Obsidian owns it) from one that is merely live in another terminal. */
const WS_SHELL_VIEW_TYPE = "workspace-shell";

type SessionState = "attached" | "live" | "detached";

interface SessionRow {
	num: string;
	uuid: string;
	state: SessionState;
	focus: string;
	zone: string;
	date: string;
	resumable: boolean;
	leaf?: WorkspaceLeaf;
}

interface DashboardSettings {
	// Pinned roadmap basenames in display order. Empty = auto mode (all active
	// roadmaps, busiest first). Migrates cleanly from the old ["","",""] tuple
	// (the empties are filtered out → []).
	tabs: string[];
	openOnStartup: boolean;
	// LWP Call-Day board: bridge to the lwp-crm CLI (state machine lives in ops.py).
	lwpCrmDir: string;
	pythonCmd: string;
	// v5 lane view (SYS-485, schema 4): per-lane collapsed/open state for the
	// WAITING / backlog / INBOX / decisions "+N" <details> sections, keyed
	// "<lane>::<sectionKey>" -> open(true)/closed(false, or absent). Written
	// directly via this.plugin.saveData() from operator-panel.ts's toggle
	// listeners (NOT via saveSettings(), which re-renders every open dashboard
	// leaf -- a repaint on every collapse/expand click would be janky and can
	// fight the very <details> being toggled).
	collapsed: Record<string, boolean>;
}

const DEFAULT_SETTINGS: DashboardSettings = {
	tabs: [],
	openOnStartup: false,
	lwpCrmDir: "C:/Dev/lwp-crm",
	pythonCmd: "python",
	collapsed: {},
};

// ── LWP CRM shapes (mirror lwp-crm cli.py --json) ──
interface CrmTouch {
	touch_date: string;
	channel: string;
	outcome: string;
	note: string | null;
}

interface CrmLead {
	id: number;
	slug: string;
	business_name: string;
	trade?: string;
	town?: string;
	owner_name?: string | null;
	decision_maker_notes?: string | null;
	phone?: string | null;
	phone_alt?: string | null;
	hook?: string | null;
	preview_url?: string | null;
	reviews_count?: number | null;
	reviews_rating?: number | null;
	reviews_platform?: string | null;
	state: string;
	tier?: string | null;
	build_status?: string;
	next_touch_date?: string | null;
	last_touch_date?: string | null;
	touch_count?: number;
	notes?: string | null;
	vault_path?: string | null;
	touches?: CrmTouch[];
}

interface CrmStanding {
	as_of: string;
	total_dials: number;
	closes: number;
	queue_size_today: number;
	stale: number;
}

interface WI {
	id: string;
	status: string;
	summary: string;
	depends?: string;
	stale?: boolean;
}

interface ProjectData {
	file: TFile;
	label: string;
	content: string;
	status: string;
	wis: WI[];
	whereImAt: string;
	liveSession: string | null;
	recentlyDone: { id: string; summary: string; date: string }[];
}

export default class DashboardPlugin extends Plugin {
	settings: DashboardSettings = DEFAULT_SETTINGS;

	async onload() {
		await this.loadSettings();
		this.registerView(VIEW_TYPE, (leaf: WorkspaceLeaf) => new DashboardView(leaf, this));
		this.addRibbonIcon(ICON, "Open Dashboard", () => this.activateDashboard());
		this.addCommand({ id: "open-dashboard", name: "Open Dashboard", callback: () => this.activateDashboard() });

		this.registerView(PROCESS_VIEW_TYPE, (leaf: WorkspaceLeaf) => new ProcessStatusView(leaf, this));
		this.addRibbonIcon(PROCESS_ICON, "Open Process Status", () => this.activateProcessStatus());
		this.addCommand({ id: "open-process-status", name: "Open Process Status", callback: () => this.activateProcessStatus() });

		this.registerView(CALLDAY_VIEW_TYPE, (leaf: WorkspaceLeaf) => new CallDayView(leaf, this));
		this.addRibbonIcon(CALLDAY_ICON, "Open LWP Call Day", () => this.activateCallDay());
		this.addCommand({ id: "open-lwp-call-day", name: "Open LWP Call Day", callback: () => this.activateCallDay() });

		this.addSettingTab(new DashboardSettingTab(this.app, this));

		if (this.settings.openOnStartup) {
			this.app.workspace.onLayoutReady(() => this.activateDashboard());
		}
	}

	async activateDashboard() {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(VIEW_TYPE);
		if (existing.length > 0) { workspace.revealLeaf(existing[0]); return; }
		const leaf = workspace.getLeaf("tab");
		await leaf.setViewState({ type: VIEW_TYPE, active: true });
	}

	async activateProcessStatus() {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(PROCESS_VIEW_TYPE);
		if (existing.length > 0) { workspace.revealLeaf(existing[0]); return; }
		const leaf = workspace.getLeaf("tab");
		await leaf.setViewState({ type: PROCESS_VIEW_TYPE, active: true });
	}

	async activateCallDay() {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(CALLDAY_VIEW_TYPE);
		if (existing.length > 0) { workspace.revealLeaf(existing[0]); return; }
		const leaf = workspace.getLeaf("tab");
		await leaf.setViewState({ type: CALLDAY_VIEW_TYPE, active: true });
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			(leaf.view as DashboardView).render();
		}
	}

	discoverRoadmaps(): TFile[] {
		// Match Mesenchyme: only files whose name contains "roadmap" — excludes
		// _Proposals.md and other non-roadmap planning files in the folder.
		return this.app.vault.getFiles().filter(f =>
			f.path.startsWith(ROADMAPS_FOLDER + "/") && f.extension === "md"
			&& /roadmap/i.test(f.name)
		);
	}
}

// ── Settings Tab ────────────────────────────────────────

class DashboardSettingTab extends PluginSettingTab {
	plugin: DashboardPlugin;

	constructor(app: App, plugin: DashboardPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "Dashboard Tabs" });
		containerEl.createEl("p", {
			text: "Choose which roadmaps appear as tabs and reorder them. Leave the list empty to auto-show every active roadmap, busiest first (by active-WI count).",
			cls: "setting-item-description",
		});

		const labelOf = (b: string) => b.replace(" Roadmap", "").replace(/^_/, "");
		const selected = this.plugin.settings.tabs.filter(t => t !== "");

		const persist = async () => {
			this.plugin.settings.tabs = selected;
			await this.plugin.saveSettings();
			this.display();
		};

		if (selected.length === 0) {
			containerEl.createEl("p", {
				text: "Auto mode — all active roadmaps, busiest first.",
				cls: "setting-item-description",
			});
		}

		// Pinned roadmaps, in order, each with move-up / move-down / remove.
		selected.forEach((basename, i) => {
			const row = new Setting(containerEl).setName(labelOf(basename));
			row.addExtraButton(b => b
				.setIcon("chevron-up").setTooltip("Move up").setDisabled(i === 0)
				.onClick(() => { [selected[i - 1], selected[i]] = [selected[i], selected[i - 1]]; persist(); }));
			row.addExtraButton(b => b
				.setIcon("chevron-down").setTooltip("Move down").setDisabled(i === selected.length - 1)
				.onClick(() => { [selected[i + 1], selected[i]] = [selected[i], selected[i + 1]]; persist(); }));
			row.addExtraButton(b => b
				.setIcon("x").setTooltip("Remove").onClick(() => { selected.splice(i, 1); persist(); }));
		});

		// Add a roadmap that isn't pinned yet.
		const remaining = this.plugin.discoverRoadmaps()
			.map(r => r.basename)
			.filter(b => !selected.includes(b));
		if (remaining.length > 0) {
			new Setting(containerEl)
				.setName("Add roadmap tab")
				.addDropdown(drop => {
					drop.addOption("", "(choose…)");
					for (const b of remaining) drop.addOption(b, labelOf(b));
					drop.setValue("");
					drop.onChange(v => { if (v) { selected.push(v); persist(); } });
				});
		}

		new Setting(containerEl)
			.setName("Open dashboard on startup")
			.setDesc("Open the dashboard tab when Obsidian launches (instead of or alongside the home note).")
			.addToggle(t => {
				t.setValue(this.plugin.settings.openOnStartup);
				t.onChange(async v => {
					this.plugin.settings.openOnStartup = v;
					await this.plugin.saveSettings();
				});
			});

		containerEl.createEl("h2", { text: "LWP Call Day" });
		containerEl.createEl("p", {
			text: "The call-day board bridges to the lwp-crm CLI (all lead-state logic stays in ops.py). Point these at your lwp-crm checkout.",
			cls: "setting-item-description",
		});

		new Setting(containerEl)
			.setName("lwp-crm directory")
			.setDesc("Absolute path to the lwp-crm repo (contains cli.py).")
			.addText(t => {
				t.setPlaceholder("C:/Dev/lwp-crm");
				t.setValue(this.plugin.settings.lwpCrmDir);
				t.onChange(async v => {
					this.plugin.settings.lwpCrmDir = v.trim();
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Python command")
			.setDesc("Python executable used to run cli.py (e.g. python, python3, or an absolute path).")
			.addText(t => {
				t.setPlaceholder("python");
				t.setValue(this.plugin.settings.pythonCmd);
				t.onChange(async v => {
					this.plugin.settings.pythonCmd = v.trim();
					await this.plugin.saveSettings();
				});
			});
	}
}

// ── Dashboard View ── see operator-panel.ts (SYS-485, session 911)

// ── Process Status View ─────────────────────────────────
// Dedicated pane (own ribbon icon) for the live process monitor.
// Extracted from DashboardView so the dashboard stays roadmap-focused.

class ProcessStatusView extends ItemView {
	private plugin: DashboardPlugin;
	private timer: ReturnType<typeof setInterval> | null = null;
	private panelEl: HTMLElement | null = null;
	private sessEl: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: DashboardPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string { return PROCESS_VIEW_TYPE; }
	getDisplayText(): string { return "Process Status"; }
	getIcon(): string { return PROCESS_ICON; }

	async onOpen(): Promise<void> {
		this.navigation = false;
		this.contentEl.addClass("vault-process-status-view");
		this.panelEl = this.contentEl.createDiv({ cls: "dash-process-status" });
		this.sessEl = this.contentEl.createDiv({ cls: "dash-process-status dash-sessions" });
		await this.refresh();
		this.timer = setInterval(() => this.refresh(), PROCESS_STATUS_REFRESH_MS);
	}

	async onClose(): Promise<void> {
		if (this.timer) clearInterval(this.timer);
	}

	private async refresh(): Promise<void> {
		await this.renderProcesses();
		await this.renderSessions();
	}

	private async renderProcesses(): Promise<void> {
		if (!this.panelEl || !this.panelEl.isConnected) return;
		let payload: ProcessStatusPayload | null = null;
		try {
			const raw = await this.app.vault.adapter.read(PROCESS_STATUS_FILE);
			payload = JSON.parse(raw);
		} catch (_) {
			// File missing or unreadable — render an empty stub
		}
		const el = this.panelEl;
		el.empty();

		const header = el.createDiv({ cls: "dash-ps-header" });
		const left = header.createDiv({ cls: "dash-ps-header-left" });
		const titleIcon = left.createSpan({ cls: "dash-ps-title-icon" });
		setIcon(titleIcon, "activity");
		left.createEl("h2", { text: "Processes" });

		if (!payload) {
			el.createEl("p", {
				text: "Status file missing. Run: python tools/process-status-collector.py --daemon",
				cls: "dash-empty",
			});
			return;
		}

		if (payload.error) {
			el.createEl("p", { text: `Collector error: ${payload.error}`, cls: "dash-empty" });
			return;
		}

		const total = payload.total_ram_mb ?? 0;
		header.createEl("span", {
			text: `${total.toFixed(0)} MB`,
			cls: `dash-ps-total ${this.ramSeverity(total, 800, 2000)}`,
		});

		const stale = (Date.now() / 1000) - payload.collected_at > 15;
		if (stale) {
			header.createEl("span", {
				text: "stale",
				cls: "dash-ps-stale-badge",
			});
		}

		const table = el.createDiv({ cls: "dash-ps-table" });
		const head = table.createDiv({ cls: "dash-ps-row dash-ps-head" });
		head.createEl("span", { text: "process" });
		head.createEl("span", { text: "pid" });
		head.createEl("span", { text: "ram" });
		head.createEl("span", { text: "port" });
		head.createEl("span", { text: "uptime" });

		for (const p of payload.processes) {
			const isDup = p.label.includes("(dup)");
			const rowCls = `dash-ps-row dash-ps-${p.status}${isDup ? " dash-ps-dup-row" : ""}`;
			const row = table.createDiv({ cls: rowCls });
			const labelEl = row.createDiv({ cls: "dash-ps-label" });
			const dot = labelEl.createSpan({ cls: `dash-ps-dot dash-ps-dot-${p.status}${isDup ? "-dup" : ""}` });
			dot.textContent = "•";
			labelEl.createEl("span", { text: p.label });
			if (p.instance_count && p.instance_count > 1 && !isDup) {
				labelEl.createEl("span", {
					text: `×${p.instance_count}`,
					cls: "dash-ps-instance-count",
				});
			}

			row.createEl("span", { text: p.pid != null ? String(p.pid) : "—", cls: "dash-ps-pid" });

			const ramText = p.ram_mb != null ? `${Math.round(p.ram_mb)} MB` : "—";
			row.createEl("span", {
				text: ramText,
				cls: `dash-ps-ram ${p.ram_mb != null ? this.ramSeverity(p.ram_mb, 300, 1000) : ""}`,
			});

			const portEl = row.createDiv({ cls: "dash-ps-port" });
			if (p.port == null) {
				portEl.createEl("span", { text: "—" });
			} else {
				portEl.createEl("span", { text: String(p.port) });
				const listenCls = p.port_listening ? "dash-ps-port-up" : "dash-ps-port-down";
				const indicator = portEl.createSpan({ cls: `dash-ps-port-indicator ${listenCls}` });
				indicator.textContent = p.port_listening ? "●" : "○";
			}

			row.createEl("span", {
				text: this.formatUptime(p.uptime_seconds),
				cls: "dash-ps-uptime",
			});
		}
	}

	// ── Sessions (lives in this view, beside the process table) ───
	// Absorbed from workspace-shell's right-sidebar Sessions panel, which is
	// retired: sessions and processes belong in one tab. The state dot is
	// informational (attached / live / detached); every open row offers
	// resume + uuid, nothing else (operator directive, session 914 — reverses
	// the earlier "never offer resume for a live session" gating). The
	// two-writer guard lives where it is authoritative: workspace-shell's pane
	// controller re-checks the transcript at spawn time and refuses to resume
	// a session whose JSONL is still advancing. Gating it here too only hid the
	// button from a wedged-but-attached seat, the one case that needs it most.
	// /close-stamped sessions are history and are deliberately not listed.

	private async renderSessions(): Promise<void> {
		if (!this.sessEl || !this.sessEl.isConnected) return;
		let registry: SessionRegistry | null = null;
		try {
			const raw = await this.app.vault.adapter.read(SESSION_REGISTRY_FILE);
			registry = JSON.parse(raw);
		} catch (_) {
			// Registry missing or unreadable
		}
		const el = this.sessEl;
		el.empty();

		const header = el.createDiv({ cls: "dash-ps-header" });
		const left = header.createDiv({ cls: "dash-ps-header-left" });
		const titleIcon = left.createSpan({ cls: "dash-ps-title-icon" });
		setIcon(titleIcon, "terminal");
		left.createEl("h2", { text: "Sessions" });

		if (!registry || !registry.sessions) {
			el.createEl("p", { text: "Session registry not found.", cls: "dash-empty" });
			return;
		}

		const attached = this.attachedUuids();
		const rows: SessionRow[] = [];
		for (const [num, s] of Object.entries(registry.sessions)) {
			if ((s.status ?? "active") !== "active") continue;
			const leaf = s.uuid ? attached.get(s.uuid) : undefined;
			const freshness = this.jsonlFreshness(s.jsonl);
			const state: SessionState = leaf ? "attached" : freshness === "live" ? "live" : "detached";
			rows.push({
				num, uuid: s.uuid, state, leaf,
				focus: (s.focus ?? "").trim(),
				zone: (s.write_zone ?? "").trim(),
				date: s.date ?? "",
				resumable: freshness !== "gone",
			});
		}
		const rank: Record<SessionState, number> = { attached: 0, live: 1, detached: 2 };
		rows.sort((a, b) => rank[a.state] - rank[b.state] || Number(b.num) - Number(a.num));

		const tally = (st: SessionState) => rows.filter(r => r.state === st).length;
		header.createEl("span", {
			text: `${tally("attached")} attached · ${tally("live")} live · ${tally("detached")} detached`,
			cls: "dash-ps-total dash-sess-summary",
		});

		if (rows.length === 0) {
			el.createEl("p", { text: "No open sessions.", cls: "dash-empty" });
			return;
		}

		const table = el.createDiv({ cls: "dash-ps-table dash-sess-table" });
		const head = table.createDiv({ cls: "dash-ps-row dash-ps-head" });
		head.createEl("span", { text: "session" });
		head.createEl("span", { text: "focus" });
		head.createEl("span", { text: "write zone" });
		head.createEl("span", { text: "date" });
		head.createEl("span", { text: "" });

		for (const r of rows) {
			const row = table.createDiv({ cls: `dash-ps-row dash-ps-running dash-sess-row-${r.state}` });
			const labelEl = row.createDiv({ cls: "dash-ps-label" });
			const dot = labelEl.createSpan({ cls: `dash-ps-dot dash-sess-dot-${r.state}` });
			dot.textContent = "•";
			dot.title = r.state === "attached"
				? "Open in a seat in this Obsidian"
				: r.state === "live"
					? "Transcript advancing under another writer — the seat refuses a resume until it goes idle"
					: "Registry-open, transcript idle";
			const nameEl = labelEl.createEl("span", { text: `s${r.num}` });
			nameEl.title = r.uuid || "no uuid on this registry row";

			const isIdle = !r.focus || r.focus === "TBD (awaiting user task)";
			row.createEl("span", {
				text: isIdle ? "—" : r.focus,
				cls: `dash-sess-focus${isIdle ? " dash-sess-idle" : ""}`,
			});
			row.createEl("span", { text: r.zone || "—", cls: "dash-sess-zone" });
			row.createEl("span", { text: r.date || "—", cls: "dash-ps-uptime" });

			const actions = row.createDiv({ cls: "dash-sess-actions" });
			const btn = actions.createEl("button", { cls: "dash-sess-btn dash-sess-resume-btn", text: "resume" });
			if (!r.uuid || !r.resumable) {
				btn.disabled = true;
				btn.title = r.uuid ? "Transcript not found — nothing to resume" : "No uuid on this registry row";
			} else {
				btn.title = r.state === "live"
					? "Reopen in a seat. If the transcript is still advancing the seat refuses (two writers corrupt a session JSONL)."
					: r.state === "attached"
						? "Reopen in a new seat. If the old seat is wedged, close it (or taskkill its claude) so it can't come back as a second writer."
						: "Reopen this session in a workspace-shell seat (claude --resume)";
				btn.addEventListener("click", () => this.resumeInSeat(r.uuid, r.num));
			}

			const uuidBtn = actions.createEl("button", { cls: "dash-sess-btn", text: "uuid" });
			uuidBtn.disabled = !r.uuid;
			uuidBtn.title = r.uuid ? `Copy ${r.uuid}` : "No uuid on this registry row";
			uuidBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				this.copyText(r.uuid, `s${r.num} uuid`);
			});
		}
	}

	/** UUID → leaf for every terminal pane open in this Obsidian, pop-out
	 *  windows included. This is what makes "attached" distinguishable from
	 *  "live elsewhere" — both have a fresh transcript. */
	private attachedUuids(): Map<string, WorkspaceLeaf> {
		const map = new Map<string, WorkspaceLeaf>();
		for (const leaf of this.app.workspace.getLeavesOfType(WS_SHELL_VIEW_TYPE)) {
			const uuid = (leaf.view as any)?.getSessionUuid?.();
			if (uuid) map.set(uuid, leaf);
		}
		return map;
	}

	private copyText(text: string, what: string): void {
		if (!text) return;
		const done = () => new Notice(`Copied ${what}`, 1800);
		const fail = () => new Notice("Copy failed", 1800);
		if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, fail);
		else fail();
	}

	/** Classify a session's JSONL freshness. <2 min mtime = a live writer owns
	 *  it (two writers on one JSONL corrupt the transcript). UX-level gating
	 *  only — workspace-shell's pane controller re-checks at spawn time and is
	 *  the authoritative guard. */
	private jsonlFreshness(jsonl?: string): "live" | "stale" | "gone" {
		if (!jsonl) return "gone";
		try {
			const fs = require("fs") as typeof import("fs");
			const mtime = fs.statSync(jsonl).mtimeMs;
			return Date.now() - mtime < 2 * 60 * 1000 ? "live" : "stale";
		} catch {
			return "gone";
		}
	}

	private resumeInSeat(uuid: string, num: string): void {
		const ws = (this.app as any).plugins?.getPlugin?.("workspace-shell");
		if (!ws?.openResumedSeat) {
			new Notice("Workspace Shell plugin is not enabled — can't open a seat.");
			return;
		}
		void ws.openResumedSeat(uuid);
		new Notice(`Resuming session ${num} in a seat`, 2000);
	}

	private ramSeverity(mb: number, warn: number, high: number): string {
		if (mb >= high) return "dash-ps-ram-high";
		if (mb >= warn) return "dash-ps-ram-warn";
		return "dash-ps-ram-ok";
	}

	private formatUptime(seconds: number | null): string {
		if (seconds == null) return "—";
		if (seconds < 60) return `${Math.round(seconds)}s`;
		if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
		if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
		return `${(seconds / 86400).toFixed(1)}d`;
	}
}

// ── LWP Call-Day board ──────────────────────────────────
// Bridges to lwp-crm via `python cli.py <cmd> --json`. All lead-state logic
// (state transitions, next_touch_date arithmetic) stays in ops.py — this view
// never reimplements it.

const CALL_OUTCOMES: { key: string; label: string }[] = [
	{ key: "reached", label: "Reached" },
	{ key: "vm", label: "VM" },
	{ key: "no_answer", label: "No ans" },
	{ key: "gatekeeper", label: "Gatekeeper" },
];

const CD_TABS: { scope: string; label: string }[] = [
	{ scope: "due", label: "Due Today" },
	{ scope: "uncontacted", label: "Uncontacted" },
	{ scope: "all", label: "All Leads" },
];

const CD_SORTS: { key: string; label: string }[] = [
	{ key: "smart", label: "smart" },
	{ key: "tier", label: "tier" },
	{ key: "next", label: "next touch" },
	{ key: "reviews", label: "reviews" },
	{ key: "name", label: "name" },
];

interface LeadGroup { title: string; rows: CrmLead[]; }

function fmtPhone(p?: string | null): string {
	if (!p) return "—";
	const d = p.replace(/\D/g, "");
	if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
	return p;
}

class CallDayView extends ItemView {
	private plugin: DashboardPlugin;
	private headerEl: HTMLElement | null = null;
	private navEl: HTMLElement | null = null;
	private listEl: HTMLElement | null = null;
	private detailEl: HTMLElement | null = null;
	private leads: CrmLead[] = [];
	private selectedSlug: string | null = null;
	private channel = "call";
	private activeTab = 0;
	private sortMode = "smart";
	private busy = false;

	constructor(leaf: WorkspaceLeaf, plugin: DashboardPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string { return CALLDAY_VIEW_TYPE; }
	getDisplayText(): string { return "LWP Call Day"; }
	getIcon(): string { return CALLDAY_ICON; }

	async onOpen(): Promise<void> {
		this.navigation = false;
		this.contentEl.addClass("lwp-callday-view");
		this.headerEl = this.contentEl.createDiv({ cls: "lwp-cd-header" });
		this.navEl = this.contentEl.createDiv({ cls: "lwp-cd-nav" });
		const body = this.contentEl.createDiv({ cls: "lwp-cd-body" });
		this.listEl = body.createDiv({ cls: "lwp-cd-queue" });
		this.detailEl = body.createDiv({ cls: "lwp-cd-detail" });
		await this.reload();
	}

	async onClose(): Promise<void> {}

	// Run `cli.py <args>` in the lwp-crm dir; parse JSON stdout.
	private runCli(args: string[]): Promise<any> {
		return new Promise((resolve, reject) => {
			const dir = this.plugin.settings.lwpCrmDir;
			const py = this.plugin.settings.pythonCmd || "python";
			execFile(py, ["cli.py", ...args], { cwd: dir, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
				(err, stdout, stderr) => {
					if (err) { reject(new Error((stderr || "").trim() || err.message)); return; }
					const text = (stdout || "").trim();
					if (!text) { resolve(null); return; }
					try { resolve(JSON.parse(text)); }
					catch (_) { reject(new Error("non-JSON from cli.py: " + text.slice(0, 200))); }
				});
		});
	}

	// Fire-and-read raw stdout (for `open`, which prints text, not JSON).
	private runCliRaw(args: string[]): Promise<void> {
		return new Promise((resolve) => {
			const dir = this.plugin.settings.lwpCrmDir;
			const py = this.plugin.settings.pythonCmd || "python";
			execFile(py, ["cli.py", ...args], { cwd: dir, windowsHide: true }, () => resolve());
		});
	}

	private async reload(): Promise<void> {
		try {
			const scope = CD_TABS[this.activeTab].scope;
			const [rows, standing] = await Promise.all([
				this.runCli(["board", scope, "--json"]) as Promise<CrmLead[]>,
				this.runCli(["standing", "--json"]) as Promise<CrmStanding>,
			]);
			this.leads = Array.isArray(rows) ? rows : [];
			this.renderHeader(standing);
			this.renderNav();
			this.renderQueue();
			if (this.selectedSlug && this.leads.some(l => l.slug === this.selectedSlug)) {
				await this.selectLead(this.selectedSlug);
			} else if (this.leads.length) {
				await this.selectLead(this.leads[0].slug);
			} else {
				this.renderEmptyDetail();
			}
		} catch (e: any) {
			this.renderError(String(e?.message || e));
		}
	}

	private renderNav(): void {
		const el = this.navEl;
		if (!el) return;
		el.empty();
		const tabs = el.createDiv({ cls: "lwp-cd-tabs" });
		CD_TABS.forEach((t, i) => {
			const tab = tabs.createDiv({
				cls: `lwp-cd-tab ${this.activeTab === i ? "lwp-cd-tab-active" : ""}`,
			});
			tab.createEl("span", { text: t.label });
			tab.onclick = () => {
				if (this.activeTab === i) return;
				this.activeTab = i;
				this.selectedSlug = null;
				void this.reload();
			};
		});
		const actions = el.createDiv({ cls: "lwp-cd-nav-actions" });
		actions.createEl("span", { text: "sort", cls: "lwp-cd-label" });
		const sortSel = actions.createEl("select", { cls: "lwp-cd-chan" });
		for (const s of CD_SORTS) {
			const o = sortSel.createEl("option", { text: s.label, value: s.key });
			if (s.key === this.sortMode) o.selected = true;
		}
		sortSel.onchange = () => { this.sortMode = sortSel.value; this.renderQueue(); };
	}

	private renderHeader(s: CrmStanding | null): void {
		const el = this.headerEl;
		if (!el) return;
		el.empty();
		const left = el.createDiv({ cls: "lwp-cd-header-left" });
		const icon = left.createSpan({ cls: "lwp-cd-title-icon" });
		setIcon(icon, CALLDAY_ICON);
		left.createEl("h2", { text: "LWP Call Day" });
		const right = el.createDiv({ cls: "lwp-cd-stats" });
		if (s) {
			right.createEl("span", { text: s.as_of, cls: "lwp-cd-stat" });
			right.createEl("span", { text: `${this.leads.length} shown`, cls: "lwp-cd-stat" });
			right.createEl("span", { text: `${s.total_dials} dials`, cls: "lwp-cd-stat" });
			right.createEl("span", { text: `${s.closes} closes`, cls: "lwp-cd-stat lwp-cd-stat-close" });
		}
		const refresh = right.createEl("button", { text: "↻", cls: "lwp-cd-refresh" });
		refresh.setAttr("aria-label", "Refresh");
		refresh.onclick = () => { void this.reload(); };
	}

	private renderQueue(): void {
		const el = this.listEl;
		if (!el) return;
		el.empty();
		if (!this.leads.length) {
			el.createEl("p", { text: "No leads here.", cls: "dash-empty" });
			return;
		}
		const today = new Date().toISOString().slice(0, 10);

		const renderRow = (lead: CrmLead) => {
			const row = el.createDiv({
				cls: "lwp-cd-row" + (lead.slug === this.selectedSlug ? " lwp-cd-row-active" : ""),
			});
			row.createEl("span", { text: lead.tier ? lead.tier : "?", cls: `lwp-cd-tier lwp-cd-tier-${lead.tier || "none"}` });
			const main = row.createDiv({ cls: "lwp-cd-row-main" });
			const nameLine = main.createDiv({ cls: "lwp-cd-row-name" });
			nameLine.createEl("span", { text: lead.business_name });
			if (lead.next_touch_date && lead.next_touch_date < today) {
				nameLine.createEl("span", { text: "STALE", cls: "lwp-cd-stale" });
			}
			main.createEl("div", {
				text: `${lead.state} · ${fmtPhone(lead.phone)}`,
				cls: "lwp-cd-row-sub",
			});
			row.onclick = () => { void this.selectLead(lead.slug); };
		};

		if (this.sortMode === "smart") {
			for (const g of this.groupLeads(this.leads, today)) {
				if (!g.rows.length) continue;
				el.createEl("div", { text: `${g.title} (${g.rows.length})`, cls: "lwp-cd-group" });
				for (const lead of g.rows) renderRow(lead);
			}
		} else {
			for (const lead of this.sortLeads(this.leads, this.sortMode)) renderRow(lead);
		}
	}

	private groupLeads(leads: CrmLead[], today: string): LeadGroup[] {
		const scope = CD_TABS[this.activeTab].scope;
		if (scope === "uncontacted") {
			return [
				{ title: "TIER A", rows: leads.filter(l => l.tier === "A") },
				{ title: "TIER B", rows: leads.filter(l => l.tier === "B") },
				{ title: "TIER C", rows: leads.filter(l => l.tier === "C") },
				{ title: "UNTIERED", rows: leads.filter(l => !l.tier) },
			];
		}
		const terminal = (s: string) => s === "dropped" || s === "closed" || s === "blocked";
		return [
			{ title: "OVERDUE", rows: leads.filter(l => !terminal(l.state) && !!l.next_touch_date && l.next_touch_date < today) },
			{ title: "DUE TODAY", rows: leads.filter(l => !terminal(l.state) && (!l.next_touch_date || l.next_touch_date === today)) },
			{ title: "UPCOMING", rows: leads.filter(l => !terminal(l.state) && !!l.next_touch_date && l.next_touch_date > today) },
			{ title: "DROPPED / CLOSED", rows: leads.filter(l => terminal(l.state)) },
		];
	}

	private sortLeads(leads: CrmLead[], mode: string): CrmLead[] {
		const arr = [...leads];
		const tierRank = (t?: string | null) => (t === "A" ? 1 : t === "B" ? 2 : t === "C" ? 3 : 4);
		if (mode === "tier") {
			arr.sort((a, b) => tierRank(a.tier) - tierRank(b.tier) || (b.reviews_count || 0) - (a.reviews_count || 0));
		} else if (mode === "next") {
			arr.sort((a, b) => (a.next_touch_date || "9999-99-99").localeCompare(b.next_touch_date || "9999-99-99"));
		} else if (mode === "reviews") {
			arr.sort((a, b) => (b.reviews_count || 0) - (a.reviews_count || 0));
		} else if (mode === "name") {
			arr.sort((a, b) => (a.business_name || "").localeCompare(b.business_name || ""));
		}
		return arr;
	}

	private renderEmptyDetail(): void {
		const el = this.detailEl;
		if (!el) return;
		el.empty();
		el.createEl("p", { text: "Queue clear. Nothing to call.", cls: "dash-empty" });
	}

	private renderError(msg: string): void {
		if (this.headerEl) { this.headerEl.empty(); this.headerEl.createEl("h2", { text: "LWP Call Day" }); }
		if (this.listEl) this.listEl.empty();
		const el = this.detailEl;
		if (!el) return;
		el.empty();
		el.createEl("p", { text: "Can't reach lwp-crm.", cls: "dash-empty" });
		el.createEl("pre", { text: msg, cls: "lwp-cd-error" });
		el.createEl("p", {
			text: "Check Settings → LWP Call Day: lwp-crm directory + Python command.",
			cls: "setting-item-description",
		});
	}

	private async selectLead(slug: string): Promise<void> {
		this.selectedSlug = slug;
		this.renderQueue(); // update active highlight
		const el = this.detailEl;
		if (!el) return;
		el.empty();
		el.createEl("p", { text: "Loading…", cls: "dash-empty" });
		let lead: CrmLead;
		try {
			lead = await this.runCli(["get", slug]) as CrmLead;
		} catch (e: any) {
			el.empty();
			el.createEl("pre", { text: String(e?.message || e), cls: "lwp-cd-error" });
			return;
		}
		this.renderDetail(lead);
	}

	private renderDetail(lead: CrmLead): void {
		const el = this.detailEl;
		if (!el) return;
		el.empty();

		// Title row
		const titleRow = el.createDiv({ cls: "lwp-cd-detail-title" });
		titleRow.createEl("h3", { text: lead.business_name });
		titleRow.createEl("span", { text: lead.state, cls: `lwp-cd-state-badge lwp-cd-state-${lead.state}` });
		if (lead.tier) titleRow.createEl("span", { text: lead.tier, cls: `lwp-cd-tier lwp-cd-tier-${lead.tier}` });

		// Meta
		const meta = el.createDiv({ cls: "lwp-cd-meta" });
		const sub: string[] = [];
		if (lead.owner_name) sub.push(lead.owner_name);
		sub.push(fmtPhone(lead.phone));
		if (lead.town) sub.push(lead.town);
		if (lead.trade) sub.push(lead.trade);
		meta.createEl("div", { text: sub.join(" · "), cls: "lwp-cd-meta-line" });
		if (lead.reviews_count) {
			meta.createEl("div", {
				text: `${lead.reviews_count} reviews @ ${lead.reviews_rating ?? "?"}★ (${lead.reviews_platform ?? "?"})`,
				cls: "lwp-cd-meta-line",
			});
		}
		const tline: string[] = [];
		if (lead.last_touch_date) tline.push(`last ${lead.last_touch_date}`);
		tline.push(`next ${lead.next_touch_date ?? "unset"}`);
		meta.createEl("div", { text: tline.join(" · "), cls: "lwp-cd-meta-line lwp-cd-meta-dim" });

		// Hook
		if (lead.hook) {
			const hook = el.createDiv({ cls: "lwp-cd-hook" });
			hook.createEl("div", { text: "HOOK", cls: "lwp-cd-label" });
			hook.createEl("div", { text: lead.hook });
		}
		// Persistent per-lead notes (auto-save on blur)
		const notesWrap = el.createDiv({ cls: "lwp-cd-notes" });
		notesWrap.createEl("div", { text: "NOTES", cls: "lwp-cd-label" });
		const notesArea = notesWrap.createEl("textarea", { cls: "lwp-cd-notes-area" });
		notesArea.value = lead.notes ?? "";
		notesArea.placeholder = "freeform notes — saves on blur";
		notesArea.onblur = () => {
			const v = notesArea.value;
			if (v !== (lead.notes ?? "")) {
				lead.notes = v;
				void this.saveNotes(lead.slug, v);
			}
		};

		if (lead.decision_maker_notes) {
			const dm = el.createDiv({ cls: "lwp-cd-dm" });
			dm.createEl("div", { text: "DM NOTES", cls: "lwp-cd-label" });
			dm.createEl("div", { text: lead.decision_maker_notes });
		}

		// Open links
		const links = el.createDiv({ cls: "lwp-cd-links" });
		const openBtn = links.createEl("button", { text: "Open preview · GBP · ammo ↗", cls: "lwp-cd-open" });
		openBtn.onclick = () => { void this.runCliRaw(["open", lead.slug]); };

		// Action panel
		const actions = el.createDiv({ cls: "lwp-cd-actions" });

		// Channel selector
		const chanRow = actions.createDiv({ cls: "lwp-cd-chan-row" });
		chanRow.createEl("span", { text: "LOG", cls: "lwp-cd-label" });
		const chanSel = chanRow.createEl("select", { cls: "lwp-cd-chan" });
		for (const c of ["call", "text", "email", "ig"]) {
			const opt = chanSel.createEl("option", { text: c, value: c });
			if (c === this.channel) opt.selected = true;
		}
		chanSel.onchange = () => { this.channel = chanSel.value; };

		// Note field (also used as drop reason for NO)
		const noteInput = el.createEl("input", { cls: "lwp-cd-note" });
		noteInput.type = "text";
		noteInput.placeholder = "note (also used as drop reason for NO)";

		// Outcome buttons
		const btnRow = actions.createDiv({ cls: "lwp-cd-btn-row" });
		for (const o of CALL_OUTCOMES) {
			const b = btnRow.createEl("button", { text: o.label, cls: "lwp-cd-btn" });
			b.onclick = () => { void this.logOutcome(lead, o.key, noteInput.value); };
		}
		const yes = btnRow.createEl("button", { text: "✓ YES (close)", cls: "lwp-cd-btn lwp-cd-btn-yes" });
		yes.onclick = () => { void this.logOutcome(lead, "YES", noteInput.value); };
		const no = btnRow.createEl("button", { text: "✗ NO (drop)", cls: "lwp-cd-btn lwp-cd-btn-no" });
		no.onclick = () => { void this.logOutcome(lead, "NO", noteInput.value, true); };

		// Touch history
		if (lead.touches && lead.touches.length) {
			const hist = el.createDiv({ cls: "lwp-cd-history" });
			hist.createEl("div", { text: "TOUCH HISTORY", cls: "lwp-cd-label" });
			for (const t of [...lead.touches].reverse()) {
				const r = hist.createDiv({ cls: "lwp-cd-hist-row" });
				r.createEl("span", { text: t.touch_date, cls: "lwp-cd-hist-date" });
				r.createEl("span", { text: `${t.channel}/${t.outcome}`, cls: "lwp-cd-hist-oc" });
				if (t.note) r.createEl("span", { text: t.note, cls: "lwp-cd-hist-note" });
			}
		}
	}

	// Persist freeform notes (set-notes); no reload — notes don't affect the queue.
	private async saveNotes(slug: string, text: string): Promise<void> {
		try {
			await this.runCli(["set-notes", slug, text, "--json"]);
		} catch (_) {
			// Non-fatal: a failed notes save shouldn't break the call flow.
		}
	}

	// Log an outcome, then advance to the next queued lead and reload.
	private async logOutcome(lead: CrmLead, outcome: string, note: string, drop = false): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		// Pick the next lead BEFORE the queue mutates.
		const idx = this.leads.findIndex(l => l.slug === lead.slug);
		const next = this.leads[idx + 1];
		const args = ["log", lead.slug, this.channel, outcome];
		const reason = (note || "").trim();
		if (reason) args.push(reason);
		if (drop) args.push("--drop");
		args.push("--json");
		try {
			const res = await this.runCli(args);
			if (res && res.ok === false) throw new Error(res.error || "log failed");
			this.selectedSlug = next ? next.slug : null;
			await this.reload();
		} catch (e: any) {
			this.renderError(String(e?.message || e));
		} finally {
			this.busy = false;
		}
	}
}
