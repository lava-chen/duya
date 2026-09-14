"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  MagnifyingGlassIcon,
  DotsThreeIcon,
  CaretDownIcon,
  CaretRightIcon,
  ChatCirclePlusIcon,
  FolderIcon,
  PencilSimpleIcon,
  ArchiveIcon,
  TrashIcon,
  PlusIcon,
} from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { PageFrame, PageHeader } from "@/components/ui/page";
import { DropdownMenu, type MenuAction } from "@/components/ui/DropdownMenu";
import {
  CreateProjectDialog,
  PROJECT_ICON_REGISTRY,
  projectColorHex,
  type CreateProjectDialogSubmit,
} from "@/components/ui/CreateProjectDialog";
import { useConversationStore, type Thread } from "@/stores/conversation-store";
import { useProjectsStore, type ProjectEntity } from "@/stores/projects-store";
import { useTranslation } from "@/hooks/useTranslation";

/**
 * ProjectsView — Plan 525 project management page (2026-09-13).
 *
 * Codex-style project list: one row per project entity (or per
 * path-only recent folder), avatar + name + last activity; clicking a
 * row expands its session list inline (project-scoped, multi-path —
 * every thread whose workingDirectory is any of `projects.paths`).
 * Each row carries a ⋯ menu: 编辑项目 / 归档聊天 / 移除项目.
 *
 * Rows merge the two existing sources:
 *  - `projects.list()` entities (multi-path, avatar, editable);
 *  - `projects.getRecentFolders()` paths without an entity (removable
 *    via remove-recent-folder, no edit).
 */

interface SessionRow {
  thread: Thread;
}

interface ProjectRowModel {
  key: string;
  kind: "entity" | "path";
  projectId: string | null;
  name: string;
  /** All paths the project covers (entity paths / the single folder). */
  paths: string[];
  icon: string | null;
  color: string | null;
  sessions: Thread[];
  lastActivity: number;
}

const SESSION_PREVIEW = 4;

function formatTimeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (hours < 24) return `${hours}h`;
  return `${days}d`;
}

function ProjectAvatar({ icon, color }: { icon: string | null; color: string | null }) {
  const IconComp = PROJECT_ICON_REGISTRY[icon ?? "FolderIcon"] ?? FolderIcon;
  return (
    <span
      className="flex items-center justify-center rounded-lg shrink-0"
      style={{
        width: 30,
        height: 30,
        color: projectColorHex(color),
        backgroundColor: "var(--surface-hover)",
      }}
    >
      <IconComp size={16} />
    </span>
  );
}

