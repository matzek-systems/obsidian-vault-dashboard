import { Plugin, ItemView, WorkspaceLeaf, TFile, setIcon, PluginSettingTab, Setting, App } from "obsidian";

const VIEW_TYPE = "vault-dashboard";
const ICON = "layout-dashboard";

const ROADMAPS_FOLDER = "00_System/AI/Claude/Roadmaps";
const SYSTEM_HOME = "00_System/AI/Claude/00_Home.md";
const SESSION_RAM_FOLDER = "00_System/AI/Claude/Scratchpad";

interface DashboardSettings {
	tabs: [string, string, string];
	openOnStartup: boolean;
}

const DEFAULT_SETTINGS: DashboardSettings = {
	tabs: ["", "", ""],
	openOnStartup: false,
};

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
		return this.app.vault.getFiles().filter(f =>
			f.path.startsWith(ROADMAPS_FOLDER + "/") && f.extension === "md"
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
			text: "Select up to 3 projects for your dashboard tabs. Leave empty to auto-discover active roadmaps.",
			cls: "setting-item-description",
		});

		const roadmaps = this.plugin.discoverRoadmaps();
		const options: Record<string, string> = { "": "(none)" };
		for (const rf of roadmaps) {
			options[rf.basename] = rf.basename.replace(" Roadmap", "").replace(/^_/, "");
		}

		for (let i = 0; i < 3; i++) {
			new Setting(containerEl)
				.setName(`Tab ${i + 1}`)
				.addDropdown(drop => {
					for (const [value, display] of Object.entries(options)) {
						drop.addOption(value, display);
					}
					drop.setValue(this.plugin.settings.tabs[i]);
					drop.onChange(async (value) => {
						this.plugin.settings.tabs[i] = value;
						await this.plugin.saveSettings();
					});
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
		const items: WI[] = [];
		const tableMatch = content.match(/<!-- STARTUP_START[\s\S]*?<!-- STARTUP_END -->/);
		if (!tableMatch) return items;
		for (const line of tableMatch[0].split("\n")) {
			const m = line.match(/^\|\s*([\w-]+)\s*\|\s*(\w[\w-]*)\s*\|\s*(.+?)\s*\|$/);
			if (m && m[1] !== "WI") items.push({ id: m[1], status: m[2], summary: m[3] });
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

		const data: ProjectData = { file, label, content, wis: allWIs, whereImAt, liveSession, recentlyDone };
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

	async render(): Promise<void> {
		const { contentEl } = this;
		const scrollTop = contentEl.scrollTop;
		contentEl.empty();

		let activeTabs = this.plugin.settings.tabs.filter(t => t !== "");

		// Auto-discover if no tabs configured
		if (activeTabs.length === 0) {
			const roadmaps = this.plugin.discoverRoadmaps();
			for (const rf of roadmaps) {
				const cache = this.app.metadataCache.getFileCache(rf);
				const status = cache?.frontmatter?.["status"] ?? "active";
				if (status === "active" && activeTabs.length < 3) {
					activeTabs.push(rf.basename);
				}
			}
		}

		if (activeTabs.length === 0) {
			contentEl.createEl("p", { text: "No roadmaps found. Add roadmap files to Roadmaps/ or configure in settings.", cls: "dash-empty" });
			return;
		}

		if (this.activeTab >= activeTabs.length) this.activeTab = 0;

		this.renderTabBar(contentEl, activeTabs);

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

	private renderTabBar(parent: HTMLElement, tabs: string[]): void {
		const nav = parent.createDiv({ cls: "dash-nav" });

		const tabWrap = nav.createDiv({ cls: "dash-nav-tabs" });
		for (let i = 0; i < tabs.length; i++) {
			const label = tabs[i].replace(" Roadmap", "").replace(/^_/, "");
			const tab = tabWrap.createDiv({
				cls: `dash-nav-tab ${this.activeTab === i ? "dash-nav-active" : ""}`,
			});
			tab.createEl("span", { text: label });
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

		if (blocked.length > 0) {
			this.renderSectionHeader(parent, "Blocked", "alert-circle", blocked.length.toString(), "blocked");
			for (const wi of blocked) this.renderBlockedRow(parent, wi, project.file);
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

	private async appendToWhereImAt(file: TFile, note: string): Promise<void> {
		const content = await this.app.vault.read(file);
		const bullet = `- ${note}`;

		if (content.includes("## Where I'm At")) {
			// Try mid-file match first (section followed by --- or ##)
			const midFileRegex = /(## Where I'm At\n[\s\S]*?)(\n---\n|\n## )/;
			const midMatch = content.match(midFileRegex);
			if (midMatch) {
				const updated = content.replace(midFileRegex,
					(_, section, terminator) => `${section.trimEnd()}\n${bullet}\n${terminator}`
				);
				await this.app.vault.modify(file, updated);
				return;
			}
			// EOF case
			const updated = content.replace(
				/(## Where I'm At\n[\s\S]*?)$/,
				(match) => `${match.trimEnd()}\n${bullet}\n`
			);
			await this.app.vault.modify(file, updated);
		} else {
			// Create section after startup table or at end
			const endTag = "<!-- STARTUP_END -->";
			const insertIdx = content.indexOf(endTag);
			if (insertIdx !== -1) {
				const lineEnd = content.indexOf("\n", insertIdx);
				const pos = lineEnd !== -1 ? lineEnd + 1 : content.length;
				const before = content.slice(0, pos);
				const after = content.slice(pos);
				await this.app.vault.modify(file, `${before}\n## Where I'm At\n\n${bullet}\n\n${after}`);
			} else {
				await this.app.vault.modify(file, `${content.trimEnd()}\n\n## Where I'm At\n\n${bullet}\n`);
			}
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

		// Update startup table row
		const tableRowRegex = new RegExp("^(\\|\\s*" + wiId + "\\s*\\|\\s*)\\w[\\w-]*(\\s*\\|)", "m");
		content = content.replace(tableRowRegex, `$1done$2`);

		await this.app.vault.modify(file, content);
		this.projectCache.clear();
		this.render();
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
