/**
 * Pure algorithm functions for MessageInput behavior.
 *
 * These functions contain no React dependencies — they are plain TypeScript
 * and can be tested directly without any framework setup.
 */

import type { PopoverItem, PopoverMode, CommandBadge, InsertResult, TriggerResult } from '@/types/slash-command';

export { InsertResult, TriggerResult };

// Built-in commands
export interface BuiltInCommand {
  label: string;
  value: string;
  description: string;
  immediate?: boolean;
  builtIn: boolean;
  kind?: 'slash_command' | 'agent_command' | 'agent_skill' | 'sdk_command' | 'cli_tool';
}

export const BUILT_IN_COMMANDS: BuiltInCommand[] = [
  // Info & Help
  { label: '/help', value: '/help', description: 'Show available commands and skills', immediate: true, builtIn: true },
  { label: '/cost', value: '/cost', description: 'Show token usage statistics and estimated costs', immediate: true, builtIn: true },

  // Session Management
  { label: '/clear', value: '/clear', description: 'Clear conversation history', immediate: true, builtIn: true },
  { label: '/compact', value: '/compact', description: 'Compress conversation context to save tokens', kind: 'agent_command', builtIn: true },
  { label: '/memory', value: '/memory', description: 'View or manage session memory', kind: 'agent_command', builtIn: true },
  { label: '/export', value: '/export', description: 'Export conversation to markdown/json/html', kind: 'agent_command', builtIn: true },

  // Code Quality
  { label: '/review', value: '/review', description: 'Review code changes with detailed feedback', kind: 'agent_skill', builtIn: true },
  { label: '/simplify', value: '/simplify', description: 'Simplify and refactor complex code', kind: 'agent_skill', builtIn: true },
  { label: '/doctor', value: '/doctor', description: 'Diagnose project issues and suggest fixes', kind: 'agent_skill', builtIn: true },

  // Git & Workflow
  { label: '/commit', value: '/commit', description: 'Generate smart Git commit messages', kind: 'agent_skill', builtIn: true },
  { label: '/plan', value: '/plan', description: 'Enter planning mode for complex tasks', kind: 'agent_skill', builtIn: true },
];

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
      (item.description || '').toLowerCase().includes(q),
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
