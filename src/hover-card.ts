// Generic floating hover card (SYS-485, session 911) — shared by wi-card.ts
// (WI detail cards) and session-hover.ts (arc-strip session cards) so both
// skins stay pixel-identical instead of drifting apart. Appended to the
// EVENT's own window's document.body, since a pop-out seat owns its own
// document; positioning clamps to that window's viewport. Plain DOM only —
// no Obsidian import — so it stays usable from anything that has a real
// `document` (unlike src/render/*, this is not Node-importable: it creates
// live elements, not strings).

export function showCard(html: string, event: MouseEvent, cls = ""): HTMLElement {
	const win: Window = event.view ?? window;
	const doc = win.document;
	const card = doc.createElement("div");
	card.className = `op-wi-card${cls ? ` ${cls}` : ""}`;
	card.innerHTML = html;
	doc.body.appendChild(card);
	const pad = 12;
	card.style.left = `${Math.min(event.clientX + pad, win.innerWidth - 400)}px`;
	const y = event.clientY + pad;
	card.style.top = `${y + 180 > win.innerHeight ? Math.max(8, event.clientY - 190) : y}px`;
	return card;
}

export function hideCard(card: HTMLElement | null): void {
	card?.remove();
}
