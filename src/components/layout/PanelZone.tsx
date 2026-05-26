"use client";

import { usePanel } from "@/hooks/usePanel";
import { SidebarPanel } from "./SidebarPanel";

export function PanelZone() {
  const { panelOpen } = usePanel();

  if (!panelOpen) return null;

  return (
    <div className="panel-zone">
      <SidebarPanel />
    </div>
  );
}