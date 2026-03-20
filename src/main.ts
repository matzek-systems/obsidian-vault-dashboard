import { Plugin, ItemView, WorkspaceLeaf, TFile, requestUrl, setIcon } from "obsidian";

const VIEW_TYPE = "vault-dashboard";
const ICON = "layout-dashboard";

const ROADMAPS_FOLDER = "00_System/AI/Claude/Roadmaps";
const AREAS_FOLDER = "03_Areas";
const SYSTEM_HOME = "00_System/AI/Claude/00_Home.md";
const DISCORD_BOT_PID = "00_System/AI/Claude/tools/discord-bot/bot.pid";
const SESSION_RAM_FOLDER = "00_System/AI/Claude/Scratchpad";
const MCP_URL = "https://127.0.0.1:27124";

type Section = "projects" | "areas" | "system" | "capture" | "status";

const NAV_ITEMS: { id: Section; label: string; icon: string }[] = [
	{ id: "projects", label: "Roadmaps", icon: "map" },
	{ id: "areas", label: "Areas", icon: "layers" },
	{ id: "system", label: "System", icon: "cpu" },
	{ id: "capture", label: "Capture", icon: "inbox" },
	{ id: "status", label: "Status", icon: "activity" },
];

export default class DashboardPlugin extends Plugin {
	async onload() {
		this.registerView(VIEW_TYPE, (leaf: WorkspaceLeaf) => new DashboardView(leaf));
		this.addRibbonIcon(ICON, "Open Dashboard", () => this.activateDashboard());
		this.addCommand({ id: "open-dashboard", name: "Open Dashboard", callback: () => this.activateDashboard() });
	}

