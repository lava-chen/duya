"use client";

import React, { useMemo } from "react";
import { ArrowRightIcon, CheckCircleIcon, CircleIcon, HandIcon } from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { useProjectWorkspaceStore, isLocalUserLease } from "@/stores/project-workspace-store";
import { useTranslation } from "@/hooks/useTranslation";
import type { TranslationKey } from "@/i18n";
import type { ProjectActivity } from "@duya/agent-protocol";

/**
 * ProjectWorkPanel — the project state beside the coordinator conversation.
 *
 * ## What it shows
 *
 * Two lists and nothing else used to be true: the project's TASKS and the
 * project's WORKING SESSIONS, both from the same Host read as the conversation
 * so they cannot disagree about which session belongs to which task. The
 * continuity read now adds the user's review queue (decision/memory
 * candidates), a paged ACTIVITY timeline and TRANSCRIPT REFS — pointers into
 * MessageLog, never a second copy of the conversation.
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

/** One decision or memory the Coordinator proposed and the user must review. */
interface ReviewCandidate {
  readonly key: string;
  readonly content: string;
  readonly revision: number;
}

/**
 * The project's durable event log. Activity is append-only and paged by the
 * Host (`event_id > after`), so this list shows the newest loaded events and
 * can extend backwards one page at a time. Transcript bodies are NOT here.
 */
