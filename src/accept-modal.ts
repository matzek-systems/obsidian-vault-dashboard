// ── INBOX "Accept" modal (v5, SYS-485 schema 4 / SYS-395) ─────────────
// Roadmap select (defaults to the row's lane roadmap), title (prefilled
// from the heading, editable), done_when (required). Pure UI -- collects
// the three fields and hands them back via onSubmit; operator-panel.ts owns
// the actual next-wi-id.py / apply-roadmap-action.py execFile calls and the
// 00_Home.md marker-append, same file-access-stays-in-operator-panel rule
// as the rest of this plugin's Obsidian-facing glue.

import { App, Modal, Setting, Notice } from "obsidian";

export interface AcceptResult {
	roadmapFile: string; // basename incl. extension, e.g. "SomaGuard Roadmap.md"
	title: string;
	doneWhen: string;
}

export class AcceptModal extends Modal {
	private roadmaps: string[];
	private defaultRoadmap: string;
	private titlePrefill: string;
	private onSubmit: (r: AcceptResult) => void;

	constructor(app: App, roadmaps: string[], defaultRoadmap: string, titlePrefill: string, onSubmit: (r: AcceptResult) => void) {
		super(app);
		this.roadmaps = roadmaps;
		this.defaultRoadmap = roadmaps.includes(defaultRoadmap) ? defaultRoadmap : (roadmaps[0] || defaultRoadmap);
		this.titlePrefill = titlePrefill;
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Accept into a WI" });

		let roadmapFile = this.defaultRoadmap;
		let title = this.titlePrefill;
		let doneWhen = "";

		new Setting(contentEl)
			.setName("Roadmap")
			.addDropdown((d) => {
				if (!this.roadmaps.length) d.addOption("", "(no roadmaps found)");
				for (const r of this.roadmaps) d.addOption(r, r.replace(" Roadmap.md", ""));
				d.setValue(roadmapFile);
				d.onChange((v) => { roadmapFile = v; });
			});

		new Setting(contentEl)
			.setName("Title")
			.addText((t) => {
				t.setValue(title);
				t.inputEl.style.width = "100%";
				t.onChange((v) => { title = v; });
			});

		new Setting(contentEl)
			.setName("Done when")
			.setDesc("Required — one observable completion criterion (outputs exist / tests pass / behavior demonstrable).")
			.addText((t) => {
				t.inputEl.style.width = "100%";
				t.onChange((v) => { doneWhen = v; });
			});

		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => b
				.setButtonText("Create WI")
				.setCta()
				.onClick(() => {
					if (!roadmapFile) { new Notice("no roadmap selected"); return; }
					if (!title.trim()) { new Notice("title is required"); return; }
					if (!doneWhen.trim()) { new Notice("done_when is required"); return; }
					this.close();
					this.onSubmit({ roadmapFile, title: title.trim(), doneWhen: doneWhen.trim() });
				}));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
