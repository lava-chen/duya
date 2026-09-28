// run-display/node-detail.tsx — the node detail viewers (plan 560 §7.2,
// node-card link upgrade 2026-09-27).
//
// The stage rail's per-kind chips and the run detail's evidence rows both
// land HERE: one dedicated viewer per node kind, the same "one component per
// kind" split node-rows.tsx uses for the collapsed rows, but expanded to the
// facts a reader digs for — a tool node's command and exit, a decision's
// reason and candidates, a human gate's verdict, a gui/browser node's
// screenshot evidence. node-rows.tsx answers "what happened" in one line;
// this file answers "show me".
//
// Screenshot refs resolve through the workflow artifact bridge to an
// absolute path, then load via the `duya-file://` protocol (same path
// markdown images take); unresolved refs degrade to a file chip.

'use client';

import { useEffect, useState } from 'react';
import {
  ChatCircleIcon,
  CheckCircleIcon,
  XCircleIcon,
  ClockCounterClockwiseIcon,
  FileIcon,
  XIcon,
} from '@/components/icons';
import { useTranslation } from '@/hooks/useTranslation';
import { ImagePreview } from '@/components/chat/preview/ImagePreview';
import { rewriteMediaSrc } from '@/components/chat/markdownComponents';
import { ReadOnlySessionChat } from '@/components/chat/ReadOnlySessionChat';
import { useConversationStore } from '@/stores/conversation-store';
import {
  openWorkflowArtifactIPC,
  resolveWorkflowArtifactPathIPC,
} from '@/lib/workflow-ipc';
import {
  NODE_KIND_TILE,
  OutputBlock,
  StatusLamp,
  formatStepDuration,
  formatStepSize,
  nodeKindOf,
} from './node-rows';
import type { WorkflowJournalRecord } from '@/components/layout/panels/WorkflowPanel';

// ─── pure selection (unit-tested) ────────────────────────────────────────────

/**
 * The record a node's detail view shows: the LAST node record for the nodeId
 * (plan 568 folding — a `running` placeholder is superseded by its terminal
 * record; a retried attempt supersedes its predecessor).
 */
export function terminalRecordFor(
  records: Pick<WorkflowJournalRecord, 'seq' | 'kind' | 'nodeId'>[],
  nodeId: string,
): Pick<WorkflowJournalRecord, 'seq' | 'kind' | 'nodeId'> | undefined {
  let found: Pick<WorkflowJournalRecord, 'seq' | 'kind' | 'nodeId'> | undefined;
  for (const r of records) {
    if (r.kind !== 'node_result' && r.kind !== 'decision' && r.kind !== 'approval') continue;
    if (r.nodeId !== nodeId) continue;
    if (!found || r.seq >= found.seq) found = r;
  }
  return found;
}

/**
 * Screenshot/artifact refs belonging to one node. Gui capture artifacts are
 * journaled per step with a `${nodeId}#step${i}` nodeId; browser shots ride
 * inside the node result (`output.screenshots`) — both shapes land here.
 */
export function artifactRefsFor(
  records: Pick<WorkflowJournalRecord, 'kind' | 'nodeId' | 'result'>[],
  nodeId: string,
): string[] {
  const refs: string[] = [];
  for (const r of records) {
    if (r.kind !== 'artifact') continue;
    if (r.nodeId !== nodeId && !r.nodeId.startsWith(`${nodeId}#`)) continue;
    const ref =
      r.result && typeof r.result === 'object' && typeof (r.result as { ref?: unknown }).ref === 'string'
        ? (r.result as { ref: string }).ref
        : undefined;
    if (ref && !refs.includes(ref)) refs.push(ref);
  }
  return refs;
}

/** Screenshot refs carried inside a node result (browser outcome shape). */
export function resultScreenshotRefs(result: unknown): string[] {
  if (!result || typeof result !== 'object') return [];
  const output = (result as { output?: unknown }).output;
  const shots = output && typeof output === 'object' ? (output as { screenshots?: unknown }).screenshots : undefined;
  if (!Array.isArray(shots)) return [];
  return shots.filter((s): s is string => typeof s === 'string');
}

// ─── shared shell pieces ─────────────────────────────────────────────────────

function MetaChips({ chips }: { chips: Array<string | null | undefined> }) {
  const list = chips.filter((c): c is string => Boolean(c));
  if (list.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-t border-[var(--border)] pt-2 text-[10px] tabular-nums text-[var(--muted)]">
      {list.map((chip, index) => (
        <span key={`${index}-${chip}`} className="rounded-md bg-[var(--surface-hover)] px-1.5 py-0.5">
          {chip}
        </span>
      ))}
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">{label}</span>
      {children}
    </div>
  );
}

