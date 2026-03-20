import { Plugin, ItemView, WorkspaceLeaf, TFile } from "obsidian";

const VIEW_TYPE = "vault-dashboard";
const ICON = "layout-dashboard";

// Roadmaps and their corresponding project home files
const ROADMAPS: { roadmap: string; home: string | null; label: string }[] = [
	{ roadmap: "00_System/AI/Claude/Roadmaps/PKM Roadmap.md", home: "02_Projects/PKM/00_Home.md", label: "PKM" },
	{ roadmap: "00_System/AI/Claude/Roadmaps/ProfileGuard Roadmap.md", home: "02_Projects/ProfileGuard/00_Home.md", label: "ProfileGuard" },
	{ roadmap: "00_System/AI/Claude/Roadmaps/_System Roadmap.md", home: null, label: "System" },
];
const AREA_HOMES = [
	"03_Areas/MatzekMedia/00_Home.md",
	"03_Areas/Savaya/00_Home.md",
	"03_Areas/CasualCosplay/00_Home.md",
	"03_Areas/PAS/00_Home.md",
];
const SYSTEM_HOME = "00_System/AI/Claude/00_Home.md";

// Nav sections
type Section = "projects" | "areas" | "system" | "capture";

export default class DashboardPlugin extends Plugin {
	async onload() {
		this.registerView(VIEW_TYPE, (leaf: WorkspaceLeaf) => new DashboardView(leaf));

		this.addRibbonIcon(ICON, "Open Dashboard", () => {
			this.activateDashboard();
		});

		this.addCommand({
			id: "open-dashboard",
			name: "Open Dashboard",
			callback: () => this.activateDashboard(),
		});
	}

	async activateDashboard() {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(VIEW_TYPE);
		if (existing.length > 0) {
			workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = workspace.getLeaf(false);
		await leaf.setViewState({ type: VIEW_TYPE, active: true });
	}
}

class DashboardView extends ItemView {
	private refreshTimer: ReturnType<typeof setTimeout> | null = null;
	private activeSection: Section = "projects";
	private captureTextarea: HTMLTextAreaElement | null = null;
	private captureDirty = false;

	getViewType(): string { return VIEW_TYPE; }
	getDisplayText(): string { return "Dashboard"; }
	getIcon(): string { return ICON; }

	async onOpen(): Promise<void> {
		this.navigation = false;
		this.contentEl.addClass("vault-dashboard");

		// Listen for vault changes — debounced refresh (skip if capture zone is being edited)
		this.registerEvent(
			this.app.metadataCache.on("resolved", () => {
				if (this.captureDirty) return;
				if (this.refreshTimer) clearTimeout(this.refreshTimer);
				this.refreshTimer = setTimeout(() => this.render(), 500);
			})
		);

		this.app.workspace.onLayoutReady(() => this.render());
	}

	async onClose(): Promise<void> {
		if (this.refreshTimer) clearTimeout(this.refreshTimer);
	}

	// ── Helpers ──────────────────────────────────────────────

	private titleFromPath(p: string): string {
		const parts = p.split("/");
		return parts.length >= 3 ? parts[parts.length - 2] : parts[0];
	}

	// Extract a section's content between a heading and the next heading/HR
	private extractSection(content: string, heading: string): string {
		const regex = new RegExp(`## ${heading}[\\s\\S]*?\\n([\\s\\S]*?)(?=\\n---\\n|\\n## |$)`, "i");
		const match = content.match(regex);
		return match ? match[1].trim() : "";
	}

	// Extract all **Label:** value lines from content
	private extractFields(content: string): Record<string, string> {
		const fields: Record<string, string> = {};
		const lines = content.split("\n");
		for (const line of lines) {
			const m = line.match(/^\*\*(.+?):\*\*\s*(.+)/);
			if (m) {
				fields[m[1].toLowerCase().trim()] = m[2].trim();
			}
		}
		return fields;
	}

	// Extract bullet list items from content
	private extractBullets(content: string): string[] {
		return content.split("\n")
			.filter(l => l.trim().startsWith("-"))
			.map(l => l.trim().replace(/^-\s*\[.\]\s*/, "").replace(/^-\s*/, ""));
	}

