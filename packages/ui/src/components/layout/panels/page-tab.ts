// Page identity types live here, not in `registry.ts`.
//
// `registry.ts` value-imports every panel it registers, and each panel needs
// the `PageTab` shape it is rendered with. Keeping the shape in `registry.ts`
// made every panel import its own registrar back, which is a cycle: the
// panel registry and the panels it registers cannot both own the contract.
//
// This module is the lower layer: it has no imports at all, so the panels and
// the registry can both depend on it without depending on each other.

export type PageId =
  | "files"
  | "workspace"
  | "review"
  | "terminal"
  | "browser"
  | "bot-settings"
  | "room-settings"
  | "session-messages"
  | "plugin-app";

export interface PageTab {
  id: string;
  pageId: PageId;
  title: string;
  favicon?: string;
  params?: Record<string, unknown>;
}
