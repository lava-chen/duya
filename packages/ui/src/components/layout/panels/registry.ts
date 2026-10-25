// apps/desktop/src/renderer/components/layout/panels/registry.ts
"use client";

import { lazy, type ComponentType } from "react";
import {
  FolderIcon,
  FileTextIcon,
  GitDiffIcon,
  GlobeIcon,
  TerminalIcon,
  GearSixIcon,
  ChatCircleIcon,
  PlugIcon,
  type IconProps,
} from "@/components/icons";
import type { TranslationKey } from "@/i18n";
import type { PageId, PageTab } from "./page-tab";
import { FileTreePanel } from "./FileTreePanel";
import { BrowserPanel } from "./BrowserPanel";
import { FilePreviewPanel } from "./FilePreviewPanel";
import { FileWorkspacePanel } from "@/components/file-workspace/FileWorkspacePanel";
import { BotSettingsPanel } from "./BotSettingsPanel";
import { RoomSettingsPanel } from "./RoomSettingsPanel";
import { PluginUiSurfacePanel } from "./PluginUiSurfacePanel";

// Heavy, low-frequency panels stay out of the entry chunk (plan 426 Phase 5.2).
// Rendered inside <Suspense> in PanelZone; chunks load from local disk in Electron.
//
// The terminal belongs here for the same reason: it is a panel the user opens
// explicitly, and it drags in xterm plus four addons (core, fit, web-links,
// unicode11, webgl). A static import put all of that into the first-screen
// closure, where the renderer had to download, parse and evaluate it before
// the first screen could paint.
const CodeReviewPanel = lazy(() =>
  import("./CodeReviewPanel").then((m) => ({ default: m.CodeReviewPanel }))
);
const SessionMessagesPanel = lazy(() =>
  import("./SessionMessagesPanel").then((m) => ({ default: m.SessionMessagesPanel }))
);
const TerminalPanel = lazy(() =>
  import("./TerminalPanel").then((m) => ({ default: m.TerminalPanel }))
);

export type { PageId, PageTab } from "./page-tab";

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
  workspace: {
    id: "workspace",
    labelKey: "panel.files",
    icon: FolderIcon,
    // One page holds every open file; the files themselves are tabs inside
    // the panel, so the outer page tab must not multiply per file.
    multiInstance: false,
    available: true,
    minWidth: 420,
    preferredWidth: 620,
    defaultExpanded: false,
    component: FileWorkspacePanel as ComponentType<{ tab: PageTab; embedded: boolean }>,
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
  "session-messages": {
    id: "session-messages",
    labelKey: "panel.sessionMessages",
    icon: ChatCircleIcon,
    // One tab per session: openOrActivatePage dedups on the params sessionId,
    // so repeated clicks on the same subagent / workflow-node session focus
    // the existing tab instead of stacking copies. Not in
    // EMPTY_LAUNCHER_ORDER or the add-page menu — it is only opened
    // programmatically via `duya:open-session-panel`.
    multiInstance: true,
    available: true,
    minWidth: 320,
    preferredWidth: 440,
    defaultExpanded: false,
    component: SessionMessagesPanel as ComponentType<{ tab: PageTab; embedded: boolean }>,
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
  "plugin-app": {
    id: "plugin-app",
    labelKey: "apps.title",
    icon: PlugIcon,
    // One tab per installed surface. `openOrActivatePage` folds repeated
    // launches by pluginId + surfaceId into the existing panel tab.
    multiInstance: true,
    available: true,
    minWidth: 360,
    preferredWidth: 520,
    defaultExpanded: false,
    component: PluginUiSurfacePanel,
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