function VerificationChip({ verification }: { verification?: string }) {
  const { t } = useTranslation();
  if (verification !== 'verified' && verification !== 'unconfirmed') return null;
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] ${
        verification === 'verified'
          ? 'bg-[color-mix(in_srgb,var(--success)_15%,transparent)] text-[var(--success)]'
          : 'bg-[var(--chip)] text-[var(--muted)]'
      }`}
    >
      {verification === 'verified' ? t('panel.workflow.verified' as never) : t('panel.workflow.unconfirmed' as never)}
    </span>
  );
}

function ReplayChip() {
  const { t } = useTranslation();
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-[var(--chip)] px-1.5 py-0.5 text-[10px] text-[var(--accent)]">
      <ClockCounterClockwiseIcon size={10} />
      {t('workflow.step.replayed' as never)}
    </span>
  );
}

// ─── screenshot gallery ──────────────────────────────────────────────────────

/**
 * One screenshot thumbnail. The ref resolves over IPC to an absolute path and
 * loads through `duya-file://` (electron/main.ts protocol handler). Loading
 * renders a quiet placeholder; an unresolvable ref (evicted bytes, pre-ref
 * runs) degrades to a file chip that still opens the preview panel.
 */
function ScreenshotThumb({
  artifactRef,
  onOpen,
}: {
  artifactRef: string;
  onOpen: (view: { src: string; alt: string }) => void;
}) {
  const [src, setSrc] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void resolveWorkflowArtifactPathIPC(artifactRef).then((path) => {
      if (alive) setSrc(path ? rewriteMediaSrc(path) : null);
    });
    return () => {
      alive = false;
    };
  }, [artifactRef]);

  const name = artifactRef.split(/[\\/]/).pop() ?? artifactRef;
  if (src === undefined) {
    return <span className="h-16 w-24 shrink-0 animate-pulse rounded-md bg-[var(--surface-hover)]" aria-hidden />;
  }
  if (src === null) {
    return (
      <button
        type="button"
        className="flex h-16 w-24 shrink-0 flex-col items-center justify-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-surface)] text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
        title={name}
        onClick={() => void openWorkflowArtifactIPC(artifactRef)}
      >
        <FileIcon size={16} />
        <span className="max-w-full truncate px-1 text-[9px]">{name}</span>
      </button>
    );
  }
  return (
    <button
      type="button"
      className="shrink-0 overflow-hidden rounded-md border border-[var(--border)] hover:border-[var(--accent)]"
      title={name}
      onClick={() => onOpen({ src, alt: name })}
    >
      <img src={src} alt={name} className="h-16 w-24 object-cover" loading="lazy" />
    </button>
  );
}

function ScreenshotGallery({ refs, emptyHint }: { refs: string[]; emptyHint?: string }) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<{ src: string; alt: string } | null>(null);
  if (refs.length === 0) {
    return emptyHint ? (
      <Section label={t('workflow.node.screenshots' as never)}>
        <span className="text-[11px] text-[var(--muted)]">{emptyHint}</span>
      </Section>
    ) : null;
  }
  return (
    <Section label={`${t('workflow.node.screenshots' as never)} · ${refs.length}`}>
      <div className="flex flex-wrap gap-1.5" data-testid="workflow-node-screenshots">
        {refs.map((ref) => (
          <ScreenshotThumb key={ref} artifactRef={ref} onOpen={setPreview} />
        ))}
      </div>
      <ImagePreview
        open={preview !== null}
        onClose={() => setPreview(null)}
        variant="lightbox"
        src={preview?.src}
        alt={preview?.alt}
      />
    </Section>
  );
}

// ─── per-kind bodies ─────────────────────────────────────────────────────────

function ToolNodeBody({ record }: { record: WorkflowJournalRecord }) {
  const { t } = useTranslation();
  return (
    <>
      <Section label={t('workflow.node.command' as never)}>
        <pre className="overflow-x-auto rounded border border-[var(--border)] bg-[var(--bg-surface)] px-2 py-1.5 font-mono text-[11px] leading-relaxed text-[var(--text)] whitespace-pre-wrap break-all">
          {record.inputSummary ?? record.action ?? record.nodeId}
        </pre>
      </Section>
      <Section label={t('workflow.node.output' as never)}>
        <OutputBlock result={record.result} />
      </Section>
      <MetaChips
        chips={[
          typeof record.exitCode === 'number' ? `${t('workflow.step.exitCode' as never)} ${record.exitCode}` : null,
          formatStepDuration(record.durationMs),
          formatStepSize(record.outputSize),
        ]}
      />
    </>
  );
}

