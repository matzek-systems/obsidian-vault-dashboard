import { Any, esc } from "./common";

export function renderWeek(week: Any): string {
	if (!week || !week.days) return `<div class="empty">calendar off</div>`;
	return week.days.map((day: Any) => `
		<div class="day ${day.today ? "today" : ""}">
			<div class="dh"><span>${esc(day.dow)}</span><span>${esc(String(day.date).slice(5))}</span></div>
			${(day.clock || []).map((c: Any) => `<div class="ck">⏱ ${esc(c.id)} due</div>`).join("")}
			${(day.events || []).map((e: Any) => `<div class="ev"><i>${e.all_day ? "all day" : esc(e.start)}</i>${esc(e.subject)}</div>`).join("")}
			${!(day.events || []).length && !(day.clock || []).length ? `<div class="none">—</div>` : ""}
		</div>`).join("");
}

export function weekNote(week: Any): string {
	if (!week || !week.days) return "";
	return (week.error ? "calendar read failed" : `outlook read-only · ${week.managed_hidden} auto-pushed wi_calendar blocks hidden`)
		+ ((week.overdue || []).length ? ` · overdue: ${week.overdue.map((o: Any) => esc(o.id)).join(", ")}` : "")
		+ (week.error ? ` · ${esc(week.error)}` : "");
}
