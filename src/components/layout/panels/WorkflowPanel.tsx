// src/components/layout/panels/WorkflowPanel.tsx
"use client";

/**
 * WorkflowPanel — the workflow console (plan 552 Phase 7, ZCode-parity
 * interaction design).
 *
 * Two tabs on one surface, mirroring ZCode's 定义 | 运行历史 split:
 *
 *   Definitions — the dwf saved library (.dwf.ts frontmatter + script),
 *     grouped by scope (project shadows global). Cards carry name +
 *     description + arg metadata. The script body is authoritative and
 *     READ-ONLY here: authoring and edits happen in chat. Running pops
 *     ZCode's 实参窗: a launch dialog to pick the target project and fill
 *     the declared args before the run is created (workflow:run → the
 *     anchor session's worker executes the real script).
 *
 *   Runs — live vs finished, counted separately. A run row expands into
 *     the evidence view: lineage (retry_of), the four-cell stats strip
 *     (time / tokens / sub-agents / phases), the phase trail with N/M step
 *     counts, per-step journal evidence rows (action + exit code + ms +
 *     size + expandable cached result), artifacts, and the
 *     verified/unconfirmed annotation on every result.
 *
 * Reads only, except for launch + cancel. Launching pops the dialog above;
 * cancelling is a store-level action exposed through `workflow:cancel`.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
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
  ArrowLeftIcon,
} from "@/components/icons";
import { WorkflowLaunchDialog } from "@/components/workflow/WorkflowLaunchDialog";
import { WorkflowRunCard } from "@/components/workflow/WorkflowRunCard";
import {
  journalToArtifacts,
  journalToSteps,
} from "@/components/workflow/run-display/journal-steps";
import type { WorkflowRunSse } from "@/types/stream";

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

/** dwf frontmatter arg declaration (mirrors SavedWorkflowArgDeclaration). */
export interface DwfArgDeclaration {
  type: "string" | "number" | "boolean" | "json";
  description?: string;
  required?: boolean;
  default?: unknown;
}

/** dwf saved-workflow list entry (mirrors SavedWorkflowEntry — no script body). */
export interface DwfWorkflowEntry {
  name: string;
  description: string;
  whenToUse?: string;
  args?: Record<string, DwfArgDeclaration>;
  scope: "project" | "global";
  path: string;
}

export interface DwfInvalidEntry {
  path: string;
  reason: string;
}

export interface DwfListResult {
  entries: DwfWorkflowEntry[];
  invalid: DwfInvalidEntry[];
  dirs: string[];
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
  /**
   * Plan 560 §6.1: one-line digest of what the node was asked to do (e.g.
   * `git tag --list v*`). Display-only — the record otherwise carries only
   * `reqHash`, so a step row would have nothing readable to print.
   */
  inputSummary?: string;
  /** This call was served from the replay cache — the host was never invoked. */
  replayed?: boolean;
}