	// ── Render ──────────────────────────────────────────────

	private async render(): Promise<void> {
		const { contentEl } = this;

		// Preserve scroll position
		const scrollTop = contentEl.scrollTop;
		contentEl.empty();

		// Nav bar
		this.renderNavBar(contentEl);

		// Content area
		const main = contentEl.createDiv({ cls: "dash-main" });

		switch (this.activeSection) {
			case "projects":
				await this.renderProjectsPage(main);
				break;
			case "areas":
				await this.renderAreasPage(main);
				break;
			case "system":
				await this.renderSystemPage(main);
				break;
			case "capture":
				await this.renderCapturePage(main);
				break;
		}

		contentEl.scrollTop = scrollTop;
	}

	private renderNavBar(parent: HTMLElement): void {
		const nav = parent.createDiv({ cls: "dash-nav" });

		const title = nav.createDiv({ cls: "dash-nav-title" });
		title.createEl("span", { text: "Command Center" });

		const tabs = nav.createDiv({ cls: "dash-nav-tabs" });

		const sections: { id: Section; label: string; icon: string }[] = [
			{ id: "projects", label: "Roadmaps", icon: "📋" },
			{ id: "areas", label: "Areas", icon: "🏢" },
			{ id: "system", label: "System", icon: "⚙️" },
			{ id: "capture", label: "Capture", icon: "📥" },
		];

		for (const section of sections) {
			const tab = tabs.createDiv({
				cls: `dash-nav-tab ${this.activeSection === section.id ? "dash-nav-active" : ""}`,
			});
			tab.createEl("span", { text: `${section.icon} ${section.label}` });

			// Badge for capture zone item count
			if (section.id === "capture") {
				const file = this.app.vault.getFileByPath(SYSTEM_HOME);
				if (file) {
					const cache = this.app.metadataCache.getFileCache(file);
					// We'll add the badge after reading content
					this.addCaptureBadge(tab);
				}
			}

			tab.addEventListener("click", () => {
				this.activeSection = section.id;
				this.render();
			});
		}

		// No timestamp — clean nav
	}

	private async addCaptureBadge(tab: HTMLElement): Promise<void> {
		const file = this.app.vault.getFileByPath(SYSTEM_HOME);
		if (!file) return;
		const content = await this.app.vault.cachedRead(file);
		const items = this.extractCaptureItems(content);
		if (items.length > 0) {
			tab.createEl("span", { text: items.length.toString(), cls: "dash-badge-count" });
		}
	}

	private extractCaptureItems(content: string): string[] {
		const section = this.extractSection(content, "Capture Zone");
		return this.extractBullets(section);
	}

	// ── Roadmaps Page ───────────────────────────────────────

	private async renderProjectsPage(parent: HTMLElement): Promise<void> {
		parent.createEl("h2", { text: "Active Roadmaps", cls: "dash-page-title" });

		for (const rm of ROADMAPS) {
			await this.renderRoadmapCard(parent, rm);
		}
	}

	// Parse WIs from the startup table in a roadmap file
	private parseStartupTable(content: string): { id: string; status: string; summary: string }[] {
		const items: { id: string; status: string; summary: string }[] = [];
		const tableMatch = content.match(/<!-- STARTUP_START[\s\S]*?<!-- STARTUP_END -->/);
		if (!tableMatch) return items;

		const lines = tableMatch[0].split("\n");
		for (const line of lines) {
			const m = line.match(/^\|\s*([\w-]+)\s*\|\s*(\w[\w-]*)\s*\|\s*(.+?)\s*\|$/);
			if (m && m[1] !== "WI") {
				items.push({ id: m[1], status: m[2], summary: m[3] });
			}
		}
		return items;
	}