function AgentNodeBody({ record }: { record: WorkflowJournalRecord }) {
  const { t } = useTranslation();
  const tokens = record.usage
    ? `${record.usage.inputTokens + record.usage.outputTokens} ${t('workflow.step.tokens' as never)}`
    : null;
  return (
    <>
      {record.childSessionId && (
        <div className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] px-2 py-1.5">
          <ChatCircleIcon className="shrink-0 text-[var(--accent)]" size={14} />
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--text)]" title={record.childSessionId}>
            {record.childSessionId}
          </span>
          <button
            type="button"
            className="shrink-0 inline-flex items-center gap-1 rounded border border-[var(--border)] px-2 py-0.5 text-[10px] text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
            data-testid="workflow-node-open-session"
            onClick={() => {
              // Enter the session's own chat view (main column) — the same
              // path the run card's agent chip takes.
              void useConversationStore.getState().setActiveThread(record.childSessionId!);
            }}
          >
            {t('workflow.node.openSession' as never)}
          </button>
        </div>
      )}
      {record.childSessionId && <ReadOnlySessionChat sessionId={record.childSessionId} />}
      <Section label={t('workflow.node.output' as never)}>
        <OutputBlock result={record.result} />
      </Section>
      <MetaChips chips={[tokens, formatStepDuration(record.durationMs)]} />
    </>
  );
}

/** Shape-agnostic read of a decision record's result — producers vary. */
function DecisionNodeBody({ record }: { record: WorkflowJournalRecord }) {
  const { t } = useTranslation();
  const res =
    record.result && typeof record.result === 'object'
      ? (record.result as {
          status?: unknown;
          reason?: unknown;
          candidates?: unknown;
          output?: unknown;
          lowConfidence?: unknown;
        })
      : {};
  const reason = typeof res.reason === 'string' && res.reason.trim() ? res.reason : null;
  const lowConfidence = Array.isArray(res.lowConfidence) ? res.lowConfidence.length : 0;
  return (
    <>
      {reason && (
        <Section label={t('workflow.node.decisionReason' as never)}>
          <p className="text-[11px] leading-relaxed text-[var(--text)]">{reason}</p>
        </Section>
      )}
      {res.candidates != null && (
        <Section label={t('workflow.node.decisionCandidates' as never)}>
          <OutputBlock result={res.candidates} />
        </Section>
      )}
      <Section label={t('workflow.node.output' as never)}>
        <OutputBlock result={record.result} />
      </Section>
      <MetaChips
        chips={[
          typeof res.status === 'string' ? res.status : null,
          lowConfidence > 0 ? `${lowConfidence} ${t('workflow.node.lowConfidence' as never)}` : null,
          formatStepDuration(record.durationMs),
        ]}
      />
    </>
  );
}

function HumanNodeBody({ record }: { record: WorkflowJournalRecord }) {
  const { t } = useTranslation();
  const res =
    record.result && typeof record.result === 'object'
      ? (record.result as { decision?: unknown; escalated?: unknown; onTimeout?: unknown })
      : {};
  const decision = typeof res.decision === 'string' ? res.decision : null;

  if (record.status === 'waiting' || decision === null) {
    return (
      <>
        <div className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] px-2 py-1.5 text-[11px] text-[var(--warning)]">
          <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-[var(--warning)]" />
          {t('workflow.step.awaitingHuman' as never)}
        </div>
        <MetaChips chips={[formatStepDuration(record.durationMs)]} />
      </>
    );
  }
  const icon =
    decision === 'approve' ? (
      <CheckCircleIcon className="shrink-0 text-[var(--success)]" size={14} />
    ) : decision === 'deny' ? (
      <XCircleIcon className="shrink-0 text-[var(--error)]" size={14} />
    ) : null;
  const labelKey =
    decision === 'approve'
      ? 'workflow.node.humanApproved'
      : decision === 'deny'
        ? 'workflow.node.humanDenied'
        : 'workflow.node.humanTimeout';
  return (
    <>
      <div className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] px-2 py-1.5 text-[11px] text-[var(--text)]" data-testid="workflow-node-human-decision">
        {icon}
        {t(labelKey as never)}
        {res.escalated === true && (
          <span className="rounded bg-[var(--chip)] px-1.5 py-0.5 text-[10px] text-[var(--muted)]">
            {t('workflow.node.humanEscalated' as never)}
          </span>
        )}
      </div>
      <MetaChips chips={[formatStepDuration(record.durationMs)]} />
    </>
  );
}

function GuiNodeBody({ record, refs }: { record: WorkflowJournalRecord; refs: string[] }) {
  const { t } = useTranslation();
  return (
    <>
      <ScreenshotGallery refs={refs} emptyHint={t('workflow.node.noScreenshots' as never)} />
      <Section label={t('workflow.node.output' as never)}>
        <OutputBlock result={record.result} />
      </Section>
      <MetaChips chips={[record.action, formatStepDuration(record.durationMs), formatStepSize(record.outputSize)]} />
    </>
  );
}

