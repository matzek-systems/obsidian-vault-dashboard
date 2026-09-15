// CALENDAR area (SYS-485; operator layout session 975). Pure string renderer
// over `data.calendar` -- no Obsidian, no DOM, same contract as the rest of
// src/render/. Sits at the top of the panel, above the tabs: it is not a lane
// view, so a tab never hides it (off-lane WI items dim, like the overdue strip).
//
//   TODAY  Tue 15          TOMORROW  Wed 16            NEXT
//   nothing dated          09:30  Acme kickoff call   Thu 17 | Fri 18      | Sat 19
//                                                       --     | due ACME-12 | --
//
// Three equal blocks: today, tomorrow, and one day-sized "next" block split
// into the three days after tomorrow, for coming big tasks. Explicit dates
// only -- Outlook appointments plus `due:` / `start_by:` on live WIs. No
// derived plan (operator: "work is too dynamic for that"), so a weekend day
// shows only what someone put on that date. Past-due WIs live in the overdue
// strip, never here.

import { Any, esc } from "./common";

function laneName(lane: string | null | undefined): string {
	return lane === "_System" ? "System" : String(lane || "");
}

function eventItem(e: Any, compact: boolean): string {
	const when = e.all_day ? "all day" : `${esc(e.start || "")}${compact ? "" : `–${esc(e.end || "")}`}`;
	const loc = !compact && e.location ? `<span class="cal-loc">${esc(e.location)}</span>` : "";
	return `<div class="cal-it ev"><span class="cal-when">${when}</span><span class="cal-txt">${esc(e.subject || "")}</span>${loc}</div>`;
}

function wiItem(w: Any, tab: string | null, compact: boolean): string {
	const dim = tab && w.lane && w.lane !== tab ? " dim" : "";
	const lane = compact ? "" : `<span class="thr-lane">${esc(laneName(w.lane))}</span>`;
	// data-id on the chip -> WiHover's rich card; no native title= (s954 double popup).
	return `<div class="cal-it wi ${esc(w.kind)}${dim}">`
		+ `<span class="cal-k">${w.kind === "start" ? "start" : "due"}</span>`
		+ `<span class="tid c-${esc(w.status || "")}" data-id="${esc(w.id)}" data-act="open">${esc(w.id)}</span>`
		+ `<span class="cal-txt">${esc(w.title || "")}</span>${lane}</div>`;
}

function dayItems(day: Any, tab: string | null, compact: boolean): string {
	const evs: Any[] = day.events || [];
	const wis: Any[] = day.wis || [];
	if (!evs.length && !wis.length) return `<div class="cal-none">${compact ? "—" : "nothing dated"}</div>`;
	return wis.map((w) => wiItem(w, tab, compact)).join("") + evs.map((e) => eventItem(e, compact)).join("");
}

function dayLabel(day: Any): string {
	return `${esc(day.dow)} ${esc(day.day)}`;
}

export function calendarSig(data: Any): string {
	const days: Any[] = data?.calendar?.days || [];
	return days.map((d) => `${d.date}:` + (d.events || []).map((e: Any) => `${e.start || "ad"}~${e.subject}`).join("~")
		+ ":" + (d.wis || []).map((w: Any) => `${w.kind}${w.id}${w.status}`).join("~")).join("|")
		+ `|${data?.calendar?.error || ""}`;
}

export function renderCalendar(data: Any, tab: string | null): string {
	const cal = data?.calendar;
	const days: Any[] = cal?.days || [];
	if (days.length < 5) return cal?.error ? `<div class="op-cal-err">calendar: ${esc(cal.error)}</div>` : "";
	const err = cal.error ? `<span class="cal-err" title="${esc(cal.error)}">outlook unavailable</span>` : "";
	const block = (day: Any, name: string, cls: string) =>
		`<div class="cal-day ${cls}${day.weekend ? " wknd" : ""}">`
		+ `<div class="cal-head"><b>${name}</b><span class="cal-date">${dayLabel(day)}</span>${cls === "today" ? err : ""}</div>`
		+ dayItems(day, tab, false) + `</div>`;
	const next = days.slice(2, 5).map((d) =>
		`<div class="cal-sub${d.weekend ? " wknd" : ""}"><div class="cal-subhead">${dayLabel(d)}</div>${dayItems(d, tab, true)}</div>`).join("");
	return `<div class="op-cal">`
		+ block(days[0], "today", "today")
		+ block(days[1], "tomorrow", "tomorrow")
		+ `<div class="cal-day next"><div class="cal-head"><b>next</b></div><div class="cal-split">${next}</div></div>`
		+ `</div>`;
}
