"use client";

import { SidebarSimple } from "@phosphor-icons/react";
import { useMemo, type ReactNode } from "react";
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
  const panel = useOptionalPanel();
  const workspaceTreeOpen = panel?.workspaceTreeOpen ?? true;
  const treeTab = useMemo<PageTab>(() => ({
    id: `integrated-files:${workingDirectory}`,
    pageId: "files",
    title: "文件",
    params: { workingDirectory },
  }), [workingDirectory]);

  return (
    <div className="panel-file-split">
      <div className="panel-file-detail">{children}</div>
      {workspaceTreeOpen && workingDirectory && (
        <aside className="panel-file-tree" aria-label="项目文件树">
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
  const panel = useOptionalPanel();
  const workspaceTreeOpen = panel?.workspaceTreeOpen ?? true;
  return (
    <button
      type="button"
      className={workspaceTreeOpen ? "active" : undefined}
      onClick={() => panel?.setWorkspaceTreeOpen(!workspaceTreeOpen)}
      title={workspaceTreeOpen ? "收起文件树" : "展开文件树"}
      aria-label={workspaceTreeOpen ? "收起文件树" : "展开文件树"}
      aria-pressed={workspaceTreeOpen}
      data-testid="file-tree-toggle"
    >
      <SidebarSimple size={15} weight="regular" />
    </button>
  );
}
