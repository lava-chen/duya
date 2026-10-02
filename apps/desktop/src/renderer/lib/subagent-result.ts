// src/lib/subagent-result.ts
// Parser for the `task` tool's structured result payload.
//
// Plan 571: the tool now returns a discriminated shape keyed on `status`
// (see `SubagentToolResult` in packages/agent/src/tool/SubagentTool/SubagentTool.ts).
// The parser stays tolerant of the pre-571 field names because persisted
// session history still contains old receipts — a session opened tomorrow must
// not render a blank row just because it was recorded last month.

import { normalizeSubagentStatus, type SubagentRunStatus } from './subagent-status';

export interface ParsedSubAgentToolResult {
  /** Agent type the model asked for (pre-alias-resolution). */
  agentType?: string;
  /** Agent type actually resolved against the registry. */
  resolvedAgentType?: string;
  description?: string;
  content?: string;
  /** The sub-agent's own session id — the side panel's conversation identity. */
  sessionId?: string;
  agentId?: string;
  taskId?: string;
  background?: boolean;
  status?: SubagentRunStatus;
  error?: string;
  /**
   * Path to the jsonl transcript on disk. The backend has always returned
   * this, but the row hardcoded `undefined` for it, so the UI could never
   * offer "read the full transcript".
   */
  outputFilePath?: string;
  totalToolUseCount?: number;
  totalDurationMs?: number;
  totalTokens?: number;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  /** Working directory the child actually ran in (differs under worktree isolation). */
  workingDirectory?: string;
  /** Present when the run was isolated into a git worktree. */
  isolation?: 'worktree';
  /** Non-fatal notes (e.g. resume requested an id that started a fresh run). */
  warnings?: string[];
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseUsage(value: unknown): ParsedSubAgentToolResult['usage'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const input = optionalNumber(raw.input_tokens);
  const output = optionalNumber(raw.output_tokens);
  if (input === undefined && output === undefined) return undefined;
  const usage: NonNullable<ParsedSubAgentToolResult['usage']> = {
    input_tokens: input ?? 0,
    output_tokens: output ?? 0,
  };
  const cacheCreation = optionalNumber(raw.cache_creation_input_tokens);
  if (cacheCreation !== undefined) usage.cache_creation_input_tokens = cacheCreation;
  const cacheRead = optionalNumber(raw.cache_read_input_tokens);
  if (cacheRead !== undefined) usage.cache_read_input_tokens = cacheRead;
  return usage;
}

export function parseSubAgentToolResult(result: string | null | undefined): ParsedSubAgentToolResult | null {
  if (!result) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const raw = parsed as Record<string, unknown>;

  const warnings = Array.isArray(raw.warnings)
    ? raw.warnings.filter((w): w is string => typeof w === 'string' && w.trim().length > 0)
    : undefined;

  const out: ParsedSubAgentToolResult = {
    agentType: optionalString(raw.agentType),
    resolvedAgentType: optionalString(raw.resolvedAgentType),
    description: optionalString(raw.description),
    content: optionalString(raw.content),
    sessionId: optionalString(raw.sessionId) ?? optionalString(raw.childSessionId),
    agentId: optionalString(raw.agentId),
    taskId: optionalString(raw.taskId) ?? optionalString(raw.backgroundTaskId),
    background: raw.background === true || raw.isAsync === true,
    status: normalizeSubagentStatus(raw.status),
    error: optionalString(raw.error),
    outputFilePath: optionalString(raw.outputFilePath) ?? optionalString(raw.outputFile),
    totalToolUseCount: optionalNumber(raw.totalToolUseCount),
    totalDurationMs: optionalNumber(raw.totalDurationMs),
    totalTokens: optionalNumber(raw.totalTokens),
    usage: parseUsage(raw.usage),
    workingDirectory: optionalString(raw.workingDirectory),
    isolation: raw.isolation === 'worktree' ? 'worktree' : undefined,
  };
  if (warnings && warnings.length > 0) out.warnings = warnings;
  return out;
}

/** True when the run has reached a state the UI must stop animating. */
export function isSubagentResultTerminal(result: ParsedSubAgentToolResult | null | undefined): boolean {
  return result?.status === 'completed' || result?.status === 'failed' || result?.status === 'killed';
}
