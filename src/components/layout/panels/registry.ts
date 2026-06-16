// src/components/layout/panels/registry.ts
"use client";

import type { ComponentType } from "react";
import {
  FolderIcon,
  SquaresFourIcon,
  TerminalIcon,
  GlobeIcon,
  type IconProps,
} from "@phosphor-icons/react";
import { FileTreePanel } from "./FileTreePanel";
import { SidebarConductorView } from "./SidebarConductorView";
import { ResearchActivityPanel } from "./ResearchActivityPanel";
import { TerminalPanel } from "./TerminalPanel";

export type PageId = "files" | "conductor" | "research" | "terminal" | "browser";

export interface PageTab {
  id: string;                 // unique instance id (uuid)
  pageId: PageId;             // page type from registry
  title: string;              // display name in tab strip
  params?: Record<string, unknown>;
}

export interface PageDescriptor {
  id: PageId;
  label: string;
  icon: ComponentType<IconProps>;
  multiInstance: boolean;
  available: boolean;         // shown in the picker; false = "未实现" hint
  component: ComponentType<{ tab: PageTab; embedded: boolean }>;
}

export const PAGE_REGISTRY: Record<PageId, PageDescriptor> = {
  files: {
    id: "files",
    label: "文件树",
    icon: FolderIcon,
    multiInstance: true,
    available: true,
    component: FileTreePanel as ComponentType<{ tab: PageTab; embedded: boolean }>,
  },
  conductor: {
    id: "conductor",
    label: "Conductor",
    icon: SquaresFourIcon,
    multiInstance: true,
    available: true,
    component: SidebarConductorView as ComponentType<{ tab: PageTab; embedded: boolean }>,
  },
  research: {
    id: "research",
    label: "Research",
    icon: GlobeIcon,
    multiInstance: false,
    available: true,
    component: ResearchActivityPanel as ComponentType<{ tab: PageTab; embedded: boolean }>,
  },
  terminal: {
    id: "terminal",
    label: "终端",
    icon: TerminalIcon,
    multiInstance: true,
    available: true,
    component: TerminalPanel as ComponentType<{ tab: PageTab; embedded: boolean }>,
  },
  browser: {
    id: "browser",
    label: "浏览器",
    icon: GlobeIcon,
    multiInstance: true,
    available: false,
    component: (() => null) as ComponentType<{ tab: PageTab; embedded: boolean }>,
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
