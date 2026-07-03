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
 * Module tool — loads design specification READMEs as markdown.
 * Single canonical name (`read_module`) registered on the agent side
 * (see MODULE_TOOL_NAME in packages/agent/src/tool/ModuleTool).
 */
export const MODULE_TOOLS = new Set(['read_module']);

/**
 * Task tool — manages an internal task list with action subcommands
 * (`create` / `get` / `list` / `update` / `output` / `stop`). Single
 * canonical name (`task`) registered on the agent side (see
 * TASK_TOOL_NAME in packages/agent/src/tool/TaskTool).
 */
export const TASK_TOOLS = new Set(['task']);

/** Action values the TaskTool accepts (must mirror the input_schema in
 *  packages/agent/src/tool/TaskTool/TaskTool.ts). Used by
 *  `isTaskToolAction` to disambiguate from legacy `task` tool calls
 *  that were actually subagent dispatches (they never carry an
 *  `action` field). */
const TASK_ACTIONS = new Set(['create', 'get', 'list', 'update', 'output', 'stop']);

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

export function isModuleTool(name: string): boolean {
  return MODULE_TOOLS.has(name.toLowerCase());
}

/** Returns true only when the tool *input* looks like a TaskTool call.
 *  This is more specific than `name === 'task'` because the legacy
 *  subagent dispatcher also used the `task` tool name. We must NOT
 *  claim a legacy `task` payload (which carries `prompt` /
 *  `subagent_type` and no `action`) for the task list. */
export function isTaskToolAction(input: unknown): boolean {
  const mod = (input as Record<string, unknown> | undefined)?.action;
  return typeof mod === 'string' && TASK_ACTIONS.has(mod);
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
  // The TaskTool now owns the `task` name and carries `input.action`.
  // A legacy subagent payload never had an `action` field, so a
  // present-and-valid `action` means this is the new TaskTool and we
  // must NOT claim it for SubAgentToolRow.
  if (isTaskToolAction(tool.input)) return false;
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
  if (name === 'task' && isTaskToolAction(tool.input)) {
    return { count: 1, categoryKey: 'tasks' };
  }
  if (isModuleTool(name)) {
    return { count: 1, categoryKey: 'module' };
  }
  return { count: 1, categoryKey: 'tools' };
}
