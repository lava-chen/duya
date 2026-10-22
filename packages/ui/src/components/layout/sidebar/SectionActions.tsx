"use client";

/**
 * SectionActions — the trailing action group on a sidebar section header.
 *
 * Claude parity (2026-10-22). Claude Code puts three small buttons on the
 * right of every group header:
 *
 *     ▾ duya            +  🔍  ⚙
 *                        │   │   └ 过滤器：分组方式 / 排序方式 / 显示空分组
 *                        │   └───── 组内搜索
 *                        └───────── 在本组中新建
 *
 * duya's sections are containers, not repositories, so "new session in this
 * group" is only meaningful where the group holds projects: the built-in
 * "项目" section and the user-defined sections. Every button is therefore
 * opt-in per section — a section that cannot honour a button does not show
 * it, rather than showing a dead control.
 *
 * The filter popover reuses the store's existing "整理 / 排序方式" state
 * (`projectGroupBy` / `projectSortBy`) and moves it out of the section's
 * `⋯` menu, so the mode is visible on the row itself (the submenu shows the
 * current value) instead of hidden behind two clicks.
 */

import { useTranslation } from "@/hooks/useTranslation";
import {
  PlusIcon,
  MagnifyingGlassIcon,
  SlidersHorizontalIcon,
  CheckIcon,
} from "@/components/icons";
import { DropdownMenu, type MenuAction } from "@/components/ui/DropdownMenu";
import type { ProjectGroupBy, ProjectSortBy } from "@/stores/conversation-store";

export interface SectionFilterModel {
  /** "按项目" / "在一个列表中" — only the built-in project section has both. */
  groupBy?: ProjectGroupBy;
  onGroupBy?: (value: ProjectGroupBy) => void;
  sortBy: ProjectSortBy;
  onSortBy: (value: ProjectSortBy) => void;
  showEmptyGroups: boolean;
  onShowEmptyGroups: (value: boolean) => void;
}

interface SectionActionsProps {
  /** Create in this group. Omit when the section cannot host new items. */
  onCreate?: () => void;
  /** Label of the create action (tooltip / aria). */
  createLabel?: string;
  /** Toggle the group-scoped search box. Omit when the section has no rows. */
  onToggleSearch?: () => void;
  searchActive?: boolean;
  /** Filter model. Omit when the section has nothing to filter. */
  filter?: SectionFilterModel;
}

export function SectionActions({
  onCreate,
  createLabel,
  onToggleSearch,
  searchActive = false,
  filter,
}: SectionActionsProps) {
  const { t } = useTranslation();

  const filterItems: MenuAction[] = filter
    ? [
        ...(filter.groupBy && filter.onGroupBy
          ? [
              {
                kind: "submenu" as const,
                id: "group-by",
                label: t("sidebar.filter.groupBy"),
                value:
                  filter.groupBy === "singleList"
                    ? t("project.inOneList")
                    : t("project.byProject"),
                items: [
                  {
                    kind: "action" as const,
                    id: "group-by-project",
                    label: t("project.byProject"),
                    iconRight:
                      filter.groupBy === "byProject" ? (
                        <CheckIcon size={12} />
                      ) : (
                        <span className="sidebar-project-menu-check" />
                      ),
                    onSelect: () => filter.onGroupBy?.("byProject"),
                  },
                  {
                    kind: "action" as const,
                    id: "group-by-single-list",
                    label: t("project.inOneList"),
                    iconRight:
                      filter.groupBy === "singleList" ? (
                        <CheckIcon size={12} />
                      ) : (
                        <span className="sidebar-project-menu-check" />
                      ),
                    onSelect: () => filter.onGroupBy?.("singleList"),
                  },
                ],
              },
            ]
          : []),
        {
          kind: "submenu" as const,
          id: "sort-by",
          label: t("sidebar.filter.sortBy"),
          value:
            filter.sortBy === "priority"
              ? t("project.priority")
              : filter.sortBy === "lastActivity"
                ? t("project.lastUpdated")
                : t("project.manualSort"),
          items: [
            {
              kind: "action" as const,
              id: "sort-priority",
              label: t("project.priority"),
              iconRight:
                filter.sortBy === "priority" ? (
                  <CheckIcon size={12} />
                ) : (
                  <span className="sidebar-project-menu-check" />
                ),
              onSelect: () => filter.onSortBy("priority"),
            },
            {
              kind: "action" as const,
              id: "sort-last-activity",
              label: t("project.lastUpdated"),
              iconRight:
                filter.sortBy === "lastActivity" ? (
                  <CheckIcon size={12} />
                ) : (
                  <span className="sidebar-project-menu-check" />
                ),
              onSelect: () => filter.onSortBy("lastActivity"),
            },
            {
              kind: "action" as const,
              id: "sort-manual",
              label: t("project.manualSort"),
              iconRight:
                filter.sortBy === "manual" ? (
                  <CheckIcon size={12} />
                ) : (
                  <span className="sidebar-project-menu-check" />
                ),
              onSelect: () => filter.onSortBy("manual"),
            },
          ],
        },
        { kind: "divider" as const, id: "filter-switches" },
        {
          kind: "checkbox" as const,
          id: "show-empty-groups",
          label: t("sidebar.filter.showEmptyGroups"),
          checked: filter.showEmptyGroups,
          onToggle: (checked: boolean) => filter.onShowEmptyGroups(checked),
        },
      ]
    : [];

  return (
    <div className="sidebar-section-actions">
      {onCreate && (
        <button
          type="button"
          className="sidebar-section-action"
          onClick={onCreate}
          title={createLabel}
          aria-label={createLabel}
        >
          <PlusIcon size={14} />
        </button>
      )}
      {onToggleSearch && (
        <button
          type="button"
          className={`sidebar-section-action${searchActive ? " active" : ""}`}
          onClick={onToggleSearch}
          title={t("sidebar.section.searchInGroup")}
          aria-label={t("sidebar.section.searchInGroup")}
          aria-pressed={searchActive}
        >
          <MagnifyingGlassIcon size={14} />
        </button>
      )}
      {filter && (
        <DropdownMenu
          align="end"
          minWidth={200}
          items={filterItems}
          trigger={
            <button
              type="button"
              className="sidebar-section-action"
              title={t("sidebar.filter.title")}
              aria-label={t("sidebar.filter.title")}
            >
              <SlidersHorizontalIcon size={14} />
            </button>
          }
        />
      )}
    </div>
  );
}
