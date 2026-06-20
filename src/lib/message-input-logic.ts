/**
 * Pure algorithm functions for MessageInput behavior.
 *
 * These functions contain no React dependencies — they are plain TypeScript
 * and can be tested directly without any framework setup.
 */

import type { PopoverItem, PopoverMode, CommandBadge, InsertResult, TriggerResult } from '@/types/slash-command';
import { getCommandsForPlatform } from '@/lib/commands';

export { InsertResult, TriggerResult };

// Built-in commands (derived from registry for UI display)
export interface BuiltInCommand {
  label: string;
  value: string;
  description: string;
  /** Optional English counterpart to `description` for bilingual display. */
  descriptionEn?: string;
  immediate?: boolean;
  builtIn: boolean;
  kind?: 'slash_command' | 'agent_command' | 'agent_skill' | 'sdk_command' | 'cli_tool';
}

// Get built-in commands from registry (immediate=true commands only for popover)
export const BUILT_IN_COMMANDS: BuiltInCommand[] = [
  ...getCommandsForPlatform('app')
    .filter((cmd) => cmd.category === 'info' || cmd.name === 'clear')
    .map((cmd) => ({
      // Primary label is the Chinese labelZh when present, else English label,
      // else fallback to "/<name>". The English label is also exposed as
      // descriptionEn so the popover can render a bilingual two-line item.
      label: pickLabel(cmd),
      value: `/${cmd.name}`,
      description: cmd.descriptionZh ?? cmd.description,
      descriptionEn: cmd.labelZh ? cmd.description : undefined,
      immediate: true,
      builtIn: true,
    })),
  // Session commands that need badge mode
  { label: pickLabelByName('compact'), value: '/compact', description: '压缩对话上下文以节省 token', descriptionEn: 'Compress conversation context to save tokens', builtIn: true, kind: 'agent_command' as const },
  { label: pickLabelByName('memory'), value: '/memory', description: '查看或管理会话记忆', descriptionEn: 'View or manage session memory', builtIn: true, kind: 'agent_command' as const },
  { label: pickLabelByName('export'), value: '/export', description: '将会话导出为 markdown/json/html', descriptionEn: 'Export conversation to markdown/json/html', builtIn: true, kind: 'agent_command' as const },
  // Skill commands
  { label: pickLabelByName('review'), value: '/review', description: '审查代码变更并给出详细反馈', descriptionEn: 'Review code changes with detailed feedback', builtIn: true, kind: 'agent_skill' as const },
  { label: pickLabelByName('simplify'), value: '/simplify', description: '简化并重构复杂的代码', descriptionEn: 'Simplify and refactor complex code', builtIn: true, kind: 'agent_skill' as const },
  { label: pickLabelByName('doctor'), value: '/doctor', description: '诊断项目问题并给出修复建议', descriptionEn: 'Diagnose project issues and suggest fixes', builtIn: true, kind: 'agent_skill' as const },
  { label: pickLabelByName('commit'), value: '/commit', description: '智能生成 Git 提交信息', descriptionEn: 'Generate smart Git commit messages', builtIn: true, kind: 'agent_skill' as const },
  { label: pickLabelByName('plan'), value: '/plan', description: '为复杂任务进入规划模式', descriptionEn: 'Enter planning mode for complex tasks', builtIn: true, kind: 'agent_skill' as const },
];

function pickLabel(cmd: { labelZh?: string; label?: string; name: string }): string {
  return cmd.labelZh?.trim() || cmd.label?.trim() || `/${cmd.name}`;
}

function pickLabelByName(name: string): string {
  const cmd = getCommandsForPlatform('app').find((c) => c.name === name);
  return cmd ? pickLabel(cmd) : `/${name}`;
}

/**
 * Detects popover trigger from input text and cursor position.
 */
export function detectPopoverTrigger(
  text: string,
  cursorPos: number,
): TriggerResult | null {
  const beforeCursor = text.slice(0, cursorPos);

  // Check for @ trigger (file mention)
  const atMatch = beforeCursor.match(/@([^\s@]*)$/);
  if (atMatch) {
    return {
      mode: 'file',
      filter: atMatch[1],
      triggerPos: cursorPos - atMatch[0].length,
    };
  }

  // Check for / trigger (only at start of line or after space)
  const slashMatch = beforeCursor.match(/(^|\s)\/([^\s]*)$/);
  if (slashMatch) {
    return {
      mode: 'skill',
      filter: slashMatch[2],
      triggerPos: cursorPos - slashMatch[2].length - 1,
    };
  }

  return null;
}

