"use client";

import { useConversationStore } from "@/stores/conversation-store";
import { usePanel } from "@/hooks/usePanel";
import { FileTreePanel } from "./panels/FileTreePanel";

export function PanelZone() {
  const { fileTreeOpen } = usePanel();
  const { activeThreadId, threads } = useConversationStore();

  if (!fileTreeOpen) return null;

  const activeThread = threads.find((t) => t.id === activeThreadId);
  const hasWorkingDirectory = !!activeThread?.workingDirectory;

  if (!hasWorkingDirectory) return null;

  return (
    <div className="panel-zone">
      <FileTreePanel />
    </div>
  );
}
