// Tool registry — maps a tool name (or alias) to a renderer def.
//
// Extracted from ToolActionsGroup.tsx. The registry is intentionally
// narrow: it owns icon, label verb, and a summary string. Per-tool
// rendering decisions (which dedicated row to mount) live in the
// ToolActionRow router; per-tool card layout lives in the row file.

import {
  FileIcon,
  NotePencilIcon,
  TerminalIcon,
  MagnifyingGlassIcon,
  WrenchIcon,
  RobotIcon,
  ChromeIcon,
  QuestionIcon,
} from '@/components/icons';
import {
  isBrowserTool,
} from './classify';
import type { ToolAction, ToolRendererDef } from './types';

/**
 * Pull a string field from a tool's `input` payload. Tolerant of
 * common alias names (`file_path` / `path` / `filePath`).
 */
export function getFilePath(input: unknown): string {
  const inp = input as Record<string, unknown> | undefined;
  if (!inp) return '';
  const rawPath = inp.file_path || inp.path || inp.filePath || '';
  return typeof rawPath === 'string' ? rawPath : '';
}

/** Last path segment — used by row summary when the full path would
 *  overflow the chrome. */
export function extractFilename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

/** Truncate a long path for the collapsed chrome's right slot. */
export function truncatePath(path: string, maxLen = 50): string {
  if (path.length <= maxLen) return path;
  return '...' + path.slice(path.length - maxLen + 3);
}

