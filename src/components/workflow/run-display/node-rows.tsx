// run-display/node-rows.tsx — plan 560 §7.2 step rows, one component per node
// kind (用户的要求：每一种节点都做一个 ui 组件).
//
// A journal record is deliberately shapeless — `kind`/`action`/`result` vary per
// node — so the temptation is one generic row with an icon swap. That reads as
// noise: a bash step's interesting fact is its exit code, an agent step's is its
// token spend and child transcript, a human step's is whether anyone answered.
// Hence six small components that each render the facts their kind produces,
// behind one shared shell so spacing/expand/output stay identical.

'use client';

import { useState } from 'react';
import {
  TerminalIcon,
  RobotIcon,
  QuestionIcon,
  UserIcon,
  CursorClickIcon,
  ChromeIcon,
  ProhibitIcon,
  CheckCircleIcon,
  XCircleIcon,
  ClockCounterClockwiseIcon,
} from '@/components/icons';
import { useTranslation } from '@/hooks/useTranslation';
import type { WorkflowJournalRecord } from '@/components/layout/panels/WorkflowPanel';

/** The node kinds a run's journal can carry. */
export type WorkflowNodeKind = 'tool' | 'agent' | 'decision' | 'human' | 'gui' | 'browser' | 'noop';

export const NODE_KINDS: readonly WorkflowNodeKind[] = [
  'tool',
  'agent',
  'decision',
  'human',
  'gui',
  'browser',
  'noop',
];

/**
 * Per-kind icon + accent. Accents reuse the definition view's mapping
 * (`workflow-types.ts`) so a node is the same colour in the graph, the library
 * and the run view — one vocabulary, not three.
 */
export const NODE_KIND_TILE: Record<
  WorkflowNodeKind,
  { Icon: typeof TerminalIcon; accent: string; labelKey: string }
> = {
  tool: { Icon: TerminalIcon, accent: 'var(--accent-emerald)', labelKey: 'workflow.nodeKind.tool' },
  agent: { Icon: RobotIcon, accent: 'var(--accent-violet)', labelKey: 'workflow.nodeKind.agent' },
  decision: {
    Icon: QuestionIcon,
    accent: 'var(--accent-amber)',
    labelKey: 'workflow.nodeKind.decision',
  },
  human: { Icon: UserIcon, accent: 'var(--accent-rose)', labelKey: 'workflow.nodeKind.human' },
  gui: { Icon: CursorClickIcon, accent: 'var(--accent-teal)', labelKey: 'workflow.nodeKind.gui' },
  browser: {
    Icon: ChromeIcon,
    accent: 'var(--accent-sky)',
    labelKey: 'workflow.nodeKind.browser',
  },
  noop: { Icon: ProhibitIcon, accent: 'var(--text-faint)', labelKey: 'workflow.nodeKind.noop' },
};

export function nodeKindOf(record: Pick<WorkflowJournalRecord, 'nodeKind' | 'kind'>): WorkflowNodeKind {
  const raw = record.nodeKind;
  if (raw && (NODE_KINDS as readonly string[]).includes(raw)) return raw as WorkflowNodeKind;
  return 'tool';
}

/** `12ms` / `1.2s` — the step row's compact duration. */
export function formatStepDuration(ms: number | undefined): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
}

/** `371 B` / `1.2 KB` — serialized output weight. */
export function formatStepSize(bytes: number | undefined): string | null {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function OutputBlock({ result }: { result: unknown }) {
  const [expanded, setExpanded] = useState(false);
  const text =
    typeof result === 'string' ? result : result === undefined || result === null ? '' : JSON.stringify(result, null, 2);
  if (!text.trim()) return null;
  const lines = text.split('\n');
  // Default collapsed to the tail: for a long build log the useful part is how
  // it ended, and the full text is one click away.
  const visible = expanded ? lines : lines.slice(-3);
  return (
    <div className="mt-1 rounded border border-[var(--border)] bg-[var(--bg-surface)]">
      <pre className="max-h-40 overflow-auto px-2 py-1 font-mono text-[10px] leading-relaxed text-[var(--text)] whitespace-pre-wrap break-all">
        {visible.join('\n')}
      </pre>
      {lines.length > 3 && (
        <button
          type="button"
          className="w-full border-t border-[var(--border)] px-2 py-0.5 text-left text-[10px] text-[var(--muted)] hover:text-[var(--text)]"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded
            ? '−'
            : `+${lines.length - 3}`}
        </button>
      )}
    </div>
  );
}

function StatusLamp({ status }: { status: string }) {
  if (status === 'succeeded') {
    return <CheckCircleIcon className="shrink-0 text-[var(--success)]" size={13} />;
  }
  if (status === 'failed') {
    return <XCircleIcon className="shrink-0 text-[var(--error)]" size={13} />;
  }
  return <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-[var(--warning)]" />;
}

interface StepRowProps {
  record: WorkflowJournalRecord;
  /** Primary line: what this node was asked to do. */
  title: string;
  /** Secondary chips: the facts only this kind produces. */
  meta: Array<string | null>;
  children?: React.ReactNode;
}

