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
  BookOpenIcon,
  ListChecksIcon,
  TablerMessageCircleIcon,
  EyeIcon,
  ImageIcon,
  SquaresFourIcon,
  AiGatewayIcon,
} from '@/components/icons';
import {
  isBrowserTool,
  isModuleTool,
  isMessageSessionTool,
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
    match: (n) => ['bash', 'execute', 'run', 'execute_command', 'run_command', 'powershell'].includes(n.toLowerCase()),
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
    match: (n) => ['task', 'agent', 'subagent', 'sub_agent'].includes(n.toLowerCase()),
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
    // research_report — final deep-research report. The registry supplies
    // icon + summary for the interaction chrome; the report document itself
    // renders as a standalone card at the end of the reply (ResearchReportCard)
    // and the tool action is a non-expandable status row (ResearchReportStatusRow).
    match: (n) => n.toLowerCase() === 'research_report',
    icon: BookOpenIcon,
    labelKey: null,
    getSummary: (input) => {
      const inp = (input as Record<string, unknown>) || {};
      const title = typeof inp.title === 'string' ? inp.title.trim() : '';
      if (title) return title.length > 60 ? title.slice(0, 57) + '...' : title;
      const query = typeof inp.query === 'string' ? inp.query.trim() : '';
      if (query) return query.length > 60 ? query.slice(0, 57) + '...' : query;
      return 'Research report';
    },
  },
  {
    // ModuleTool — loads design specification READMEs. The summary
    // parses `input.module` (string or array) and lists the modules
    // instead of dumping the raw JSON. The expanded body is rendered by
    // ModuleToolRow.
    match: (n) => isModuleTool(n),
    icon: BookOpenIcon,
    labelKey: null,
    getSummary: (input) => {
      const inp = (input || {}) as Record<string, unknown>;
      const mod = inp.module;
      const parts = Array.isArray(mod)
        ? mod.filter((s): s is string => typeof s === 'string' && s.length > 0)
        : typeof mod === 'string' && mod.length > 0 ? [mod] : [];
      if (parts.length === 0) return 'module';
      return parts.join(' + ');
    },
  },
  {
    // TodoTool — manages an internal task list (aligned to Grok
    // `todo_write`). The summary renders the count of updated items so
    // the chrome reads as natural language instead of the raw JSON dump.
    // Each todo gets routed to TaskToolRow which renders the chrome
    // summary and the JSON envelope body.
    match: (n) => n.toLowerCase() === 'todo' || n.toLowerCase() === 'todowrite',
    icon: ListChecksIcon,
    labelKey: null,
    getSummary: (input) => {
      const inp = (input || {}) as Record<string, unknown>;
      const todos = Array.isArray(inp.todos) ? inp.todos : [];
      if (todos.length === 0) return 'todo';
      const first = todos[0] as Record<string, unknown> | undefined;
      const firstContent = typeof first?.content === 'string' ? first.content.trim() : '';
      if (firstContent) return firstContent.length > 60 ? `${firstContent.slice(0, 57)}...` : firstContent;
      return todos.length === 1 ? 'todo' : `${todos.length} todos`;
    },
  },
  {
    // MessageSession — sends a message to another session's agent.
    // The registry summary only carries the message preview; the
    // target session *title* is resolved inside MessageSessionToolRow
    // (which has access to the conversation store + IPC fallback) so
    // the user never sees a raw session id. This summary is used by
    // the generic catch-all and group summary builder only.
    match: (n) => isMessageSessionTool(n),
    icon: TablerMessageCircleIcon,
    labelKey: 'streaming.toolAction.label.messageSession',
    getSummary: (input) => {
      const inp = (input || {}) as Record<string, unknown>;
      const message = typeof inp.message === 'string' ? inp.message.trim() : '';
      if (message) {
        return message.length > 60 ? message.slice(0, 57) + '…' : message;
      }
      return 'message session';
    },
  },
  {
    // Plan 504 session tool — spawn shows the target project directory in
    // the collapsed chrome (the live card renders in SessionToolRow).
    match: (n) => n.toLowerCase() === 'session',
    icon: WrenchIcon,
    labelKey: null,
    getSummary: (input) => {
      const inp = (input || {}) as Record<string, unknown>;
      const action = typeof inp.action === 'string' ? inp.action : 'spawn';
      const wd = typeof inp.workingDirectory === 'string' ? inp.workingDirectory : '';
      const text = wd ? wd : `session:${action}`;
      return text.length > 50 ? '...' + text.slice(text.length - 50) : text;
    },
  },
  {
    // vision_analyze — invokes a dedicated vision model on an image
    // (see packages/agent/src/tool/VisionTool/VisionTool.ts). The
    // summary shows the optional `question` (or the image filename)
    // so the chrome reads "Used vision · check layout overlap" instead
    // of leaking the raw tool name. The expanded preview / modal lives
    // in VisionToolRow.
    match: (n) => n.toLowerCase() === 'vision_analyze',
    icon: EyeIcon,
    labelKey: 'streaming.toolAction.label.vision',
    getSummary: (input) => {
      const inp = (input || {}) as Record<string, unknown>;
      const question = typeof inp.question === 'string' ? inp.question.trim() : '';
      if (question) {
        return question.length > 60 ? question.slice(0, 57) + '…' : question;
      }
      const imagePath = typeof inp.image_path === 'string' ? inp.image_path : '';
      if (imagePath) {
        const name = imagePath.split(/[/\\]/).pop() || imagePath;
        return name.length > 60 ? name.slice(0, 57) + '…' : name;
      }
      return 'vision';
    },
  },
  {
    // image_generate — AI image generation (plan image-gen). Summary
    // shows the prompt so the chrome reads the request instead of the
    // raw tool name; the saved file path is surfaced in the result.
    match: (n) => n.toLowerCase() === 'image_generate',
    icon: ImageIcon,
    labelKey: null,
    getSummary: (input) => {
      const inp = (input || {}) as Record<string, unknown>;
      const prompt = typeof inp.prompt === 'string' ? inp.prompt.trim() : '';
      if (prompt) {
        return prompt.length > 60 ? prompt.slice(0, 57) + '…' : prompt;
      }
      return 'image_generate';
    },
  },
  {
    // Canvas Conductor — the canvas_* tool family grouped under one
    // renderer. The dedicated CanvasConductorToolRow supplies the
    // per-tool verb and summary; this entry is the registry fallback
    // for the group summary builder and any path that bypasses the row.
    match: (n) => n.toLowerCase().startsWith('canvas_') || n.toLowerCase() === 'database_manage',
    icon: SquaresFourIcon,
    labelKey: 'streaming.toolAction.label.canvas',
    getSummary: (input, name?: string) => {
      const inp = (input || {}) as Record<string, unknown>;
      const toolBase = (name || '').replace(/^canvas_/, '');
      // Batch create: surface the number of operations.
      if (toolBase === 'batch_create') {
        const ops = inp.operations;
        const count = Array.isArray(ops) ? ops.length : 0;
        return count > 0 ? `${count} elements` : 'batch create';
      }
      // Single create: surface the element kind.
      if (toolBase === 'create_element' && typeof inp.kind === 'string') {
        return inp.kind;
      }
      // Delete / fill / style / move / resize: surface the target element.
      const targetId = typeof inp.elementId === 'string' ? inp.elementId : (typeof inp.ref === 'string' ? inp.ref : '');
      if (targetId) {
        return targetId.length > 24 ? targetId.slice(0, 21) + '…' : targetId;
      }
      return toolBase || 'canvas';
    },
  },
  {
    // MCP-provided tools — any name starting with the `mcp_` provider
    // prefix (see computeProviderName in
    // packages/plugin-core/src/mcp/provider-tool-name.ts). The summary
    // surfaces the *MCP server name* (one server exposes many tools)
    // instead of the raw envelope or the per-tool name. The dedicated
    // McpToolRow owns the visible chrome; this entry keeps the registry
    // icon/label consistent for any path that bypasses it (e.g. group
    // summary).
    match: (n) => n.toLowerCase().startsWith('mcp_'),
    icon: AiGatewayIcon,
    labelKey: 'streaming.toolAction.label.mcp',
    getSummary: (input, name?: string) => {
      const prefix = name || '';
      if (!prefix.toLowerCase().startsWith('mcp_')) return prefix || 'mcp';
      const rest = prefix.slice('mcp_'.length);
      const lastSep = rest.lastIndexOf('_');
      return lastSep !== -1 ? rest.slice(0, lastSep) : rest;
    },
  },
  {
    match: () => true,
    icon: WrenchIcon,
    labelKey: null,
    getSummary: (input, name?: string) => {
      const prefix = name || '';
      if (!input || typeof input !== 'object') return prefix || 'tool';
      const str = JSON.stringify(input);
      // Empty object — common for orphan tool_results synthesized by
      // MessageList. Show just the name instead of a noisy "{}".
      if (str === '{}') return prefix || 'tool';
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
