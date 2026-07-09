"use client";

import { Files } from "@phosphor-icons/react";
import { useMemo, type ReactNode } from "react";
import { useTranslation } from "@/hooks/useTranslation";
import { useOptionalPanel } from "@/hooks/usePanel";
import { FileTreePanel } from "./FileTreePanel";
import type { PageTab } from "./registry";

export function PanelFileTreeSplit({
  workingDirectory,
  children,
}: {
  workingDirectory: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const panel = useOptionalPanel();
  // Default the integrated file tree to CLOSED for the preview panel so
  // the file preview opens like a focused editor rather than a split
  // browser. Users can still expand it with the toolbar toggle inside
  // FilePreviewPanel.
  const workspaceTreeOpen = panel?.workspaceTreeOpen ?? false;
  const treeTab = useMemo<PageTab>(() => ({
    id: `integrated-files:${workingDirectory}`,
    pageId: "files",
    title: t('panel.files'),
    params: { workingDirectory },
  }), [workingDirectory, t]);

  return (
    <div className="panel-file-split">
      <div className="panel-file-detail">{children}</div>
      {workspaceTreeOpen && workingDirectory && (
        <aside className="panel-file-tree" aria-label={t('panel.projectFileTree')}>
          <div className="panel-file-tree-header">
            <PanelFileTreeToggle />
          </div>
          <FileTreePanel tab={treeTab} embedded />
        </aside>
      )}
    </div>
  );
}

export function PanelFileTreeToggle() {
  const { t } = useTranslation();
  const panel = useOptionalPanel();
  const workspaceTreeOpen = panel?.workspaceTreeOpen ?? false;
  return (
    <button
      type="button"
      className={workspaceTreeOpen ? "active" : undefined}
      onClick={() => panel?.setWorkspaceTreeOpen(!workspaceTreeOpen)}
      title={workspaceTreeOpen ? t('panel.collapseFileTree') : t('panel.expandFileTree')}
      aria-label={workspaceTreeOpen ? t('panel.collapseFileTree') : t('panel.expandFileTree')}
      aria-pressed={workspaceTreeOpen}
      data-testid="file-tree-toggle"
    >
      <Files size={15} weight="regular" />
    </button>
  );
}
