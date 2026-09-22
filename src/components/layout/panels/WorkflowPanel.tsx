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
}

export type WorkflowApi = {
  list: (filter?: { status?: string; workflowName?: string; limit?: number; offset?: number }) => Promise<unknown[]>;
  journal: (runId: string) => Promise<unknown[]>;
  snapshot: (runId: string) => Promise<unknown>;
  delete: (id: string) => Promise<boolean>;
  cancel: (id: string) => Promise<{ ok: boolean; reason?: string }>;
  run: (payload: { name: string; sessionId?: string; params?: Record<string, unknown>; projectDir?: string }) => Promise<{ ok: boolean; error?: string; runId?: string; sessionId?: string }>;
  defs: {
    list: (projectDir?: string) => Promise<unknown[]>;
    get: (payload: { name: string; projectDir?: string }) => Promise<unknown>;
    create: (payload: { def: unknown; scope?: string; projectDir?: string }) => Promise<{ ok: boolean; file?: string; name?: string; error?: string }>;
    update: (payload: { name: string; def: unknown; scope?: string; projectDir?: string }) => Promise<{ ok: boolean; file?: string; name?: string; error?: string }>;
    delete: (payload: { name: string; scope?: string; projectDir?: string }) => Promise<{ ok: boolean; error?: string }>;
  };
  dwf: {
    list: (projectDir?: string) => Promise<unknown>;
    get: (payload: { name: string; projectDir?: string; homeDir?: string }) => Promise<unknown>;
    save: (payload: { name: string; meta: unknown; script: string; scope?: string; projectDir?: string; homeDir?: string }) => Promise<{ ok: boolean; path?: string; scope?: string; shadowing?: unknown; error?: string }>;
    delete: (payload: { name: string; scope?: string; projectDir?: string; homeDir?: string }) => Promise<{ ok: boolean; error?: string }>;
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

// ─── definitions tab (dwf saved workflows) ───

/** Default param values gathered from a dwf entry's arg declarations. */
export function dwfDefaultParams(entry: DwfWorkflowEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, decl] of Object.entries(entry.args ?? {})) {
    if (decl.default !== undefined) out[name] = decl.default;
  }
  return out;
}

const LAUNCH_INPUT_CLS =
  "w-full rounded border border-[var(--border)] bg-[var(--bg-canvas)] px-2 py-1 text-xs text-[var(--text)] focus:border-[var(--accent)] focus:outline-none";

function ArgInput({
  decl,
  value,
  onChange,
}: {
  decl: DwfArgDeclaration;
  value: string;
  onChange: (v: string) => void;
}) {
  if (decl.type === "boolean") {
    return (
      <input
        type="checkbox"
        checked={value === "true"}
        onChange={(e) => onChange(e.target.checked ? "true" : "false")}
        className="h-3.5 w-3.5 accent-[var(--accent)]"
      />
    );
  }
  if (decl.type === "json") {
    return (
      <textarea
        value={value}
        rows={3}
        placeholder={decl.default !== undefined ? JSON.stringify(decl.default) : undefined}
        onChange={(e) => onChange(e.target.value)}
        className={`${LAUNCH_INPUT_CLS} font-mono`}
      />
    );
  }
  return (
    <input
      type={decl.type === "number" ? "number" : "text"}
      value={value}
      placeholder={decl.default !== undefined ? String(decl.default) : undefined}
      onChange={(e) => onChange(e.target.value)}
      className={LAUNCH_INPUT_CLS}
    />
  );
}

/**
 * ZCode's 实参窗: pick the target project, fill the declared args, then
 * launch. Absent args fall back to the declared defaults worker-side.
 */
