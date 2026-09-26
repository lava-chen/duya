// run-display/stage-columns.tsx — the run card's stage rail (阶段轨).
//
// The runner folds `wf.phase(name)` records into the step list as
// nodeKind:'phase' dividers (plan 560 §6.2), so the stage structure is cut
// HERE, renderer-side: steps before the first divider belong to the implicit
// 「准备」 column, everything after a divider belongs to that stage's column.
//
// Chip vocabulary follows the reference design: non-agent work (tool / gui /
// noop) aggregates into one 「脚本」 chip per column — a run can make dozens of
// tool calls and one chip reads better than a column of them — while each
// agent / decision / human step gets its own chip, because those are the units
// a reader cares about. Step counts (n/m) stay step-accurate regardless of
// chip aggregation.

'use client';

import { useMemo } from 'react';
import {
  ArrowSquareOutIcon,
  CheckCircleIcon,
  CircleNotchIcon,
  QuestionIcon,
  RobotIcon,
  ChromeIcon,
  TerminalIcon,
  UserIcon,
  XCircleIcon,
} from '@/components/icons';
import { AgentFace, type AgentFaceStatus } from '@/components/agent-face/AgentFace';
import { useTranslation } from '@/hooks/useTranslation';
import type { RunStepNodeKind, RunStepStatus } from '@/types/stream';

// ─── pure model (unit-tested, no react) ─────────────────────────────────────

/**
 * 'pending' is preview-only: the static dwf parser (dwf-preview.ts) emits steps
 * for a definition that has never run. Live runs never carry it.
 */
export type StageStepStatus = RunStepStatus | 'pending';

/** Structural superset of RunStepView — live frames and preview steps both fit. */
export interface StageStep {
  id: string;
  label?: string;
  status: StageStepStatus;
  nodeKind?: RunStepNodeKind;
  /** Plan 568: agent steps carry their sub-session id — the chip opens the watch pane. */
  childSessionId?: string;
}

export interface RunChipView {
  key: string;
  kind: 'script' | 'agent' | 'decision' | 'human' | 'browser';
  /** Display name; only agents carry one (stripped of the `agent:` prefix). */
  name?: string;
  status: StageStepStatus;
  /** Plan 568: agent chip → `dispatchOpenSessionPanel(childSessionId)` watch pane. */
  childSessionId?: string;
}

export interface StageColumn {
  /** Divider step id, or 'implicit' for the pre-first-phase column. */
  key: string;
  /** Divider label; '' for the implicit column (the component substitutes i18n). */
  name: string;
  implicit: boolean;
  status: StageStepStatus;
  /** Step-accurate progress: succeeded / all steps in the column. */
  done: number;
  total: number;
  chips: RunChipView[];
}

/** `agent:项目解读员` → `项目解读员`; labels without the prefix pass through. */
export function agentChipName(label: string | undefined): string {
  const raw = label ?? '';
  if (raw.startsWith('agent:')) return raw.slice('agent:'.length);
  return raw;
}

/**
 * Status precedence for a column / script chip. 'pending' sits above 'success'
 * so a preview column (all-pending steps) reads as pending, not done.
 */
function worst(a: StageStepStatus, b: StageStepStatus): StageStepStatus {
  if (a === 'failed' || b === 'failed') return 'failed';
  if (a === 'running' || b === 'running') return 'running';
  if (a === 'pending' || b === 'pending') return 'pending';
  return 'success';
}

/**
 * Cut the accumulated step list into stage columns at nodeKind:'phase'
 * dividers. Order-preserving and honest: only steps the runner reported
 * appear, and a divider's own status never bleeds into the column's counts
 * (a phase marker stays 'running' forever — it is a boundary, not work).
 */
