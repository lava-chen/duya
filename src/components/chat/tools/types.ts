// Shared types for the chat-tool chrome / row / group system.
//
// Extracted from ToolActionsGroup.tsx so every row / chrome / group file
// imports the same shapes instead of redefining them inline. No runtime
// code lives here — pure type declarations only.

import type { Icon } from '@/components/icons';
import type { AgentProgressEventWithMeta } from '@/hooks/useStreamingAgentProgress';
import type { TranslationKey } from '@/i18n';
import type { HookAction } from '@/types/hooks';

// Re-export so row / chrome / group files can `import type { HookAction }
// from '@/components/chat/tools/types'` and stay co-located with the rest
// of the chat-tool chrome.
export type { HookAction };

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
  metadata?: Record<string, unknown>;
  /** Research lifecycle stage the tool ran in (e.g. gathering / evaluating).
   *  Set by the streaming path from the tool_use event in arrival order. */
  stage?: string;
}

/**
 * One element of the action stream. Tool actions are routed through
 * `ToolActionRow`; thinking / text / widget actions are rendered as
 * standalone rows that break the group run. Hook actions (plan 437)
 * render through `HookActionRow` and also break the run — they are not
 * LLM tool calls and should read as separate signals interleaved with
 * the model's prose.
 */
export type ActionItem =
  | { kind: 'thinking'; content: string; isStreaming?: boolean }
  | { kind: 'tool'; tool: ToolAction; streamingToolOutput?: string }
  | { kind: 'text'; content: string }
  | { kind: 'widget'; content: string; sourceMessageId?: string; sourceLabel?: string }
  | { kind: 'hook'; hook: HookAction };

/**
 * One element of a Segment's run. Tool actions render through
 * `ToolActionRow`; thinking rows render through `ThinkingRow`; hook
 * actions render through `HookActionRow`. Tool + thinking + hook share
 * the same ordering inside a group, so a sequence like [tool, hook,
 * thinking, tool] becomes a single Group with four entries interleaved
 * in their original action order.
 */
export type SegmentEntry =
  | { kind: 'tool'; tool: ToolAction }
  | { kind: 'thinking'; content: string; isStreaming?: boolean }
  | { kind: 'hook'; hook: HookAction };

/**
 * Segment produced by `computeSegments`. A run of consecutive tool /
 * thinking actions either becomes a Group (≥2) or a single standalone
 * entry (1). Only `text` and `widget` actions break the run —
 * thinking joins the run because it's a side-channel of the model's
 * reasoning, not a separate user-visible step.
 */
export type Segment =
  | { kind: 'group'; entries: SegmentEntry[] }
  | { kind: 'single'; entry: SegmentEntry };

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
  | 'skill'
  | 'module'
  | 'tasks'
  | 'canvas'
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
