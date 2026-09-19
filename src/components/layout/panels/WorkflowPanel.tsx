// src/components/layout/panels/WorkflowPanel.tsx
"use client";

/**
 * WorkflowPanel — the workflow console minimal set (plan 552 Phase 7,
 * ruling-3 shrunk to the grok TUI shape): run list with status, phase
 * trail and duration; expandable journal view; delete for finished
 * runs. Launching/resuming stays with the agent process (trigger
 * layer); the console is a read + hygiene surface.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "@/hooks/useTranslation";
import {
  RepeatIcon,
  CaretDownIcon,
  CaretRightIcon,
  TrashIcon,
} from "@/components/icons";

export interface WorkflowRunRow {
  id: string;
  workflowName: string;
  workflowVersionId: string | null;
  status: string;
  triggerKind: string | null;
  dedupKey: string | null;
  waitTill: number | null;
  pauseMessage: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowJournalRecord {
  seq: number;
  kind: string;
  nodeId: string;
  status: string;
  verification?: string;
  result?: unknown;
  errorClass?: string;
}

type WorkflowApi = {
  list: (filter?: { status?: string; workflowName?: string; limit?: number; offset?: number }) => Promise<unknown[]>;
  journal: (runId: string) => Promise<unknown[]>;
  delete: (id: string) => Promise<boolean>;
};

function api(): WorkflowApi | undefined {
  return (window as unknown as { electronAPI?: { workflow?: WorkflowApi } }).electronAPI?.workflow;
}

const STATUS_STYLES: Record<string, string> = {
  active: "text-[var(--accent)]",
  verifying: "text-[var(--accent)]",
  blocked: "text-yellow-500",
  awaiting_confirm: "text-yellow-500",
  complete: "text-green-600 dark:text-green-400",
  failed: "text-red-500",
  cancelled: "text-[var(--text-muted)]",
  interrupted: "text-orange-500",
};

export function statusClass(status: string): string {
  return STATUS_STYLES[status] ?? "text-[var(--text-muted)]";
}

/** Human duration between two epoch points (m:ss under an hour). */
export function formatDuration(from: number, to: number): string {
  const s = Math.max(0, Math.round((to - from) / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

interface RunRowProps {
  run: WorkflowRunRow;
  expanded: boolean;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
}

export function RunRow({ run, expanded, onToggle, onDelete }: RunRowProps) {
  const { t } = useTranslation();
  const [journal, setJournal] = useState<WorkflowJournalRecord[] | null>(null);
  const [journalError, setJournalError] = useState(false);

  useEffect(() => {
    if (!expanded || journal || journalError) return;
    let alive = true;
    api()
      ?.journal(run.id)
      .then((records) => {
        if (alive) setJournal(records as WorkflowJournalRecord[]);
      })
      .catch(() => {
        if (alive) setJournalError(true);
      });
    return () => {
      alive = false;
    };
  }, [expanded, journal, journalError, run.id]);

  const phaseTrail = useMemo(() => {
    if (!journal) return null;
    return journal.filter((r) => r.kind === "phase");
  }, [journal]);

  const deletable = ["complete", "failed", "cancelled", "interrupted"].includes(run.status);

  return (
    <div className="border-b border-[var(--border)] py-2" data-testid={`workflow-run-${run.id}`}>
      <div className="flex items-center gap-2 px-1">
        <button
          type="button"
          className="text-[var(--text-muted)] hover:text-[var(--text)]"
          aria-expanded={expanded}
          aria-label={expanded ? t("panel.workflow.collapse") : t("panel.workflow.expand")}
          onClick={() => onToggle(run.id)}
        >
          {expanded ? <CaretDownIcon className="h-3.5 w-3.5" /> : <CaretRightIcon className="h-3.5 w-3.5" />}
        </button>
        <span className="font-medium text-[var(--text)]">{run.workflowName}</span>
        <span className={`text-xs font-semibold uppercase ${statusClass(run.status)}`}>{run.status}</span>
        {run.triggerKind && (
          <span className="rounded bg-[var(--bg-surface)] px-1.5 py-0.5 text-xs text-[var(--text-muted)]">{run.triggerKind}</span>
        )}
        <span className="ml-auto text-xs text-[var(--text-muted)]">
          {formatDuration(run.createdAt, run.updatedAt)}
        </span>
        {deletable && (
          <button
            type="button"
            className="text-[var(--text-muted)] hover:text-red-500"
            aria-label={t("panel.workflow.delete")}
            onClick={() => onDelete(run.id)}
          >
            <TrashIcon className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {run.pauseMessage && (
        <div className="px-7 pt-1 text-xs text-[var(--text-muted)]">{run.pauseMessage}</div>
      )}
      {expanded && (
        <div className="px-7 pt-2 text-xs">
          {journalError && <div className="text-[var(--text-muted)]">{t("panel.workflow.journalUnavailable")}</div>}
          {phaseTrail && phaseTrail.length > 0 && (
            <ol className="flex flex-wrap gap-1 pb-1" data-testid={`workflow-phase-trail-${run.id}`}>
              {phaseTrail.map((r) => (
                <li
                  key={`${r.seq}`}
                  className={`rounded bg-[var(--bg-surface)] px-1.5 py-0.5 ${r.status === "succeeded" ? statusClass("complete") : statusClass("active")}`}
                >
                  {r.nodeId}
                </li>
              ))}
            </ol>
          )}
          {journal?.map((r) => (
            <div key={r.seq} className="flex gap-2 py-0.5 text-[var(--text-muted)]">
              <span className="w-24 shrink-0 truncate">{r.nodeId}</span>
              <span className={`w-20 shrink-0 ${r.status === "succeeded" ? statusClass("complete") : statusClass(r.status)}`}>{r.status}</span>
              {r.verification && <span className="w-24 shrink-0">{r.verification}</span>}
              {r.errorClass && <span className="text-red-500">{r.errorClass}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function WorkflowPanel() {
  const { t } = useTranslation();
  const [runs, setRuns] = useState<WorkflowRunRow[] | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api()
      ?.list({ limit: 100 })
      .then((rows) => setRuns(rows as WorkflowRunRow[]))
      .catch(() => setRuns([]));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const onDelete = useCallback(
    (id: string) => {
      void api()?.delete(id).then(() => refresh());
    },
    [refresh],
  );

  const onToggle = useCallback((id: string) => {
    setExpandedId((cur) => (cur === id ? null : id));
  }, []);

  return (
    <div className="flex h-full flex-col bg-[var(--bg-canvas)] text-[var(--text)]">
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2">
        <RepeatIcon className="h-4 w-4 text-[var(--accent)]" />
        <span className="text-sm font-semibold">{t("panel.workflow.title")}</span>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-1">
        {runs === null && <div className="px-1 py-2 text-xs text-[var(--text-muted)]">…</div>}
        {runs?.length === 0 && (
          <div className="px-1 py-2 text-xs text-[var(--text-muted)]">{t("panel.workflow.empty")}</div>
        )}
        {runs?.map((run) => (
          <RunRow
            key={run.id}
            run={run}
            expanded={expandedId === run.id}
            onToggle={onToggle}
            onDelete={onDelete}
          />
        ))}
      </div>
    </div>
  );
}