/**
 * Filters popover items by substring match on label or description.
 */
export function filterItems(items: PopoverItem[], filter: string): PopoverItem[] {
  const q = filter.toLowerCase();
  return items.filter(
    (item) =>
      item.label.toLowerCase().includes(q) ||
      String(item.description ?? '').toLowerCase().includes(q),
  );
}

/**
 * Determines what happens when an item is selected from the popover.
 */
export function resolveItemSelection(
  item: PopoverItem,
  popoverMode: PopoverMode,
  triggerPos: number,
  inputValue: string,
  popoverFilter: string,
): InsertResult {
  // Immediate built-in commands
  if (item.builtIn && item.immediate) {
    return { action: 'immediate_command', commandValue: item.value };
  }

  // Non-immediate commands: show as badge
  if (popoverMode === 'skill') {
    return {
      action: 'set_badge',
      badge: {
        command: item.value,
        label: item.label,
        description: item.description || '',
        kind: item.kind || 'slash_command',
        installedSource: item.installedSource,
      },
    };
  }

  // File mention: insert into text
  const before = inputValue.slice(0, triggerPos);
  const cursorEnd = triggerPos + popoverFilter.length + 1;
  const after = inputValue.slice(cursorEnd);
  const insertText = `@${item.value} `;
  return {
    action: 'insert_file_mention',
    newInputValue: before + insertText + after,
  };
}

/**
 * ArrowDown/ArrowUp index cycling logic.
 */
export function cycleIndex(current: number, direction: 'up' | 'down', length: number): number {
  if (length === 0) return 0;
  if (direction === 'down') return (current + 1) % length;
  return (current - 1 + length) % length;
}

/**
 * Keyboard dispatch logic — determines what action to take for a given key.
 */
export type KeyAction =
  | { type: 'popover_navigate'; direction: 'up' | 'down' }
  | { type: 'popover_select' }
  | { type: 'close_popover' }
  | { type: 'remove_badge' }
  | { type: 'remove_cli_badge' }
  | { type: 'passthrough' };

export function resolveKeyAction(
  key: string,
  state: {
    popoverMode: PopoverMode;
    popoverHasItems: boolean;
    inputValue: string;
    hasBadge: boolean;
    hasCliBadge?: boolean;
  },
): KeyAction {
  // Popover navigation (skill/file mode)
  if (state.popoverMode && state.popoverHasItems) {
    if (key === 'ArrowDown') return { type: 'popover_navigate', direction: 'down' };
    if (key === 'ArrowUp') return { type: 'popover_navigate', direction: 'up' };
    if (key === 'Enter' || key === 'Tab') return { type: 'popover_select' };
    if (key === 'Escape') return { type: 'close_popover' };
  }

  // Backspace removes badge when input is empty
  if (key === 'Backspace' && !state.inputValue) {
    if (state.hasBadge) return { type: 'remove_badge' };
    if (state.hasCliBadge) return { type: 'remove_cli_badge' };
  }

  // Escape removes badge
  if (key === 'Escape') {
    if (state.hasBadge) return { type: 'remove_badge' };
    if (state.hasCliBadge) return { type: 'remove_cli_badge' };
  }

  return { type: 'passthrough' };
}

/**
 * Direct slash command detection — when user types "/command" in input and submits.
 */
export function resolveDirectSlash(content: string): { action: 'immediate_command'; commandValue: string } | { action: 'set_badge'; badge: CommandBadge } | { action: 'not_slash' } {
  if (!content.startsWith('/')) return { action: 'not_slash' };

  const cmd = BUILT_IN_COMMANDS.find((c) => c.value === content);
  if (cmd) {
    if (cmd.immediate) {
      return { action: 'immediate_command', commandValue: content };
    }
    return {
      action: 'set_badge',
      badge: {
        command: cmd.value,
        label: cmd.label,
        description: cmd.description || '',
        kind: (cmd.kind || 'slash_command') as CommandBadge['kind'],
      },
    };
  }

  // Unknown slash command - treat as badge
  const skillName = content.slice(1);
  if (skillName) {
    return {
      action: 'set_badge',
      badge: {
        command: content,
        label: skillName,
        description: '',
        kind: 'slash_command',
      },
    };
  }

  return { action: 'not_slash' };
}

