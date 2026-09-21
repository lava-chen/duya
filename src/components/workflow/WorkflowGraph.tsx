/**
 * WorkflowGraph — read-only node-graph view for a workflow definition
 * (plan 552 Phase 9). Renders the YAML phases + nodes as a vertical
 * timeline with the same visual style as the existing run result view
 * (green status dot on the left, expandable cards on the right).
 *
 * Editing always goes through the agent conversation; this component
 * only renders the structure for human inspection.
 */

import { useState, type CSSProperties } from 'react';
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

const phaseStyle: CSSProperties = {
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-2, 8px)',
};

const phaseHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-3, 12px)',
  padding: '10px 14px',
  background: 'var(--bg-surface-1, transparent)',
  border: '1px solid var(--border-weak)',
  borderRadius: '8px',
  cursor: 'pointer',
  userSelect: 'none',
  transition: 'background 120ms ease',
};

const phaseDotStyle: CSSProperties = {
  width: '8px',
  height: '8px',
  borderRadius: '50%',
  background: 'var(--accent-emerald, #10b981)',
  flexShrink: 0,
};

const phaseTitleStyle: CSSProperties = {
  flex: 1,
  fontSize: '14px',
  fontWeight: 500,
  color: 'var(--text)',
};

const phaseCountStyle: CSSProperties = {
  fontSize: '12px',
  color: 'var(--text-faint)',
  fontVariantNumeric: 'tabular-nums',
};

const nodesWrapStyle: CSSProperties = {
  marginLeft: 'var(--space-4, 16px)',
  paddingLeft: 'var(--space-4, 16px)',
  borderLeft: '2px solid var(--border-weak)',
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-2, 8px)',
};

const nodeCardStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-3, 12px)',
  padding: '10px 12px',
  background: 'var(--bg-surface-1, transparent)',
  border: '1px solid var(--border-weak)',
  borderRadius: '6px',
  fontSize: '13px',
};

const nodeIconBoxStyle = (accent: string): CSSProperties => ({
  width: '28px',
  height: '28px',
  borderRadius: '6px',
  background: 'var(--bg-surface-2, rgba(255,255,255,0.05))',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: accent,
  flexShrink: 0,
});

const nodeTitleStyle: CSSProperties = {
  fontWeight: 500,
  color: 'var(--text)',
};

const nodePreviewStyle: CSSProperties = {
  flex: 1,
  fontSize: '12px',
  color: 'var(--text-faint)',
  fontFamily: 'var(--font-mono, ui-monospace, "SF Mono", monospace)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const nodeKindChipStyle = (accent: string): CSSProperties => ({
  fontSize: '11px',
  padding: '2px 8px',
  borderRadius: '999px',
  background: 'var(--bg-surface-2, rgba(255,255,255,0.05))',
  color: accent,
  border: `1px solid ${accent}33`,
  whiteSpace: 'nowrap',
});

// ─── icon mapping ──────────────────────────────────────────────────────────

function NodeIcon({ kind, size = 14 }: { kind: WorkflowNodeKind; size?: number }) {
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

// ─── node card ─────────────────────────────────────────────────────────────

function NodeCard({ node }: { node: WorkflowNodeView }) {
  const kind = deriveNodeKind(node);
  const accent = NODE_KIND_ACCENT[kind];
  const preview = nodeInlinePreview(node);
  const label = kind === 'tool' && node.tool ? node.tool : NODE_KIND_LABEL[kind];

  return (
    <div style={nodeCardStyle}>
      <div style={nodeIconBoxStyle(accent)}>
        <NodeIcon kind={kind} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
        <span style={nodeTitleStyle}>{node.id}</span>
        {preview && <span style={nodePreviewStyle}>{preview}</span>}
      </div>
      <span style={nodeKindChipStyle(accent)}>{label}</span>
    </div>
  );
}

// ─── phase card ────────────────────────────────────────────────────────────

function PhaseCard({ phase }: { phase: WorkflowPhaseView }) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div style={phaseStyle}>
      <div
        style={phaseHeaderStyle}
        onClick={() => setExpanded((v) => !v)}
        role="button"
        aria-expanded={expanded}
      >
        <span style={phaseDotStyle} />
        <span style={phaseTitleStyle}>{phase.title || phase.phase}</span>
        <span style={phaseCountStyle}>
          {phase.nodes.length} {phase.nodes.length === 1 ? 'step' : 'steps'}
        </span>
        {expanded ? <CaretDownIcon size={14} /> : <CaretRightIcon size={14} />}
      </div>
      {expanded && (
        <div style={nodesWrapStyle}>
          {phase.nodes.map((node) => (
            <NodeCard key={node.id} node={node} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── public component ──────────────────────────────────────────────────────

export interface WorkflowGraphProps {
  def: WorkflowDefView;
}

export function WorkflowGraph({ def }: WorkflowGraphProps) {
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
      {def.phases.map((phase) => (
        <PhaseCard key={phase.phase} phase={phase} />
      ))}
    </div>
  );
}