// Tool name classification helpers and small constant sets.
//
// These predicates are used by both the renderer (`isBrowserTool` decides
// whether a row uses the chrome icon, `isAskUserQuestionTool` decides
// whether to route to a dedicated row) and the group summary builder
// (`classifyToolForSummary` decides which SummaryCategoryKey bucket a
// tool falls into).

import type { SummaryCategoryKey, ToolAction } from './types';

/**
 * Canonical browser tool names. Anything starting with `browser_` or
 * `browser-` is also treated as a browser tool — see `isBrowserTool`.
 */
export const BROWSER_TOOLS = new Set([
  'browser', 'browsertool', 'browser_tool', 'chrome',
]);

/** Edit tool names (canonical + common aliases). */
export const FILE_EDIT_TOOLS = new Set([
  'edit', 'edit_file', 'str_replace_editor',
]);

/** Write / create tool names. */
export const FILE_CREATE_TOOLS = new Set([
  'write', 'writefile', 'write_file', 'create_file', 'createfile',
]);

/**
 * AskUserQuestion has a dedicated row layout (mirrors BashToolRow).
 * The tool name is registered as 'AskUserQuestion' on the agent side
 * (see ASK_USER_QUESTION_TOOL_NAME in packages/agent). Only one
 * canonical name exists — no sub-action family to match.
 */
export const ASK_USER_QUESTION_TOOLS = new Set(['askuserquestion']);

/**
 * Browser tools (chrome / browser / browsertool / browser_tool).
 * Consecutive browser actions are collapsed into a single "已使用 浏览器"
 * group rather than rendered as a wall of JSON dumps.
 */
export function isBrowserTool(name: string): boolean {
  const lower = name.toLowerCase();
  if (BROWSER_TOOLS.has(lower)) return true;
  // Match browser sub-actions like browser_navigate, browser_click,
  // browser_screenshot, etc. — agents often expose browser capability
  // as one base tool with an `operation` parameter, but they may also
  // expose it as a family of namespaced tools. Treating any name
  // starting with "browser_" as a browser tool keeps every consecutive
  // call inside the same generic Group instead of leaking the last one
  // out as a standalone row.
  if (lower.startsWith('browser_') || lower.startsWith('browser-')) {
    return true;
  }
  return false;
}

export function isAskUserQuestionTool(name: string): boolean {
  return ASK_USER_QUESTION_TOOLS.has(name.toLowerCase());
}

/**
 * Legacy `task` tool sometimes carries subagent-shaped input or result;
 * detect that so the router can dispatch it through SubAgentToolRow
 * instead of the generic catch-all. New code uses `agent` / `subagent`
 * directly; this branch is kept for old sessions whose history still
 * contains the legacy task tool.
 */
export function isLegacySubAgentToolAction(tool: ToolAction): boolean {
  const lowerName = tool.name.toLowerCase();
  if (lowerName !== 'task') return false;
  const input = tool.input as Record<string, unknown> | undefined;
  if (typeof input?.prompt === 'string' || typeof input?.subagent_type === 'string') {
    return true;
  }
  // Defer the parseSubAgentToolResult import to keep this module
  // synchronous-friendly. The legacy check only matters when a result
  // has already arrived.
  if (tool.result) {
    try {
      const parsed = JSON.parse(tool.result);
      if (typeof parsed === 'object' && parsed !== null) {
        if (typeof (parsed as { sessionId?: unknown }).sessionId === 'string') return true;
        if (typeof (parsed as { background?: unknown }).background === 'boolean') return true;
      }
    } catch {
      // not JSON — fall through
    }
  }
  return false;
}

/**
 * Map one tool call to a summary part. Returns null if the tool doesn't
 * contribute to the summary (no tool should hit this — the registry
 * catch-all maps to `tools`).
 */
export function classifyToolForSummary(tool: ToolAction): { count: 1; categoryKey: SummaryCategoryKey } | null {
  const name = tool.name.toLowerCase();
  if (['shell', 'bash', 'execute', 'run', 'execute_command', 'run_command', 'duya_cli', 'duya-cli', 'duyacli', 'powershell'].includes(name)) {
    return { count: 1, categoryKey: 'commands' };
  }
  if (['edit', 'edit_file', 'str_replace_editor', 'write', 'writefile', 'write_file', 'create_file', 'createfile'].includes(name)) {
    return { count: 1, categoryKey: 'editFiles' };
  }
  if (['read', 'readfile', 'read_file', 'read_multiple_files'].includes(name)) {
    return { count: 1, categoryKey: 'readFiles' };
  }
  if (['search', 'glob', 'grep', 'find_files', 'search_files', 'ls'].includes(name)) {
    return { count: 1, categoryKey: 'search' };
  }
  if (isBrowserTool(name)) {
    return { count: 1, categoryKey: 'browser' };
  }
  if (['agent', 'subagent', 'sub_agent'].includes(name)) {
    return { count: 1, categoryKey: 'agent' };
  }
  if (name === 'askuserquestion') {
    return { count: 1, categoryKey: 'ask' };
  }
  if (name === 'memory') {
    return { count: 1, categoryKey: 'memory' };
  }
  if (name === 'skill') {
    return { count: 1, categoryKey: 'skill' };
  }
  return { count: 1, categoryKey: 'tools' };
}
