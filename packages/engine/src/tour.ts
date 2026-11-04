/** Desk tour order. The workplace copy follows this list through MO-1 grading. */
export const DESK_TOUR_IDS = [
  "chat",
  "kt",
  "calendar",
  "board",
  "connections",
  "preview",
  "workbench",
  "notebook",
  "run-query",
  "submit",
  "feedback",
] as const;

export type DeskTourId = (typeof DESK_TOUR_IDS)[number];