function ActivityTimeline({
  items, hasMore, loading, onLoadMore, onOpenSession,
}: {
  readonly items: readonly ProjectActivity[];
  readonly hasMore: boolean;
  readonly loading: boolean;
  readonly onLoadMore: () => void;
  readonly onOpenSession: (sessionId: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="px-4 py-3" style={{ borderTop: "1px solid var(--border)" }}>
      <h3 className="text-xs font-medium uppercase tracking-wide" style={{ color: "var(--muted)" }}>
        {t("project.workspace.activityTitle")}
      </h3>
      {items.length === 0 ? (
        <p className="mt-2 text-xs" style={{ color: "var(--muted)" }}>
          {t("project.workspace.activityEmpty")}
        </p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2" data-testid="project-activity-list">
          {items.map((item) => {
            const details = Object.entries(item.payload).slice(0, 3)
              .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
              .join(" · ");
            return (
              <li
                key={item.cursor}
                data-testid="project-activity-entry"
                className="rounded-lg px-2 py-2"
                style={{ border: "1px solid var(--border)" }}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs font-medium" style={{ color: "var(--text)" }} title={item.type}>
                    {item.type}
                  </span>
                  <time className="shrink-0 text-[10px]" style={{ color: "var(--muted)" }}>
                    {new Date(item.createdAt).toLocaleString()}
                  </time>
                </div>
                {(item.taskId || item.sessionId) && (
                  <div className="mt-1 truncate text-[10px]" style={{ color: "var(--muted)" }}>
                    {item.taskId ? `task ${item.taskId}` : ""}
                    {item.taskId && item.sessionId ? " · " : ""}
                    {item.sessionId ? `session ${item.sessionId}` : ""}
                  </div>
                )}
                {details && (
                  <div className="mt-1 truncate text-[10px]" style={{ color: "var(--muted)" }} title={details}>
                    {details.slice(0, 200)}
                  </div>
                )}
                {item.sessionId && (
                  <Button variant="ghost" size="sm" onClick={() => onOpenSession(item.sessionId!)}>
                    {t("project.workspace.open")}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {hasMore && (
        <Button variant="ghost" size="sm" disabled={loading} onClick={onLoadMore}>
          {t("project.workspace.activityLoadMore")}
        </Button>
      )}
    </section>
  );
}

/** Where to read the original conversation — MessageLog stays authoritative. */
function TranscriptRefs({
  refs, onOpenSession,
}: {
  readonly refs: readonly { sessionId: string; role: "coordinator" | "work"; taskId?: string }[];
  readonly onOpenSession: (sessionId: string) => void;
}) {
  const { t } = useTranslation();
  if (refs.length === 0) return null;
  return (
    <section className="px-4 py-3" style={{ borderTop: "1px solid var(--border)" }}>
      <h3 className="text-xs font-medium uppercase tracking-wide" style={{ color: "var(--muted)" }}>
        {t("project.workspace.transcriptsTitle")}
      </h3>
      <ul className="mt-2 flex flex-col gap-1">
        {refs.map((ref) => (
          <li key={ref.sessionId} data-testid="project-transcript-ref">
            <Button variant="ghost" size="sm" onClick={() => onOpenSession(ref.sessionId)}>
              {t(ref.role === "coordinator"
                ? "project.workspace.transcriptCoordinator"
                : "project.workspace.transcriptWork")}
              {" · "}{ref.sessionId.slice(0, 8)}
              {ref.taskId ? ` · ${ref.taskId.slice(0, 8)}` : ""}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

interface CandidateListProps {
  readonly title: TranslationKey;
  readonly items: readonly ReviewCandidate[];
  readonly pending: boolean;
  /** `confirm: true` accepts (or corrects and accepts); false discards. */
  readonly onReview: (item: ReviewCandidate, content: string, confirm: boolean) => void;
}

/**
 * The user half of project continuity.
 *
 * A Coordinator can only PROPOSE a decision / memory candidate; only the
 * accepted decisions and active memories are ever injected into the prompt
 * (project/context.ts). Without this list the project memory is a dead end,
 * so each candidate gets three explicit actions: confirm, correct (edit the
 * content and confirm), and discard.
 */
function CandidateList({ title, items, pending, onReview }: CandidateListProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState("");
  if (items.length === 0) return null;

  return (
    <section className="px-4 py-3" style={{ borderTop: "1px solid var(--border)" }}>
      <h3 className="text-xs font-medium uppercase tracking-wide" style={{ color: "var(--muted)" }}>
        {t(title)}
      </h3>
      <ul className="mt-2 flex flex-col gap-2">
        {items.map((item) => (
          <li
            key={item.key}
            data-testid="project-review-candidate"
            className="rounded-lg px-2 py-2"
            style={{ border: "1px solid var(--border)" }}
          >
            <div className="truncate text-xs font-medium" style={{ color: "var(--text)" }} title={item.key}>
              {item.key}
            </div>
            {editing === item.key ? (
              <div className="mt-1 flex flex-col gap-1">
                <textarea
                  aria-label={t("project.workspace.reviewCorrect")}
                  className="w-full rounded px-2 py-1 text-xs"
                  style={{ backgroundColor: "var(--surface-hover)", color: "var(--text)" }}
                  rows={3}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                />
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={pending || draft.trim() === ""}
                    onClick={() => {
                      onReview(item, draft.trim(), true);
                      setEditing(null);
                    }}
                  >
                    {t("project.workspace.reviewSave")}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>
                    {t("project.workspace.reviewCancel")}
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <p className="mt-1 whitespace-pre-wrap break-words text-xs" style={{ color: "var(--muted)" }}>
                  {item.content}
                </p>
                <div className="mt-1 flex flex-wrap gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    onClick={() => onReview(item, item.content, true)}
                  >
                    {t("project.workspace.reviewAccept")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    onClick={() => {
                      setEditing(item.key);
                      setDraft(item.content);
                    }}
                  >
                    {t("project.workspace.reviewCorrect")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    onClick={() => onReview(item, item.content, false)}
                  >
                    {t("project.workspace.reviewDiscard")}
                  </Button>
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
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
  const continuity = useProjectWorkspaceStore((s) => s.continuity);
  const actionError = useProjectWorkspaceStore((s) => s.actionError);
  const actionPending = useProjectWorkspaceStore((s) => s.actionPending);
  const acceptTask = useProjectWorkspaceStore((s) => s.acceptTask);
  const reviewDecision = useProjectWorkspaceStore((s) => s.reviewDecision);
  const reviewMemory = useProjectWorkspaceStore((s) => s.reviewMemory);
  const hasMoreActivity = useProjectWorkspaceStore((s) => s.continuityHasMoreActivity) ?? false;
  const activityLoading = useProjectWorkspaceStore((s) => s.activityLoading) ?? false;
  const loadMoreActivity = useProjectWorkspaceStore((s) => s.loadMoreActivity);

  const workSessions = snapshot?.workSessions ?? [];
  const tasks = snapshot?.tasks ?? [];

  /** Acceptance lives on the task LINK, which only the continuity read has. */
  const acceptanceByTaskId = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of continuity?.tasks ?? []) {
      map.set(entry.link.taskId, entry.link.acceptanceStatus);
    }
    return map;
  }, [continuity]);

  // The Host returns `event_id > after` in ascending order; the timeline is
  // read newest-first. Sort here rather than relying on the store having
  // sorted the snapshot, so any caller of this component sees the same order.
  const activityItems = useMemo(
    () => [...(continuity?.activity ?? [])].sort((a, b) => b.cursor - a.cursor),
    [continuity],
  );

  const decisionCandidates: readonly ReviewCandidate[] = (continuity?.decisions ?? [])
    .filter((item) => item.status === "proposed")
    .map(({ key, content, revision }) => ({ key, content, revision }));
  const memoryCandidates: readonly ReviewCandidate[] = (continuity?.memories ?? [])
    .filter((item) => item.status === "candidate")
    .map(({ key, content, revision }) => ({ key, content, revision }));

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
              const acceptance = acceptanceByTaskId.get(task.taskId);
              return (
                <li key={task.taskId} className="flex flex-col gap-1 text-sm">
                  <div className="flex items-start gap-2">
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
                  </div>
                  {acceptance === "accepted" || acceptance === "rejected" ? (
                    <span className="pl-5 text-xs" style={{ color: "var(--muted)" }}>
                      {t(acceptance === "accepted" ? "project.workspace.acceptanceAccepted" : "project.workspace.acceptanceRejected")}
                    </span>
                  ) : (
                    <div className="flex gap-1 pl-5">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={actionPending}
                        onClick={() => void acceptTask?.(task.taskId, "accepted")}
                      >
                        {t("project.workspace.acceptTask")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={actionPending}
                        onClick={() => void acceptTask?.(task.taskId, "rejected")}
                      >
                        {t("project.workspace.rejectTask")}
                      </Button>
                    </div>
                  )}
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

      {actionError && (
        <div
          role="alert"
          data-testid="project-action-error"
          className="px-4 py-2 text-xs"
          style={{ backgroundColor: "var(--error-soft)", color: "var(--error)", borderTop: "1px solid var(--border)" }}
        >
          {actionError}
        </div>
      )}

      <CandidateList
        title="project.workspace.reviewDecisions"
        items={decisionCandidates}
        pending={actionPending ?? false}
        onReview={(item, content, confirm) =>
          void reviewDecision?.({
            key: item.key,
            content,
            status: confirm ? "accepted" : "superseded",
            expectedRevision: item.revision,
          })
        }
      />
      <CandidateList
        title="project.workspace.reviewMemories"
        items={memoryCandidates}
        pending={actionPending ?? false}
        onReview={(item, content, confirm) =>
          void reviewMemory?.({
            key: item.key,
            content,
            status: confirm ? "active" : "retired",
            expectedRevision: item.revision,
          })
        }
      />

      <ActivityTimeline
        items={activityItems}
        hasMore={hasMoreActivity}
        loading={activityLoading}
        onLoadMore={() => void loadMoreActivity?.()}
        onOpenSession={onOpenSession}
      />
      <TranscriptRefs refs={continuity?.transcriptRefs ?? []} onOpenSession={onOpenSession} />
    </aside>
  );
}