function BrowserNodeBody({ record, refs }: { record: WorkflowJournalRecord; refs: string[] }) {
  const { t } = useTranslation();
  const output =
    record.result && typeof record.result === 'object'
      ? (record.result as { output?: { url?: unknown; title?: unknown; steps?: unknown; screenshots?: unknown } }).output
      : undefined;
  const url = typeof output?.url === 'string' && output.url.length > 0 ? output.url : null;
  const title = typeof output?.title === 'string' && output.title.length > 0 ? output.title : null;
  const steps = typeof output?.steps === 'number' ? output.steps : null;
  const shotRefs = [...refs];
  for (const s of resultScreenshotRefs(record.result)) {
    if (!shotRefs.includes(s)) shotRefs.push(s);
  }
  return (
    <>
      {url && (
        <Section label={t('workflow.node.browserUrl' as never)}>
          <span className="block truncate font-mono text-[11px] text-[var(--text)]" title={url}>
            {url}
          </span>
        </Section>
      )}
      <Section label={t('workflow.node.output' as never)}>
        <OutputBlock result={record.result} />
      </Section>
      <ScreenshotGallery refs={shotRefs} emptyHint={t('workflow.node.noScreenshots' as never)} />
      <MetaChips
        chips={[
          title,
          steps !== null ? `${steps} ${t('workflow.node.browserSteps' as never)}` : null,
          formatStepDuration(record.durationMs),
          formatStepSize(record.outputSize),
        ]}
      />
    </>
  );
}

function NoopNodeBody({ record }: { record: WorkflowJournalRecord }) {
  const { t } = useTranslation();
  return (
    <>
      <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] px-2 py-1.5 text-[11px] text-[var(--muted)]">
        {record.inputSummary ?? record.nodeId}
      </div>
      <Section label={t('workflow.node.output' as never)}>
        <OutputBlock result={record.result} />
      </Section>
      <MetaChips chips={[formatStepDuration(record.durationMs), formatStepSize(record.outputSize)]} />
    </>
  );
}

// ─── shell ───────────────────────────────────────────────────────────────────

/**
 * One node's dedicated detail card — opened from a stage-rail chip or an
 * evidence row. The shell carries the identity (kind tile, nodeId, status,
 * verification, replayed); the body is the kind's own viewer above.
 */
export function NodeDetailView({
  records,
  nodeId,
  onClose,
}: {
  records: WorkflowJournalRecord[];
  nodeId: string;
  onClose?: () => void;
}) {
  const { t } = useTranslation();
  const record = terminalRecordFor(records, nodeId) as WorkflowJournalRecord | undefined;
  if (!record) return null;

  const kind = nodeKindOf(record);
  const { Icon, accent, labelKey } = NODE_KIND_TILE[kind];
  const refs = artifactRefsFor(records, nodeId);

  let body: React.ReactNode;
  switch (kind) {
    case 'agent':
      body = <AgentNodeBody record={record} />;
      break;
    case 'decision':
      body = <DecisionNodeBody record={record} />;
      break;
    case 'human':
      body = <HumanNodeBody record={record} />;
      break;
    case 'gui':
      body = <GuiNodeBody record={record} refs={refs} />;
      break;
    case 'browser':
      body = <BrowserNodeBody record={record} refs={refs} />;
      break;
    case 'noop':
      body = <NoopNodeBody record={record} />;
      break;
    case 'tool':
    default:
      body = <ToolNodeBody record={record} />;
  }

  return (
    <div
      className="rounded-lg border border-[var(--border)] bg-[var(--bg-canvas)] p-2.5"
      data-testid="workflow-node-detail"
      data-node-kind={kind}
    >
      <div className="flex items-center gap-2 pb-2">
        <span
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
          style={{ background: `color-mix(in srgb, ${accent} 22%, transparent)`, color: accent }}
          aria-hidden
        >
          <Icon size={13} />
        </span>
        <span className="shrink-0 text-[10px] uppercase tracking-wide text-[var(--muted)]">{t(labelKey as never)}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--text)]" title={record.nodeId}>
          {record.nodeId}
        </span>
        <VerificationChip verification={record.verification} />
        {record.replayed && <ReplayChip />}
        <StatusLamp status={record.status} />
        {onClose && (
          <button
            type="button"
            className="shrink-0 rounded p-0.5 text-[var(--muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
            aria-label={t('workflow.node.closeDetail' as never)}
            title={t('workflow.node.closeDetail' as never)}
            onClick={onClose}
          >
            <XIcon size={12} />
          </button>
        )}
      </div>
      <div className="flex flex-col gap-2">{body}</div>
    </div>
  );
}
