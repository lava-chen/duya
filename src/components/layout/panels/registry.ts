// src/components/layout/panels/registry.ts
"use client";

import type { ComponentType } from "react";
import {
  FolderIcon,
  FileText,
  GlobeIcon,
  SquaresFourIcon,
  TerminalIcon,
  type IconProps,
} from "@phosphor-icons/react";
import { FileTreePanel } from "./FileTreePanel";
import { SidebarConductorView } from "./SidebarConductorView";
import { ResearchActivityPanel } from "./ResearchActivityPanel";
import { TerminalPanel } from "./TerminalPanel";
import { BrowserPanel } from "./BrowserPanel";
import { OfficePanel } from "./OfficePanel";
import { FilePreviewPanel } from "./FilePreviewPanel";

export type PageId = "files" | "preview" | "conductor" | "research" | "terminal" | "browser" | "office";

export interface PageTab {
  id: string;
  pageId: PageId;
  title: string;
  params?: Record<string, unknown>;
}

export interface PageDescriptor {
  id: PageId;
  label: string;
  icon: ComponentType<IconProps>;
  multiInstance: boolean;
  available: boolean;
  minWidth: number;
  preferredWidth?: number;
  defaultExpanded: boolean;
  component: ComponentType<{ tab: PageTab; embedded: boolean }>;
}

export const PAGE_REGISTRY: Record<PageId, PageDescriptor> = {
  files: {
    id: "files",
    label: "文件树",
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
    label: "预览",
    icon: FileText,
    multiInstance: true,
    available: true,
    minWidth: 520,
    preferredWidth: 760,
    defaultExpanded: false,
    component: FilePreviewPanel as ComponentType<{ tab: PageTab; embedded: boolean }>,
  },
  conductor: {
    id: "conductor",
    label: "Conductor",
    icon: SquaresFourIcon,
    multiInstance: true,
    available: true,
    minWidth: 420,
    preferredWidth: 560,
    defaultExpanded: false,
    component: SidebarConductorView as ComponentType<{ tab: PageTab; embedded: boolean }>,
  },
  research: {
    id: "research",
    label: "Research",
    icon: GlobeIcon,
    multiInstance: false,
    available: true,
    minWidth: 320,
    defaultExpanded: false,
    component: ResearchActivityPanel as ComponentType<{ tab: PageTab; embedded: boolean }>,
  },
  terminal: {
    id: "terminal",
    label: "终端",
    icon: TerminalIcon,
    multiInstance: true,
    available: true,
    minWidth: 320,
    defaultExpanded: false,
    component: TerminalPanel as ComponentType<{ tab: PageTab; embedded: boolean }>,
  },
  browser: {
    id: "browser",
    label: "浏览器",
    icon: GlobeIcon,
    multiInstance: true,
    available: true,
    minWidth: 460,
    preferredWidth: 760,
    defaultExpanded: false,
    component: BrowserPanel as ComponentType<{ tab: PageTab; embedded: boolean }>,
  },
  office: {
    id: "office",
    label: "Office",
    icon: FileText,
    multiInstance: true,
    available: true,
    minWidth: 520,
    preferredWidth: 760,
    defaultExpanded: false,
    component: OfficePanel as ComponentType<{ tab: PageTab; embedded: boolean }>,
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
