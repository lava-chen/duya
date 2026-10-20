/**
 * workflow-types.ts — renderer-side shape types for workflow definitions
 * (plan 552 Phase 9, file format from packages/agent/src/modes/workflow/schema.ts).
 *
 * The YAML file is the authoritative source: the renderer reads it via the
 * `workflow:defs:get` IPC channel and renders it read-only as a node graph.
 * Editing the script body always goes through the agent conversation; the UI
 * only edits the metadata header (params + when_to_use + description).
 */

export type WorkflowNodeKind = 'tool' | 'gui' | 'browser' | 'decision' | 'human' | 'agent' | 'noop';

export type WorkflowParamType = 'string' | 'number' | 'boolean' | 'json';

export interface WorkflowParamView {
  name: string;
  type: WorkflowParamType;
  required?: boolean;
  default?: unknown;
}

export interface WorkflowNodeView {
  id: string;
  /** Derived from which field is present — display + icon pick. */
  kind: WorkflowNodeKind;
  /** When the YAML `tool` field is set (e.g. "Bash", "Read"). */
  tool?: string;
  /** Tool input (e.g. { cmd: "git log..." }). */
  input?: Record<string, unknown>;
  /** Gui node (raw, simplified for preview). */
  gui?: { target_app?: string; steps?: unknown[] };
  /** Decision node (raw, simplified for preview). */
  decision?: { questions?: Record<string, unknown> };
  /** Human node (raw, simplified for preview). */
  human?: { prompt?: string };
  /** Agent node identifier. */
  agent?: string;
  /** Agent prompt. */
  prompt?: string;
  /** Optional LLM model override. */
  model?: string;
  /** Output schema for the agent. */
  output_schema?: Record<string, unknown>;
  /** Noop marker. */
  noop?: boolean;
  /** Conditional edge expression — evaluated per node. */
  when?: string;
  on_error?: 'skip' | 'fail' | 'retry';
  max_retries?: number;
}

export interface WorkflowPhaseView {
  phase: string;
  title: string;
  detail?: string;
  nodes: WorkflowNodeView[];
}

export interface WorkflowDefView {
  name: string;
  description: string;
  when_to_use?: string;
  params: WorkflowParamView[];
  triggers?: Array<'cron' | 'bot' | 'http'>;
  phases: WorkflowPhaseView[];
  /** Raw script body for .dwf.ts workflows (phases will be empty). */
  script?: string;
}

/**
 * Best-effort derivation of node kind for icon + label. Matches the schema
 * refine() rule: exactly one of tool/gui/decision/human/agent/noop.
 */
export function deriveNodeKind(node: Partial<WorkflowNodeView>): WorkflowNodeKind {
  if (node.tool) return 'tool';
  if (node.gui) return 'gui';
  if (node.decision) return 'decision';
  if (node.human) return 'human';
  if (node.agent) return 'agent';
  if (node.noop) return 'noop';
  return 'noop';
}

/**
 * Compact one-line preview for a node — used as the inline subtitle.
 * Returns null when nothing meaningful is available.
 */
export function nodeInlinePreview(node: WorkflowNodeView): string | null {
  if (node.kind === 'tool' && node.input) {
    const cmd = node.input.cmd ?? node.input.command ?? node.input.command_text;
    if (typeof cmd === 'string') return cmd.length > 120 ? `${cmd.slice(0, 117)}…` : cmd;
    // File read style: { path: 'package.json' }
    const filePath = node.input.file_path ?? node.input.path;
    if (typeof filePath === 'string') return filePath;
  }
  if (node.kind === 'agent') {
    return node.agent ?? 'subagent';
  }
  if (node.kind === 'decision' && node.decision?.questions) {
    const ids = Object.keys(node.decision.questions);
    return ids.length > 0 ? `${ids.length} question${ids.length === 1 ? '' : 's'}` : null;
  }
  if (node.kind === 'human' && node.human?.prompt) {
    return node.human.prompt.length > 80 ? `${node.human.prompt.slice(0, 77)}…` : node.human.prompt;
  }
  if (node.kind === 'gui' && node.gui?.target_app) {
    return node.gui.target_app;
  }
  return null;
}

/** Friendly label for a node kind (used in chip badges). */
export const NODE_KIND_LABEL: Record<WorkflowNodeKind, string> = {
  tool: 'Tool',
  gui: 'GUI',
  browser: 'Browser',
  decision: 'Decision',
  human: 'Human',
  agent: 'Subagent',
  noop: 'Noop',
};

/** Color accent (CSS var name) for each node kind. Matches Duya palette. */
export const NODE_KIND_ACCENT: Record<WorkflowNodeKind, string> = {
  tool: 'var(--accent-emerald)',
  agent: 'var(--accent-teal)',
  decision: 'var(--accent-amber)',
  human: 'var(--accent-rose)',
  gui: 'var(--accent-violet)',
  browser: 'var(--accent-sky)',
  noop: 'var(--text-faint)',
};