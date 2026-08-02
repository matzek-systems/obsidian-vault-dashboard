import { Plugin, ItemView, WorkspaceLeaf, TFile, setIcon, Notice, PluginSettingTab, Setting, App } from "obsidian";
import { execFile } from "child_process";

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

interface DashboardSettings {
	// Pinned roadmap basenames in display order. Empty = auto mode (all active
	// roadmaps, busiest first). Migrates cleanly from the old ["","",""] tuple
	// (the empties are filtered out → []).
	tabs: string[];
	openOnStartup: boolean;
	// LWP Call-Day board: bridge to the lwp-crm CLI (state machine lives in ops.py).
	lwpCrmDir: string;
	pythonCmd: string;
}

const DEFAULT_SETTINGS: DashboardSettings = {
	tabs: [],
	openOnStartup: false,
	lwpCrmDir: "C:/Dev/lwp-crm",
	pythonCmd: "python",
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

// ── Dashboard View ──────────────────────────────────────

class DashboardView extends ItemView {
	private plugin: DashboardPlugin;
	private refreshTimer: ReturnType<typeof setTimeout> | null = null;
	private activeTab = 0;
	private projectCache: Map<string, ProjectData> = new Map();

	constructor(leaf: WorkspaceLeaf, plugin: DashboardPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string { return VIEW_TYPE; }
	getDisplayText(): string { return "Dashboard"; }
	getIcon(): string { return ICON; }

	async onOpen(): Promise<void> {
		this.navigation = false;
		this.contentEl.addClass("vault-dashboard");
		this.registerEvent(
			this.app.metadataCache.on("resolved", () => {
				if (this.refreshTimer) clearTimeout(this.refreshTimer);
				this.refreshTimer = setTimeout(() => {
					this.projectCache.clear();
					this.render();
				}, 500);
			})
		);
		// Paint immediately on mount (reads via cachedRead, available at startup),
		// then re-render once layout/files settle. No longer gated solely on the
		// metadataCache "resolved" event, which could fire before this handler
		// registered and leave the view stuck empty until a manual click.
		this.render();
		this.app.workspace.onLayoutReady(() => this.render());
	}

	async onClose(): Promise<void> {
		if (this.refreshTimer) clearTimeout(this.refreshTimer);
	}

	// ── Helpers ──────────────────────────────────────────

	private stripMd(text: string): string {
		return text
			.replace(/\*\*(.+?)\*\*/g, "$1")
			.replace(/\*(.+?)\*/g, "$1")
			.replace(/`(.+?)`/g, "$1")
			.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
			.replace(/\[\[([^\]]+)\]\]/g, "$1")
			.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
	}

	private parseStartupTable(content: string): WI[] {
		// SYS-330: the WI list is derived from the detail sections, mirroring
		// roadmap_parser.parse_roadmap + generate_startup_table (no stored table).
		const items: WI[] = [];
		const lines = content.split("\n");
		for (let i = 0; i < lines.length - 1; i++) {
			const headerMatch = lines[i].match(/^### ([A-Z]+-\d+[a-z]?):\s*(.+)$/);
			if (!headerMatch) continue;
			const statusLine = lines[i + 1];
			const statusMatch = statusLine.match(/^`status:\s*(\S+?)`/);
			if (!statusMatch) continue;
			const status = statusMatch[1];
			if (status === "done" || status === "killed") continue;
			let summary = headerMatch[2].trim();
			const triggerMatch = statusLine.match(/`trigger:\s*([^`]+)`/);
			if (status === "deferred" && triggerMatch) {
				summary += ` → trigger: ${triggerMatch[1]}`;
			}
			items.push({ id: headerMatch[1], status, summary });
		}
		return items;
	}

	private parseDependencies(content: string, wiId: string): string | undefined {
		// Match: ### WI-98: ... \n `status: blocked` | `depends: WI-102, WI-104`
		const sectionRegex = new RegExp("### " + wiId + ":[\\s\\S]*?(?=\\n### |\\n---\\n|$)", "i");
		const section = content.match(sectionRegex);
		if (!section) return undefined;
		const depMatch = section[0].match(/`depends:\s*([^`]+)`/);
		return depMatch ? depMatch[1].trim() : undefined;
	}

	private extractSection(content: string, heading: string): string {
		const regex = new RegExp("## " + heading + "[\\s\\S]*?\\n([\\s\\S]*?)(?=\\n---\\n|\\n## |$)", "i");
		const match = content.match(regex);
		return match ? match[1].trim() : "";
	}

	private extractBullets(content: string): string[] {
		return content.split("\n")
			.filter(l => l.trim().startsWith("-"))
			.map(l => l.trim().replace(/^-\s*\[.\]\s*/, "").replace(/^-\s*/, ""));
	}

	private extractWISection(content: string, wiId: string): string {
		// Match ### WI-73: Title through next ### or --- or EOF
		const regex = new RegExp("### " + wiId + ":[\\s\\S]*?(?=\\n### |\\n---\\n|$)", "i");
		const m = content.match(regex);
		return m ? m[0] : "";
	}

	private parseRecentlyDone(content: string): { id: string; summary: string; date: string }[] {
		const results: { id: string; summary: string; date: string }[] = [];
		// Actual format:
		// ### WI-73: Deliverable 05 The System
		// `status: done` | `completed: 2026-03-02 (session 55)`
		const lines = content.split("\n");
		for (let i = 0; i < lines.length - 1; i++) {
			const headingMatch = lines[i].match(/^### ([\w-]+):\s*(.+)/);
			if (!headingMatch) continue;

			const nextLine = lines[i + 1];
			const doneMatch = nextLine.match(/`status: done`\s*\|\s*`completed:\s*([^`]+)`/);
			if (!doneMatch) continue;

			const id = headingMatch[1];
			const summary = headingMatch[2].trim();
			const date = doneMatch[1].replace(/\s*\(session.*\)/, "").trim();
			results.push({ id, summary, date });
		}
		results.sort((a, b) => b.date.localeCompare(a.date));
		return results.slice(0, 5);
	}

	// ── Load project data ───────────────────────────────

	private async loadProject(basename: string): Promise<ProjectData | null> {
		if (this.projectCache.has(basename)) return this.projectCache.get(basename)!;

		const roadmaps = this.plugin.discoverRoadmaps();
		const file = roadmaps.find(f => f.basename === basename);
		if (!file) return null;

		const content = await this.app.vault.cachedRead(file);
		const label = file.basename.replace(" Roadmap", "").replace(/^_/, "");
		const allWIs = this.parseStartupTable(content);

		for (const wi of allWIs) {
			wi.depends = this.parseDependencies(content, wi.id);
			// Staleness detection: if active/needs-testing and all tasks are checked
			if (wi.status === "active" || wi.status === "needs-testing") {
				const section = this.extractWISection(content, wi.id);
				const unchecked = section.split("\n").filter(l => /^- \[ \]/.test(l));
				const checked = section.split("\n").filter(l => /^- \[x\]/i.test(l));
				if (unchecked.length === 0 && checked.length > 0) {
					wi.stale = true;
				}
			}
		}

		const whereImAt = this.extractSection(content, "Where I'm At");
		const recentlyDone = this.parseRecentlyDone(content);
		const liveSession = await this.findLiveSession(label, file.basename);
		// Frontmatter status, parsed from content (cachedRead) — NOT metadataCache,
		// which is cold at startup and caused the "click to load" render race.
		const fm = content.match(/^---\n([\s\S]*?)\n---/);
		const status = fm?.[1].match(/^status:\s*(\S+)/m)?.[1] ?? "active";

		const data: ProjectData = { file, label, content, status, wis: allWIs, whereImAt, liveSession, recentlyDone };
		this.projectCache.set(basename, data);
		return data;
	}

	private async findLiveSession(projectLabel: string, basename: string): Promise<string | null> {
		const ramFiles = this.app.vault.getFiles().filter(f =>
			f.path.startsWith(SESSION_RAM_FOLDER + "/") && /^session-\d+-ram\.md$/.test(f.name)
		);

		// Use multiple search strategies to avoid false positives
		// "System" is too generic — also match on roadmap filename patterns
		const labelLower = projectLabel.toLowerCase();
		const basenameTerms = basename.toLowerCase().replace(" roadmap", "").replace(/^_/, "").split(/\s+/);

		for (const rf of ramFiles) {
			const content = await this.app.vault.cachedRead(rf);

			// Look specifically in Focus and Write zone lines
			const focusMatch = content.match(/\*\*Focus:\*\*\s*(.+)/);
			const writeZoneMatch = content.match(/\*\*Write zone:\*\*\s*(.+)/);
			const focusLine = (focusMatch?.[1] ?? "").toLowerCase();
			const writeZoneLine = (writeZoneMatch?.[1] ?? "").toLowerCase();
			const searchArea = focusLine + " " + writeZoneLine;

			// Check if this project is mentioned in focus or write zone
			const isMatch = basenameTerms.some(term =>
				term.length > 3 && searchArea.includes(term)
			) || searchArea.includes(labelLower);

			if (isMatch) {
				const num = rf.name.match(/session-(\d+)-ram/)?.[1] ?? "?";
				const focus = focusMatch ? this.stripMd(focusMatch[1].trim()) : "active";
				if (focus === "TBD (awaiting user task)") continue; // Skip idle sessions
				return `Session ${num} — ${focus}`;
			}
		}
		return null;
	}

	// ── Render ──────────────────────────────────────────

	private activeCount(p: ProjectData): number {
		return p.wis.filter(w => w.status === "active").length;
	}

	async render(): Promise<void> {
		const { contentEl } = this;
		const scrollTop = contentEl.scrollTop;
		contentEl.empty();

		let activeTabs = this.plugin.settings.tabs.filter(t => t !== "");

		// Auto mode (nothing pinned): every active roadmap, ordered by active-WI
		// count (busiest first), alphabetical tiebreak — the Mesenchyme top-bar
		// behavior (DL-337). Reads via loadProject (vault.cachedRead), so the
		// first paint never depends on a cold metadataCache.
		if (activeTabs.length === 0) {
			const projects: ProjectData[] = [];
			for (const rf of this.plugin.discoverRoadmaps()) {
				const p = await this.loadProject(rf.basename);
				if (p && p.status === "active") projects.push(p);
			}
			projects.sort((a, b) =>
				this.activeCount(b) - this.activeCount(a) || a.label.localeCompare(b.label)
			);
			activeTabs = projects.map(p => p.file.basename);
		}

		if (activeTabs.length === 0) {
			contentEl.createEl("p", { text: "No roadmaps found. Add roadmap files to Roadmaps/ or configure in settings.", cls: "dash-empty" });
			return;
		}

		if (this.activeTab >= activeTabs.length) this.activeTab = 0;

		// Active-WI count per tab for the badge (loadProject is cached).
		const counts: number[] = [];
		for (const t of activeTabs) {
			const p = await this.loadProject(t);
			counts.push(p ? this.activeCount(p) : 0);
		}

		this.renderTabBar(contentEl, activeTabs, counts);

		const main = contentEl.createDiv({ cls: "dash-main" });
		const project = await this.loadProject(activeTabs[this.activeTab]);

		if (!project) {
			main.createEl("p", { text: "Could not load roadmap.", cls: "dash-empty" });
		} else {
			await this.renderProject(main, project);
		}

		await this.renderStatusBar(contentEl, activeTabs);
		contentEl.scrollTop = scrollTop;
	}

	// ── Tab Bar ─────────────────────────────────────────

	private renderTabBar(parent: HTMLElement, tabs: string[], counts: number[]): void {
		const nav = parent.createDiv({ cls: "dash-nav" });

		const tabWrap = nav.createDiv({ cls: "dash-nav-tabs" });
		for (let i = 0; i < tabs.length; i++) {
			const label = tabs[i].replace(" Roadmap", "").replace(/^_/, "");
			const tab = tabWrap.createDiv({
				cls: `dash-nav-tab ${this.activeTab === i ? "dash-nav-active" : ""}`,
			});
			tab.createEl("span", { text: label });
			if (counts[i] > 0) {
				tab.createEl("span", { text: String(counts[i]), cls: "dash-nav-tab-count" });
			}
			tab.addEventListener("click", () => {
				this.activeTab = i;
				this.render();
			});
		}

		const actions = nav.createDiv({ cls: "dash-nav-actions" });

		const refresh = actions.createDiv({ cls: "dash-nav-action" });
		const refreshIcon = refresh.createSpan();
		setIcon(refreshIcon, "refresh-cw");
		refresh.setAttribute("aria-label", "Refresh");
		refresh.addEventListener("click", () => {
			this.projectCache.clear();
			this.render();
		});

		const gear = actions.createDiv({ cls: "dash-nav-action" });
		const gearIcon = gear.createSpan();
		setIcon(gearIcon, "settings");
		gear.addEventListener("click", () => {
			(this.app as any).setting.open();
			(this.app as any).setting.openTabById("vault-dashboard");
		});
	}

	// ── Project Page ────────────────────────────────────

	private async renderProject(parent: HTMLElement, project: ProjectData): Promise<void> {
		const { wis, content } = project;

		// ── State Block
		const stateBlock = parent.createDiv({ cls: "dash-state-block" });

		if (project.whereImAt) {
			const stateText = stateBlock.createDiv({ cls: "dash-state-text" });
			for (const line of project.whereImAt.split("\n").filter(l => l.trim())) {
				stateText.createEl("p", { text: this.stripMd(line.trim()) });
			}
		} else {
			stateBlock.createEl("p", { text: "No project state yet. Add a note below or run /close.", cls: "dash-empty" });
		}

		if (project.liveSession) {
			const live = stateBlock.createDiv({ cls: "dash-live-badge" });
			const iconEl = live.createSpan({ cls: "dash-live-icon" });
			setIcon(iconEl, "radio");
			live.createEl("span", { text: project.liveSession });
		}

		// Quick-append
		const appendRow = stateBlock.createDiv({ cls: "dash-append-row" });
		const input = appendRow.createEl("input", {
			cls: "dash-append-input",
			attr: { type: "text", placeholder: "+ add note..." },
		});
		input.addEventListener("keydown", async (e: KeyboardEvent) => {
			if (e.key === "Enter" && input.value.trim()) {
				await this.appendToWhereImAt(project.file, input.value.trim());
				input.value = "";
				this.projectCache.clear();
				this.render();
			}
		});

		// Click state block to open roadmap
		stateBlock.addEventListener("click", (e) => {
			if ((e.target as HTMLElement).tagName === "INPUT") return;
			this.app.workspace.getLeaf(false).openFile(project.file);
		});

		// ── WI Sections
		const active = wis.filter(w => w.status === "active");
		const blocked = wis.filter(w => w.status === "blocked");
		const testing = wis.filter(w => w.status === "needs-testing");
		const ready = wis.filter(w => w.status === "ready");
		const waiting = wis.filter(w => w.status === "waiting");
		const deferred = wis.filter(w => w.status === "deferred");

		if (active.length > 0) {
			this.renderSectionHeader(parent, "Active", "zap", active.length.toString(), "active");
			for (const wi of active) this.renderHeroCard(parent, wi, content, project.file);
		}

		if (testing.length > 0) {
			this.renderSectionHeader(parent, "Needs Testing", "flask-conical", testing.length.toString(), "testing");
			for (const wi of testing) this.renderCompactRow(parent, wi, "testing", project.file);
		}

		if (ready.length > 0) {
			this.renderSectionHeader(parent, "Ready", "circle-dot", ready.length.toString(), "ready");
			const visible = ready.slice(0, 8);
			for (const wi of visible) this.renderCompactRow(parent, wi, "ready", project.file);
			if (ready.length > 8) parent.createEl("p", { text: `+ ${ready.length - 8} more`, cls: "dash-more-note" });
		}

		if (blocked.length > 0) {
			this.renderSectionHeader(parent, "Blocked", "alert-circle", blocked.length.toString(), "blocked");
			for (const wi of blocked) this.renderBlockedRow(parent, wi, project.file);
		}

		if (waiting.length > 0) {
			this.renderSectionHeader(parent, "Waiting", "clock", waiting.length.toString(), "waiting");
			for (const wi of waiting) this.renderCompactRow(parent, wi, "waiting", project.file);
		}

		if (project.recentlyDone.length > 0) {
			this.renderSectionHeader(parent, "Recently Done", "check-circle", project.recentlyDone.length.toString(), "done");
			const doneList = parent.createDiv({ cls: "dash-done-list" });
			for (const item of project.recentlyDone) {
				const row = doneList.createDiv({ cls: "dash-done-row" });
				row.createEl("span", { text: item.id, cls: "dash-wi-id" });
				row.createEl("span", { text: this.stripMd(item.summary), cls: "dash-done-summary" });
				row.createEl("span", { text: item.date, cls: "dash-done-date" });
			}
		}

		if (deferred.length > 0) {
			parent.createEl("p", { text: `${deferred.length} deferred`, cls: "dash-deferred-note" });
		}
	}

	// ── Quick Append ────────────────────────────────────

	// FIFO cap on quick-append notes: keep at most WIA_MAX_NOTES "- " bullets in
	// the section, dropping the oldest. Bounds the one unbounded write path the
	// dashboard owns. Generous (6) so the frequently-run close drains notes into
	// the narrative before overflow — preserves the merge-don't-drop contract.
	private static readonly WIA_MAX_NOTES = 6;

	private capNotes(section: string): string {
		const lines = section.split("\n");
		const bulletIdx = lines
			.map((l, i) => (l.trim().startsWith("-") ? i : -1))
			.filter((i) => i >= 0);
		if (bulletIdx.length <= DashboardView.WIA_MAX_NOTES) return section;
		const drop = new Set(bulletIdx.slice(0, bulletIdx.length - DashboardView.WIA_MAX_NOTES));
		return lines.filter((_, i) => !drop.has(i)).join("\n");
	}

	private async appendToWhereImAt(file: TFile, note: string): Promise<void> {
		const content = await this.app.vault.read(file);
		const bullet = `- ${note}`;

		if (content.includes("## Where I'm At")) {
			// Try mid-file match first (section followed by --- or ##)
			const midFileRegex = /(## Where I'm At\n[\s\S]*?)(\n---\n|\n## )/;
			const midMatch = content.match(midFileRegex);
			if (midMatch) {
				const updated = content.replace(midFileRegex,
					(_, section, terminator) =>
						`${this.capNotes(`${section.trimEnd()}\n${bullet}`)}\n${terminator}`
				);
				await this.app.vault.modify(file, updated);
				return;
			}
			// EOF case
			const updated = content.replace(
				/(## Where I'm At\n[\s\S]*?)$/,
				(match) => `${this.capNotes(`${match.trimEnd()}\n${bullet}`)}\n`
			);
			await this.app.vault.modify(file, updated);
		} else {
			// Create section at EOF (SYS-330: no sentinel anchor; the `---`
			// terminator establishes the canonical section boundary)
			await this.app.vault.modify(file, `${content.trimEnd()}\n\n## Where I'm At\n\n${bullet}\n\n---\n`);
		}
	}

	// ── WI Note Append ──────────────────────────────────

	private async appendNoteToWI(file: TFile, wiId: string, note: string): Promise<void> {
		const content = await this.app.vault.read(file);
		const bullet = `- ${note}`;
		const sectionRegex = new RegExp("(### " + wiId + ":[\\s\\S]*?)(\\n### |\\n---\\n|$)", "i");
		const match = content.match(sectionRegex);
		if (match) {
			const updated = content.replace(sectionRegex,
				(_, section, terminator) => `${section.trimEnd()}\n${bullet}\n${terminator}`
			);
			await this.app.vault.modify(file, updated);
			this.projectCache.clear();
			this.render();
		}
	}

	private async markWIDone(file: TFile, wiId: string): Promise<void> {
		let content = await this.app.vault.read(file);
		const today = new Date().toISOString().slice(0, 10);

		// Update detail block: status line
		const statusRegex = new RegExp("(### " + wiId + ":[^\\n]*\\n)`status: [^`]+`", "i");
		const statusMatch = content.match(statusRegex);
		if (statusMatch) {
			content = content.replace(statusRegex,
				`$1\`status: done\` | \`completed: ${today}\``
			);
		}

		// (SYS-330: no stored startup table — the WI list re-derives from the
		// status line on next render)

		// Unlock blockers: promote blocked -> ready if all dependencies are now done
		content = this.unlockDependents(content, wiId);

		await this.app.vault.modify(file, content);
		this.projectCache.clear();
		this.render();
	}

	private unlockDependents(content: string, completedId: string): string {
		const headings = [...content.matchAll(/### ([\w-]+):/g)];
		for (const heading of headings) {
			const wiId = heading[1];
			const sectionRegex = new RegExp("### " + wiId + ":[\\s\\S]*?(?=\\n### |\\n---\\n|$)", "i");
			const sectionMatch = content.match(sectionRegex);
			if (!sectionMatch) continue;
			const section = sectionMatch[0];

			if (!/`status: blocked`/.test(section)) continue;
			const depMatch = section.match(/`depends:\s*([^`]+)`/);
			if (!depMatch) continue;

			const deps = depMatch[1].split(",").map((d: string) => d.trim());
			if (!deps.includes(completedId)) continue;

			const allDone = deps.every((dep: string) => {
				if (dep === completedId) return true;
				const depRegex = new RegExp("### " + dep + ":[^\\n]*\\n`status: done`");
				return depRegex.test(content);
			});

			if (allDone) {
				content = content.replace(
					new RegExp("(### " + wiId + ":[^\\n]*\\n)`status: blocked`", "i"),
					`$1\`status: ready\``
				);
			}
		}
		return content;
	}

	private renderWIActions(parent: HTMLElement, file: TFile, wi: WI): void {
		const actions = parent.createDiv({ cls: "dash-wi-actions" });

		// Plus: add note
		const plus = actions.createDiv({ cls: "dash-wi-btn dash-wi-btn-add" });
		const plusIcon = plus.createSpan();
		setIcon(plusIcon, "plus");
		plus.addEventListener("click", (e) => {
			e.stopPropagation();
			const card = parent.closest(".dash-card, .dash-blocked-row, .dash-compact-row");
			if (!card) return;
			const existing = card.querySelector(".dash-wi-add-input") as HTMLInputElement;
			if (existing) { existing.remove(); return; }
			const input = card.createEl("input", {
				cls: "dash-wi-add-input",
				attr: { type: "text", placeholder: "Add note..." },
			});
			input.focus();
			input.addEventListener("keydown", async (ev: KeyboardEvent) => {
				if (ev.key === "Enter" && input.value.trim()) {
					await this.appendNoteToWI(file, wi.id, input.value.trim());
				}
				if (ev.key === "Escape") input.remove();
			});
			input.addEventListener("blur", () => {
				setTimeout(() => input.remove(), 200);
			});
		});

		// Check: mark done (glows when stale)
		const checkCls = wi.stale ? "dash-wi-btn dash-wi-btn-done dash-wi-stale" : "dash-wi-btn dash-wi-btn-done";
		const check = actions.createDiv({ cls: checkCls });
		const checkIcon = check.createSpan();
		setIcon(checkIcon, "check");
		check.addEventListener("click", async (e) => {
			e.stopPropagation();
			await this.markWIDone(file, wi.id);
		});
	}

	// ── Section Header ──────────────────────────────────

	private renderSectionHeader(parent: HTMLElement, title: string, icon: string, count: string, colorCls: string): void {
		const header = parent.createDiv({ cls: "dash-section-header" });
		const left = header.createDiv({ cls: "dash-section-left" });
		const iconEl = left.createSpan({ cls: "dash-section-icon" });
		setIcon(iconEl, icon);
		left.createEl("h2", { text: title });
		header.createEl("span", { text: count, cls: `dash-section-count dash-sc-${colorCls}` });
	}

	// ── Hero Card ───────────────────────────────────────

	private renderHeroCard(parent: HTMLElement, wi: WI, content: string, file: TFile): void {
		const card = parent.createDiv({ cls: "dash-card dash-card-hero" });
		const header = card.createDiv({ cls: "dash-card-header" });
		header.createEl("span", { text: wi.id, cls: "dash-wi-id" });
		header.createEl("h3", { text: this.stripMd(wi.summary) });
		this.renderWIActions(header, file, wi);

		const wiSection = this.extractWISection(content, wi.id);
		const unchecked = wiSection.split("\n")
			.filter(l => /^- \[ \]/.test(l))
			.map(l => l.replace(/^- \[ \]\s*/, "").trim());

		if (unchecked.length > 0) {
			const taskList = card.createDiv({ cls: "dash-hero-tasks" });
			for (const task of unchecked.slice(0, 5)) {
				const row = taskList.createDiv({ cls: "dash-hero-task-row" });
				row.createEl("span", { text: "\u25CB", cls: "dash-task-bullet" });
				row.createEl("span", { text: this.stripMd(task) });
			}
			if (unchecked.length > 5) {
				taskList.createEl("p", { text: `+ ${unchecked.length - 5} more`, cls: "dash-more-note" });
			}
		}

		card.addEventListener("click", () => {
			this.app.workspace.openLinkText(file.path + "#" + wi.id, "", false);
		});
	}

	// ── Blocked Row ─────────────────────────────────────

	private renderBlockedRow(parent: HTMLElement, wi: WI, file: TFile): void {
		const row = parent.createDiv({ cls: "dash-blocked-row" });
		const left = row.createDiv({ cls: "dash-blocked-left" });
		left.createEl("span", { text: wi.id, cls: "dash-wi-id" });
		left.createEl("span", { text: this.stripMd(wi.summary), cls: "dash-blocked-summary" });
		this.renderWIActions(left, file, wi);

		if (wi.depends) {
			const depEl = row.createDiv({ cls: "dash-blocked-deps" });
			const iconEl = depEl.createSpan({ cls: "dash-dep-icon" });
			setIcon(iconEl, "arrow-left");
			for (const dep of wi.depends.split(",").map(d => d.trim())) {
				depEl.createEl("span", { text: dep, cls: "dash-dep-link" });
			}
		}

		row.addEventListener("click", () => {
			this.app.workspace.openLinkText(file.path + "#" + wi.id, "", false);
		});
	}

	// ── Compact Row ─────────────────────────────────────

	private renderCompactRow(parent: HTMLElement, wi: WI, statusCls: string, file: TFile): void {
		const row = parent.createDiv({ cls: "dash-compact-row" });
		row.createEl("span", { text: wi.id, cls: "dash-wi-id" });
		row.createEl("span", { text: wi.status, cls: `dash-wi-badge dash-wb-${statusCls}` });
		row.createEl("span", { text: this.stripMd(wi.summary), cls: "dash-compact-summary" });
		this.renderWIActions(row, file, wi);
		row.addEventListener("click", () => {
			this.app.workspace.openLinkText(file.path + "#" + wi.id, "", false);
		});
	}

	// ── Status Bar ──────────────────────────────────────

	private async renderStatusBar(parent: HTMLElement, allTabNames: string[]): Promise<void> {
		const bar = parent.createDiv({ cls: "dash-status-bar" });

		let totalActive = 0, totalBlocked = 0, totalReady = 0, totalTesting = 0;
		for (const tabName of allTabNames) {
			const project = await this.loadProject(tabName); // uses cache
			if (!project) continue;
			for (const wi of project.wis) {
				if (wi.status === "active") totalActive++;
				else if (wi.status === "blocked") totalBlocked++;
				else if (wi.status === "ready") totalReady++;
				else if (wi.status === "needs-testing") totalTesting++;
			}
		}

		const counts = bar.createDiv({ cls: "dash-bar-counts" });
		this.addBarChip(counts, totalActive, "active", "active");
		this.addBarChip(counts, totalBlocked, "blocked", "blocked");
		this.addBarChip(counts, totalReady, "ready", "ready");
		this.addBarChip(counts, totalTesting, "testing", "testing");

		const alerts = bar.createDiv({ cls: "dash-bar-alerts" });

		const homeFile = this.app.vault.getFileByPath(SYSTEM_HOME);
		if (homeFile) {
			const homeContent = await this.app.vault.cachedRead(homeFile);
			const items = this.extractBullets(this.extractSection(homeContent, "Capture Zone"));
			if (items.length > 0) {
				const alert = alerts.createEl("span", { cls: "dash-alert dash-alert-capture" });
				const iconEl = alert.createSpan({ cls: "dash-alert-icon" });
				setIcon(iconEl, "inbox");
				alert.createEl("span", { text: `${items.length} capture` });
				alert.addEventListener("click", () => {
					this.app.workspace.openLinkText(SYSTEM_HOME, "", false);
				});
			}
		}

		const ramFiles = this.app.vault.getFiles().filter(f =>
			f.path.startsWith(SESSION_RAM_FOLDER + "/") && /^session-\d+-ram\.md$/.test(f.name)
		);
		if (ramFiles.length > 0) {
			const sessionEl = bar.createEl("span", { cls: "dash-bar-sessions-info" });
			const sIcon = sessionEl.createSpan({ cls: "dash-bar-session-icon" });
			setIcon(sIcon, "terminal");
			sessionEl.createEl("span", { text: `${ramFiles.length}` });
		}
	}

	private addBarChip(parent: HTMLElement, count: number, label: string, cls: string): void {
		if (count === 0) return;
		const el = parent.createEl("span", { cls: `dash-bar-chip dash-bc-${cls}` });
		el.createEl("span", { text: count.toString(), cls: "dash-bar-chip-num" });
		el.createEl("span", { text: label });
	}
}

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

	// ── Sessions tracker (lives in the Process area, not a dashboard tab) ──

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

		const entries = Object.entries(registry.sessions).map(([num, s]) => ({ num, ...s }));
		const active = entries.filter(s => (s.status ?? "active") === "active");
		active.sort((a, b) => Number(b.num) - Number(a.num)); // newest session first

		header.createEl("span", {
			text: `${active.length} active · ${entries.length} total`,
			cls: "dash-ps-total dash-sess-summary",
		});

		if (active.length === 0) {
			el.createEl("p", { text: "No active sessions.", cls: "dash-empty" });
			return;
		}

		const table = el.createDiv({ cls: "dash-ps-table dash-sess-table" });
		const head = table.createDiv({ cls: "dash-ps-row dash-ps-head" });
		head.createEl("span", { text: "session" });
		head.createEl("span", { text: "focus" });
		head.createEl("span", { text: "write zone" });
		head.createEl("span", { text: "date" });
		head.createEl("span", { text: "" });

		for (const s of active) {
			const row = table.createDiv({ cls: "dash-ps-row dash-ps-running" });
			const labelEl = row.createDiv({ cls: "dash-ps-label" });
			const dot = labelEl.createSpan({ cls: "dash-ps-dot dash-ps-dot-running" });
			dot.textContent = "•";
			labelEl.createEl("span", { text: s.num });

			const focus = (s.focus ?? "").trim();
			const isIdle = !focus || focus === "TBD (awaiting user task)";
			row.createEl("span", {
				text: isIdle ? "—" : focus,
				cls: `dash-sess-focus${isIdle ? " dash-sess-idle" : ""}`,
			});

			const wz = (s.write_zone ?? "").trim();
			row.createEl("span", { text: wz || "—", cls: "dash-sess-zone" });
			row.createEl("span", { text: s.date ?? "—", cls: "dash-ps-uptime" });

			const resumeEl = row.createDiv({ cls: "dash-sess-resume" });
			const btn = resumeEl.createEl("button", { cls: "dash-sess-resume-btn", text: "resume" });
			const freshness = this.jsonlFreshness(s.jsonl);
			if (freshness === "live") {
				btn.disabled = true;
				btn.title = "Live in another terminal — resuming would put two writers on one transcript";
			} else if (freshness === "gone") {
				btn.disabled = true;
				btn.title = "Transcript not found — nothing to resume";
			} else {
				btn.title = "Reopen this session in a workspace-shell seat (claude --resume)";
				btn.addEventListener("click", () => this.resumeInSeat(s.uuid, s.num));
			}
		}
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
