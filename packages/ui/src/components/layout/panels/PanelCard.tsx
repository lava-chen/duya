// One card of the side panel's wall.
//
// Every card owns its actions and body. Page content supplies its own title
// or toolbar, so the shared card chrome does not repeat that label.

"use client";

import type { ComponentType, ReactNode } from "react";
import {
  ArrowDownLeftIcon,
  ArrowUpRightIcon,
  CornersInIcon,
  CornersOutIcon,
  XIcon,
  type IconProps,
} from "@/components/icons";
import { fileExtensionFromName, getFileTypeIcon } from "@/components/file-tree/file-type-icon";
import { useTranslation } from "@/hooks/useTranslation";
import type { PageTab } from "./page-tab";

interface PanelCardProps {
  tab: PageTab;
  /** Whether this card currently fills the whole wall. */
  expanded: boolean;
  /** Whether the card may be expanded (a lone card has nothing to expand to). */
  expandable: boolean;
  /** Focus the card (its title is the click target). */
  onActivate?: () => void;
  onToggleExpand: () => void;
  onClose: () => void;
  /**
   * Detach this pane into its own OS window. Omitted on surfaces without the
   * detached-window bridge (web), which removes the action from the header.
   */
  onPopout?: () => void;
  /** Test hook for the expand action (the lone-card case drives the workspace). */
  expandTestId?: string;
  children: ReactNode;
}

export function PanelCard({
  tab,
  expanded,
  expandable,
  onActivate,
  onToggleExpand,
  onClose,
  onPopout,
  expandTestId,
  children,
}: PanelCardProps) {
  const { t } = useTranslation();
  const expandLabel = expanded ? t("panel.collapsePanel") : t("panel.expandPanel");

  return (
    <section className="panel-card" data-pane-id={tab.id} aria-label={tab.title}>
      <header className="panel-card-header panel-card-header-compact" onMouseDown={onActivate}>
        <span className="panel-card-actions">
          {onPopout && (
            <button
              type="button"
              className="panel-card-action"
              onClick={onPopout}
              title={t("panel.openInNewWindow")}
              aria-label={t("panel.openInNewWindow")}
              data-testid={`panel-popout-${tab.pageId}`}
            >
              <ArrowUpRightIcon size={14} stroke={1.5} />
            </button>
          )}
          {expandable && (
            <button
              type="button"
              className="panel-card-action"
              onClick={onToggleExpand}
              title={expandLabel}
              aria-label={expandLabel}
              aria-pressed={expanded}
              data-testid={expandTestId}
            >
              {expanded
                ? <CornersInIcon size={14} stroke={1.5} />
                : <CornersOutIcon size={14} stroke={1.5} />}
            </button>
          )}
          <button
            type="button"
            className="panel-card-action panel-card-close"
            onClick={onClose}
            title={t("panel.closeTab")}
            aria-label={t("panel.closeTab")}
          >
            <XIcon size={12} stroke={2} />
          </button>
        </span>
      </header>
      <div className="panel-card-body">{children}</div>
    </section>
  );
}

/**
 * Placeholder shown in the wall while a pane lives in its own OS window.
 *
 * The pane keeps its grid slot so the wall's shape and column widths do not
 * shift underneath the user, but the panel component itself is not mounted —
 * a browser webview must not end up instantiated twice. The button hands the
 * pane back to the wall, mirroring what the detached window's own header does.
 */
export function PanelCardDetachedPlaceholder({
  tab,
  icon: Icon,
  onReturn,
}: {
  tab: PageTab;
  icon: ComponentType<IconProps>;
  onReturn: () => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="panel-card panel-card-detached" data-pane-id={tab.id} aria-label={tab.title}>
      <header className="panel-card-header">
        <span className="panel-card-icon">
          <CardIcon tab={tab} fallback={<Icon size={14} stroke={1.5} />} />
        </span>
        <span className="panel-card-title" title={tab.title}>
          {tab.title}
        </span>
        <span className="panel-card-actions">
          <button
            type="button"
            className="panel-card-action"
            onClick={onReturn}
            title={t("panel.returnToMain")}
            aria-label={t("panel.returnToMain")}
            data-testid={`panel-return-${tab.pageId}`}
          >
            <ArrowDownLeftIcon size={14} stroke={1.5} />
          </button>
        </span>
      </header>
      <div className="panel-card-body">
        <div className="panel-card-detached-hint">{t("panel.detachedRunning")}</div>
      </div>
    </section>
  );
}

/**
 * Per-extension icon for file-backed cards (preview), resolved through the
 * same mapping the project file tree uses. Falls back to the page's static
 * icon when the card has no file path.
 */
function CardIcon({ tab, fallback }: { tab: PageTab; fallback: ReactNode }) {
  const filePath = typeof tab.params?.filePath === "string" ? tab.params.filePath : "";
  if (filePath) {
    const fileName = filePath.split(/[/\\]/).pop() ?? "";
    const Icon = getFileTypeIcon(fileExtensionFromName(fileName));
    if (Icon) return <Icon size={14} stroke={1.5} />;
  }
  return <>{fallback}</>;
}