export function ProjectsView() {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [recentFolders, setRecentFolders] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showAllSessions, setShowAllSessions] = useState<Set<string>>(new Set());
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<ProjectEntity | null>(null);

  const threads = useConversationStore((s) => s.threads);
  const { projects, loadProjects, invalidate } = useProjectsStore();
  const createThread = useConversationStore((s) => s.createThread);
  const setActiveThread = useConversationStore((s) => s.setActiveThread);
  const archiveThread = useConversationStore((s) => s.archiveThread);
  const setCurrentView = useConversationStore((s) => s.setCurrentView);

  // Hydrate the entity store + recent folders on mount.
  useEffect(() => {
    void loadProjects();
    window.electronAPI?.projects?.getRecentFolders?.().then((folders) => {
      setRecentFolders(Array.isArray(folders) ? folders : []);
    }).catch(() => setRecentFolders([]));
  }, [loadProjects]);

  const pathKey = useCallback((p: string) => p.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase(), []);

  const rows = useMemo<ProjectRowModel[]>(() => {
    const entityPathSet = new Set<string>();
    const models: ProjectRowModel[] = [];

    const sessionsByPath = new Map<string, Thread[]>();
    for (const thread of threads) {
      if (!thread.workingDirectory) continue;
      const key = pathKey(thread.workingDirectory);
      const list = sessionsByPath.get(key);
      if (list) list.push(thread);
      else sessionsByPath.set(key, [thread]);
    }

    for (const entity of projects) {
      const pathKeys = entity.paths.map((e) => pathKey(e.path));
      pathKeys.forEach((k) => entityPathSet.add(k));
      const sessions = pathKeys.flatMap((k) => sessionsByPath.get(k) ?? []);
      sessions.sort((a, b) => b.updatedAt - a.updatedAt);
      models.push({
        key: entity.project_id,
        kind: "entity",
        projectId: entity.project_id,
        name: entity.name || entity.canonical_root.split(/[\\/]/).pop() || entity.project_id,
        paths: entity.paths.map((e) => e.path),
        icon: entity.icon,
        color: entity.color,
        sessions,
        lastActivity: sessions[0]?.updatedAt ?? entity.last_seen_at,
      });
    }

    for (const folder of recentFolders) {
      const key = pathKey(folder);
      if (entityPathSet.has(key)) continue;
      const sessions = sessionsByPath.get(key) ?? [];
      sessions.sort((a, b) => b.updatedAt - a.updatedAt);
      models.push({
        key: `path:${key}`,
        kind: "path",
        projectId: null,
        name: folder.split(/[\\/]/).filter(Boolean).pop() || folder,
        paths: [folder],
        icon: null,
        color: null,
        sessions,
        lastActivity: sessions[0]?.updatedAt ?? 0,
      });
    }

    models.sort((a, b) => b.lastActivity - a.lastActivity);
    return models;
  }, [projects, recentFolders, threads, pathKey]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.paths.some((p) => p.toLowerCase().includes(q))
    );
  }, [rows, query]);

  const toggleExpanded = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleShowAll = (key: string) => {
    setShowAllSessions((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleNewChatInProject = async (row: ProjectRowModel) => {
    const thread = await createThread({
      workingDirectory: row.paths[0],
      projectName: row.name,
    });
    if (thread) {
      setActiveThread(thread.id);
      setCurrentView("chat");
    }
  };

  const handleArchiveChats = (row: ProjectRowModel) => {
    for (const session of row.sessions) {
      archiveThread(session.id);
    }
  };

  const handleRemove = async (row: ProjectRowModel) => {
    if (row.kind === "entity") {
      if (!window.confirm(t("projects.removeConfirm"))) return;
      const result = await window.electronAPI?.projects?.delete?.(row.projectId!);
      if (!result || !result.success) {
        console.error("[ProjectsView] projects.delete failed:", result?.error);
        return;
      }
      invalidate();
      void loadProjects();
    } else {
      const folders = await window.electronAPI?.projects?.removeRecentFolder?.(row.paths[0]);
      setRecentFolders(Array.isArray(folders) ? folders : []);
    }
  };

  const handleEditSubmit = async (input: CreateProjectDialogSubmit) => {
    if (!editing) return;
    setEditing(null);
    const result = await window.electronAPI?.projects?.update?.(editing.project_id, {
      name: input.name,
      paths: input.paths.map((p) => ({ path: p })),
      icon: input.icon,
      color: input.color,
    });
    if (!result || !result.success) {
      console.error("[ProjectsView] projects.update failed:", result?.error);
      return;
    }
    invalidate();
    void loadProjects();
  };

  return (
    <PageFrame>
      <PageHeader
        title={t("projects.title")}
        actions={
          <>
            <div
              className="flex items-center gap-2 rounded-lg px-3"
              style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)", height: 36, minWidth: 220 }}
            >
              <MagnifyingGlassIcon size={14} style={{ color: "var(--muted)", flexShrink: 0 }} />
              <Input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("projects.searchPlaceholder")}
                className="border-0 bg-transparent p-0 shadow-none focus-visible:ring-0"
                style={{ height: "auto", padding: 0 }}
              />
            </div>
            <Button variant="primary" size="md" onClick={() => setCreateOpen(true)}>
              <PlusIcon size={14} />
              {t("project.createProject")}
            </Button>
          </>
        }
      />

      {/* Column header strip (matches the Codex table look). */}
      <div
        className="flex items-center px-4 text-xs uppercase tracking-wide select-none"
        style={{ color: "var(--muted)", paddingTop: 8, paddingBottom: 6 }}
      >
        <span style={{ width: 30, flexShrink: 0 }} />
        <span className="flex-1">{t("projects.columnName")}</span>
        <span style={{ width: 72, textAlign: "right" }}>{t("projects.columnUpdated")}</span>
        <span style={{ width: 32, flexShrink: 0 }} />
      </div>

      <div className="flex flex-col overflow-y-auto" style={{ borderTop: "1px solid var(--border)" }}>
        {filtered.length === 0 && (
          <div className="py-16 text-center text-sm" style={{ color: "var(--muted)" }}>
            {query.trim() ? t("projects.noSearchMatch") : t("projects.empty")}
          </div>
        )}
        {filtered.map((row) => {
          const isExpanded = expanded.has(row.key);
          const showAll = showAllSessions.has(row.key);
          const visibleSessions = showAll ? row.sessions : row.sessions.slice(0, SESSION_PREVIEW);
          return (
            <div key={row.key} style={{ borderBottom: "1px solid var(--border)" }}>
              <div
                className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-[var(--surface-hover)]"
                style={{ minHeight: 52 }}
              >
                <button
                  type="button"
                  onClick={() => toggleExpanded(row.key)}
                  className="flex items-center justify-center shrink-0"
                  style={{ width: 30, height: 30, color: "var(--muted)" }}
                  aria-label={isExpanded ? t("projects.showLess") : t("projects.showMore")}
                >
                  {isExpanded ? <CaretDownIcon size={12} /> : <CaretRightIcon size={12} />}
                </button>
                <button
                  type="button"
                  onClick={() => toggleExpanded(row.key)}
                  className="flex items-center gap-3 flex-1 min-w-0 text-left"
                >
                  <ProjectAvatar icon={row.icon} color={row.color} />
                  <span className="flex flex-col min-w-0">
                    <span className="text-sm font-medium truncate" style={{ color: "var(--text)" }} title={row.name}>
                      {row.name}
                    </span>
                    <span className="text-xs truncate" style={{ color: "var(--muted)" }} title={row.paths.join(" · ")}>
                      {row.paths.map((p) => p.split(/[\\/]/).filter(Boolean).pop()).join(" · ")}
                    </span>
                  </span>
                </button>
                <span
                  className="text-xs shrink-0"
                  style={{ width: 72, textAlign: "right", color: "var(--muted)" }}
                  title={new Date(row.lastActivity).toLocaleString()}
                >
                  {row.lastActivity > 0 ? formatTimeAgo(row.lastActivity) : "—"}
                </span>
                <div className="shrink-0" style={{ width: 32 }}>
                  <DropdownMenu
                    className="project-dropdown-menu"
                    align="end"
                    minWidth={180}
                    items={[
                      {
                        kind: "action",
                        id: "new-chat",
                        label: t("projects.newChatInProject"),
        className: "project-dropdown-item",
                        iconLeft: <ChatCirclePlusIcon size={14} />,
                        onSelect: () => handleNewChatInProject(row),
                      },
                      ...(row.kind === "entity"
                        ? [
                            {
                              kind: "action" as const,
                              id: "edit",
                              label: t("projects.editProject"),
        className: "project-dropdown-item",
                              iconLeft: <PencilSimpleIcon size={14} />,
                              onSelect: () => {
                                const entity = projects.find((p) => p.project_id === row.projectId);
                                if (entity) setEditing(entity);
                              },
                            },
                          ]
                        : []),
                      {
                        kind: "action",
                        id: "archive",
                        label: t("projects.archiveChats"),
        className: "project-dropdown-item",
                        iconLeft: <ArchiveIcon size={14} />,
                        disabled: row.sessions.length === 0,
                        onSelect: () => handleArchiveChats(row),
                      },
                      { kind: "divider", id: "sep-remove" },
                      {
                        kind: "action",
                        id: "remove",
                        label: t("projects.removeProject"),
        className: "project-dropdown-item",
                        iconLeft: <TrashIcon size={14} />,
                        danger: true,
                        onSelect: () => void handleRemove(row),
                      },
                    ]}
                    trigger={
                      <button
                        type="button"
                        className="flex items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-hover)]"
                        style={{ width: 28, height: 28, color: "var(--muted)" }}
                        aria-label={t("projects.editProject")}
                      >
                        <DotsThreeIcon size={16} />
                      </button>
                    }
                  />
                </div>
              </div>

              {isExpanded && (
                <div>
                  {row.sessions.length === 0 ? (
                    <div
                      className="px-4 py-3 text-xs"
                      style={{ paddingLeft: 58, color: "var(--muted)" }}
                    >
                      —
                    </div>
                  ) : (
                    visibleSessions.map((session) => (
                      <SessionRowItem key={session.id} thread={session} />
                    ))
                  )}
                  {row.sessions.length > SESSION_PREVIEW && !showAll && (
                    <button
                      type="button"
                      onClick={() => toggleShowAll(row.key)}
                      className="w-full flex items-center gap-1 px-4 py-2 text-left text-xs transition-colors hover:bg-[var(--surface-hover)]"
                      style={{ paddingLeft: 58, color: "var(--muted)" }}
                    >
                      <CaretDownIcon size={10} /> {t("projects.showMore")} ({row.sessions.length - SESSION_PREVIEW})
                    </button>
                  )}
                  {showAll && row.sessions.length > SESSION_PREVIEW && (
                    <button
                      type="button"
                      onClick={() => toggleShowAll(row.key)}
                      className="w-full flex items-center gap-1 px-4 py-2 text-left text-xs transition-colors hover:bg-[var(--surface-hover)]"
                      style={{ paddingLeft: 58, color: "var(--muted)" }}
                    >
                      <CaretRightIcon size={10} /> {t("projects.showLess")}
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <CreateProjectDialog
        isOpen={createOpen || editing !== null}
        mode={editing ? "edit" : "create"}
        initial={
          editing
            ? {
                name: editing.name,
                paths: editing.paths.map((p) => p.path),
                icon: editing.icon,
                color: editing.color,
              }
            : undefined
        }
        onCancel={() => {
          setCreateOpen(false);
          setEditing(null);
        }}
        onConfirm={(input) => {
          if (editing) {
            void handleEditSubmit(input);
          } else {
            setCreateOpen(false);
            // The create flow (entity + thread) is owned by the sidebar;
            // from the page we mirror the same semantics inline.
            void handleCreateFromPage(input);
          }
        }}
      />
    </PageFrame>
  );

  async function handleCreateFromPage(input: CreateProjectDialogSubmit) {
    let firstPath = input.paths[0] ?? null;
    if (!firstPath) {
      if (!window.electronAPI?.app?.createProjectFolder) return;
      const result = await window.electronAPI.app.createProjectFolder(input.name);
      if (!result.success || !result.path) {
        console.error("[ProjectsView] createProjectFolder failed:", result.error);
        return;
      }
      firstPath = result.path;
    }
    const register = window.electronAPI?.projects?.register;
    if (register) {
      const registered = await register({
        name: input.name,
        paths: (input.paths.length > 0 ? input.paths : [firstPath]).map((p) => ({ path: p })),
        icon: input.icon,
        color: input.color,
      });
      if (!registered.success) {
        console.error("[ProjectsView] projects.register failed:", registered.error);
      }
    }
    invalidate();
    void loadProjects();
    const thread = await createThread({ workingDirectory: firstPath, projectName: input.name });
    if (thread) {
      setActiveThread(thread.id);
      setCurrentView("chat");
    }
  }
}

function SessionRowItem({ thread }: SessionRowItemProps) {
  const setActiveThread = useConversationStore((s) => s.setActiveThread);
  const setCurrentView = useConversationStore((s) => s.setCurrentView);
  return (
    <button
      type="button"
      onClick={() => {
        setActiveThread(thread.id);
        setCurrentView("chat");
      }}
      className="w-full flex items-center gap-2 px-4 py-2 text-left transition-colors hover:bg-[var(--surface-hover)]"
      style={{ paddingLeft: 58 }}
    >
      <span className="text-xs flex-1 truncate" style={{ color: "var(--text)" }} title={thread.title}>
        {thread.title || thread.id}
      </span>
      <span className="text-xs shrink-0" style={{ color: "var(--muted)" }}>
        {formatTimeAgo(thread.updatedAt)}
      </span>
    </button>
  );
}

interface SessionRowItemProps {
  thread: Thread;
}
