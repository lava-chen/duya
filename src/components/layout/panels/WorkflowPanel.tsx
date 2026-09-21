// src/components/layout/panels/WorkflowPanel.tsx
"use client";

/**
 * WorkflowPanel — the workflow console (plan 552 Phase 7, ZCode-parity
 * interaction design).
 *
 * Two tabs on one surface, mirroring ZCode's 定义 | 运行历史 split:
 *
 *   Definitions — the saved library, grouped by scope (project shadows
 *     global). Cards carry name + description + param/trigger/phase
 *     metadata. The definition text is authoritative and READ-ONLY here:
 *     authoring and edits happen in chat (the planner generates, code
 *     validates), never in this panel.
 *
 *   Runs — live vs finished, counted separately. A run row expands into
 *     the evidence view: lineage (retry_of), the four-cell stats strip
 *     (time / tokens / sub-agents / phases), the phase trail with N/M step
 *     counts, per-step journal evidence rows (action + exit code + ms +
 *     size + expandable cached result), artifacts, and the
 *     verified/unconfirmed annotation on every result.
 *
 * Reads only. Launching/resuming belongs to the agent-side trigger layer;
 * cancelling is a store-level action exposed through `workflow:cancel`.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "@/hooks/useTranslation";
import {
  RepeatIcon,
  CaretDownIcon,
  CaretRightIcon,
  TrashIcon,
  StopIcon,
  CopyIcon,
  CheckIcon,
  IconRefresh,
} from "@/components/icons";

// ─── shapes mirrored from the core store / journal ───

export interface WorkflowRunRow {
  id: string;
  workflowName: string;
  workflowVersionId: string | null;
  status: string;
  triggerKind: string | null;
  dedupKey: string | null;
  waitTill: number | null;
  pauseMessage: string | null;
  retryOf: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowDefinitionSummary {
  name: string;
  scope: "project" | "global";
  description: string;
  whenToUse?: string;
  file: string;
  params: Array<{ name: string; type: string; required: boolean; default?: unknown }>;
  triggers: Array<"cron" | "bot" | "http">;
  phaseCount: number;
  nodeCount: number;
  valid: boolean;
  error?: string;
}

export interface WorkflowJournalRecord {
  seq: number;
  kind: string;
  nodeId: string;
  status: string;
  verification?: string;
  errorClass?: string;
  result?: unknown;
  nodeKind?: string;
  action?: string;
  exitCode?: number | null;
  durationMs?: number;
  outputSize?: number;
  childSessionId?: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export type WorkflowApi = {
  list: (filter?: { status?: string; workflowName?: string; limit?: number; offset?: number }) => Promise<unknown[]>;
  journal: (runId: string) => Promise<unknown[]>;
  snapshot: (runId: string) => Promise<unknown>;
  delete: (id: string) => Promise<boolean>;
  cancel: (id: string) => Promise<{ ok: boolean; reason?: string }>;
  run: (payload: { name: string; params?: Record<string, unknown>; projectDir?: string }) => Promise<{ ok: boolean; error?: string; runId?: string }>;
  defs: {
    list: (projectDir?: string) => Promise<unknown[]>;
    get: (payload: { name: string; projectDir?: string }) => Promise<unknown>;
    create: (payload: { def: unknown; scope?: string; projectDir?: string }) => Promise<{ ok: boolean; file?: string; name?: string; error?: string }>;
    update: (payload: { name: string; def: unknown; scope?: string; projectDir?: string }) => Promise<{ ok: boolean; file?: string; name?: string; error?: string }>;
    delete: (payload: { name: string; scope?: string; projectDir?: string }) => Promise<{ ok: boolean; error?: string }>;
  };
};

function api(): WorkflowApi | undefined {
  return (window as unknown as { electronAPI?: { workflow?: WorkflowApi } }).electronAPI?.workflow;
}

// ─── status / formatting helpers (exported for tests) ───

/** Runs still moving (or parked mid-flight) vs durable outcomes. */
export const RUNNING_STATUSES = new Set([
  "inactive",
  "planning",
  "awaiting_confirm",
  "active",
  "verifying",
  "user_paused",
  "backoff_paused",
  "no_progress_paused",
  "infra_paused",
  "blocked",
  "budget_limited",
]);