/**
 * Badge dispatch logic — what prompt is sent for each badge kind.
 */
export function dispatchBadge(badge: CommandBadge, userContent: string): { prompt: string; displayLabel: string } {
  const baseLabel = `/${badge.label}`;
  const displayLabel = userContent ? `${baseLabel}\n${userContent}` : baseLabel;

  switch (badge.kind) {
    case 'agent_command':
    case 'slash_command':
    case 'sdk_command':
    case 'cli_tool': {
      const slashPrompt = userContent
        ? `${badge.command} ${userContent}`
        : badge.command;
      return { prompt: slashPrompt, displayLabel };
    }
    case 'agent_skill': {
      const agentPrompt = userContent
        ? `Use the ${badge.label} skill. User context: ${userContent}`
        : `Please use the ${badge.label} skill.`;
      return { prompt: agentPrompt, displayLabel };
    }
    default: {
      const defaultPrompt = userContent
        ? `${badge.command} ${userContent}`
        : badge.command;
      return { prompt: defaultPrompt, displayLabel };
    }
  }
}

// CLI badge type for tool suggestions
export interface CliBadge {
  name: string;
  summary?: string;
}

/**
 * CLI badge system prompt append generation.
 * Used by handleSubmit in MessageInput to guide model towards using a CLI tool.
 */
export function buildCliAppend(cliBadge: CliBadge | null): string | undefined {
  if (!cliBadge) return undefined;
  return `The user wants to use the installed CLI tool "${cliBadge.name}" if appropriate for this task. Prefer using "${cliBadge.name}" when suitable.`;
}

/**
 * Detect slash command from input text.
 * Returns the command string if found, null otherwise.
 */
export function detectSlashCommand(input: string): string | null {
  if (!input.startsWith('/')) return null;

  const cmd = BUILT_IN_COMMANDS.find((c) => c.value === input);
  if (cmd) return cmd.value;

  // Unknown slash command
  const skillName = input.slice(1);
  if (skillName) return input;

  return null;
}

/**
 * Detect CLI tool from input text (when AI requests them).
 * This is used when the AI explicitly mentions using a CLI tool.
 */
export function detectCliTool(input: string): string | null {
  const cliTools = ['bash', 'write', 'read', 'edit', 'grep', 'glob', 'task_create', 'task_list', 'task_get', 'task_update'];
  const lowerInput = input.toLowerCase();

  for (const tool of cliTools) {
    if (lowerInput.includes(tool)) {
      return tool;
    }
  }

  return null;
}

/**
 * Parse slash command from input text.
 * Extracts the command part and remaining text after the slash command.
 */
export function parseSlashCommand(input: string): { slashCommand: string; remainingText: string } | null {
  if (!input.startsWith('/')) return null;

  const spaceIndex = input.indexOf(' ');
  if (spaceIndex === -1) {
    return { slashCommand: input, remainingText: '' };
  }

  return {
    slashCommand: input.slice(0, spaceIndex),
    remainingText: input.slice(spaceIndex + 1),
  };
}

/**
 * Resolve badge action to determine what to do when a badge is submitted.
 */
export function resolveBadgeAction(
  badge: CommandBadge
): { type: 'submit' | 'command' | 'cli' | 'sdk'; content?: string; command?: string } {
  switch (badge.kind) {
    case 'slash_command':
    case 'agent_command':
      return { type: 'command', command: badge.command };
    case 'cli_tool':
      return { type: 'cli', command: badge.command };
    case 'sdk_command':
      return { type: 'sdk', command: badge.command };
    case 'agent_skill':
      return { type: 'submit', content: `Use the ${badge.label} skill.` };
    default:
      return { type: 'submit', content: badge.command };
  }
}
