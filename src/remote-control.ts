/**
 * Remote (SYS-497, DL-689, session 942): the dashboard plugin owns the phone app's server.
 *
 *  - Lifecycle: `runLauncher` spawns remote-server/launch.py from the plugin's own folder
 *    (--restart on plugin load so the server always runs the code on disk, --stop on unload /
 *    Obsidian quit), with VAULT_PATH in the environment so the server finds the vault. Obsidian
 *    is the runtime; the community-plugin toggle is the reboot; Processes keeps a Restart.
 *  - Control channel: `ControlSocket` is a loopback HTTP server (127.0.0.1:<port>, token in
 *    %LOCALAPPDATA%/vault-remote/control-token) that runs the pane operations the phone server
 *    needs (panes / focus / send / keys / screen / resume / new) in-process, instead of an
 *    `obsidian eval` CLI spawn per action (~300 ms -> a few ms). remote-server/seat_bridge.py
 *    tries this first and falls back to `obsidian eval` when the socket is not there.
 *
 *  The server itself stays a separate supervised process: a renderer freeze (the SYS-491
 *  family) is exactly when the phone must keep answering, so it keeps its own failure domain.
 */
import { App } from "obsidian";
import { spawn } from "child_process";
import * as http from "http";
import { randomBytes } from "crypto";
import { mkdirSync, unlinkSync, writeFileSync } from "fs";

const LAUNCHER = "remote-server/launch.py";
const WS_VIEW = "workspace-shell";
const MAX_BODY = 64 * 1024;

export interface RemoteHost {
	app: App;
	pythonCmd: string;
	vaultPath: string;   // the vault root, forward slashes
	claudeDir: string;   // <vault>/00_System/AI/Claude, forward slashes
	pluginDir: string;   // <vault>/.obsidian/plugins/vault-dashboard, forward slashes
}

export type LauncherMode = "--ensure" | "--restart" | "--stop";

function stateDir(): string {
	const base = process.env.LOCALAPPDATA || process.env.HOME || ".";
	return `${base.replace(/\\/g, "/")}/vault-remote`;
}

/** Detached so a slow --ensure (Tailscale wake-up) never blocks the renderer, and so a
 *  --stop spawned from onunload survives Obsidian quitting. */
export function runLauncher(host: RemoteHost, mode: LauncherMode): boolean {
	try {
		const child = spawn(host.pythonCmd || "python", [`${host.pluginDir}/${LAUNCHER}`, mode],
			{ cwd: host.pluginDir, detached: true, stdio: "ignore", windowsHide: true,
			  env: { ...process.env, VAULT_PATH: host.vaultPath } });
		child.unref();
		return true;
	} catch (e) {
		console.warn("[vault-dashboard] remote launcher failed", mode, e);
		return false;
	}
}

interface OpBody {
	op?: string;
	handle?: string;
	text?: string;
	enter?: boolean;
	seq?: string;
	rows?: number;
	uuid?: string;
	profile?: string;
	cwd?: string;
}

export class ControlSocket {
	private server: http.Server | null = null;
	private token = "";
	private tokenFile = `${stateDir()}/control-token`;

	constructor(private host: () => RemoteHost, private port: number) {}

	start(): void {
		this.token = randomBytes(24).toString("hex");
		try {
			mkdirSync(stateDir(), { recursive: true });
			writeFileSync(this.tokenFile, JSON.stringify({ port: this.port, token: this.token, pid: process.pid }), "utf-8");
		} catch (e) {
			console.warn("[vault-dashboard] control token not written", e);
		}
		this.server = http.createServer((req, res) => this.handle(req, res));
		this.server.on("error", (e: any) => {
			console.warn("[vault-dashboard] control socket", e?.code || e);
		});
		this.server.listen(this.port, "127.0.0.1");
	}

	stop(): void {
		try { this.server?.close(); } catch (_) { /* already closed */ }
		this.server = null;
		try { unlinkSync(this.tokenFile); } catch (_) { /* never written */ }
	}

	private json(res: http.ServerResponse, code: number, obj: unknown): void {
		const body = JSON.stringify(obj);
		res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
		res.end(body);
	}