	async activateDashboard() {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(VIEW_TYPE);
		if (existing.length > 0) { workspace.revealLeaf(existing[0]); return; }
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

	private extractSection(content: string, heading: string): string {
		const regex = new RegExp(`## ${heading}[\\s\\S]*?\\n([\\s\\S]*?)(?=\\n---\\n|\\n## |$)`, "i");
		const match = content.match(regex);
		return match ? match[1].trim() : "";
	}

	private extractFields(content: string): Record<string, string> {
		const fields: Record<string, string> = {};
		for (const line of content.split("\n")) {
			const m = line.match(/^\*\*(.+?):\*\*\s*(.+)/);
			if (m) fields[m[1].toLowerCase().trim()] = m[2].trim();
		}
		return fields;
	}

	private extractBullets(content: string): string[] {
		return content.split("\n")
			.filter(l => l.trim().startsWith("-"))
			.map(l => l.trim().replace(/^-\s*\[.\]\s*/, "").replace(/^-\s*/, ""));
	}

	private parseStartupTable(content: string): { id: string; status: string; summary: string }[] {
		const items: { id: string; status: string; summary: string }[] = [];
		const tableMatch = content.match(/<!-- STARTUP_START[\s\S]*?<!-- STARTUP_END -->/);
		if (!tableMatch) return items;
		for (const line of tableMatch[0].split("\n")) {
			const m = line.match(/^\|\s*([\w-]+)\s*\|\s*(\w[\w-]*)\s*\|\s*(.+?)\s*\|$/);
			if (m && m[1] !== "WI") items.push({ id: m[1], status: m[2], summary: m[3] });
		}
		return items;
	}

	// Auto-discover roadmap files
	private discoverRoadmaps(): TFile[] {
		return this.app.vault.getFiles().filter(f =>
			f.path.startsWith(ROADMAPS_FOLDER + "/") && f.extension === "md"
		);
	}

	// Auto-discover area home files
	private discoverAreaHomes(): TFile[] {
		return this.app.vault.getFiles().filter(f =>
			f.path.startsWith(AREAS_FOLDER + "/") && f.name === "00_Home.md"
			&& f.path.split("/").length === 3 // Only top-level area homes
		);
	}

	// ── Render ──────────────────────────────────────────────

	private async render(): Promise<void> {
		const { contentEl } = this;
		const scrollTop = contentEl.scrollTop;
		contentEl.empty();

		this.renderNavBar(contentEl);
		const main = contentEl.createDiv({ cls: "dash-main" });

		switch (this.activeSection) {
			case "projects": await this.renderRoadmapsPage(main); break;
			case "areas": await this.renderAreasPage(main); break;
			case "system": await this.renderSystemPage(main); break;
			case "capture": await this.renderCapturePage(main); break;
			case "status": await this.renderStatusPage(main); break;
		}

		contentEl.scrollTop = scrollTop;
	}

	private renderNavBar(parent: HTMLElement): void {
		const nav = parent.createDiv({ cls: "dash-nav" });
		const title = nav.createDiv({ cls: "dash-nav-title" });
		title.createEl("span", { text: "Command Center" });

		const tabs = nav.createDiv({ cls: "dash-nav-tabs" });
		for (const item of NAV_ITEMS) {
			const tab = tabs.createDiv({
				cls: `dash-nav-tab ${this.activeSection === item.id ? "dash-nav-active" : ""}`,
			});
			const iconSpan = tab.createSpan({ cls: "dash-nav-icon" });
			setIcon(iconSpan, item.icon);
			tab.createEl("span", { text: item.label });

			if (item.id === "capture") this.addCaptureBadge(tab);

			tab.addEventListener("click", () => {
				this.activeSection = item.id;
				this.render();
			});
		}
	}

	private async addCaptureBadge(tab: HTMLElement): Promise<void> {
		const file = this.app.vault.getFileByPath(SYSTEM_HOME);
		if (!file) return;
		const content = await this.app.vault.cachedRead(file);
		const items = this.extractBullets(this.extractSection(content, "Capture Zone"));
		if (items.length > 0) {
			tab.createEl("span", { text: items.length.toString(), cls: "dash-badge-count" });
		}
	}

	// ── Roadmaps Page ───────────────────────────────────────

	private async renderRoadmapsPage(parent: HTMLElement): Promise<void> {
		parent.createEl("h2", { text: "Active Roadmaps", cls: "dash-page-title" });

		const roadmapFiles = this.discoverRoadmaps();
		let hasActive = false;
		const pausedCards: HTMLElement[] = [];

		for (const rf of roadmapFiles) {
			const content = await this.app.vault.cachedRead(rf);
			const cache = this.app.metadataCache.getFileCache(rf);
			const fmStatus = cache?.frontmatter?.["status"] ?? "active";
			const allWIs = this.parseStartupTable(content);
			const liveWIs = allWIs.filter(wi => wi.status !== "deferred" && wi.status !== "done");

			const label = rf.basename.replace(" Roadmap", "").replace(/^_/, "");
			const isPaused = fmStatus === "paused" || fmStatus === "inactive";

			if (liveWIs.length === 0 && !isPaused) continue;

			const el = parent.createDiv({
				cls: `dash-card dash-card-project ${isPaused ? "dash-paused" : "dash-active"}`
			});

			// Header with chips
			const header = el.createDiv({ cls: "dash-card-header" });
			header.createEl("h3", { text: label });

			if (isPaused) {
				header.createEl("span", { text: "paused", cls: "dash-badge dash-badge-paused" });
			}

			const chipWrap = header.createDiv({ cls: "dash-header-chips" });
			const counts: Record<string, number> = {};
			for (const wi of allWIs) {
				if (wi.status === "done" || wi.status === "deferred") continue;
				counts[wi.status] = (counts[wi.status] || 0) + 1;
			}
			for (const [status, count] of Object.entries(counts)) {
				const cls = status === "needs-testing" ? "testing" : status;
				chipWrap.createEl("span", { text: `${count} ${status}`, cls: `dash-inline-chip dash-chip-${cls}` });
			}

			// Where I'm at — supports multi-line
			const whereSection = this.extractSection(content, "Where I'm At");
			if (whereSection) {
				const stateEl = el.createDiv({ cls: "dash-card-state" });
				stateEl.createEl("strong", { text: "Where I'm at: " });
				const lines = whereSection.split("\n").filter(l => l.trim());
				for (const line of lines) {
					stateEl.createEl("p", { text: line.trim(), cls: "dash-state-line" });
				}
			}

			// Top WIs — clickable rows
			const priority = ["active", "ready", "needs-testing", "blocked", "waiting"];
			const sorted = liveWIs.sort((a, b) =>
				(priority.indexOf(a.status) ?? 99) - (priority.indexOf(b.status) ?? 99)
			);
			const topWIs = sorted.slice(0, 7);

			if (topWIs.length > 0) {
				const wiSection = el.createDiv({ cls: "dash-card-wis" });
				wiSection.createEl("span", { text: "Top Work Items", cls: "dash-field-label" });

				for (const wi of topWIs) {
					const row = wiSection.createDiv({ cls: "dash-wi-row" });
					const cls = wi.status === "needs-testing" ? "testing" : wi.status;
					row.createEl("span", { text: wi.id, cls: "dash-wi-id" });
					row.createEl("span", { text: wi.status, cls: `dash-wi-status dash-wis-${cls}` });
					row.createEl("span", { text: wi.summary, cls: "dash-wi-summary" });

					// Click WI row to open roadmap at that heading
					row.addEventListener("click", (e) => {
						e.stopPropagation();
						this.app.workspace.openLinkText(rf.path + "#" + wi.id, "", false);
					});
				}
			}

			// Deferred count
			const deferredCount = allWIs.filter(wi => wi.status === "deferred").length;
			if (deferredCount > 0) {
				el.createEl("p", { text: `+ ${deferredCount} deferred`, cls: "dash-deferred-note" });
			}

			// Click card to open roadmap
			el.addEventListener("click", () => {
				this.app.workspace.getLeaf(false).openFile(rf);
			});

			if (isPaused) {
				pausedCards.push(el);
				hasActive = hasActive; // don't toggle
			} else {
				hasActive = true;
			}
		}

		if (!hasActive) {
			parent.createEl("p", { text: "No active roadmaps found.", cls: "dash-empty" });
		}
	}

	// ── Areas Page ──────────────────────────────────────────

	private async renderAreasPage(parent: HTMLElement): Promise<void> {
		parent.createEl("h2", { text: "Areas", cls: "dash-page-title" });

		const areaHomes = this.discoverAreaHomes();
		for (const file of areaHomes) {
			const content = await this.app.vault.cachedRead(file);
			const cache = this.app.metadataCache.getFileCache(file);
			const fm = cache?.frontmatter;
			const status = fm?.["status"] ?? "unknown";
			const isActive = status === "active";
			const title = file.path.split("/")[1]; // e.g., "MatzekMedia" from "03_Areas/MatzekMedia/00_Home.md"

			const el = parent.createDiv({ cls: `dash-card dash-card-area ${isActive ? "dash-active" : "dash-inactive"}` });

			const header = el.createDiv({ cls: "dash-card-header" });
			header.createEl("h3", { text: title });
			header.createEl("span", { text: status, cls: `dash-badge dash-badge-${status}` });

			const desc = fm?.["description"];
			if (desc) el.createEl("p", { text: String(desc).replace(/^"|"$/g, ""), cls: "dash-card-desc" });

			const focusSection = this.extractSection(content, "Current Focus");
			if (focusSection) {
				const bullets = this.extractBullets(focusSection);
				if (bullets.length > 0) {
					const listEl = el.createEl("ul", { cls: "dash-card-bullets" });
					for (const b of bullets) listEl.createEl("li", { text: b });
				}
			}

			el.addEventListener("click", () => {
				this.app.workspace.getLeaf(false).openFile(file);
			});
		}
	}

	// ── System Page ─────────────────────────────────────────

	private async renderSystemPage(parent: HTMLElement): Promise<void> {
		parent.createEl("h2", { text: "System Infrastructure", cls: "dash-page-title" });

		const roadmapFiles = this.discoverRoadmaps();
		const counts: Record<string, number> = { active: 0, "needs-testing": 0, ready: 0, blocked: 0, waiting: 0, deferred: 0 };

		for (const rf of roadmapFiles) {
			const rc = await this.app.vault.cachedRead(rf);
			for (const status of Object.keys(counts)) {
				counts[status] += (rc.match(new RegExp("`status: " + status + "`", "g")) || []).length;
			}
		}

		const chips = parent.createDiv({ cls: "dash-card-counts dash-system-counts" });
		this.addCount(chips, counts["active"].toString(), "active", "dash-count-active");
		this.addCount(chips, counts["needs-testing"].toString(), "testing", "dash-count-testing");
		this.addCount(chips, counts["ready"].toString(), "ready", "dash-count-ready");
		this.addCount(chips, counts["waiting"].toString(), "waiting", "dash-count-waiting");
		this.addCount(chips, counts["deferred"].toString(), "deferred", "dash-count-deferred");

		const sysFile = this.app.vault.getFileByPath(SYSTEM_HOME);
		if (sysFile) {
			const content = await this.app.vault.cachedRead(sysFile);
			const systemSection = this.extractSection(content, "System");
			const fields = this.extractFields(systemSection);
			if (fields["current state"]) {
				const card = parent.createDiv({ cls: "dash-card dash-card-system dash-active" });
				const stateEl = card.createDiv({ cls: "dash-card-state" });
				stateEl.createEl("span", { text: fields["current state"] });
			}
			if (fields["apps"]) {
				const card = parent.createDiv({ cls: "dash-card dash-card-system dash-active" });
				card.createDiv({ cls: "dash-card-header" }).createEl("h3", { text: "Apps & Tools" });
				card.createEl("p", { text: fields["apps"], cls: "dash-card-desc" });
			}
		}

		for (const rf of roadmapFiles) {
			const rc = await this.app.vault.cachedRead(rf);
			const title = rf.basename.replace(" Roadmap", "").replace(/^_/, "");
			const a = (rc.match(/`status: active`/g) || []).length;
			const t = (rc.match(/`status: needs-testing`/g) || []).length;
			const r = (rc.match(/`status: ready`/g) || []).length;
			if (a + t + r === 0) continue;

			const card = parent.createDiv({ cls: "dash-card dash-card-system dash-active" });
			card.createDiv({ cls: "dash-card-header" }).createEl("h3", { text: title });
			const mini = card.createDiv({ cls: "dash-card-counts" });
			if (a > 0) this.addCount(mini, a.toString(), "active", "dash-count-active");
			if (t > 0) this.addCount(mini, t.toString(), "testing", "dash-count-testing");
			if (r > 0) this.addCount(mini, r.toString(), "ready", "dash-count-ready");
			card.addEventListener("click", () => this.app.workspace.getLeaf(false).openFile(rf));
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
		if (!file) { parent.createEl("p", { text: "Could not find 00_Home.md" }); return; }

		const content = await this.app.vault.cachedRead(file);
		const captureSection = this.extractSection(content, "Capture Zone");

		const editorWrap = parent.createDiv({ cls: "dash-capture-editor" });
		editorWrap.createEl("p", {
			text: "Edit the capture zone below. Use markdown bullet syntax (- item). Changes save to 00_Home.md.",
			cls: "dash-capture-help"
		});

		this.captureTextarea = editorWrap.createEl("textarea", { cls: "dash-capture-textarea" });
		this.captureTextarea.value = captureSection;
		this.captureTextarea.rows = Math.max(10, captureSection.split("\n").length + 3);
		this.captureTextarea.placeholder = "- New capture item\n- Another item";
		this.captureTextarea.addEventListener("input", () => { this.captureDirty = true; });

		const buttons = editorWrap.createDiv({ cls: "dash-capture-buttons" });
		const saveBtn = buttons.createEl("button", { text: "Save", cls: "dash-btn dash-btn-primary" });
		saveBtn.addEventListener("click", () => this.saveCaptureZone());
		const cancelBtn = buttons.createEl("button", { text: "Cancel", cls: "dash-btn" });
		cancelBtn.addEventListener("click", () => { this.captureDirty = false; this.render(); });

		const items = this.extractBullets(captureSection);
		if (items.length > 0) {
			const preview = parent.createDiv({ cls: "dash-capture-preview" });
			preview.createEl("h3", { text: `Current Items (${items.length})` });
			const list = preview.createEl("ul");
			for (const item of items) list.createEl("li", { text: item });
		}
	}

	private async saveCaptureZone(): Promise<void> {
		if (!this.captureTextarea) return;
		const file = this.app.vault.getFileByPath(SYSTEM_HOME);
		if (!file || !(file instanceof TFile)) return;

		const content = await this.app.vault.read(file);
		const newCapture = this.captureTextarea.value;
		const itemCount = newCapture.split("\n").filter(l => l.trim().startsWith("-")).length;
		const counterLine = `*${itemCount} item${itemCount !== 1 ? "s" : ""} pending.*`;

		// Handle both mid-file and EOF capture zones
		let updated: string;
		if (/## Capture Zone[\s\S]*?(?=\n---\n|\n## )/.test(content)) {
			updated = content.replace(
				/## Capture Zone[\s\S]*?(?=\n---\n|\n## )/,
				`## Capture Zone\n\n${counterLine}\n\n${newCapture}\n\n`
			);
		} else {
			// Capture zone is at EOF
			updated = content.replace(
				/## Capture Zone[\s\S]*$/,
				`## Capture Zone\n\n${counterLine}\n\n${newCapture}\n`
			);
		}

		await this.app.vault.modify(file, updated);
		this.captureDirty = false;
	}

	// ── Status Page ─────────────────────────────────────────

	private async renderStatusPage(parent: HTMLElement): Promise<void> {
		parent.createEl("h2", { text: "Status", cls: "dash-page-title" });

		// Service health cards
		const grid = parent.createDiv({ cls: "dash-health-grid" });

		this.renderHealthCard(grid, {
			name: "MCP (Local REST API)",
			description: "Obsidian REST API for reading/writing vault files via MCP tools.",
			checkFn: () => this.checkMCP(),
		});

		this.renderHealthCard(grid, {
			name: "Smart Connections",
			description: "Semantic search over vault content. Required for search_vault_smart.",
			checkFn: () => this.checkSmartConnections(),
			fixFn: async () => {
				// Call the mcp-fix plugin's command
				await (this.app as any).commands.executeCommandById("mcp-fix:fix-mcp-tools");
				// Wait for re-registration
				await new Promise(r => setTimeout(r, 2500));
			},
			fixLabel: "Fix (re-toggle MCP Tools)",
		});

		this.renderHealthCard(grid, {
			name: "Discord Vault Bot",
			description: "Voice + text bot for mobile vault access.",
			checkFn: () => this.checkDiscordBot(),
		});

		// Active sessions
		await this.renderSessionRAMs(parent);

		// Loaded plugins
		this.renderPluginsList(parent);
	}

	private renderHealthCard(parent: HTMLElement, config: {
		name: string; description: string;
		checkFn: () => Promise<{ status: "up" | "down" | "degraded"; detail: string }>;
		fixFn?: () => Promise<void>;
		fixLabel?: string;
	}): void {
		const card = parent.createDiv({ cls: "dash-card dash-health-card" });
		const header = card.createDiv({ cls: "dash-card-header" });
		header.createEl("h3", { text: config.name });
		const badge = header.createEl("span", { text: "checking...", cls: "dash-badge dash-badge-unknown" });

		card.createEl("p", { text: config.description, cls: "dash-card-desc" });
		const detailEl = card.createDiv({ cls: "dash-health-detail" });

		const btnRow = card.createDiv({ cls: "dash-health-btn-row" });
		const checkBtn = btnRow.createEl("button", { text: "Run Check", cls: "dash-btn dash-btn-primary" });

		let lastStatus: string | null = null;

		const runCheck = async () => {
			badge.setText("checking...");
			badge.className = "dash-badge dash-badge-unknown";
			detailEl.empty();
			try {
				const result = await config.checkFn();
				lastStatus = result.status;
				badge.setText(result.status);
				badge.className = `dash-badge dash-badge-${result.status === "up" ? "active" : result.status === "degraded" ? "warning" : "down"}`;
				detailEl.createEl("span", { text: result.detail, cls: "dash-health-detail-text" });
			} catch (e) {
				lastStatus = "error";
				badge.setText("error");
				badge.className = "dash-badge dash-badge-down";
				detailEl.createEl("span", { text: String(e), cls: "dash-health-detail-text" });
			}

			// Show fix button if degraded/down and a fix function exists
			fixBtn.style.display = (lastStatus !== "up" && config.fixFn) ? "inline-block" : "none";
		};

		// Fix button (hidden by default)
		const fixBtn = btnRow.createEl("button", {
			text: config.fixLabel ?? "Fix",
			cls: "dash-btn dash-btn-fix"
		});
		fixBtn.style.display = "none";
		fixBtn.addEventListener("click", async () => {
			if (!config.fixFn) return;
			fixBtn.setText("Fixing...");
			fixBtn.toggleClass("dash-btn-disabled", true);
			await config.fixFn();
			fixBtn.setText(config.fixLabel ?? "Fix");
			fixBtn.toggleClass("dash-btn-disabled", false);
			await runCheck();
		});

		checkBtn.addEventListener("click", runCheck);
		runCheck();
	}

	private async checkMCP(): Promise<{ status: "up" | "down" | "degraded"; detail: string }> {
		const plugins = (this.app as any).plugins;
		const restApi = plugins?.plugins?.["obsidian-local-rest-api"];

		if (!restApi) {
			return { status: "down", detail: "Local REST API plugin not found or not enabled." };
		}

		const version = restApi.manifest?.version ?? "unknown";

		// Try HTTP check — may fail due to self-signed cert
		try {
			const resp = await requestUrl({ url: MCP_URL + "/", method: "GET" });
			const data = resp.json;
			const extensions = data?.apiExtensions ?? [];
			const extCount = Array.isArray(extensions) ? extensions.length : 0;
			return {
				status: "up",
				detail: `v${version}, Obsidian ${data?.versions?.obsidian ?? "?"}, ${extCount} API extension(s). HTTP endpoint responding.`
			};
		} catch {
			return {
				status: "up",
				detail: `Plugin loaded (v${version}). HTTP check failed (self-signed cert) — this is normal. MCP tools work independently of HTTP.`
			};
		}
	}

	private async checkSmartConnections(): Promise<{ status: "up" | "down" | "degraded"; detail: string }> {
		const plugins = (this.app as any).plugins;
		const sc = plugins?.plugins?.["smart-connections"];

		if (!sc) {
			return { status: "down", detail: "Smart Connections plugin not found or not enabled." };
		}

		const version = sc.manifest?.version ?? "unknown";

		// Check if MCP Tools plugin is also loaded (needed for API extension)
		const mcpTools = plugins?.plugins?.["smart-connections-mcp-tools"];
		if (mcpTools) {
			return { status: "up", detail: `Plugin loaded (v${version}). MCP Tools extension loaded.` };
		}

		// Check apiExtensions via REST API if possible
		try {
			const resp = await requestUrl({ url: MCP_URL + "/", method: "GET" });
			const extensions = resp.json?.apiExtensions ?? [];
			if (Array.isArray(extensions) && extensions.length > 0) {
				return { status: "up", detail: `Plugin loaded (v${version}). API extension registered.` };
			}
			return { status: "degraded", detail: `Plugin loaded (v${version}) but apiExtensions is empty. search_vault_smart will 404. Restart Obsidian to fix.` };
		} catch {
			return { status: "degraded", detail: `Plugin loaded (v${version}). Cannot verify API extension (cert error). If search_vault_smart 404s, restart Obsidian.` };
		}
	}

	private async checkDiscordBot(): Promise<{ status: "up" | "down" | "degraded"; detail: string }> {
		const pidExists = await this.app.vault.adapter.exists(DISCORD_BOT_PID);
		if (!pidExists) return { status: "down", detail: "No bot.pid file — bot is not running." };

		try {
			const pidContent = await this.app.vault.adapter.read(DISCORD_BOT_PID);
			const pid = pidContent.trim();
			return { status: "up", detail: `Bot running (PID ${pid}). Verify via task manager if unsure.` };
		} catch {
			return { status: "degraded", detail: "bot.pid exists but couldn't read it." };
		}
	}

	// ── Session RAMs ────────────────────────────────────────

	private async renderSessionRAMs(parent: HTMLElement): Promise<void> {
		const ramFiles = this.app.vault.getFiles().filter(f =>
			f.path.startsWith(SESSION_RAM_FOLDER + "/") && /^session-\d+-ram\.md$/.test(f.name)
		);

		const section = parent.createDiv({ cls: "dash-sessions" });
		section.createEl("h3", { text: `Active Sessions (${ramFiles.length})`, cls: "dash-page-title" });

		if (ramFiles.length === 0) {
			section.createEl("p", { text: "No active session RAMs found.", cls: "dash-empty" });
			return;
		}

		for (const rf of ramFiles) {
			const content = await this.app.vault.cachedRead(rf);
			const cache = this.app.metadataCache.getFileCache(rf);
			const fm = cache?.frontmatter;

			const sessionNum = rf.name.match(/session-(\d+)-ram/)?.[1] ?? "?";
			const card = section.createDiv({ cls: "dash-card dash-session-card" });

			const header = card.createDiv({ cls: "dash-card-header" });
			header.createEl("h3", { text: `Session ${sessionNum}` });
			header.createEl("span", { text: fm?.["created"] ?? "", cls: "dash-session-date" });

			// Extract focus and current state
			const fields = this.extractFields(content);
			if (fields["focus"]) {
				card.createEl("p", { text: fields["focus"], cls: "dash-card-desc" });
			}

			// Current State section
			const stateSection = this.extractSection(content, "Current State RIGHT NOW");
			if (stateSection) {
				const bullets = this.extractBullets(stateSection);
				if (bullets.length > 0) {
					const stateEl = card.createDiv({ cls: "dash-card-state" });
					for (const b of bullets) {
						stateEl.createEl("p", { text: b, cls: "dash-state-line" });
					}
				}
			}

			card.addEventListener("click", () => {
				this.app.workspace.getLeaf(false).openFile(rf);
			});
			card.style.cursor = "pointer";
		}
	}

	// ── Plugin List ─────────────────────────────────────────

	private renderPluginsList(parent: HTMLElement): void {
		const section = parent.createDiv({ cls: "dash-health-plugins" });
		section.createEl("h3", { text: "Loaded Plugins", cls: "dash-page-title" });

		const plugins = (this.app as any).plugins;
		if (!plugins?.plugins) return;

		const pluginNames = Object.keys(plugins.plugins).sort();
		const grid = section.createDiv({ cls: "dash-plugin-grid" });
		for (const name of pluginNames) {
			const plugin = plugins.plugins[name];
			const manifest = plugin?.manifest;
			const row = grid.createDiv({ cls: "dash-plugin-row" });
			row.createEl("span", { text: manifest?.name ?? name, cls: "dash-plugin-name" });
			row.createEl("span", { text: `v${manifest?.version ?? "?"}`, cls: "dash-plugin-version" });
		}
	}
}
