import { Any, esc } from "./common";

/** First line of the panel: "generated at X · Ns" (+ inline generator error).
 *  No title bar, no "operator panel" heading — operator ruling, s911. */
export function renderHeader(data: Any, genError?: string | null): string {
	const timeStr = esc(String(data?.generated || "").slice(11, 16));
	const secs = data?.gen_ms != null ? (data.gen_ms / 1000).toFixed(1) : "?";
	const err = genError ? ` · <span class="bad">generator: ${esc(genError)}</span>` : "";
	return `generated ${timeStr} · ${secs}s${err}`;
}