const STATUS_CLASS: Record<string, string> = {
  active: "text-[var(--accent)]",
  verifying: "text-[var(--accent)]",
  planning: "text-[var(--accent)]",
  blocked: "text-amber-500",
  awaiting_confirm: "text-amber-500",
  budget_limited: "text-amber-500",
  user_paused: "text-amber-500",
  complete: "text-emerald-500",
  failed: "text-red-500",
  cancelled: "text-[var(--text-muted)]",
  interrupted: "text-orange-500",
};

export function statusClass(status: string): string {
  return STATUS_CLASS[status] ?? "text-[var(--text-muted)]";
}

export function isRunning(status: string): boolean {
  return RUNNING_STATUSES.has(status);
}

/** Human duration between two epoch points. */
export function formatDuration(from: number, to: number): string {
  const s = Math.max(0, Math.round((to - from) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Compact count formatting for the stats strip (1723456 → 1.72M). */
export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatBytes(n: number | undefined): string {
  if (!n) return "0 B";
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/** Run-level stats derived purely from journal records (code computes). */
export interface RunStats {
  durationMs: number;
  tokens: number;
  subAgents: number;
  phases: number;
}

export function computeRunStats(run: WorkflowRunRow, journal: WorkflowJournalRecord[]): RunStats {
  let tokens = 0;
  let subAgents = 0;
  const phases = new Set<string>();
  for (const r of journal) {
    if (r.usage) tokens += r.usage.inputTokens + r.usage.outputTokens;
    if (r.nodeKind === "agent" && r.status === "succeeded") subAgents++;
    if (r.kind === "phase") phases.add(r.nodeId);
  }
  return {
    durationMs: Math.max(0, run.updatedAt - run.createdAt),
    tokens,
    subAgents,
    phases: phases.size,
  };
}

/** Per-phase step progress (finished / attempted) for the phase trail. */
export interface PhaseProgress {
  phaseId: string;
  done: number;
  total: number;
  status: "running" | "succeeded" | "failed";
}

export function computePhaseTrail(journal: WorkflowJournalRecord[]): PhaseProgress[] {
  const out: PhaseProgress[] = [];
  const byId = new Map<string, PhaseProgress>();
  for (const r of journal) {
    if (r.kind !== "phase") continue;
    let entry = byId.get(r.nodeId);
    if (!entry) {
      entry = { phaseId: r.nodeId, done: 0, total: 0, status: "running" };
      byId.set(r.nodeId, entry);
      out.push(entry);
    }
    entry.status = r.status === "succeeded" ? "succeeded" : r.status === "failed" ? "failed" : "running";
  }
  // Step counts: node-results grouped under the phase boundaries in order.
  let current: PhaseProgress | undefined;
  for (const r of journal) {
    if (r.kind === "phase") {
      current = byId.get(r.nodeId);
      continue;
    }
    if (!current || r.kind !== "node_result") continue;
    current.total++;
    if (r.status === "succeeded" || r.status === "skipped") current.done++;
  }
  return out;
}

/** Artifact records (screenshots / files) for the artifacts section. */
export function computeArtifacts(journal: WorkflowJournalRecord[]): WorkflowJournalRecord[] {
  return journal.filter((r) => r.kind === "artifact");
}

/** Evidence rows: the per-step view, phases and artifacts excluded. */
export function evidenceRows(journal: WorkflowJournalRecord[]): WorkflowJournalRecord[] {
  return journal.filter((r) => r.kind === "node_result" || r.kind === "decision" || r.kind === "approval");
}

// ─── small pieces ───

function CopyablePath({ path }: { path: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="flex min-w-0 items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
      title={t("panel.workflow.copyPath")}
      onClick={() => {
        void navigator.clipboard?.writeText(path).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      <span className="truncate font-mono">{path}</span>
      {copied ? <CheckIcon className="h-3 w-3 shrink-0" /> : <CopyIcon className="h-3 w-3 shrink-0" />}
    </button>
  );
}

function StatCell({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-sm font-semibold text-[var(--text)]">{value}</span>
      <span className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">{label}</span>
    </div>
  );
}

/** One journal row: action + outcome evidence (ZCode replay-row parity). */
export function EvidenceRow({ record }: { record: WorkflowJournalRecord }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const hasDetail = record.result !== undefined && record.result !== null;

  return (
    <div className="border-b border-[var(--border)]/50 py-1 last:border-b-0" data-testid={`evidence-${record.seq}`}>
      <button
        type="button"
        className="flex w-full items-center gap-2 text-left text-xs"
        aria-expanded={open}
        onClick={() => hasDetail && setOpen((v) => !v)}
      >
        <span className="w-28 shrink-0 truncate font-mono text-[var(--text)]">{record.nodeId}</span>
        {record.action && <span className="w-24 shrink-0 truncate text-[var(--text-muted)]">{record.action}</span>}
        <span className={`w-20 shrink-0 ${statusClass(record.status === "succeeded" ? "complete" : record.status)}`}>
          {record.status === "succeeded" && record.exitCode !== undefined && record.exitCode !== null
            ? `exit ${record.exitCode}`
            : record.status}
        </span>
        {record.verification && (
          <span className="shrink-0 text-[var(--text-muted)]">
            {record.verification === "verified" ? t("panel.workflow.verified") : t("panel.workflow.unconfirmed")}
          </span>
        )}
        {record.errorClass && <span className="shrink-0 text-red-500">{record.errorClass}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-2 text-[10px] text-[var(--text-muted)]">
          {record.durationMs !== undefined && <span>{record.durationMs}ms</span>}
          {record.outputSize !== undefined && <span>{formatBytes(record.outputSize)}</span>}
          {record.childSessionId && <span className="font-mono">{record.childSessionId.slice(0, 8)}</span>}
          {hasDetail && (open ? <CaretDownIcon className="h-3 w-3" /> : <CaretRightIcon className="h-3 w-3" />)}
        </span>
      </button>
      {open && hasDetail && (
        <pre className="mt-1 max-h-48 overflow-auto rounded bg-[var(--bg-surface)] p-2 text-[10px] text-[var(--text-muted)]">
          {typeof record.result === "string" ? record.result : JSON.stringify(record.result, null, 2)}
        </pre>
      )}
    </div>
  );
}

// ─── definitions tab ───

export function DefinitionCard({ def }: { def: WorkflowDefinitionSummary }) {
  const { t } = useTranslation();
  return (
    <div className="rounded-lg border border-[var(--border)] p-3" data-testid={`workflow-def-${def.name}`}>
      <div className="flex items-center gap-2">
        <span className="font-medium text-[var(--text)]">{def.name}</span>
        <span className="rounded bg-[var(--bg-surface)] px-1.5 py-0.5 text-[10px] uppercase text-[var(--text-muted)]">
          {def.scope === "project" ? t("panel.workflow.scopeProject") : t("panel.workflow.scopeGlobal")}
        </span>
        {!def.valid && <span className="text-[10px] font-semibold text-red-500">{t("panel.workflow.invalid")}</span>}
        <div className="ml-auto flex items-center gap-2 text-[10px] text-[var(--text-muted)]">
          {def.phaseCount > 0 && <span>{def.phaseCount} phases</span>}
          {def.nodeCount > 0 && <span>{def.nodeCount} nodes</span>}
        </div>
      </div>
      {def.description && <p className="pt-1 text-xs text-[var(--text-muted)]">{def.description}</p>}
      {def.error && <p className="pt-1 text-xs text-red-500">{def.error}</p>}
      <div className="flex flex-wrap items-center gap-2 pt-2">
        {def.triggers.map((tr) => (
          <span key={tr} className="rounded bg-[var(--bg-surface)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">
            {tr}
          </span>
        ))}
        {def.params.length > 0 && (
          <span className="text-[10px] text-[var(--text-muted)]">
            {t("panel.workflow.paramsShort")} · {def.params.length}
          </span>
        )}
      </div>
      <div className="pt-2">
        <CopyablePath path={def.file} />
      </div>
    </div>
  );
}

export function DefinitionsTab({ projectDir }: { projectDir?: string }) {
  const { t } = useTranslation();
  const [defs, setDefs] = useState<WorkflowDefinitionSummary[] | null>(null);

  const refresh = useCallback(() => {
    api()
      ?.defs.list(projectDir)
      .then((rows) => setDefs(rows as WorkflowDefinitionSummary[]))
      .catch(() => setDefs([]));
  }, [projectDir]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const project = defs?.filter((d) => d.scope === "project") ?? [];
  const global = defs?.filter((d) => d.scope === "global") ?? [];

  return (
    <div className="px-3 py-2">
      <div className="flex items-center gap-2 pb-2">
        <span className="text-xs text-[var(--text-muted)]">
          {t("panel.workflow.savedCount")} · {defs?.length ?? 0}
        </span>
        <button
          type="button"
          className="ml-auto flex items-center gap-1 rounded border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-muted)] hover:text-[var(--text)]"
          onClick={refresh}
          aria-label={t("panel.workflow.refresh")}
        >
          <IconRefresh className="h-3 w-3" />
        </button>
      </div>
      {defs === null && <div className="py-2 text-xs text-[var(--text-muted)]">…</div>}
      {defs?.length === 0 && (
        <div className="py-2 text-xs text-[var(--text-muted)]">{t("panel.workflow.noDefinitions")}</div>
      )}
      {project.length > 0 && (
        <>
          <div className="pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
            {t("panel.workflow.scopeProject")} · {project.length}
          </div>
          <div className="flex flex-col gap-2">
            {project.map((d) => (
              <DefinitionCard key={`p-${d.name}`} def={d} />
            ))}
          </div>
        </>
      )}
      {global.length > 0 && (
        <>
          <div className="pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
            {t("panel.workflow.scopeGlobal")} · {global.length}
          </div>
          <div className="flex flex-col gap-2">
            {global.map((d) => (
              <DefinitionCard key={`g-${d.name}`} def={d} />
            ))}
          </div>
        </>
      )}
      <p className="pt-3 text-[10px] text-[var(--text-muted)]">{t("panel.workflow.definitionsHint")}</p>
    </div>
  );
}

// ─── runs tab ───

interface RunRowProps {
  run: WorkflowRunRow;
  runs: WorkflowRunRow[];
  expanded: boolean;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
  onCancel: (id: string) => void;
}

export function RunRow({ run, runs, expanded, onToggle, onDelete, onCancel }: RunRowProps) {
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

  const stats = useMemo(() => computeRunStats(run, journal ?? []), [run, journal]);
  const trail = useMemo(() => computePhaseTrail(journal ?? []), [journal]);
  const artifacts = useMemo(() => computeArtifacts(journal ?? []), [journal]);
  const rows = useMemo(() => evidenceRows(journal ?? []), [journal]);
  const lineage = run.retryOf ? runs.find((r) => r.id === run.retryOf) : undefined;
  const live = isRunning(run.status);

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
        <span className={`text-xs font-semibold ${statusClass(run.status)}`}>{run.status}</span>
        {run.triggerKind && (
          <span className="rounded bg-[var(--bg-surface)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">
            {run.triggerKind}
          </span>
        )}
        <span className="ml-auto text-xs text-[var(--text-muted)]">
          {formatDuration(run.createdAt, run.updatedAt)}
        </span>
        {live ? (
          <button
            type="button"
            className="flex items-center gap-1 rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)] hover:text-red-500"
            aria-label={t("panel.workflow.stop")}
            onClick={() => onCancel(run.id)}
          >
            <StopIcon className="h-3 w-3" />
            {t("panel.workflow.stop")}
          </button>
        ) : (
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

      {run.pauseMessage && <div className="px-7 pt-1 text-xs text-[var(--text-muted)]">{run.pauseMessage}</div>}

      {expanded && (
        <div className="px-7 pt-2 text-xs">
          {lineage && (
            <div className="pb-1 text-[10px] text-[var(--text-muted)]" data-testid={`workflow-lineage-${run.id}`}>
              {t("panel.workflow.adjustedFrom")} <span className="font-mono">{lineage.id.slice(0, 12)}</span>
            </div>
          )}
          <div className="flex flex-wrap gap-4 rounded-md bg-[var(--bg-surface)] px-3 py-2">
            <StatCell value={formatDuration(0, stats.durationMs)} label={t("panel.workflow.statTime")} />
            <StatCell value={formatCount(stats.tokens)} label={t("panel.workflow.statTokens")} />
            <StatCell value={String(stats.subAgents)} label={t("panel.workflow.statSubAgents")} />
            <StatCell value={String(stats.phases)} label={t("panel.workflow.statPhases")} />
          </div>

          {journalError && <div className="pt-2 text-[var(--text-muted)]">{t("panel.workflow.journalUnavailable")}</div>}

          {trail.length > 0 && (
            <ol className="flex flex-wrap gap-1 pt-2" data-testid={`workflow-phase-trail-${run.id}`}>
              {trail.map((p) => (
                <li
                  key={p.phaseId}
                  className={`flex items-center gap-1 rounded bg-[var(--bg-surface)] px-1.5 py-0.5 ${
                    p.status === "succeeded" ? statusClass("complete") : statusClass(p.status)
                  }`}
                >
                  <span>{p.phaseId}</span>
                  {p.total > 0 && (
                    <span className="text-[10px] text-[var(--text-muted)]">
                      {p.done}/{p.total}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          )}

          {rows.length > 0 && (
            <div className="pt-2" data-testid={`workflow-evidence-${run.id}`}>
              <div className="pb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                {t("panel.workflow.steps")} · {rows.length}
              </div>
              {rows.map((r) => (
                <EvidenceRow key={r.seq} record={r} />
              ))}
            </div>
          )}

          {artifacts.length > 0 && (
            <div className="pt-2" data-testid={`workflow-artifacts-${run.id}`}>
              <div className="pb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                {t("panel.workflow.artifacts")} · {artifacts.length}
              </div>
              {artifacts.map((a) => {
                const ref = (a.result as { ref?: string } | undefined)?.ref ?? "";
                return (
                  <div key={a.seq} className="flex items-center gap-2 py-0.5 text-[10px] text-[var(--text-muted)]">
                    <span className="truncate font-mono">{ref}</span>
                    {a.outputSize !== undefined && <span>{formatBytes(a.outputSize)}</span>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function RunsTab() {
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

  const onCancel = useCallback(
    (id: string) => {
      void api()?.cancel(id).then(() => refresh());
    },
    [refresh],
  );

  const onToggle = useCallback((id: string) => {
    setExpandedId((cur) => (cur === id ? null : id));
  }, []);

  const live = runs?.filter((r) => isRunning(r.status)) ?? [];
  const finished = runs?.filter((r) => !isRunning(r.status)) ?? [];

  return (
    <div className="px-3 py-2">
      <div className="flex items-center gap-2 pb-1">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
          {t("panel.workflow.running")} · {live.length}
        </span>
        <button
          type="button"
          className="ml-auto flex items-center gap-1 rounded border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-muted)] hover:text-[var(--text)]"
          onClick={refresh}
          aria-label={t("panel.workflow.refresh")}
        >
          <IconRefresh className="h-3 w-3" />
        </button>
      </div>
      {runs === null && <div className="py-2 text-xs text-[var(--text-muted)]">…</div>}
      {live.length === 0 && <div className="py-1 text-xs text-[var(--text-muted)]">{t("panel.workflow.noRunning")}</div>}
      {live.map((run) => (
        <RunRow
          key={run.id}
          run={run}
          runs={runs ?? []}
          expanded={expandedId === run.id}
          onToggle={onToggle}
          onDelete={onDelete}
          onCancel={onCancel}
        />
      ))}
      <div className="pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
        {t("panel.workflow.finished")} · {finished.length}
      </div>
      {finished.length === 0 && (
        <div className="py-1 text-xs text-[var(--text-muted)]">{t("panel.workflow.noFinished")}</div>
      )}
      {finished.map((run) => (
        <RunRow
          key={run.id}
          run={run}
          runs={runs ?? []}
          expanded={expandedId === run.id}
          onToggle={onToggle}
          onDelete={onDelete}
          onCancel={onCancel}
        />
      ))}
    </div>
  );
}

// ─── panel shell ───

export interface WorkflowPanelProps {
  /** Session working directory — resolves the project-scope definition root. */
  projectDir?: string;
  /** Panel tab descriptor; `params.workingDirectory` seeds `projectDir`. */
  tab?: { params?: Record<string, unknown> };
}

export function WorkflowPanel({ projectDir, tab: tabDesc }: WorkflowPanelProps = {}) {
  const { t } = useTranslation();
  const resolvedProjectDir =
    projectDir ??
    (typeof tabDesc?.params?.workingDirectory === "string" ? tabDesc.params.workingDirectory : undefined);
  const [tab, setTab] = useState<"definitions" | "runs">("definitions");

  return (
    <div className="flex h-full flex-col bg-[var(--bg-canvas)] text-[var(--text)]">
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2">
        <RepeatIcon className="h-4 w-4 text-[var(--accent)]" />
        <span className="text-sm font-semibold">{t("panel.workflow.title")}</span>
      </div>
      <div className="flex items-center gap-1 border-b border-[var(--border)] px-3 py-1.5" role="tablist">
        {(["definitions", "runs"] as const).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            data-testid={`workflow-tab-${id}`}
            className={`rounded px-2 py-1 text-xs ${
              tab === id
                ? "bg-[var(--bg-surface)] font-semibold text-[var(--text)]"
                : "text-[var(--text-muted)] hover:text-[var(--text)]"
            }`}
            onClick={() => setTab(id)}
          >
            {id === "definitions" ? t("panel.workflow.tabDefinitions") : t("panel.workflow.tabRuns")}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto">
        {tab === "definitions" ? <DefinitionsTab projectDir={resolvedProjectDir} /> : <RunsTab />}
      </div>
    </div>
  );
}
