/**
 * WorkflowGraph — read-only node-graph view for a workflow definition
 * (plan 552 Phase 9). Renders the phases + nodes as a vertical timeline in
 * the style of ZCode's run-execution view:
 *
 *   • one emerald vertical line running top-to-bottom (#10b981 / #4ADE80)
 *   • each PHASE is a single row on the line (the "step"): left status lamp
 *     sitting on the spine, bold phase title in the middle, and a right-aligned
 *     status block — a colored sub-agent avatar square + N/M counter for
 *     agent phases, or a `>_` glyph + N/M counter for script phases — plus a
 *     collapsible chevron
 *   • expanding a phase row reveals its sub-nodes, indented under the row
 *     (each a compact single row with its own kind icon + counter)
 *   • the summary bar / result block / artifacts footer render when a run
 *     data source is wired in; otherwise the graph reads cleanly as a static
 *     definition view
 *
 * Editing always goes through the agent conversation; this component only
 * renders the structure for human inspection.
 */

import { useState, type CSSProperties, type ReactNode } from 'react';
import {
  TerminalIcon,
  UserIcon,
  CpuIcon,
  LightbulbIcon,
  CursorClickIcon,
  CircleIcon,
  CaretDownIcon,
  CaretRightIcon,
  FileIcon,
  FileMdIcon,
} from '@/components/icons';
import type {
  WorkflowDefView,
  WorkflowNodeView,
  WorkflowPhaseView,
  WorkflowNodeKind,
} from '@/lib/workflow-types';
import {
  deriveNodeKind,
  nodeInlinePreview,
  NODE_KIND_LABEL,
  NODE_KIND_ACCENT,
} from '@/lib/workflow-types';
import type { RunStepView } from '@/types/stream';

// ─── styles ────────────────────────────────────────────────────────────────

const wrapperStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-3, 12px)',
};

const summaryBarStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  padding: '8px 12px',
  background: 'var(--bg-surface-1, transparent)',
  border: '1px solid var(--border-weak)',
  borderRadius: '8px',
  fontSize: '12px',
  color: 'var(--text-faint)',
  fontVariantNumeric: 'tabular-nums',
};

const summaryOkDotStyle: CSSProperties = {
  width: '8px',
  height: '8px',
  borderRadius: '50%',
  background: 'var(--accent-emerald, #4ade80)',
  flexShrink: 0,
  boxShadow: '0 0 0 3px color-mix(in srgb, var(--accent-emerald) 18%, transparent)',
};

// The single continuous timeline. The emerald vertical line is this element's
// left border; every phase row parks its status lamp centered on it.
const lineStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
  borderLeft: '2px solid var(--accent-emerald, #4ade80)',
  paddingLeft: '22px',
  paddingTop: '4px',
  paddingBottom: '4px',
};

/**
 * Status lamp centered exactly on the timeline's left border.
 * Timeline: border(2) + paddingLeft(22) = content starts 24px in; the 2px
 * border sits at x=0..2 (center x=1). A 10px lamp needs left of -28px relative
 * to the row's content edge to land its center on the border.
 */
const phaseLampStyle: CSSProperties = {
  position: 'absolute',
  left: '-28px',
  top: '50%',
  transform: 'translateY(-50%)',
  width: '10px',
  height: '10px',
  borderRadius: '50%',
  background: 'var(--accent-emerald, #4ade80)',
  boxShadow: '0 0 0 3px color-mix(in srgb, var(--accent-emerald) 18%, transparent)',
  pointerEvents: 'none',
  flexShrink: 0,
};

const phaseRowStyle: CSSProperties = {
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
  minHeight: '38px',
  padding: '6px 10px',
  borderRadius: '8px',
  cursor: 'pointer',
  userSelect: 'none',
  transition: 'background 120ms ease',
};

const phaseRowOpenStyle: CSSProperties = {
  background: 'var(--bg-surface-1, transparent)',
};

const phaseTitleBlockStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: '1px',
};

const phaseTitleStyle: CSSProperties = {
  fontSize: '13px',
  fontWeight: 600,
  color: 'var(--text)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const phaseDetailStyle: CSSProperties = {
  fontSize: '11px',
  color: 'var(--text-faint)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

/** Right-aligned status block: [avatar | glyph] + N/M counter. */
const phaseStatusBlockStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  flexShrink: 0,
};