function StepRow({ record, title, meta, children }: StepRowProps) {
  const { t } = useTranslation();
  const kind = nodeKindOf(record);
  const { Icon, accent, labelKey } = NODE_KIND_TILE[kind];
  const chips = meta.filter((m): m is string => Boolean(m));

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-canvas)] px-2 py-1.5" data-node-kind={kind} data-seq={record.seq}>
      <div className="flex items-center gap-2">
        <span
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded"
          style={{ background: `color-mix(in srgb, ${accent} 22%, transparent)`, color: accent }}
          aria-hidden
        >
          <Icon size={12} />
        </span>
        <span className="shrink-0 text-[10px] uppercase tracking-wide text-[var(--muted)]">
          {t(labelKey as never)}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--text)]" title={title}>
          {title}
        </span>
        <StatusLamp status={record.status} />
      </div>

      {(chips.length > 0 || record.replayed) && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-7 pt-0.5 text-[10px] tabular-nums text-[var(--muted)]">
          {chips.map((chip) => (
            <span key={chip}>{chip}</span>
          ))}
          {record.replayed && (
            <span className="inline-flex items-center gap-0.5 text-[var(--accent)]">
              <ClockCounterClockwiseIcon size={10} />
              {t('workflow.step.replayed' as never)}
            </span>
          )}
        </div>
      )}

      {children}
      <OutputBlock result={record.result} />
    </div>
  );
}

/** tool — the interesting fact is how the process ended. */
export function ToolStepRow({ record }: { record: WorkflowJournalRecord }) {
  const { t } = useTranslation();
  const exit =
    typeof record.exitCode === 'number' ? `${t('workflow.step.exitCode' as never)} ${record.exitCode}` : null;
  return (
    <StepRow
      record={record}
      title={record.inputSummary ?? record.action ?? record.nodeId}
      meta={[exit, formatStepDuration(record.durationMs), formatStepSize(record.outputSize)]}
    />
  );
}

/** agent — the interesting fact is what it cost and where its transcript lives. */
export function AgentStepRow({ record }: { record: WorkflowJournalRecord }) {
  const { t } = useTranslation();
  const tokens = record.usage
    ? `${record.usage.inputTokens + record.usage.outputTokens} ${t('workflow.step.tokens' as never)}`
    : null;
  return (
    <StepRow
      record={record}
      title={record.inputSummary ?? record.action ?? record.nodeId}
      meta={[tokens, formatStepDuration(record.durationMs)]}
    />
  );
}

/** decision — the interesting fact is which branch won. */
export function DecisionStepRow({ record }: { record: WorkflowJournalRecord }) {
  return (
    <StepRow
      record={record}
      title={record.inputSummary ?? record.nodeId}
      meta={[record.verification ?? null, formatStepDuration(record.durationMs)]}
    />
  );
}

/** human — the interesting fact is whether anybody answered. */
export function HumanStepRow({ record }: { record: WorkflowJournalRecord }) {
  const { t } = useTranslation();
  const waited =
    record.status === 'waiting'
      ? t('workflow.step.awaitingHuman' as never)
      : record.status === 'skipped'
        ? t('workflow.step.humanTimeout' as never)
        : null;
  return (
    <StepRow
      record={record}
      title={record.inputSummary ?? record.action ?? record.nodeId}
      meta={[waited, formatStepDuration(record.durationMs)]}
    />
  );
}

/** gui — the interesting fact is the app it drove. */
export function GuiStepRow({ record }: { record: WorkflowJournalRecord }) {
  return (
    <StepRow
      record={record}
      title={record.inputSummary ?? record.action ?? record.nodeId}
      meta={[formatStepDuration(record.durationMs), formatStepSize(record.outputSize)]}
    />
  );
}

/**
 * browser — the interesting fact is where it went and what it captured.
 * inputSummary carries `start_url: first-step +N`; the output carries the
 * final url/title and screenshot artifact refs.
 */
export function BrowserStepRow({ record }: { record: WorkflowJournalRecord }) {
  const { t } = useTranslation();
  const output = typeof record.result === 'object' && record.result !== null
    ? (record.result as { url?: unknown; title?: unknown; screenshots?: unknown[] })
    : undefined;
  const landed =
    typeof output?.url === 'string' && output.url.length > 0
      ? `${t('workflow.step.browserLanded' as never)} ${output.url}`
      : null;
  const shots =
    Array.isArray(output?.screenshots) && output.screenshots.length > 0
      ? `${output.screenshots.length} × ${t('workflow.step.screenshot' as never)}`
      : null;
  return (
    <StepRow
      record={record}
      title={record.inputSummary ?? record.action ?? record.nodeId}
      meta={[landed, shots, formatStepDuration(record.durationMs), formatStepSize(record.outputSize)]}
    />
  );
}

/** noop — a marker, not work: one quiet line, no meta, no output. */
export function NoopStepRow({ record }: { record: WorkflowJournalRecord }) {
  return <StepRow record={record} title={record.inputSummary ?? record.nodeId} meta={[null, null]} />;
}

/** Dispatch to the component that owns this node kind. */
export function NodeStepRow({ record }: { record: WorkflowJournalRecord }) {
  switch (nodeKindOf(record)) {
    case 'agent':
      return <AgentStepRow record={record} />;
    case 'decision':
      return <DecisionStepRow record={record} />;
    case 'human':
      return <HumanStepRow record={record} />;
    case 'gui':
      return <GuiStepRow record={record} />;
    case 'browser':
      return <BrowserStepRow record={record} />;
    case 'noop':
      return <NoopStepRow record={record} />;
    case 'tool':
    default:
      return <ToolStepRow record={record} />;
  }
}
