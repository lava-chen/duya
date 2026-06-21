// Shared types for the chat-tool chrome / row / group system.
//
// Extracted from ToolActionsGroup.tsx so every row / chrome / group file
// imports the same shapes instead of redefining them inline. No runtime
// code lives here — pure type declarations only.

import type { Icon } from '@phosphor-icons/react';
import type { AgentProgressEventWithMeta } from '@/hooks/useStreamingAgentProgress';
import type { TranslationKey } from '@/i18n';

/**
 * A single tool_use + tool_result pair as it flows through the action
 * stream. `result` is `undefined` while the tool is still running; once
 * the tool returns, the chrome flips from spinner to check / x.
 */
export interface ToolAction {
  id?: string;
  name: string;
  input: unknown;
  result?: string;
  isError?: boolean;
  durationMs?: number | null;
}

/**
 * One element of the action stream. Tool actions are routed through
 * `ToolActionRow`; thinking / text / widget actions are rendered as
 * standalone rows that break the group run.
 */
export type ActionItem =
  | { kind: 'thinking'; content: string; isStreaming?: boolean }
  | { kind: 'tool'; tool: ToolAction; streamingToolOutput?: string }
  | { kind: 'text'; content: string }
  | { kind: 'widget'; content: string; sourceMessageId?: string; sourceLabel?: string };

/**
 * Segment produced by `computeSegments`. A run of consecutive tool
 * actions either becomes a Group (≥2) or a single standalone row (1).
 */
export type Segment =
  | { kind: 'group'; tools: ToolAction[] }
  | { kind: 'single'; tool: ToolAction };

/**
 * Coarse-grained category the group summary uses to count tool calls.
 * One tool name belongs to exactly one category (the registry's catch-all
 * maps to `tools`).
 */
export type SummaryCategoryKey =
  | 'commands'
  | 'editFiles'
  | 'readFiles'
  | 'search'
  | 'browser'
  | 'agent'
  | 'ask'
  | 'memory'
  | 'skill'
  | 'tools';

/**
 * Display status derived from a tool action's result + isError fields.
 */
export type ToolStatus = 'running' | 'success' | 'error';

/**
 * Registry entry for a family of tool names. The match predicate
 * accepts the canonical name and any aliases an agent might emit.
 */
export interface ToolRendererDef {
  match: (name: string) => boolean;
  icon: Icon;
  /** i18n key for the verb shown next to the icon (e.g. "已编辑"/"Edited").
   *  Null when no label is shown (e.g. shell/bash where the command itself
   *  is the label). Translation happens at render time inside ToolActionRow
   *  because hooks can't be called at module top level. */
  labelKey: TranslationKey | null;
  getSummary: (input: unknown, name?: string) => string;
  renderDetail?: (tool: ToolAction, streamingOutput?: string) => React.ReactNode;
}

/**
 * Diff stats surfaced by FileEditToolRow's collapsed chrome. Live values
 * are computed from the tool input while streaming; once a result arrives
 * the row recomputes from the authoritative result payload.
 */
export interface FileEditStats {
  stats: { additions: number; removals: number };
  kind: 'edit' | 'create' | 'unknown';
}

/**
 * Re-export of the agent-progress event stream type so row components
 * can type their props without reaching back into the chat hooks
 * directory.
 */
export type { AgentProgressEventWithMeta };
