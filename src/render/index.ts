// Barrel for the pure render layer (no Obsidian, no DOM) -- what
// tools/render-preview.mjs bundles under plain Node. v3.0.0 (session 927):
// the thread board is the whole panel; the v4/v5 modules (arc-strip, lane,
// triage, could-do, capture, week, today, now-next, inbox, tabs) are gone.
// Session 931: active-window fold + WI chip badges (threads.ts) and the
// OVERDUE strip (overdue.ts). Session 975: the SYS-518 ranking surfaces
// (surfaces.ts -- Big rocks + Do now, s954 scoring model).
export * from "./common";
export * from "./header";
export * from "./threads";
export * from "./overdue";
export * from "./surfaces";
