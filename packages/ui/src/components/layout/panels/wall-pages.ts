// The panel kinds the side panel's wall offers.
//
// The wall shows one card per open page. These are the kinds the user can
// add from the wall's empty cell:
//
//   files     — the project file tree
//   workspace — the file viewer (opened by clicking a file; not added by hand)
//   review    — the code review diff
//   browser   — the embedded browser
//   terminal  — a shell
//
// Plugin Apps use the generic Apps view rather than this panel registry.
// Session-messages panels are also event-only, but they are not wall pages.

import type { PageId } from "./page-tab";

/** The pages the wall's add-panel menu offers, in menu order. */
export const WALL_PAGE_IDS: readonly PageId[] = [
  "files",
  "review",
  "browser",
  "terminal",
];