/** Colored rounded-square avatar badge for agent-containing phases. */
const avatarSquareStyle = (accent: string): CSSProperties => ({
  width: '20px',
  height: '20px',
  borderRadius: '6px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: '#fff',
  background: accent,
});

/** Monospace `>_` script glyph for non-agent phases. */
const scriptGlyphStyle = (accent: string): CSSProperties => ({
  fontSize: '11px',
  fontWeight: 700,
  color: accent,
  fontFamily: 'var(--font-mono, ui-monospace, "SF Mono", monospace)',
});

const nodeCountStyle: CSSProperties = {
  fontSize: '11px',
  color: 'var(--text-faint)',
  fontVariantNumeric: 'tabular-nums',
};

const phaseChevronStyle: CSSProperties = {
  color: 'var(--text-faint)',
  flexShrink: 0,
};

/** Indented sub-node stack revealed under an expanded phase row. */
const subStackStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '2px',
  marginLeft: '10px',
  paddingLeft: '10px',
  borderLeft: '1px solid var(--border-weak)',
};

const nodeIconBoxStyle = (accent: string): CSSProperties => ({
  width: '18px',
  height: '18px',
  borderRadius: '5px',
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: accent,
  background: `color-mix(in srgb, ${accent} 14%, transparent)`,
});

const nodeChevronStyle: CSSProperties = {
  color: 'var(--text-faint)',
  flexShrink: 0,
};

/** Expanded inline preview body, indented under the collapsed node row. */
const nodePreviewBodyStyle: CSSProperties = {
  marginTop: '2px',
  marginLeft: '38px',
  padding: '6px 10px',
  borderRadius: '6px',
  fontSize: '12px',
  lineHeight: 1.5,
  color: 'var(--text-faint)',
  fontFamily: 'var(--font-mono, ui-monospace, "SF Mono", monospace)',
  background: 'var(--bg-surface-1, transparent)',
  border: '1px solid var(--border-weak)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

/** Optional result description block, aligned under the node line. */
const resultBlockStyle: CSSProperties = {
  marginLeft: '24px',
  padding: '8px 12px',
  borderRadius: '6px',
  fontSize: '12px',
  lineHeight: 1.5,
  color: 'var(--text-faint)',
  background: 'var(--bg-surface-1, transparent)',
  border: '1px solid var(--border-weak)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

const artifactsHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  padding: '8px 12px',
  marginTop: '4px',
  background: 'var(--bg-surface-1, transparent)',
  border: '1px solid var(--border-weak)',
  borderRadius: '8px',
  cursor: 'pointer',
  userSelect: 'none',
  fontSize: '12px',
  fontWeight: 500,
  color: 'var(--text)',
};

const artifactsBodyStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '8px',
  padding: '4px 12px 8px',
};

const artifactChipStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  maxWidth: '100%',
  padding: '5px 10px',
  background: 'var(--bg-surface-1, transparent)',
  border: '1px solid var(--border-weak)',
  borderRadius: '6px',
  fontSize: '12px',
  color: 'var(--text)',
};

const artifactNameStyle: CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontFamily: 'var(--font-mono, ui-monospace, "SF Mono", monospace)',
  fontSize: '12px',
};

const artifactSizeStyle: CSSProperties = {
  color: 'var(--text-faint)',
  fontSize: '11px',
  fontVariantNumeric: 'tabular-nums',
  flexShrink: 0,
};

// ─── sub-node step card styles ─────────────────────────────────────────────

const stepCardStyle: CSSProperties = {
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
  padding: '8px 10px',
  borderRadius: '8px',
  background: 'var(--bg-surface-1, transparent)',
  border: '1px solid var(--border-weak)',
  transition: 'border-color 120ms ease, background 120ms ease',
};

const stepCardOpenStyle: CSSProperties = {
  ...stepCardStyle,
  background: 'var(--bg-surface-2, rgba(255,255,255,0.04))',
};

const stepMainRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  cursor: 'pointer',
  userSelect: 'none',
};

const stepTextBlockStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: '1px',
};

const stepActionStyle: CSSProperties = {
  fontSize: '12px',
  fontFamily: 'var(--font-mono, ui-monospace, "SF Mono", monospace)',
  color: 'var(--text)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const stepSubStyle: CSSProperties = {
  fontSize: '11px',
  color: 'var(--text-faint)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const stepMetaRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '6px',
  paddingLeft: '26px',
};

const metricChipStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '3px',
  padding: '1px 7px',
  borderRadius: '4px',
  fontSize: '11px',
  color: 'var(--text-faint)',
  background: 'var(--bg-surface-2, rgba(255,255,255,0.05))',
  fontFamily: 'var(--font-mono, ui-monospace, "SF Mono", monospace)',
  fontVariantNumeric: 'tabular-nums',
};

const statusDotInlineStyle = (bg: string): CSSProperties => ({
  width: '8px',
  height: '8px',
  borderRadius: '50%',
  background: bg,
  flexShrink: 0,
});

const stepStatusChipStyle = (color: string): CSSProperties => ({
  ...metricChipStyle,
  color,
  background: 'transparent',
});

// ─── icon mapping ──────────────────────────────────────────────────────────

function NodeIcon({ kind, size = 12 }: { kind: WorkflowNodeKind; size?: number }) {
  switch (kind) {
    case 'tool':
      return <TerminalIcon size={size} />;
    case 'agent':
      return <UserIcon size={size} />;
    case 'decision':
      return <LightbulbIcon size={size} />;
    case 'human':
      return <CpuIcon size={size} />;
    case 'gui':
      return <CursorClickIcon size={size} />;
    case 'noop':
      return <CircleIcon size={size} />;
  }
}

// ─── phase aggregate status ────────────────────────────────────────────────

type PhaseStatus = 'success' | 'running' | 'failed' | 'pending';

function phaseStatus(nodes: WorkflowNodeView[], runSteps?: Record<string, RunStepView>): PhaseStatus {
  if (!runSteps) return 'pending';
  let hasRunning = false;
  for (const n of nodes) {
    const s = runSteps[n.id];
    if (!s) continue;
    if (s.status === 'failed') return 'failed';
    if (s.status === 'success') continue;
    hasRunning = true;
  }
  return hasRunning ? 'running' : 'success';
}

// ─── sub-agent avatar / script glyph helper ────────────────────────────────

/** Picks one accent for the phase's status badge: agent wins, else tool. */
function phaseAccent(nodes: WorkflowNodeView[]): string {
  for (const n of nodes) {
    if (deriveNodeKind(n) === 'agent') return NODE_KIND_ACCENT.agent;
  }
  return NODE_KIND_ACCENT.tool;
}

function appearsAgentPhase(nodes: WorkflowNodeView[]): boolean {
  return nodes.some((n) => deriveNodeKind(n) === 'agent');
}

// ─── sub-node helpers & step card ──────────────────────────────────────────

/** Primary mono action line and a faint sub-label for a node (definition data). */
function nodeAction(node: WorkflowNodeView): { text: string; sub: string | null } {
  const kind = deriveNodeKind(node);
  switch (kind) {
    case 'tool': {
      const cmd = (node.input?.cmd ?? node.input?.command ?? node.input?.command_text) as string | undefined;
      if (typeof cmd === 'string') return { text: cmd, sub: node.tool ?? 'shell' };
      const path = (node.input?.file_path ?? node.input?.path) as string | undefined;
      if (typeof path === 'string') return { text: path, sub: node.tool ?? 'read' };
      return { text: node.id, sub: node.tool ?? 'tool' };
    }
    case 'agent':
      return { text: node.agent ?? node.id, sub: node.model ? `model ${node.model}` : 'subagent' };
    case 'decision': {
      const q = node.decision?.questions ? Object.keys(node.decision.questions).length : 0;
      return { text: node.id, sub: q ? `${q} question${q === 1 ? '' : 's'}` : 'decision' };
    }
    case 'human':
      return { text: node.human?.prompt ?? node.id, sub: 'human' };
    case 'gui':
      return { text: node.gui?.target_app ?? node.id, sub: 'gui' };
    default:
      return { text: node.id, sub: 'noop' };
  }
}

/** Definition-level metadata chips shown under a step's action line. */
function nodeMetaChips(node: WorkflowNodeView): string[] {
  const chips: string[] = [];
  if (node.max_retries !== undefined) chips.push(`retry x${node.max_retries}`);
  if (node.on_error) chips.push(`on_error ${node.on_error}`);
  if (node.when) chips.push(`when ${node.when}`);
  if (node.output_schema) chips.push('schema');
  return chips;
}