	private async renderRoadmapCard(parent: HTMLElement, rm: { roadmap: string; home: string | null; label: string }): Promise<void> {
		const roadmapFile = this.app.vault.getFileByPath(rm.roadmap);
		if (!roadmapFile) return;

		const roadmapContent = await this.app.vault.cachedRead(roadmapFile);
		const allWIs = this.parseStartupTable(roadmapContent);

		// Skip roadmaps with zero non-deferred/done items
		const liveWIs = allWIs.filter(wi => wi.status !== "deferred" && wi.status !== "done");
		if (liveWIs.length === 0) return;

		const el = parent.createDiv({ cls: "dash-card dash-card-project dash-active" });

		// Header
		const header = el.createDiv({ cls: "dash-card-header" });
		header.createEl("h3", { text: rm.label });

		// WI count chips inline in header
		const counts: Record<string, number> = {};
		for (const wi of allWIs) {
			if (wi.status === "done") continue;
			counts[wi.status] = (counts[wi.status] || 0) + 1;
		}
		const chipWrap = header.createDiv({ cls: "dash-header-chips" });
		for (const [status, count] of Object.entries(counts)) {
			if (status === "deferred") continue;
			const statusClass = status === "needs-testing" ? "testing" : status;
			chipWrap.createEl("span", {
				text: `${count} ${status}`,
				cls: `dash-inline-chip dash-chip-${statusClass}`
			});
		}

		// "Where I'm at" — read directly from roadmap's ## Where I'm At section
		const whereSection = this.extractSection(roadmapContent, "Where I'm At");
		if (whereSection) {
			const stateEl = el.createDiv({ cls: "dash-card-state" });
			stateEl.createEl("strong", { text: "Where I'm at: " });
			stateEl.createEl("span", { text: whereSection });
		}

		// Top work items — active first, then ready, then needs-testing
		const priority = ["active", "ready", "needs-testing", "blocked", "waiting"];
		const sorted = liveWIs.sort((a, b) => {
			return (priority.indexOf(a.status) ?? 99) - (priority.indexOf(b.status) ?? 99);
		});
		const topWIs = sorted.slice(0, 7);

		if (topWIs.length > 0) {
			const wiSection = el.createDiv({ cls: "dash-card-wis" });
			wiSection.createEl("span", { text: "Top Work Items", cls: "dash-field-label" });

			for (const wi of topWIs) {
				const row = wiSection.createDiv({ cls: "dash-wi-row" });
				const statusClass = wi.status === "needs-testing" ? "testing" : wi.status;
				row.createEl("span", { text: wi.id, cls: "dash-wi-id" });
				row.createEl("span", { text: wi.status, cls: `dash-wi-status dash-wis-${statusClass}` });
				row.createEl("span", { text: wi.summary, cls: "dash-wi-summary" });
			}
		}

		// Deferred count
		const deferredCount = allWIs.filter(wi => wi.status === "deferred").length;
		if (deferredCount > 0) {
			el.createEl("p", { text: `+ ${deferredCount} deferred`, cls: "dash-deferred-note" });
		}

		// Click to open roadmap
		el.addEventListener("click", () => {
			this.app.workspace.getLeaf(false).openFile(roadmapFile);
		});
	}

	// ── Areas Page ──────────────────────────────────────────

	private async renderAreasPage(parent: HTMLElement): Promise<void> {
		parent.createEl("h2", { text: "Areas", cls: "dash-page-title" });

		for (const path of AREA_HOMES) {
			await this.renderAreaCard(parent, path);
		}
	}