export type WorkflowApi = {
  list: (filter?: { status?: string; workflowName?: string; limit?: number; offset?: number }) => Promise<unknown[]>;
  journal: (runId: string) => Promise<unknown[]>;
  snapshot: (runId: string) => Promise<unknown>;
  delete: (id: string) => Promise<boolean>;
  cancel: (id: string) => Promise<{ ok: boolean; reason?: string; error?: string }>;
  run: (payload: { name: string; sessionId?: string; params?: Record<string, unknown>; projectDir?: string }) => Promise<{ ok: boolean; error?: string; runId?: string; sessionId?: string }>;
  /** Plan 560 run-anchored surface — a library run needs no chat session. */
  trigger: (payload: { name: string; params?: Record<string, unknown>; projectDir?: string; scope?: "project" | "global" | null }) => Promise<{ ok: boolean; runId?: string; error?: string }>;
  status: (runId: string) => Promise<WorkflowRunRow | null>;
  listRuns: (filter?: { workflowName?: string; origin?: "library" | "session" | "agent" | "cron"; status?: string; limit?: number; offset?: number }) => Promise<WorkflowRunRow[]>;
  getEvents: (payload: { runId: string; afterSeq?: number }) => Promise<WorkflowJournalRecord[]>;
  resolvePermission: (payload: { runId: string; requestId: string; decision: "allow" | "deny" }) => Promise<{ ok: boolean; error?: string }>;
  dwf: {
    list: (projectDir?: string) => Promise<unknown>;
    get: (payload: { name: string; projectDir?: string; homeDir?: string }) => Promise<unknown>;
    save: (payload: { name: string; meta: unknown; script: string; scope?: string; projectDir?: string; homeDir?: string }) => Promise<{ ok: boolean; path?: string; scope?: string; shadowing?: unknown; error?: string }>;
    delete: (payload: { name: string; scope?: string; projectDir?: string; homeDir?: string }) => Promise<{ ok: boolean; error?: string }>;
  };
  /** YAML definition library (legacy, parallel to dwf). */
  defs: {
    list: (projectDir?: string) => Promise<unknown>;
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

export interface PhaseDetailStep {
  nodeId: string;
  label: string;
  nodeKind?: string;
  status: string;
  usage?: { inputTokens: number; outputTokens: number };
  result?: unknown;
  errorClass?: string;
  durationMs?: number;
  outputSize?: number;
  childSessionId?: string;
  exitCode?: number | null;
  verification?: string;
}

export interface PhaseDetail {
  phaseId: string;
  label: string;
  nodeKind?: string;
  status: "running" | "succeeded" | "failed" | "pending";
  done: number;
  total: number;
  steps: PhaseDetailStep[];
}

/** Map a raw journal status to a timeline status lamp family. Honest: picks the
 *  closest of running/succeeded/failed/pending, nothing fabricated. */
function mapPhaseStatus(status: string): PhaseDetail["status"] {
  if (status === "succeeded") return "succeeded";
  if (status === "failed" || status === "interrupted" || status === "stopped" || status === "cancelled")
    return "failed";
  if (RUNNING_STATUSES.has(status) || status === "running") return "running";
  return "pending";
}

/** Per-phase vertical-timeline model: phase records open a group, the journal
 *  records beneath (node_result / decision / approval, in emission order) become
 *  the phase's steps. Mirrors `computePhaseTrail` grouping but keeps the rows. */
export function computePhaseDetail(journal: WorkflowJournalRecord[]): PhaseDetail[] {
  const phases: PhaseDetail[] = [];
  const byId = new Map<string, PhaseDetail>();
  let current: PhaseDetail | undefined;
  for (const r of journal) {
    if (r.kind === "phase") {
      // A node emits start + end phase records; merge into one timeline node.
      let ph = byId.get(r.nodeId);
      if (!ph) {
        ph = {
          phaseId: r.nodeId,
          label: r.action || r.nodeId,
          nodeKind: r.nodeKind,
          status: mapPhaseStatus(r.status),
          done: 0,
          total: 0,
          steps: [],
        };
        byId.set(r.nodeId, ph);
        phases.push(ph);
      } else {
        ph.status = mapPhaseStatus(r.status);
        if (r.action) ph.label = r.action;
        if (r.nodeKind) ph.nodeKind = r.nodeKind;
      }
      current = ph;
      continue;
    }
    if (!current || (r.kind !== "node_result" && r.kind !== "decision" && r.kind !== "approval")) continue;
    current.steps.push({
      nodeId: r.nodeId,
      label: r.action ?? r.nodeId,
      nodeKind: r.nodeKind,
      status: r.status,
      usage: r.usage,
      result: r.result,
      errorClass: r.errorClass,
      durationMs: r.durationMs,
      outputSize: r.outputSize,
      childSessionId: r.childSessionId,
      exitCode: r.exitCode,
      verification: r.verification,
    });
    current.total++;
    if (r.status === "succeeded" || r.status === "skipped") current.done++;
  }
  return phases;
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

/** One journal row: action + outcome evidence (ZCode replay-row parity). */
export function EvidenceRow({
  record,
  index,
  total,
}: {
  record: WorkflowJournalRecord;
  index?: number;
  total?: number;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const hasDetail = record.result !== undefined && record.result !== null;

  const lampClass =
    record.status === "succeeded"
      ? "bg-emerald-500"
      : record.status === "failed"
        ? "bg-red-500"
        : "bg-[var(--accent)] animate-pulse";

  return (
    <div className="border-b border-[var(--border)]/50 py-1 last:border-b-0" data-testid={`evidence-${record.seq}`}>
      <button
        type="button"
        className="flex w-full items-center gap-2 text-left text-xs"
        aria-expanded={open}
        onClick={() => hasDetail && setOpen((v) => !v)}
      >
        <span className={`h-2 w-2 shrink-0 rounded-full ${lampClass}`} />
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
          {index !== undefined && (
            <span className="tabular-nums">{total !== undefined && total > 0 ? `${index + 1}/${total}` : index + 1}</span>
          )}
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

// ─── ZCode-style phase timeline (Runs detail) ───

/** Small glyph per node type, mirroring the dwf node kinds. */
const NODE_GLYPH: Record<string, string> = {
  script: ">_",
  agent: "✧",
  approval: "👤",
  decision: "◇",
  edit: "✎",
  publish: "🚀",
  browser: "🌐",
};

/** Distinct avatar fills for sub-agent clusters, cycled by index within a phase. */
const AVATAR_COLORS = [
  "bg-teal-500",
  "bg-orange-500",
  "bg-purple-500",
  "bg-cyan-500",
  "bg-rose-500",
];

function nodeGlyph(nodeKind: string | undefined, nodeId: string, label: string): string {
  return (nodeKind && NODE_GLYPH[nodeKind]) || NODE_GLYPH[label] || nodeId[0] || "•";
}

function phaseLamp(status: PhaseDetail["status"]): string {
  if (status === "succeeded") return "bg-emerald-500";
  if (status === "failed") return "bg-red-500";
  if (status === "running") return "bg-[var(--accent)] animate-pulse";
  // Pending — hollow node on the connector line.
  return "border border-[var(--text-muted)]";
}

function runStatusLamp(status: string): string {
  if (status === "complete") return "bg-emerald-500";
  if (status === "failed" || status === "cancelled" || status === "interrupted") return "bg-red-500";
  if (isRunning(status)) return "bg-[var(--accent)] animate-pulse";
  return "bg-[var(--text-muted)]";
}

export function PhaseTimeline({ phases }: { phases: PhaseDetail[] }) {
  const { t } = useTranslation();
  const [openId, setOpenId] = useState<string | null>(null);
  if (phases.length === 0) return null;

  return (
    <div className="space-y-2 border-l-2 border-emerald-500/60 pl-3" data-testid="workflow-phase-line">
      {phases.map((phase) => {
        const expanded = openId === phase.phaseId;
        // Sub-agent clusters: agent-kind steps under this phase, tinted by index.
        const agents = phase.steps.filter((s) => s.nodeKind === "agent");
        return (
          <div key={phase.phaseId}>
            <button
              type="button"
              className="flex w-full items-center gap-2 text-left"
              aria-expanded={expanded}
              onClick={() => setOpenId(expanded ? null : phase.phaseId)}
            >
              <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${phaseLamp(phase.status)}`} />
              <span className="shrink-0 text-xs text-[var(--text-muted)]">{nodeGlyph(phase.nodeKind, phase.phaseId, phase.label)}</span>
              <span className="flex-1 truncate text-xs font-medium text-[var(--text)]">{phase.label}</span>
              {agents.length > 0 && (
                <span className="flex shrink-0 items-center -space-x-1">
                  {agents.map((a, i) => (
                    <span
                      key={a.nodeId}
                      title={a.label}
                      className={`h-3.5 w-3.5 rounded-full ${AVATAR_COLORS[i % AVATAR_COLORS.length]} ${
                        a.status === "succeeded" ? "" : "opacity-50"
                      }`}
                    />
                  ))}
                </span>
              )}
              <span className="shrink-0 text-[10px] tabular-nums text-[var(--text-muted)]">{phase.done}/{phase.total}</span>
              {phase.steps.length > 0 && (expanded ? <CaretDownIcon className="h-3 w-3" /> : <CaretRightIcon className="h-3 w-3" />)}
            </button>
            {expanded && (
              <div className="ml-3 mt-1 border-b border-[var(--border)]/30 pb-1" data-testid={`workflow-evidence-${phase.phaseId}`}>
                {phase.steps.map((s, i) => (
                  <EvidenceRow
                    key={`${phase.phaseId}-${s.nodeId}`}
                    record={s as unknown as WorkflowJournalRecord}
                    index={i}
                    total={phase.total}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── definitions tab (dwf saved workflows) ───

/** Default param values gathered from a dwf entry's arg declarations. */
export function dwfDefaultParams(entry: DwfWorkflowEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, decl] of Object.entries(entry.args ?? {})) {
    if (decl.default !== undefined) out[name] = decl.default;
  }
  return out;
}

export function DefinitionCard({
  entry,
  projectDir,
  onLaunched,
}: {
  entry: DwfWorkflowEntry;
  projectDir?: string;
  onLaunched?: () => void;
}) {
  const { t } = useTranslation();
  const [launching, setLaunching] = useState(false);
  const argCount = Object.keys(entry.args ?? {}).length;

  return (
    <div className="rounded-lg border border-[var(--border)] p-3" data-testid={`workflow-def-${entry.name}`}>
      <div className="flex items-center gap-2">
        <span className="font-medium text-[var(--text)]">{entry.name}</span>
        <span className="rounded bg-[var(--bg-surface)] px-1.5 py-0.5 text-[10px] uppercase text-[var(--text-muted)]">
          {entry.scope === "project" ? t("panel.workflow.scopeProject") : t("panel.workflow.scopeGlobal")}
        </span>
        <div className="ml-auto flex items-center gap-2 text-[10px] text-[var(--text-muted)]">
          {argCount > 0 && (
            <span>
              {t("panel.workflow.paramsShort")} · {argCount}
            </span>
          )}
        </div>
      </div>
      {entry.description && <p className="pt-1 text-xs text-[var(--text-muted)]">{entry.description}</p>}
      <div className="flex items-center gap-2 pt-2">
        <button
          type="button"
          data-testid={`workflow-run-${entry.name}`}
          className="flex items-center gap-1 rounded border border-[var(--border)] px-2 py-0.5 text-[10px] text-[var(--text)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
          onClick={() => setLaunching(true)}
        >
          {t("panel.workflow.run")}
        </button>
        <CopyablePath path={entry.path} />
      </div>
      {launching && (
        <WorkflowLaunchDialog
          entry={entry}
          defaultProjectDir={projectDir}
          onClose={() => setLaunching(false)}
          onLaunched={onLaunched ?? (() => {})}
        />
      )}
    </div>
  );
}

export function DefinitionsTab({
  projectDir,
  onLaunched,
}: {
  projectDir?: string;
  onLaunched?: () => void;
}) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<DwfWorkflowEntry[] | null>(null);
  const [invalid, setInvalid] = useState<DwfInvalidEntry[]>([]);

  const refresh = useCallback(() => {
    api()
      ?.dwf.list(projectDir)
      .then((res) => {
        const list = (res ?? { entries: [], invalid: [] }) as DwfListResult;
        setEntries(list.entries ?? []);
        setInvalid(list.invalid ?? []);
      })
      .catch(() => {
        setEntries([]);
        setInvalid([]);
      });
  }, [projectDir]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const project = entries?.filter((d) => d.scope === "project") ?? [];
  const global = entries?.filter((d) => d.scope === "global") ?? [];

  return (
    <div className="px-3 py-2">
      <div className="flex items-center gap-2 pb-2">
        <span className="text-xs text-[var(--text-muted)]">
          {t("panel.workflow.savedCount")} · {entries?.length ?? 0}
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
      {entries === null && <div className="py-2 text-xs text-[var(--text-muted)]">…</div>}
      {entries?.length === 0 && (
        <div className="py-2 text-xs text-[var(--text-muted)]">{t("panel.workflow.noDefinitions")}</div>
      )}
      {project.length > 0 && (
        <>
          <div className="pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
            {t("panel.workflow.scopeProject")} · {project.length}
          </div>
          <div className="flex flex-col gap-2">
            {project.map((d) => (
              <DefinitionCard key={`p-${d.name}`} entry={d} projectDir={projectDir} onLaunched={onLaunched} />
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
              <DefinitionCard key={`g-${d.name}`} entry={d} projectDir={projectDir} onLaunched={onLaunched} />
            ))}
          </div>
        </>
      )}
      {invalid.length > 0 && (
        <div className="pt-3">
          <div className="pb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
            {t("panel.workflow.invalidFiles")} · {invalid.length}
          </div>
          {invalid.map((row) => (
            <div key={row.path} className="py-0.5 text-[10px] text-[var(--text-muted)]">
              <span className="font-mono">{row.path}</span> — {row.reason}
            </div>
          ))}
        </div>
      )}
      <p className="pt-3 text-[10px] text-[var(--text-muted)]">{t("panel.workflow.definitionsHint")}</p>
    </div>
  );
}

// ─── runs tab (stage-rail cards) ───

/**
 * Row + journal → the exact view the run card renders. The card was built for
 * the live SSE shape; history surfaces assemble the same shape from the
 * durable row + its journal, so a historical run and its live twin look
 * identical. Until the journal lands the card renders honest "—" stats and no
 * rail — it fills in the moment the query resolves.
 */
export function rowToRunView(
  row: WorkflowRunRow,
  journal: WorkflowJournalRecord[] | null,
): WorkflowRunSse {
  const steps = journal ? journalToSteps(journal) : undefined;
  const artifacts = journal ? journalToArtifacts(journal) : undefined;
  const stats = journal ? computeRunStats(row, journal) : null;
  const live = isRunning(row.status);
  return {
    runId: row.id,
    workflowName: row.workflowName,
    status: row.status,
    startedAt: row.createdAt,
    ...(live ? {} : { finishedAt: row.updatedAt }),
    ...(stats && stats.tokens > 0 ? { tokens: stats.tokens } : {}),
    ...(steps && steps.length > 0 ? { steps } : {}),
    ...(artifacts && artifacts.length > 0 ? { artifacts } : {}),
    ...(row.pauseMessage ? { stoppedReason: row.pauseMessage } : {}),
  };
}

/**
 * One history entry: the stage-rail card fed from the DB. The journal loads on
 * mount (local SQLite — cheap), and the card's clickable header opens the run
 * detail via `duya:open-workflow-run-panel`, which this panel listens for.
 */
function RunHistoryCard({ run }: { run: WorkflowRunRow }) {
  const [journal, setJournal] = useState<WorkflowJournalRecord[] | null>(null);

  useEffect(() => {
    let alive = true;
    api()
      ?.journal(run.id)
      .then((records) => {
        if (alive) setJournal(records as WorkflowJournalRecord[]);
      })
      .catch(() => {
        /* journal unavailable — the card keeps its header-only view */
      });
    return () => {
      alive = false;
    };
  }, [run.id]);

  const view = useMemo(() => rowToRunView(run, journal), [run, journal]);
  return (
    <div data-testid={`workflow-run-${run.id}`}>
      <WorkflowRunCard run={view} />
    </div>
  );
}

export function RunsTab() {
  const { t } = useTranslation();
  const [runs, setRuns] = useState<WorkflowRunRow[] | null>(null);

  const refresh = useCallback(() => {
    api()
      ?.list({ limit: 100 })
      .then((rows) => setRuns(rows as WorkflowRunRow[]))
      .catch(() => setRuns([]));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const live = runs?.filter((r) => isRunning(r.status)) ?? [];
  const hasLive = live.length > 0;

  // Poll while a run is live so background / engine runs surface in the
  // list in near-real-time and settle into the finished section once done.
  useEffect(() => {
    if (!hasLive) return;
    const id = window.setInterval(refresh, 3000);
    return () => window.clearInterval(id);
  }, [hasLive, refresh]);

  const finished = runs?.filter((r) => !isRunning(r.status)) ?? [];

  return (
    <div className="flex flex-col gap-2 px-3 py-2">
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
        <RunHistoryCard key={run.id} run={run} />
      ))}
      <div className="pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
        {t("panel.workflow.finished")} · {finished.length}
      </div>
      {finished.length === 0 && (
        <div className="py-1 text-xs text-[var(--text-muted)]">{t("panel.workflow.noFinished")}</div>
      )}
      {finished.map((run) => (
        <RunHistoryCard key={run.id} run={run} />
      ))}
    </div>
  );
}

// ─── run detail (sidebar sub-view) ───

/**
 * RunDetailView — the evidence view for one run, opened inside this panel when
 * a history card is clicked (or a chat card's ↗ lands here). Owns the
 * stop/delete affordances that used to live on the list rows, the lineage
 * note, the summary strip, the phase timeline with per-step evidence rows and
 * the artifacts section.
 */
export function RunDetailView({ runId, onBack }: { runId: string; onBack: () => void }) {
  const { t } = useTranslation();
  const [row, setRow] = useState<WorkflowRunRow | null>(null);
  const [missing, setMissing] = useState(false);
  const [journal, setJournal] = useState<WorkflowJournalRecord[] | null>(null);
  const [journalError, setJournalError] = useState(false);

  const refresh = useCallback(() => {
    api()
      ?.status(runId)
      .then((r) => {
        if (r) setRow(r);
        else setMissing(true);
      })
      .catch(() => setMissing(true));
    api()
      ?.journal(runId)
      .then((records) => setJournal(records as WorkflowJournalRecord[]))
      .catch(() => setJournalError(true));
  }, [runId]);

  useEffect(() => {
    setRow(null);
    setMissing(false);
    setJournal(null);
    setJournalError(false);
    refresh();
  }, [refresh]);

  const live = row ? isRunning(row.status) : false;

  // Poll while the run is live, mirroring the list's cadence.
  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(refresh, 3000);
    return () => window.clearInterval(id);
  }, [live, refresh]);

  const stats = useMemo(() => (row ? computeRunStats(row, journal ?? []) : null), [row, journal]);
  const detail = useMemo(() => computePhaseDetail(journal ?? []), [journal]);
  const stepTotal = detail.reduce((n, p) => n + p.total, 0);
  const stepDone = detail.reduce((n, p) => n + p.done, 0);
  const artifacts = useMemo(() => computeArtifacts(journal ?? []), [journal]);

  const onDelete = useCallback(() => {
    void api()?.delete(runId).then(() => onBack());
  }, [runId, onBack]);

  const onCancel = useCallback(() => {
    void api()?.cancel(runId).then(() => refresh());
  }, [runId, refresh]);

  return (
    <div className="flex flex-col px-3 py-2" data-testid="workflow-run-detail">
      <div className="flex items-center gap-2 pb-1">
        <button
          type="button"
          className="flex items-center gap-1 rounded px-1 py-0.5 text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
          aria-label={t("panel.workflow.back")}
          onClick={onBack}
        >
          <ArrowLeftIcon className="h-3.5 w-3.5" />
          {t("panel.workflow.back")}
        </button>
        {row && (
          <span className="ml-auto flex items-center gap-2">
            <span className="text-xs text-[var(--text-muted)]">
              {formatDuration(row.createdAt, row.updatedAt)}
            </span>
            {live ? (
              <button
                type="button"
                className="flex items-center gap-1 rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)] hover:text-red-500"
                aria-label={t("panel.workflow.stop")}
                onClick={onCancel}
              >
                <StopIcon className="h-3 w-3" />
                {t("panel.workflow.stop")}
              </button>
            ) : (
              <button
                type="button"
                className="text-[var(--text-muted)] hover:text-red-500"
                aria-label={t("panel.workflow.delete")}
                onClick={onDelete}
              >
                <TrashIcon className="h-3.5 w-3.5" />
              </button>
            )}
          </span>
        )}
      </div>

      {missing && (
        <div className="py-2 text-xs text-[var(--text-muted)]">{t("panel.workflow.runDetailUnavailable")}</div>
      )}

      {row && (
        <>
          <div className="flex items-center gap-2 py-1">
            <span className={`h-2 w-2 rounded-full ${runStatusLamp(row.status)}`} />
            <span className="min-w-0 truncate font-medium text-[var(--text)]">{row.workflowName}</span>
            <span className={`text-xs font-semibold ${statusClass(row.status)}`}>{row.status}</span>
            {row.triggerKind && (
              <span className="rounded bg-[var(--bg-surface)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">
                {row.triggerKind}
              </span>
            )}
          </div>
          {row.pauseMessage && (
            <div className="pb-1 text-xs text-[var(--text-muted)]">{row.pauseMessage}</div>
          )}

          <div className="flex items-center gap-3 pt-1 text-[10px] text-[var(--text-muted)]">
            {stats && (
              <span>
                {t("panel.workflow.summaryLine", {
                  subAgents: stats.subAgents,
                  done: stepDone,
                  total: stepTotal,
                  tokens: formatCount(stats.tokens),
                })}
              </span>
            )}
          </div>

          {row.retryOf && (
            <div className="pb-1 pt-1 text-[10px] text-[var(--text-muted)]" data-testid={`workflow-lineage-${runId}`}>
              {t("panel.workflow.adjustedFrom")} <span className="font-mono">{row.retryOf.slice(0, 12)}</span>
            </div>
          )}

          {journalError && (
            <div className="pt-2 text-[var(--text-muted)]">{t("panel.workflow.journalUnavailable")}</div>
          )}

          <div className="pt-1" data-testid={`workflow-phase-line-${runId}`}>
            <PhaseTimeline phases={detail} />
          </div>

          {artifacts.length > 0 && (
            <div className="pt-2" data-testid={`workflow-artifacts-${runId}`}>
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
        </>
      )}
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
  // A run card's click / ↗ lands here: the panel switches to the runs tab and
  // opens the run detail sub-view (`params.runId` seeds it on a fresh tab;
  // panel-tab params are frozen on reuse, so the same
  // `duya:open-workflow-run-panel` event also drives re-open below).
  const paramRunId =
    typeof tabDesc?.params?.runId === "string" ? tabDesc.params.runId.trim() : "";
  const [tab, setTab] = useState<"definitions" | "runs">(paramRunId ? "runs" : "definitions");
  const [detailRunId, setDetailRunId] = useState<string>(paramRunId);

  useEffect(() => {
    const handleOpenRunPanel = (event: Event) => {
      const runId = (event as CustomEvent<{ runId?: string }>).detail?.runId;
      if (typeof runId !== "string" || !runId.trim()) return;
      setTab("runs");
      setDetailRunId(runId.trim());
    };
    window.addEventListener("duya:open-workflow-run-panel", handleOpenRunPanel as EventListener);
    return () => {
      window.removeEventListener("duya:open-workflow-run-panel", handleOpenRunPanel as EventListener);
    };
  }, []);

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
        {tab === "definitions" ? (
          <DefinitionsTab projectDir={resolvedProjectDir} onLaunched={() => setTab("runs")} />
        ) : detailRunId ? (
          <RunDetailView runId={detailRunId} onBack={() => setDetailRunId("")} />
        ) : (
          <RunsTab />
        )}
      </div>
    </div>
  );
}