export function buildStageColumns(steps: StageStep[]): StageColumn[] {
  const columns: StageColumn[] = [];
  let current: StageColumn | null = null;

  const ensureCurrent = (): StageColumn => {
    if (current === null) {
      current = {
        key: 'implicit',
        name: '',
        implicit: true,
        status: 'success',
        done: 0,
        total: 0,
        chips: [],
      };
      columns.push(current);
    }
    return current;
  };

  for (const step of steps) {
    if (step.nodeKind === 'phase') {
      current = {
        key: step.id,
        name: step.label ?? step.id,
        implicit: false,
        status: 'success',
        done: 0,
        total: 0,
        chips: [],
      };
      columns.push(current);
      continue;
    }

    const column = ensureCurrent();
    column.total += 1;
    if (step.status === 'success') column.done += 1;
    column.status = worst(column.status, step.status);

    const kind = chipKindOf(step.nodeKind);
    if (kind === 'script') {
      // Aggregate: one script chip per column, status = worst of its members.
      const existing = column.chips.find((c) => c.kind === 'script');
      if (existing) existing.status = worst(existing.status, step.status);
      else column.chips.push({ key: `${column.key}:script`, kind: 'script', status: step.status });
      continue;
    }
    column.chips.push({
      key: step.id,
      kind,
      ...(kind === 'agent' ? { name: agentChipName(step.label) || 'agent' } : {}),
      ...(step.childSessionId !== undefined ? { childSessionId: step.childSessionId } : {}),
      status: step.status,
    });
  }

  return columns;
}

function chipKindOf(nodeKind: RunStepNodeKind | undefined): RunChipView['kind'] {
  switch (nodeKind) {
    case 'agent':
      return 'agent';
    case 'decision':
      return 'decision';
    case 'human':
    case 'ask':
      // Plan 565 Phase D: an escalation ask is a human-in-the-loop row too —
      // it renders with the human chip vocabulary.
      return 'human';
    case 'browser':
      // Browser-extension nodes get their own chip (plan 564) — collapsing
      // them into the script aggregate would hide the one kind that drives
      // the user's real Chrome.
      return 'browser';
    default:
      // tool / gui / noop (and undefined on older frames) → script work.
      return 'script';
  }
}

// ─── presentation ────────────────────────────────────────────────────────────

/** Avatar accents rotate per agent chip so parallel agents stay tellable. */
const AGENT_ACCENTS = [
  'var(--accent-teal)',
  'var(--accent-amber)',
  'var(--accent-sky)',
  'var(--accent-violet)',
  'var(--accent-rose)',
  'var(--accent-emerald)',
];

function StepStatusIcon({ status }: { status: StageStepStatus }) {
  if (status === 'success') {
    return <CheckCircleIcon className="shrink-0 text-[var(--success)]" size={13} />;
  }
  if (status === 'failed') {
    return <XCircleIcon className="shrink-0 text-[var(--error)]" size={13} />;
  }
  if (status === 'pending') {
    // Preview: a hollow ring — not started, not spun up.
    return <span className="h-2 w-2 shrink-0 rounded-full border border-[var(--border)]" aria-hidden />;
  }
  return <CircleNotchIcon className="shrink-0 animate-spin text-[var(--warning)]" size={12} />;
}

/** Stage chip status -> the animated face's four statuses. */
function faceStatusOf(status: StageStepStatus): AgentFaceStatus {
  if (status === 'success') return 'done';
  if (status === 'failed') return 'failed';
  if (status === 'pending') return 'pending';
  return 'running';
}

function ColumnDot({ status }: { status: StageStepStatus }) {
  const bg =
    status === 'success'
      ? 'var(--success)'
      : status === 'failed'
        ? 'var(--error)'
        : status === 'pending'
          ? 'var(--chip)'
          : 'var(--warning)';
  return (
    <span
      className={`h-2 w-2 shrink-0 rounded-full ${status === 'running' ? 'animate-pulse' : ''}`}
      style={{ background: bg }}
      aria-hidden
    />
  );
}

/**
 * One chip in the stage rail. When `onOpen` is given the chip is interactive:
 * clicking it (or its hover-revealed ↗) opens the node's destination — an
 * agent chip with a child session opens the watch pane
 * (`duya:open-session-panel`), everything else opens the run detail
 * (`onChipOpen` receives the chip so the caller can decide).
 */