const STEP_STATUS_COLOR: Record<RunStepView['status'], string> = {
  success: 'var(--accent-emerald, #4ade80)',
  running: 'var(--accent)',
  failed: 'var(--red-500, #ef4444)',
};

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function SubNodeRow({ node, runStep }: { node: WorkflowNodeView; runStep?: RunStepView }) {
  const [expanded, setExpanded] = useState(false);
  const kind = deriveNodeKind(node);
  const accent = NODE_KIND_ACCENT[kind];
  const preview = nodeInlinePreview(node);
  const { text, sub } = nodeAction(node);
  const chips = nodeMetaChips(node);
  const statusColor = runStep ? STEP_STATUS_COLOR[runStep.status] : null;
  const statusLabel = runStep
    ? runStep.status === 'success'
      ? 'done'
      : runStep.status === 'failed'
        ? 'failed'
        : 'running'
    : null;
  const durationMs =
    runStep?.finishedAt !== undefined && runStep.startedAt !== undefined
      ? runStep.finishedAt - runStep.startedAt
      : undefined;

  return (
    <div style={expanded ? stepCardOpenStyle : stepCardStyle}>
      <div
        style={stepMainRowStyle}
        role="button"
        aria-expanded={expanded}
        tabIndex={0}
        onClick={() => (preview ? setExpanded((v) => !v) : undefined)}
        onKeyDown={(e) => {
          if (preview && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        }}
      >
        <span style={nodeIconBoxStyle(accent)}>
          <NodeIcon kind={kind} />
        </span>
        <span style={stepTextBlockStyle}>
          <span style={stepActionStyle}>{text}</span>
          {sub ? <span style={stepSubStyle}>{sub}</span> : null}
        </span>
        {statusColor && statusLabel ? (
          <span style={stepStatusChipStyle(statusColor)}>
            <span style={statusDotInlineStyle(statusColor)} />
            {statusLabel}
          </span>
        ) : null}
        {preview ? (
          <span style={nodeChevronStyle}>
            {expanded ? <CaretDownIcon size={12} /> : <CaretRightIcon size={12} />}
          </span>
        ) : null}
      </div>

      {chips.length > 0 || durationMs !== undefined ? (
        <div style={stepMetaRowStyle}>
          {chips.map((c) => (
            <span key={c} style={metricChipStyle}>
              {c}
            </span>
          ))}
          {durationMs !== undefined ? <span style={metricChipStyle}>{formatMs(durationMs)}</span> : null}
        </div>
      ) : null}

      {expanded && preview ? (
        <div style={{ ...nodePreviewBodyStyle, marginLeft: 0, marginTop: 8 }}>{preview}</div>
      ) : null}
    </div>
  );
}

// ─── phase row (the timeline "step") ───────────────────────────────────────

function PhaseRow({
  phase,
  runSteps,
}: {
  phase: WorkflowPhaseView;
  runSteps?: Record<string, RunStepView>;
}) {
  const [open, setOpen] = useState(false);
  const hasPreview = phase.detail !== undefined;
  const accent = phaseAccent(phase.nodes);
  const isAgent = appearsAgentPhase(phase.nodes);
  const status = phaseStatus(phase.nodes, runSteps);
  const n = phase.nodes.length;

  const lampStyle: CSSProperties =
    status === 'failed'
      ? { ...phaseLampStyle, background: 'var(--red-500, #ef4444)' }
      : status === 'running'
        ? {
            ...phaseLampStyle,
            background: 'var(--accent)',
            animation: 'duya-pulse 1.6s ease-in-out infinite',
          }
        : phaseLampStyle;

  return (
    <div>
      <div
        style={{ ...phaseRowStyle, ...(hasPreview || n > 0 ? phaseRowOpenStyle : undefined) }}
        role="button"
        aria-expanded={open}
        tabIndex={0}
        onClick={() => (n > 0 ? setOpen((v) => !v) : undefined)}
        onKeyDown={(e) => {
          if (n > 0 && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
      >
        <span style={lampStyle} />
        <span style={phaseTitleBlockStyle}>
          <span style={phaseTitleStyle}>{phase.title || phase.phase}</span>
          {phase.detail ? <span style={phaseDetailStyle}>{phase.detail}</span> : null}
        </span>
        <span style={phaseStatusBlockStyle}>
          {isAgent ? (
            <span style={avatarSquareStyle(accent)} title={NODE_KIND_LABEL.agent}>
              <UserIcon size={12} />
            </span>
          ) : (
            <span style={scriptGlyphStyle(accent)} title={NODE_KIND_LABEL.tool}>
              {'>_'}
            </span>
          )}
          <span style={nodeCountStyle}>
            {runSteps !== undefined ? `${status === 'success' ? n : status === 'running' ? 0 : 0}/${n}` : `${n}/${n}`}
          </span>
        </span>
        {n > 0 ? (
          <span style={phaseChevronStyle}>
            {open ? <CaretDownIcon size={13} /> : <CaretRightIcon size={13} />}
          </span>
        ) : null}
      </div>

      {open && n > 0 && (
        <div style={subStackStyle}>
          {phase.nodes.map((node) => (
            <SubNodeRow key={node.id} node={node} runStep={runSteps?.[node.id]} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── optional run-derived sections ─────────────────────────────────────────

interface SummaryBarProps {
  children: ReactNode;
}

function SummaryBar({ children }: SummaryBarProps) {
  return (
    <div style={summaryBarStyle}>
      <span style={summaryOkDotStyle} />
      <span>{children}</span>
    </div>
  );
}

function ArtifactsBlock({ items }: { items: WorkflowArtifactView[] }) {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <div style={artifactsHeaderStyle} role="button" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <FileMdIcon size={14} />
        <span>Artifacts</span>
        <span style={nodeCountStyle}>{items.length}</span>
        <span style={{ flex: 1 }} />
        <span style={nodeChevronStyle}>
          {open ? <CaretDownIcon size={12} /> : <CaretRightIcon size={12} />}
        </span>
      </div>
      {open && (
        <div style={artifactsBodyStyle}>
          {items.map((a) => (
            <div key={a.name} style={artifactChipStyle} title={a.name}>
              <FileMdIcon size={14} style={{ color: 'var(--accent-emerald)' }} />
              <span style={artifactNameStyle}>{a.name}</span>
              {a.size && <span style={artifactSizeStyle}>{a.size}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── public component ──────────────────────────────────────────────────────

/** Shape of an artifact chip shown in the optional run-result footer. */
export interface WorkflowArtifactView {
  /** Artifact file name (e.g. "report.md"). */
  name: string;
  /** Human-readable size label (e.g. "12 KB"). */
  size?: string;
}

export interface WorkflowGraphProps {
  def: WorkflowDefView;
  /**
   * Optional one-line run summary shown above the line, e.g.
   * "2 subagents · 8/8 steps · 1,821,463 tokens · 1 artifact".
   */
  summary?: ReactNode;
  /** Optional collapsed set of artifact chips rendered under the line. */
  artifacts?: WorkflowArtifactView[];
  /** Optional result message block rendered after the node line. */
  resultMessage?: ReactNode;
  /**
   * Optional live per-node step status (keyed by node id). When present, each
   * phase row's lamp + counter reflect the run; when absent, the graph stays
   * the plain definition placeholders (N/N from the static node counts).
   */
  runSteps?: Record<string, RunStepView>;
}

export function WorkflowGraph({ def, summary, artifacts, resultMessage, runSteps }: WorkflowGraphProps) {
  if (!def.phases.length) {
    return (
      <div
        style={{
          padding: 'var(--space-6, 24px)',
          textAlign: 'center',
          color: 'var(--text-faint)',
          fontSize: '13px',
        }}
      >
        <FileIcon size={20} />
        <div style={{ marginTop: 8 }}>No phases defined yet.</div>
      </div>
    );
  }

  return (
    <div style={wrapperStyle}>
      {summary ? <SummaryBar>{summary}</SummaryBar> : null}

      <div style={lineStyle}>
        {def.phases.map((phase) => (
          <PhaseRow key={phase.phase} phase={phase} runSteps={runSteps} />
        ))}
        {resultMessage ? <div style={resultBlockStyle}>{resultMessage}</div> : null}
      </div>

      {artifacts && artifacts.length > 0 ? <ArtifactsBlock items={artifacts} /> : null}
    </div>
  );
}