export const TOOL_REGISTRY: ToolRendererDef[] = [
  {
    match: (n) => n.toLowerCase() === 'shell',
    icon: TerminalIcon,
    labelKey: null,
    getSummary: (input) => {
      const rawCmd = (input as Record<string, unknown>)?.command || (input as Record<string, unknown>)?.cmd || '';
      const cmd = typeof rawCmd === 'string' ? rawCmd : JSON.stringify(rawCmd);
      return cmd ? (cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd) : 'shell';
    },
  },
  {
    match: (n) => ['bash', 'execute', 'run', 'execute_command', 'run_command'].includes(n.toLowerCase()),
    icon: TerminalIcon,
    labelKey: null,
    getSummary: (input) => {
      const rawCmd = (input as Record<string, unknown>)?.command || (input as Record<string, unknown>)?.cmd || '';
      const cmd = typeof rawCmd === 'string' ? rawCmd : JSON.stringify(rawCmd);
      return cmd ? (cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd) : 'bash';
    },
  },
  {
    match: (n) => n.toLowerCase() === 'duya_cli' || n.toLowerCase() === 'duya-cli' || n.toLowerCase() === 'duyacli',
    icon: TerminalIcon,
    labelKey: 'streaming.toolAction.label.cli',
    getSummary: (input) => {
      // "Run duya status" / "运行 duya status"
      const argv = (input as Record<string, unknown>)?.argv;
      const args = Array.isArray(argv) ? argv.map(String) : [];
      return args.length > 0 ? `duya ${args.join(' ')}` : 'duya';
    },
  },
  {
    match: (n) => ['edit', 'edit_file', 'str_replace_editor'].includes(n.toLowerCase()),
    icon: NotePencilIcon,
    labelKey: 'streaming.toolAction.label.edit',
    getSummary: (input) => {
      const path = getFilePath(input);
      return path ? extractFilename(path) : 'file';
    },
  },
  {
    match: (n) => ['write', 'writefile', 'write_file', 'create_file', 'createfile'].includes(n.toLowerCase()),
    icon: NotePencilIcon,
    labelKey: 'streaming.toolAction.label.create',
    getSummary: (input) => {
      const path = getFilePath(input);
      return path ? extractFilename(path) : 'file';
    },
  },
  {
    match: (n) => ['read', 'readfile', 'read_file', 'read_multiple_files'].includes(n.toLowerCase()),
    icon: FileIcon,
    labelKey: 'streaming.toolAction.label.read',
    getSummary: (input) => {
      const path = getFilePath(input);
      return path ? extractFilename(path) : 'file';
    },
  },
  {
    match: (n) => ['search', 'glob', 'grep', 'find_files', 'search_files'].includes(n.toLowerCase()),
    icon: MagnifyingGlassIcon,
    labelKey: 'streaming.toolAction.label.search',
    getSummary: (input) => {
      const inp = input as Record<string, unknown> | undefined;
      const rawPattern = inp?.pattern || inp?.query || inp?.glob || '';
      const pattern = typeof rawPattern === 'string' ? rawPattern : JSON.stringify(rawPattern);
      return pattern ? `"${pattern.length > 50 ? pattern.slice(0, 47) + '...' : pattern}"` : 'search';
    },
  },
  {
    match: (n) => ['agent', 'subagent', 'sub_agent'].includes(n.toLowerCase()),
    icon: RobotIcon,
    labelKey: 'streaming.toolAction.label.agent',
    getSummary: (input) => {
      const inp = input as Record<string, unknown> | undefined;
      const name = inp?.name || inp?.description || '';
      const subagentType = inp?.subagent_type || '';
      if (name && typeof name === 'string') {
        return name.length > 50 ? name.slice(0, 47) + '...' : name;
      }
      if (subagentType && typeof subagentType === 'string') {
        return subagentType;
      }
      return 'Launch agent';
    },
  },
  {
    // AgentStatus tool — query/wait for background sub-agents
    // launched by the Agent tool. Shares the RobotIcon + agent
    // verb with the Agent row so both read naturally as "agent
    // operations" in the chrome.
    match: (n) => n.toLowerCase() === 'agentstatus',
    icon: RobotIcon,
    labelKey: 'streaming.toolAction.label.agent',
    getSummary: (input) => {
      const inp = (input || {}) as Record<string, unknown>;
      const action = typeof inp.action === 'string' ? inp.action : '';
      const id =
        typeof inp.agent_id === 'string'
          ? inp.agent_id
          : typeof inp.agent_ids === 'string'
            ? inp.agent_ids
            : '';
      if (id) return `${action} ${id.slice(0, 16)}`;
      return action || 'AgentStatus';
    },
  },
  {
    match: (n) => isBrowserTool(n),
    icon: ChromeIcon,
    labelKey: 'streaming.toolAction.label.browser',
    getSummary: (input, name) => {
      const inp = (input || {}) as Record<string, unknown>;
      if (typeof inp.title === 'string' && inp.title.trim()) return inp.title.trim();
      if (typeof inp.description === 'string' && inp.description.trim()) return inp.description.trim();
      if (typeof inp.url === 'string' && inp.url) return inp.url;
      if (typeof inp.operation === 'string' && inp.operation) return inp.operation as string;
      return name || 'browser';
    },
  },
  {
    // AskUserQuestion. Mirrors BashToolRow's pattern — a dedicated
    // AskUserQuestionResultRow renders both the collapsed header and the
    // expanded dark card. We register an entry so the registry can still
    // produce a sensible icon / summary if the row component ever falls
    // back to the generic renderer.
    match: (n) => n.toLowerCase() === 'askuserquestion',
    icon: QuestionIcon,
    labelKey: 'streaming.toolAction.label.askQuestion',
    getSummary: (input) => {
      const inp = (input || {}) as Record<string, unknown>;
      const firstQ = (inp.questions as Array<{ question?: string }> | undefined)?.[0];
      const q = firstQ?.question || '';
      return q ? (q.length > 60 ? q.slice(0, 57) + '...' : q) : 'question';
    },
  },
  {
    match: () => true,
    icon: WrenchIcon,
    labelKey: null,
    getSummary: (input, name?: string) => {
      const prefix = name || '';
      if (!input || typeof input !== 'object') return prefix;
      const str = JSON.stringify(input);
      const detail = str.length > 50 ? str.slice(0, 47) + '...' : str;
      return prefix ? `${prefix} ${detail}` : detail;
    },
  },
];

export function getRenderer(name: string): ToolRendererDef {
  return TOOL_REGISTRY.find((r) => r.match(name)) || TOOL_REGISTRY[TOOL_REGISTRY.length - 1];
}

/**
 * Derive the chrome status from a tool action. `running` is signalled
 * by `result === undefined`; once the result lands, `isError` decides
 * between success and error.
 */
export function getStatus(tool: ToolAction): 'running' | 'success' | 'error' {
  if (tool.result === undefined) return 'running';
  return tool.isError ? 'error' : 'success';
}

/**
 * Detect whether any tool in the list was a browser tool running in
 * fallback mode (extension not installed). Surfaced as a single banner
 * at the top of the group rather than repeated per action.
 */
export function isBrowserFallbackMode(tools: ToolAction[]): boolean {
  for (const t of tools) {
    if (!t.result) continue;
    try {
      const data = JSON.parse(t.result);
      if (data?.mode === 'fallback') return true;
      if (typeof data?.error === 'string' &&
          (data.error.includes('fallback') ||
           data.error.includes('Extension') ||
           data.error.includes('not available'))) {
        return true;
      }
    } catch {
      // ignore
    }
  }
  return false;
}
