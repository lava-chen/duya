"use client";

import React, { useMemo } from "react";
import { ArrowRightIcon, CheckCircleIcon, CircleIcon, HandIcon } from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { useProjectWorkspaceStore, isLocalUserLease } from "@/stores/project-workspace-store";
import { useTranslation } from "@/hooks/useTranslation";
import type { TranslationKey } from "@/i18n";

/**
 * ProjectWorkPanel — the project state beside the coordinator conversation.
 *
 * ## What it shows
 *
 * Two lists and nothing else: the project's TASKS and the project's WORKING
 * SESSIONS. Both come from the same Host read as the conversation, so the
 * three cannot disagree about which session belongs to which task.
 *
 * ## Why a working session opens read-only
 *
 * A working session belongs to the project — the Coordinator is usually the
 * one directing it. Opening one to LOOK at it must not silently take it over,
 * so the panel opens the transcript and says what it is; the user asks for
 * the session explicitly with 接管, and gives it back with 交还.
 *
 * The takeover is a real lease, held by the Host: while the user holds it, the
 * Coordinator cannot send that session a new instruction.
 */

interface ProjectWorkPanelProps {
  /** Open a working session. The caller decides whether it opens read-only. */
  onOpenSession: (sessionId: string) => void;
  /** Take a working session over, so the user can work in it directly. */
  onTakeOver: (sessionId: string) => void;
}

const SESSION_STATUS_LABELS: Record<string, TranslationKey> = {
  STREAMING: "project.workspace.statusRunning",
  STARTING: "project.workspace.statusRunning",
  PENDING: "project.workspace.statusRunning",
  IDLE: "project.workspace.statusIdle",
  COMPLETED: "project.workspace.statusDone",
  ERROR: "project.workspace.statusError",
  CRASHED: "project.workspace.statusError",
};

const TASK_STATUS_LABELS: Record<string, TranslationKey> = {
  pending: "project.workspace.taskPending",
  in_progress: "project.workspace.taskInProgress",
  completed: "project.workspace.taskCompleted",
};

export function ProjectWorkPanel({ onOpenSession, onTakeOver }: ProjectWorkPanelProps) {
  const { t } = useTranslation();
  const snapshot = useProjectWorkspaceStore((s) => s.snapshot);
  const sessionStatuses = useProjectWorkspaceStore((s) => s.sessionStatuses);
  const leases = useProjectWorkspaceStore((s) => s.leases);

  const workSessions = snapshot?.workSessions ?? [];
  const tasks = snapshot?.tasks ?? [];

  /** The task a working session executes, by task id. */
  const taskById = useMemo(() => {
    const map = new Map<string, (typeof tasks)[number]>();
    for (const task of tasks) map.set(task.taskId, task);
    return map;
  }, [tasks]);

  if (!snapshot) return null;

  return (
    <aside
      data-testid="project-work-panel"
      className="flex h-full w-[320px] shrink-0 flex-col overflow-y-auto"
      style={{ borderLeft: "1px solid var(--border)", backgroundColor: "var(--surface)" }}
    >
      <section className="px-4 py-3" style={{ borderBottom: "1px solid var(--border)" }}>
        <h3 className="text-xs font-medium uppercase tracking-wide" style={{ color: "var(--muted)" }}>
          {t("project.workspace.tasks")}
        </h3>
        {tasks.length === 0 ? (
          <p className="mt-2 text-xs" style={{ color: "var(--muted)" }}>
            {t("project.workspace.noTasks")}
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1">
            {tasks.map((task) => {
              const statusKey = TASK_STATUS_LABELS[task.status] ?? "project.workspace.taskUnknown";
              const done = task.status === "completed";
              return (
                <li key={task.taskId} className="flex items-start gap-2 text-sm">
                  <span className="mt-0.5 shrink-0" style={{ color: done ? "var(--success, var(--muted))" : "var(--muted)" }}>
                    {done ? <CheckCircleIcon size={14} /> : <CircleIcon size={14} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate" style={{ color: "var(--text)" }} title={task.subject}>
                      {task.subject || task.taskId}
                    </span>
                    <span className="block text-xs" style={{ color: "var(--muted)" }}>
                      {t(statusKey)}
                      {task.workSessionId ? ` · ${task.workSessionId.slice(0, 8)}` : ""}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="px-4 py-3">
        <h3 className="text-xs font-medium uppercase tracking-wide" style={{ color: "var(--muted)" }}>
          {t("project.workspace.workSessions")}
        </h3>
        {workSessions.length === 0 ? (
          <p className="mt-2 text-xs" style={{ color: "var(--muted)" }}>
            {t("project.workspace.noWorkSessions")}
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1">
            {workSessions.map((session) => {
              const liveStatus = sessionStatuses[session.sessionId];
              const statusKey = liveStatus
                ? SESSION_STATUS_LABELS[liveStatus] ?? "project.workspace.statusUnknown"
                : "project.workspace.statusUnknown";
              const running = liveStatus === "STREAMING" || liveStatus === "STARTING";
              const lease = leases[session.sessionId];
              // Only the local user's lease is "the user is working in it".
              const held = isLocalUserLease(lease);
              const task = session.taskId ? taskById.get(session.taskId) : undefined;

              return (
                <li
                  key={session.sessionId}
                  data-testid="project-work-session"
                  className="rounded-lg px-2 py-2"
                  style={{ border: "1px solid var(--border)" }}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px]"
                      style={{
                        backgroundColor: running ? "var(--accent-soft, var(--surface-hover))" : "var(--surface-hover)",
                        color: running ? "var(--accent, var(--text))" : "var(--muted)",
                      }}
                    >
                      {t(statusKey)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm" style={{ color: "var(--text)" }} title={session.title}>
                      {session.title || session.sessionId}
                    </span>
                  </div>
                  {task && (
                    <div className="mt-1 truncate text-xs" style={{ color: "var(--muted)" }} title={task.subject}>
                      {task.subject}
                    </div>
                  )}
                  <div className="mt-2 flex items-center gap-2">
                    <Button variant="ghost" size="sm" onClick={() => onOpenSession(session.sessionId)}>
                      {t("project.workspace.open")}
                      <ArrowRightIcon size={12} />
                    </Button>
                    {held ? (
                      <span className="text-xs" style={{ color: "var(--accent, var(--muted))" }}>
                        <HandIcon size={12} /> {t("project.workspace.holding")}
                      </span>
                    ) : (
                      <Button variant="ghost" size="sm" onClick={() => onTakeOver(session.sessionId)}>
                        {t("project.workspace.takeOver")}
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </aside>
  );
}