	private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
		if (req.headers["x-control-token"] !== this.token) {
			this.json(res, 403, { ok: false, result: "bad token" });
			return;
		}
		if (req.method === "GET" && req.url === "/panes") {
			this.json(res, 200, { ok: true, result: this.panes() });
			return;
		}
		if (req.method !== "POST" || req.url !== "/op") {
			this.json(res, 404, { ok: false, result: "no such route" });
			return;
		}
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (c: Buffer) => {
			size += c.length;
			if (size <= MAX_BODY) chunks.push(c);
		});
		req.on("end", () => {
			if (size > MAX_BODY) { this.json(res, 413, { ok: false, result: "body too large" }); return; }
			let body: OpBody = {};
			try { body = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}"); }
			catch (_) { this.json(res, 400, { ok: false, result: "bad json" }); return; }
			try {
				this.json(res, 200, this.op(body));
			} catch (e: any) {
				this.json(res, 200, { ok: false, result: `op failed: ${String(e?.message || e).slice(0, 160)}` });
			}
		});
	}

	// ── pane access (mirrors seat_bridge.py's eval snippets) ──

	private leaves() {
		return this.host().app.workspace.getLeavesOfType(WS_VIEW);
	}

	private find(handle: string): { leaf: any; pane: any } | null {
		if (!handle) return null;
		for (const leaf of this.leaves() as any[]) {
			const pane = leaf.view?.pane;
			if (!pane) continue;
			if ((handle.startsWith("leaf:") && leaf.id === handle.slice(5)) ||
				(pane.sessionUuid && pane.sessionUuid === handle)) {
				return { leaf, pane };
			}
		}
		return null;
	}

	panes(): Record<string, unknown>[] {
		const out: Record<string, unknown>[] = [];
		for (const leaf of this.leaves() as any[]) {
			const p = leaf.view?.pane;
			if (!p) continue;
			out.push({
				leaf: leaf.id,
				uuid: p.sessionUuid || null,
				profile: p.getProfileId ? p.getProfileId() : null,
				label: p.seatLabel ? p.seatLabel() : null,
				cwd: p.getCwd ? p.getCwd() : null,
				cols: p.terminal ? p.terminal.cols : null,
				pty: !!p.ptyProcess,
			});
		}
		return out;
	}

	private op(b: OpBody): { ok: boolean; result: unknown } {
		const app: any = this.host().app;
		if (b.op === "resume") {
			const ws = app.plugins?.getPlugin?.("workspace-shell");
			if (!ws || !ws.openResumedSeat) return { ok: false, result: "workspace-shell not enabled" };
			if (!b.uuid) return { ok: false, result: "bad uuid" };
			if (this.panes().some(p => p.uuid === b.uuid)) return { ok: false, result: "already on the desk" };
			ws.openResumedSeat(b.uuid);
			return { ok: true, result: "ok" };
		}
		if (b.op === "new") {
			// s948: "New seat" from the phone / the desktop sidebar. A fresh Claude seat in a new
			// tab on the desk; it shows on the phone once it registers a session number.
			const ws = app.plugins?.getPlugin?.("workspace-shell");
			if (!ws || !ws.openNewSeat) return { ok: false, result: "workspace-shell not enabled" };
			ws.openNewSeat(String(b.profile || "claude"), b.cwd ? String(b.cwd) : undefined, "tab");
			return { ok: true, result: "ok" };
		}
		const f = this.find(String(b.handle || ""));
		if (!f) return { ok: false, result: "no leaf" };
		const P = f.pane;
		switch (b.op) {
			case "focus": {
				app.workspace.revealLeaf(f.leaf);
				try { const w = f.leaf.view?.containerEl?.win; if (w && w.focus) w.focus(); } catch (_) { /* pop-out closed */ }
				try { P.focus(); } catch (_) { /* no terminal yet */ }
				return { ok: true, result: "ok" };
			}
			case "send": {
				if (!P.ptyProcess) return { ok: false, result: "no pty" };
				const text = String(b.text ?? "");
				if (!text) return { ok: false, result: "empty" };
				P.sendText(text);
				if (b.enter !== false) setTimeout(() => { try { P.sendText("\r"); } catch (_) { /* pane gone */ } }, 150);
				return { ok: true, result: "ok" };
			}
			case "keys": {
				if (!P.ptyProcess) return { ok: false, result: "no pty" };
				const seq = String(b.seq ?? "");
				if (!seq) return { ok: false, result: "no key" };
				P.sendKey(seq);
				return { ok: true, result: "ok" };
			}
			case "screen": {
				const buf = P.terminal?.buffer?.active;
				if (!buf) return { ok: false, result: "no buffer" };
				const rows = Math.max(5, Math.min(200, Number(b.rows) || 45));
				const lines: string[] = [];
				for (let y = Math.max(0, buf.length - rows); y < buf.length; y++) {
					const ln = buf.getLine(y);
					lines.push(ln ? ln.translateToString(true) : "");
				}
				while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
				return { ok: true, result: lines.join("\n") };
			}
			default:
				return { ok: false, result: `unknown op ${String(b.op)}` };
		}
	}
}