	private async renderAreaCard(parent: HTMLElement, filePath: string): Promise<void> {
		const file = this.app.vault.getFileByPath(filePath);
		if (!file) return;

		const content = await this.app.vault.cachedRead(file);
		const cache = this.app.metadataCache.getFileCache(file);
		const fm = cache?.frontmatter;
		const status = fm?.["status"] ?? "unknown";
		const isActive = status === "active";
		const title = this.titleFromPath(filePath);

		const el = parent.createDiv({ cls: `dash-card dash-card-area ${isActive ? "dash-active" : "dash-inactive"}` });

		const header = el.createDiv({ cls: "dash-card-header" });
		header.createEl("h3", { text: title });
		header.createEl("span", { text: status, cls: `dash-badge dash-badge-${status}` });

		const desc = fm?.["description"];
		if (desc) {
			el.createEl("p", { text: String(desc).replace(/^"|"$/g, ""), cls: "dash-card-desc" });
		}

		// Current focus
		const fields = this.extractFields(content);
		const focus = fields["current focus"] || "";
		if (focus) {
			const focusEl = el.createDiv({ cls: "dash-card-state" });
			focusEl.createEl("strong", { text: "Focus: " });
			focusEl.createEl("span", { text: focus });
		}

		// Focus bullets from "Current Focus" section
		const focusSection = this.extractSection(content, "Current Focus");
		if (focusSection) {
			const bullets = this.extractBullets(focusSection);
			if (bullets.length > 0) {
				const listEl = el.createEl("ul", { cls: "dash-card-bullets" });
				for (const b of bullets) {
					listEl.createEl("li", { text: b });
				}
			}
		}

		el.addEventListener("click", () => {
			this.app.workspace.getLeaf(false).openFile(file);
		});
	}

	// ── System Page ─────────────────────────────────────────

	private async renderSystemPage(parent: HTMLElement): Promise<void> {
		parent.createEl("h2", { text: "System Infrastructure", cls: "dash-page-title" });

		// WI counts from all roadmaps
		const roadmapFiles = this.app.vault.getFiles().filter(f =>
			f.path.startsWith("00_System/AI/Claude/Roadmaps/") && f.extension === "md"
		);

		const counts: Record<string, number> = { active: 0, "needs-testing": 0, ready: 0, blocked: 0, waiting: 0, deferred: 0 };
		for (const rf of roadmapFiles) {
			const rc = await this.app.vault.cachedRead(rf);
			for (const status of Object.keys(counts)) {
				counts[status] += (rc.match(new RegExp("`status: " + status + "`", "g")) || []).length;
			}
		}

		// Summary chips
		const chips = parent.createDiv({ cls: "dash-card-counts dash-system-counts" });
		this.addCount(chips, counts["active"].toString(), "active", "dash-count-active");
		this.addCount(chips, counts["needs-testing"].toString(), "testing", "dash-count-testing");
		this.addCount(chips, counts["ready"].toString(), "ready", "dash-count-ready");
		this.addCount(chips, counts["waiting"].toString(), "waiting", "dash-count-waiting");
		this.addCount(chips, counts["deferred"].toString(), "deferred", "dash-count-deferred");

		// System card from 00_Home
		const sysFile = this.app.vault.getFileByPath(SYSTEM_HOME);
		if (sysFile) {
			const content = await this.app.vault.cachedRead(sysFile);
			const systemSection = this.extractSection(content, "System");
			if (systemSection) {
				const fields = this.extractFields(systemSection);
				const state = fields["current state"];
				if (state) {
					const stateCard = parent.createDiv({ cls: "dash-card dash-card-system dash-active" });
					const stateEl = stateCard.createDiv({ cls: "dash-card-state" });
					stateEl.createEl("span", { text: state });
				}

				// Apps
				const apps = fields["apps"];
				if (apps) {
					const appsCard = parent.createDiv({ cls: "dash-card dash-card-system dash-active" });
					const appsHeader = appsCard.createDiv({ cls: "dash-card-header" });
					appsHeader.createEl("h3", { text: "Apps & Tools" });
					appsCard.createEl("p", { text: apps, cls: "dash-card-desc" });
				}
			}
		}

		// Per-roadmap breakdown
		for (const rf of roadmapFiles) {
			const rc = await this.app.vault.cachedRead(rf);
			const roadmapTitle = rf.basename.replace(" Roadmap", "").replace("_", "");

			// Count active WIs in this file
			const activeInFile = (rc.match(/`status: active`/g) || []).length;
			const testingInFile = (rc.match(/`status: needs-testing`/g) || []).length;
			const readyInFile = (rc.match(/`status: ready`/g) || []).length;

			if (activeInFile + testingInFile + readyInFile === 0) continue;

			const card = parent.createDiv({ cls: "dash-card dash-card-system dash-active" });
			const header = card.createDiv({ cls: "dash-card-header" });
			header.createEl("h3", { text: roadmapTitle });

			const mini = card.createDiv({ cls: "dash-card-counts" });
			if (activeInFile > 0) this.addCount(mini, activeInFile.toString(), "active", "dash-count-active");
			if (testingInFile > 0) this.addCount(mini, testingInFile.toString(), "testing", "dash-count-testing");
			if (readyInFile > 0) this.addCount(mini, readyInFile.toString(), "ready", "dash-count-ready");

			card.addEventListener("click", () => {
				this.app.workspace.getLeaf(false).openFile(rf);
			});
			card.style.cursor = "pointer";
		}
	}