function RunChip({
  chip,
  accent,
  onOpen,
}: {
  chip: RunChipView;
  accent?: string;
  onOpen?: (chip: RunChipView) => void;
}) {
  const { t } = useTranslation();
  const name =
    chip.kind === 'agent'
      ? (chip.name ?? 'agent')
      : chip.kind === 'script'
        ? t('workflow.nodeKind.tool')
        : chip.kind === 'decision'
          ? t('workflow.nodeKind.decision')
          : chip.kind === 'browser'
            ? t('workflow.nodeKind.browser')
            : t('workflow.nodeKind.human');
  const Icon =
    chip.kind === 'agent'
      ? RobotIcon
      : chip.kind === 'decision'
        ? QuestionIcon
        : chip.kind === 'human'
          ? UserIcon
          : chip.kind === 'browser'
            ? ChromeIcon
            : TerminalIcon;
  const interactive = onOpen !== undefined;
  return (
    <span
      className={`group inline-flex max-w-full items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-hover)] py-1 pl-1 pr-1.5 ${
        interactive ? 'cursor-pointer transition-colors hover:border-[var(--accent)]' : ''
      }`}
      data-chip-kind={chip.kind}
      data-chip-status={chip.status}
      {...(interactive
        ? {
            role: 'button',
            tabIndex: 0,
            title: name,
            onClick: (e) => {
              e.stopPropagation();
              onOpen?.(chip);
            },
            onKeyDown: (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onOpen?.(chip);
              }
            },
          }
        : { title: name })}
    >
      {/* agent chips wear the animated face — the status mark at the end stays
          as the at-a-glance glyph, the face carries the life */}
      {chip.kind === 'agent' && accent ? (
        <AgentFace size={20} status={faceStatusOf(chip.status)} color={accent} />
      ) : (
        <span
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-white"
          style={accent ? { background: accent } : { background: 'var(--chip)', color: 'var(--text)' }}
          aria-hidden
        >
          <Icon size={12} />
        </span>
      )}
      <span className="min-w-0 truncate text-xs leading-none text-[var(--text)]">{name}</span>
      {interactive && (
        <ArrowSquareOutIcon
          className="shrink-0 text-[var(--muted)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
          size={11}
        />
      )}
      <StepStatusIcon status={chip.status} />
    </span>
  );
}

export function StageColumns({
  steps,
  showChips = true,
  onChipOpen,
}: {
  steps: StageStep[];
  /**
   * Progressive disclosure (2026-09-23 feedback): the live run card keeps the
   * chips collapsed by default — the rail headers + honest n/m counters are
   * the at-a-glance view, one click reveals the per-node chips. The preview
   * card and any surface that wants the full picture pass true (the default).
   */
  showChips?: boolean;
  /**
   * When given, chips become interactive. The callback receives the chip — an
   * agent chip with a `childSessionId` opens the watch pane, the rest open
   * the run detail.
   */
  onChipOpen?: (chip: RunChipView) => void;
}) {
  const { t } = useTranslation();
  const columns = useMemo(() => buildStageColumns(steps), [steps]);
  if (columns.length === 0) return null;

  let agentIndex = 0;
  return (
    <div className="flex items-start gap-0 overflow-x-auto pb-0.5" data-testid="workflow-stage-rail">
      {columns.map((column, i) => (
        <div key={column.key} className="flex items-start shrink-0">
          {i > 0 && <div className="mt-[5px] h-px w-5 shrink-0 bg-[var(--border)]" aria-hidden />}
          <div className="flex min-w-0 max-w-[240px] flex-col gap-1.5">
            <div className="flex items-center gap-1.5">
              <ColumnDot status={column.status} />
              <span
                className={`min-w-0 truncate text-xs ${column.implicit ? 'text-[var(--muted)]' : 'text-[var(--text)]'}`}
                title={column.implicit ? t('workflow.card.implicitStage') : column.name}
              >
                {column.implicit ? t('workflow.card.implicitStage') : column.name}
              </span>
              <span className="shrink-0 text-[10px] tabular-nums text-[var(--muted)]">
                {column.done}/{column.total}
              </span>
            </div>
            {showChips &&
              column.chips.map((chip) => (
                <RunChip
                  key={chip.key}
                  chip={chip}
                  onOpen={onChipOpen}
                  accent={
                    chip.kind === 'agent'
                      ? agentAccentOf(agentIndex++)
                      : chip.kind === 'browser'
                        ? 'var(--accent-sky)'
                        : undefined
                  }
                />
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Accents advance once per agent chip so two agents never share a colour. */
function agentAccentOf(index: number): string {
  return AGENT_ACCENTS[index % AGENT_ACCENTS.length];
}
