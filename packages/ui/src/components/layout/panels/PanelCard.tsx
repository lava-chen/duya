// One card of the side panel's wall.
//
// Every card owns its header (icon + title + actions) and its body, the way
// the reference product's panels do. There is no global tab strip above the
// wall: the card header is the only chrome.

"use client";

import type { ComponentType, ReactNode } from "react";
import { CornersInIcon, CornersOutIcon, XIcon, type IconProps } from "@/components/icons";
import { fileExtensionFromName, getFileTypeIcon } from "@/components/file-tree/file-type-icon";
import { useTranslation } from "@/hooks/useTranslation";
import type { PageTab } from "./page-tab";

interface PanelCardProps {
  tab: PageTab;
  /** The page's icon, used when the card is not backed by a file. */
  icon: ComponentType<IconProps>;
  /** Whether this card currently fills the whole wall. */
  expanded: boolean;
  /** Whether the card may be expanded (a lone card has nothing to expand to). */
  expandable: boolean;
  /** Focus the card (its title is the click target). */
  onActivate?: () => void;
  onToggleExpand: () => void;
  onClose: () => void;
  /** Test hook for the expand action (the lone-card case drives the workspace). */
  expandTestId?: string;
  children: ReactNode;
}

export function PanelCard({
  tab,
  icon: Icon,
  expanded,
  expandable,
  onActivate,
  onToggleExpand,
  onClose,
  expandTestId,
  children,
}: PanelCardProps) {
  const { t } = useTranslation();
  const expandLabel = expanded ? t("panel.collapsePanel") : t("panel.expandPanel");

  return (
    <section className="panel-card" data-pane-id={tab.id} aria-label={tab.title}>
      <header className="panel-card-header">
        <span className="panel-card-icon">
          <CardIcon tab={tab} fallback={<Icon size={14} stroke={1.5} />} />
        </span>
        <span className="panel-card-title" title={tab.title} onClick={onActivate}>
          {tab.title}
        </span>
        <span className="panel-card-actions">
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
