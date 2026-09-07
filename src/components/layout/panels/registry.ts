// src/components/layout/panels/registry.ts
"use client";

import { lazy, type ComponentType } from "react";
import {
  FolderIcon,
  FileTextIcon,
  GitDiffIcon,
  GlobeIcon,
  ChalkboardIcon,
  TerminalIcon,
  GearSixIcon,
  type IconProps,
} from "@/components/icons";
import type { TranslationKey } from "@/i18n";
import { FileTreePanel } from "./FileTreePanel";
import { TerminalPanel } from "./TerminalPanel";
import { BrowserPanel } from "./BrowserPanel";
import { FilePreviewPanel } from "./FilePreviewPanel";
import { BotSettingsPanel } from "./BotSettingsPanel";
import { RoomSettingsPanel } from "./RoomSettingsPanel";

// Heavy, low-frequency panels are lazy-loaded so their dependencies
// (conductor canvas engine, diff viewer, office suite) stay out of the
// entry chunk (plan 426 Phase 5.2). Rendered inside <Suspense> in
// PanelZone; chunks load from local disk in Electron.
const SidebarConductorView = lazy(() =>
  import("./SidebarConductorView").then((m) => ({ default: m.SidebarConductorView }))
);
const CodeReviewPanel = lazy(() =>
  import("./CodeReviewPanel").then((m) => ({ default: m.CodeReviewPanel }))
);
const OfficePanel = lazy(() =>
  import("./OfficePanel").then((m) => ({ default: m.OfficePanel }))
);

export type PageId = "files" | "preview" | "review" | "conductor" | "terminal" | "browser" | "office" | "bot-settings" | "room-settings";

export interface PageTab {
  id: string;
  pageId: PageId;
  title: string;
  favicon?: string;
  params?: Record<string, unknown>;
}

export interface PageDescriptor {
  id: PageId;
  /** Translation key for the page label shown in menus and tabs. */
  labelKey: TranslationKey;
  icon: ComponentType<IconProps>;
  multiInstance: boolean;
  available: boolean;
  minWidth: number;
  preferredWidth?: number;
  /**
   * Fraction of the workspace row this page should claim when opened.
   * The main chat column remains protected by its minimum width, even
   * when the panel uses a ratio-driven default.
   * `workspace * ratio`. Mutually exclusive with `preferredWidth` —
   * the ratio wins when both are present.
   */
  widthRatio?: number;
  /** Maximum share of the workspace this page can claim while resizing. */
  maxWidthRatio?: number;
  /**
   * Absolute width ceiling. `null` opts out of the shared ceiling for pages
   * whose intended size is proportion-based, such as the browser.
   */
  maxWidth?: number | null;
  defaultExpanded: boolean;
  component: ComponentType<{ tab: PageTab; embedded: boolean }>;
}

export const PAGE_REGISTRY: Record<PageId, PageDescriptor> = {
  files: {
    id: "files",
    labelKey: "panel.files",
    icon: FolderIcon,
    multiInstance: true,
    available: true,
    minWidth: 300,
    preferredWidth: 320,
    defaultExpanded: false,
    component: FileTreePanel as ComponentType<{ tab: PageTab; embedded: boolean }>,
  },
  preview: {
    id: "preview",
    labelKey: "panel.preview",
    icon: FileTextIcon,
    multiInstance: true,
    available: true,
    // Code/markdown preview stays readable down to ~360px; the previous
    // 640/820 values forced the panel past the visible window on 1280px
    // laptops with the standard left sidebar.
    minWidth: 360,
    preferredWidth: 480,
    defaultExpanded: false,
    component: FilePreviewPanel as ComponentType<{ tab: PageTab; embedded: boolean }>,
  },
  review: {
    id: "review",
    labelKey: "panel.review",
    icon: GitDiffIcon,
    multiInstance: false,
    available: true,
    minWidth: 460,
    widthRatio: 2 / 3,
    maxWidthRatio: 2 / 3,
    maxWidth: null,
    defaultExpanded: false,
    component: CodeReviewPanel as ComponentType<{ tab: PageTab; embedded: boolean }>,
  },
  conductor: {
    id: "conductor",
    labelKey: "panel.conductor",
    icon: ChalkboardIcon,
    multiInstance: true,
    available: true,
    minWidth: 420,
    widthRatio: 0.6,
    defaultExpanded: false,
    component: SidebarConductorView as ComponentType<{ tab: PageTab; embedded: boolean }>,
  },
  terminal: {
    id: "terminal",
    labelKey: "panel.terminal",
    icon: TerminalIcon,
    multiInstance: true,
    available: true,
    minWidth: 320,
    defaultExpanded: false,
    component: TerminalPanel as ComponentType<{ tab: PageTab; embedded: boolean }>,
  },
  browser: {
    id: "browser",
    labelKey: "panel.browser",
    icon: GlobeIcon,
    multiInstance: true,
    available: true,
    minWidth: 460,
    widthRatio: 2 / 3,
    maxWidthRatio: 2 / 3,
    maxWidth: null,
    defaultExpanded: false,
    component: BrowserPanel as ComponentType<{ tab: PageTab; embedded: boolean }>,
  },
  office: {
    id: "office",
    labelKey: "panel.office",
    icon: FileTextIcon,
    multiInstance: true,
    available: true,
    minWidth: 520,
    preferredWidth: 760,
    defaultExpanded: false,
    component: OfficePanel as ComponentType<{ tab: PageTab; embedded: boolean }>,
  },
  "bot-settings": {
    id: "bot-settings",
    labelKey: "panel.botSettings",
    icon: GearSixIcon,
    // One tab per bot: openOrActivatePage dedups on the params agentId, so
    // repeated header clicks on the same bot activate the existing tab.
    // Not in EMPTY_LAUNCHER_ORDER — it is only opened programmatically.
    multiInstance: true,
    available: true,
    minWidth: 320,
    preferredWidth: 360,
    defaultExpanded: false,
    component: BotSettingsPanel as ComponentType<{ tab: PageTab; embedded: boolean }>,
  },
  "room-settings": {
    id: "room-settings",
    labelKey: "panel.roomSettings",
    icon: GearSixIcon,
    // One tab per room: openOrActivatePage dedups on the params roomId, so
    // repeated header clicks on the same room activate the existing tab.
    // Not in EMPTY_LAUNCHER_ORDER — it is only opened programmatically.
    multiInstance: true,
    available: true,
    minWidth: 320,
    preferredWidth: 360,
    defaultExpanded: false,
    component: RoomSettingsPanel as ComponentType<{ tab: PageTab; embedded: boolean }>,
  },
};

export function getPageDescriptor(id: PageId): PageDescriptor {
  const desc = PAGE_REGISTRY[id];
  if (!desc) {
    throw new Error(`Unknown page id: ${id}`);
  }
  return desc;
}

export function isPageId(value: unknown): value is PageId {
  return typeof value === "string" && value in PAGE_REGISTRY;
}
