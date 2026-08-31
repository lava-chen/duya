/**
 * SidebarSectionItem.tsx — unified section container. Renders a header
 * (icon / title / collapse caret / optional ⋯ menu) plus whatever the
 * caller puts in the body — most often an array of `ProjectGroupItem`
 * or `ThreadListItem`. Both "system" sections (cron / gateway / wakeup /
 * uncategorized / pinned) and "user" sections (defined in
 * `SidebarSectionsStore`) share this component, so a section rule is a
 * render rule and adding a new section is just a new descriptor.
 *
 * Plan 471.
 */

"use client";

import { useTranslation } from '@/hooks/useTranslation';
import {
  CaretRightIcon,
  CaretDownIcon,
  DotsThreeIcon,
  type IconProps,
} from '@/components/icons';

export type SectionKind = 'project' | 'cron' | 'gateway' | 'wakeup' | 'pinned' | 'user';

export interface SidebarSectionItemProps {
  id: string;
  name: string;
  kind: SectionKind;
  /** Mapped from `SidebarSection.collapsed` (user) or a UI-local boolean (system). */
  collapsed: boolean;
  onToggleCollapsed?: () => void;
  /** Optional trailing button. Used for primary actions only (the "+"
   *  new-project CTA on "项目"). Secondary controls live in the project
   *  right-click menu instead, so the header stays minimal. */
  trailing?: React.ReactNode;
  /** Body content. Usually a `<div className="thread-list">…</div>`. */
  children?: React.ReactNode;
  /**
   * Default visual style:
   *  - `bold` (default): system sections and user section headers
   *  - `soft`: subtle styling (e.g. for the "项目" default group fallback)
   */
  tone?: 'bold' | 'soft';
}

export function SidebarSectionItem({
  id,
  name,
  kind,
  collapsed,
  onToggleCollapsed,
  trailing,
  children,
  tone = 'bold',
}: SidebarSectionItemProps) {
  const { t } = useTranslation();

  const handleToggle = () => {
    if (!onToggleCollapsed) return;
    onToggleCollapsed();
  };

  return (
    <div
      className={`sidebar-section-item sidebar-section-${tone} sidebar-section-kind-${kind}`}
      data-section-id={id}
      data-section-kind={kind}
      data-section-collapsed={collapsed ? 'true' : 'false'}
    >
      <div
        className="sidebar-section-header"
        role="button"
        tabIndex={0}
        onClick={handleToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleToggle();
          }
        }}
      >
        <span className="sidebar-section-name">{name}</span>
        <span className="sidebar-section-caret">
          {collapsed ? (
            <CaretRightIcon size={12} />
          ) : (
            <CaretDownIcon size={12} />
          )}
        </span>
        {trailing && (
          <span
            className="sidebar-section-trailing"
            onClick={(e) => e.stopPropagation()}
          >
            {trailing}
          </span>
        )}
      </div>
      {!collapsed && children && <div className="sidebar-section-body">{children}</div>}
    </div>
  );
}

/**
 * Right-click context menu trigger for user sections. Renders a tiny
 * `⋯` button that opens the section's options menu (rename, delete,
 * reorder). The caller is responsible for the menu DOM — this is just
 * the trigger wrapper.
 */
export function SidebarSectionMenuTrigger(): React.ReactElement {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className="sidebar-section-menu-trigger"
      aria-label={t('sidebar.section.options')}
    >
      <DotsThreeIcon size={14} />
    </button>
  );
}
