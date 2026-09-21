/**
 * WorkflowGraph — read-only node-graph view for a workflow definition
 * (plan 552 Phase 9). Renders the YAML phases + nodes as a vertical
 * timeline in the style of ZCode's run-execution view:
 *
 *   • one emerald vertical line running top-to-bottom (#10b981 / #4ADE80)
 *   • nodes strung in order on the line, each a compact single row
 *   • left status dot sitting on the line, accent icon block + title in the
 *     middle, a glyph badge + run counter + collapse chevron on the right
 *   • expanding a row unfolds its inline preview text
 *
 * The `def` path is a plain definition browser. Run-derived facades
 * (summary / result / artifacts) are optional props: pass them only when a
 * run data source is available, otherwise they render as nothing so the
 * component still reads cleanly as a definition view.
 *
 * Editing always goes through the agent conversation; this component only
 * renders the structure for human inspection.
 */

import { useState, Fragment, type CSSProperties, type ReactNode } from 'react';
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
// left border; every node row parks its status dot centered on it.
const lineStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '10px',
  borderLeft: '2px solid var(--accent-emerald, #4ade80)',
  paddingLeft: '22px',
  paddingTop: '4px',
  paddingBottom: '4px',
};

/** Muted per-phase group heading. Deliberately small so the node line is the focal axis. */
const phaseHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: '8px',
  fontSize: '11px',
  color: 'var(--text-faint)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  marginTop: '4px',
};

const phaseHeaderTitleStyle: CSSProperties = {
  fontWeight: 600,
  color: 'var(--text)',
  textTransform: 'none',
  letterSpacing: 'normal',
};

const phaseCountStyle: CSSProperties = {
  fontSize: '11px',
  color: 'var(--text-faint)',
  fontVariantNumeric: 'tabular-nums',
};

const nodeStackItemStyle: CSSProperties = {
  position: 'relative',
};

const nodeRowStyle: CSSProperties = {
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  minHeight: '30px',
  padding: '4px 8px',
  borderRadius: '6px',
  cursor: 'pointer',
  userSelect: 'none',
  transition: 'background 120ms ease',
};

const nodeRowSelectedStyle: CSSProperties = {
  background: 'var(--bg-surface-1, transparent)',
};

/**
 * Status dot centered exactly on the timeline's left border.
 * Timeline: border(2) + paddingLeft(22) = content starts 24px in; the 2px
 * border sits at x=0..2 (center x=1). A 10px dot needs left of -28px relative
 * to the row's content edge to land its center on the border.
 */
const nodeDotStyle: CSSProperties = {
  position: 'absolute',
  left: '-28px',
  top: '10px',
  width: '10px',
  height: '10px',
  borderRadius: '50%',
  background: 'var(--accent-emerald, #4ade80)',
  boxShadow: '0 0 0 3px color-mix(in srgb, var(--accent-emerald) 18%, transparent)',
  pointerEvents: 'none',
};

const nodeIconBoxStyle = (accent: string): CSSProperties => ({
  width: '20px',
  height: '20px',
  borderRadius: '5px',
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: accent,
  background: `color-mix(in srgb, ${accent} 14%, transparent)`,
});

const nodeTitleStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: '13px',
  fontWeight: 500,
  color: 'var(--text)',
  fontFamily: 'var(--font-mono, ui-monospace, "SF Mono", monospace)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const nodeBadgeStyle = (accent: string): CSSProperties => ({
  minWidth: '26px',
  textAlign: 'center',
  padding: '1px 6px',
  borderRadius: '4px',
  fontSize: '11px',
  fontWeight: 600,
  color: accent,
  background: `color-mix(in srgb, ${accent} 14%, transparent)`,
  border: `1px solid color-mix(in srgb, ${accent} 30%, transparent)`,
  fontFamily: 'var(--font-mono, ui-monospace, "SF Mono", monospace)',
  whiteSpace: 'nowrap',
});

/**
 * N/M run counter. The definition source carries no run counters, so this is
 * an honest 1/1 placeholder rather than a fabricated status — swap in real
 * `done/total` values from a run data source when one is wired up.
 */
const nodeCountStyle: CSSProperties = {
  fontSize: '11px',
  color: 'var(--text-faint)',
  fontVariantNumeric: 'tabular-nums',
};

const nodeChevronStyle: CSSProperties = {
  color: 'var(--text-faint)',
  flexShrink: 0,
};

/** Expanded inline preview body, indented under the collapsed row. */
const nodePreviewBodyStyle: CSSProperties = {
  marginTop: '2px',
  marginLeft: '28px',
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

// ─── kind glyphs ───────────────────────────────────────────────────────────

/** Short monospace glyph shown in the right-side kind badge (ZCode `>_` style). */
const KIND_GLYPH: Record<WorkflowNodeKind, string> = {
  tool: '>_',
  agent: '@',
  decision: '?',
  human: '✎',
  gui: '◎',
  noop: '·',
};

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

// ─── node row ──────────────────────────────────────────────────────────────

function NodeRow({ node }: { node: WorkflowNodeView }) {
  const [expanded, setExpanded] = useState(false);
  const kind = deriveNodeKind(node);
  const accent = NODE_KIND_ACCENT[kind];
  const preview = nodeInlinePreview(node);
  const label = kind === 'tool' && node.tool ? node.tool : NODE_KIND_LABEL[kind];

  return (
    <div style={nodeStackItemStyle}>
      <div
        style={{ ...nodeRowStyle, ...(preview ? nodeRowSelectedStyle : undefined) }}
        role="button"
        aria-expanded={expanded}
        tabIndex={0}
        onClick={() => preview && setExpanded((v) => !v)}
        onKeyDown={(e) => {
          if (preview && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        }}
      >
        <span style={nodeDotStyle} />
        <span style={nodeIconBoxStyle(accent)}>
          <NodeIcon kind={kind} />
        </span>
        <span style={nodeTitleStyle}>{node.id}</span>
        <span style={nodeBadgeStyle(accent)} title={label}>
          {KIND_GLYPH[kind]}
        </span>
        <span style={nodeCountStyle} title="run counters are placeholders (definition has no run data)">
          1/1
        </span>
        {preview ? (
          <span style={nodeChevronStyle}>
            {expanded ? <CaretDownIcon size={12} /> : <CaretRightIcon size={12} />}
          </span>
        ) : null}
      </div>
      {expanded && preview && <div style={nodePreviewBodyStyle}>{preview}</div>}
    </div>
  );
}

// ─── phase group ───────────────────────────────────────────────────────────

function PhaseGroup({ phase }: { phase: WorkflowPhaseView }) {
  return (
    <Fragment>
      <div style={phaseHeaderStyle}>
        <span style={phaseHeaderTitleStyle}>{phase.title || phase.phase}</span>
        <span style={phaseCountStyle}>
          {phase.nodes.length} {phase.nodes.length === 1 ? 'step' : 'steps'}
        </span>
      </div>
      {phase.nodes.map((node) => (
        <NodeRow key={node.id} node={node} />
      ))}
    </Fragment>
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
      <div
        style={artifactsHeaderStyle}
        role="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
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
}

export function WorkflowGraph({ def, summary, artifacts, resultMessage }: WorkflowGraphProps) {
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
          <PhaseGroup key={phase.phase} phase={phase} />
        ))}
        {resultMessage ? <div style={resultBlockStyle}>{resultMessage}</div> : null}
      </div>

      {artifacts && artifacts.length > 0 ? <ArtifactsBlock items={artifacts} /> : null}
    </div>
  );
}