	private addCount(parent: HTMLElement, value: string, label: string, cls: string): void {
		const el = parent.createDiv({ cls: `dash-count ${cls}` });
		el.createEl("span", { text: value, cls: "dash-count-value" });
		el.createEl("span", { text: label, cls: "dash-count-label" });
	}

	// ── Capture Page ────────────────────────────────────────

	private async renderCapturePage(parent: HTMLElement): Promise<void> {
		parent.createEl("h2", { text: "Capture Zone", cls: "dash-page-title" });

		const file = this.app.vault.getFileByPath(SYSTEM_HOME);
		if (!file) {
			parent.createEl("p", { text: "Could not find 00_Home.md" });
			return;
		}

		const content = await this.app.vault.cachedRead(file);
		const captureSection = this.extractSection(content, "Capture Zone");

		// Editable textarea
		const editorWrap = parent.createDiv({ cls: "dash-capture-editor" });

		const helpText = editorWrap.createEl("p", { cls: "dash-capture-help" });
		helpText.setText("Edit the capture zone below. Use markdown bullet syntax (- item). Changes save to 00_Home.md.");

		this.captureTextarea = editorWrap.createEl("textarea", { cls: "dash-capture-textarea" });
		this.captureTextarea.value = captureSection;
		this.captureTextarea.rows = Math.max(10, captureSection.split("\n").length + 3);
		this.captureTextarea.placeholder = "- New capture item\n- Another item";

		// Track dirty state
		this.captureTextarea.addEventListener("input", () => {
			this.captureDirty = true;
		});

		// Button bar
		const buttons = editorWrap.createDiv({ cls: "dash-capture-buttons" });

		const saveBtn = buttons.createEl("button", { text: "Save", cls: "dash-btn dash-btn-primary" });
		saveBtn.addEventListener("click", async () => {
			await this.saveCaptureZone();
		});

		const cancelBtn = buttons.createEl("button", { text: "Cancel", cls: "dash-btn" });
		cancelBtn.addEventListener("click", () => {
			this.captureDirty = false;
			this.render();
		});

		// Also render current items as a preview list
		const items = this.extractBullets(captureSection);
		if (items.length > 0) {
			const preview = parent.createDiv({ cls: "dash-capture-preview" });
			preview.createEl("h3", { text: `Current Items (${items.length})` });
			const list = preview.createEl("ul");
			for (const item of items) {
				list.createEl("li", { text: item });
			}
		}
	}

	private async saveCaptureZone(): Promise<void> {
		if (!this.captureTextarea) return;

		const file = this.app.vault.getFileByPath(SYSTEM_HOME);
		if (!file || !(file instanceof TFile)) return;

		const content = await this.app.vault.read(file);
		const newCapture = this.captureTextarea.value;

		// Count items for the counter line
		const itemCount = newCapture.split("\n").filter(l => l.trim().startsWith("-")).length;
		const counterLine = `*${itemCount} item${itemCount !== 1 ? "s" : ""} pending.*`;

		// Replace the capture zone section
		const updated = content.replace(
			/## Capture Zone[\s\S]*?(?=\n---\n|\n## )/,
			`## Capture Zone\n\n${counterLine}\n\n${newCapture}\n\n`
		);

		await this.app.vault.modify(file, updated);
		this.captureDirty = false;
		// Render will be triggered by the vault change event
	}
}