export function WorkflowLaunchDialog({
  entry,
  defaultProjectDir,
  onClose,
  onLaunched,
}: {
  entry: DwfWorkflowEntry;
  defaultProjectDir?: string;
  onClose: () => void;
  onLaunched: () => void;
}) {
  const { t } = useTranslation();
  const [projectDir, setProjectDir] = useState(defaultProjectDir ?? "");
  const [values, setValues] = useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {};
    for (const [name, decl] of Object.entries(entry.args ?? {})) {
      if (decl.default !== undefined) {
        seed[name] = decl.type === "json" ? JSON.stringify(decl.default) : String(decl.default);
      } else if (decl.type === "boolean") {
        seed[name] = "false";
      } else {
        seed[name] = "";
      }
    }
    return seed;
  });
  const [error, setError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);

  const argEntries = useMemo(() => Object.entries(entry.args ?? {}), [entry]);

  const submit = useCallback(async () => {
    const params: Record<string, unknown> = {};
    for (const [name, decl] of argEntries) {
      const raw = (values[name] ?? "").trim();
      if (raw === "" || (decl.type === "boolean" && raw === "false")) {
        if (decl.required === true && raw === "") {
          setError(`${name}: ${t("panel.workflow.argRequired")}`);
          return;
        }
        continue; // absent → declared default applies worker-side
      }
      if (decl.type === "number") {
        const n = Number(raw);
        if (!Number.isFinite(n)) {
          setError(`${name}: not a number`);
          return;
        }
        params[name] = n;
      } else if (decl.type === "boolean") {
        params[name] = raw === "true";
      } else if (decl.type === "json") {
        try {
          params[name] = JSON.parse(raw);
        } catch {
          setError(`${name}: invalid JSON`);
          return;
        }
      } else {
        params[name] = raw;
      }
    }
    if (!projectDir.trim()) {
      setError(t("panel.workflow.launchProject"));
      return;
    }
    setLaunching(true);
    setError(null);
    try {
      const res = await api()?.run({ name: entry.name, params, projectDir: projectDir.trim() });
      if (res && res.ok === false) {
        setError(res.error ?? t("panel.workflow.launchFailed"));
        return;
      }
      onLaunched();
      onClose();
    } finally {
      setLaunching(false);
    }
  }, [argEntries, values, projectDir, entry.name, onLaunched, onClose, t]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      data-testid={`workflow-launch-${entry.name}`}
      onClick={onClose}
    >
      <div
        className="w-[420px] max-w-[90vw] rounded-lg border border-[var(--border)] bg-[var(--bg-canvas)] shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-[var(--border)] px-4 py-2.5 text-sm font-semibold text-[var(--text)]">
          {t("panel.workflow.launchTitle")} · {entry.name}
        </div>
        <div className="flex flex-col gap-3 px-4 py-3 text-xs">
          <div>
            <label className="block pb-1 text-[var(--text-muted)]">{t("panel.workflow.launchProject")}</label>
            <input
              value={projectDir}
              onChange={(e) => setProjectDir(e.target.value)}
              data-testid="workflow-launch-project"
              className={LAUNCH_INPUT_CLS}
            />
            <p className="pt-1 text-[10px] text-[var(--text-muted)]">{t("panel.workflow.launchProjectHint")}</p>
          </div>
          {argEntries.length > 0 && (
            <div>
              <div className="pb-1 text-[var(--text-muted)]">{t("panel.workflow.launchArgs")}</div>
              <div className="flex flex-col gap-2">
                {argEntries.map(([name, decl]) => (
                  <div key={name} className="flex flex-col gap-0.5" data-testid={`workflow-launch-arg-${name}`}>
                    <label className="flex items-center gap-1.5 text-[var(--text)]">
                      <span className="font-mono">{name}</span>
                      <span className="text-[10px] text-[var(--text-muted)]">{decl.type}</span>
                      {decl.required === true && (
                        <span className="text-[10px] text-amber-500">{t("panel.workflow.argRequired")}</span>
                      )}
                    </label>
                    <ArgInput
                      decl={decl}
                      value={values[name] ?? ""}
                      onChange={(v) => setValues((cur) => ({ ...cur, [name]: v }))}
                    />
                    {decl.description && <span className="text-[10px] text-[var(--text-muted)]">{decl.description}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
          {error && (
            <div className="text-red-500" data-testid="workflow-launch-error">
              {error}
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] px-4 py-2.5">
          <button
            type="button"
            className="rounded border border-[var(--border)] px-2.5 py-1 text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
            onClick={onClose}
            data-testid="workflow-launch-cancel"
          >
            {t("panel.workflow.dialogCancel")}
          </button>
          <button
            type="button"
            disabled={launching}
            className="rounded border border-[var(--accent)] px-2.5 py-1 text-xs text-[var(--accent)] hover:bg-[var(--bg-surface)] disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => void submit()}
            data-testid="workflow-launch-confirm"
          >
            {launching ? t("panel.workflow.pending") : t("panel.workflow.launch")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
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
              {rows.map((r, i) => (
                <EvidenceRow key={r.seq} record={r} index={i} total={rows.length} />
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
        {tab === "definitions" ? (
          <DefinitionsTab projectDir={resolvedProjectDir} onLaunched={() => setTab("runs")} />
        ) : (
          <RunsTab />
        )}
      </div>
    </div>
  );
}
