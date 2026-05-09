"use client";

import { usePanel } from "@/hooks/usePanel";
import { FileTreePanel } from "./panels/FileTreePanel";

export function PanelZone() {
  const { fileTreeOpen } = usePanel();

  if (!fileTreeOpen) return null;

  return (
    <div className="panel-zone">
      {fileTreeOpen && <FileTreePanel />}
    </div>
  );
}
