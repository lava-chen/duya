/**
 * Command Registry
 *
 * Central registry for all slash commands. Single source of truth for:
 * - CLI (processed in App)
 * - Gateway (processed in platform adapters)
 *
 * Usage:
 *   import { resolveCommand, getCommandsForPlatform, COMMAND_REGISTRY } from '@/lib/commands/registry';
 */

import type { CommandDef, CommandPlatform, CommandContext, CommandResult } from './types';

// ============================================================================
// Built-in Commands
// ============================================================================

const BUILT_IN_COMMANDS: CommandDef[] = [
  // ========================================================================
  // Session
  // ========================================================================
  {
    name: 'new',
    aliases: ['reset'],
    label: 'New session',
    labelZh: '新建会话',
    description: 'Start a new session',
    descriptionZh: '开始一个新会话',
    category: 'session',
    argsHint: '',
    platforms: ['app', 'gateway'],
    requiresSession: false,
  },
  {
    name: 'clear',
    label: 'Clear conversation',
    labelZh: '清空对话',
    description: 'Clear conversation history',
    descriptionZh: '清空当前会话的所有消息',
    category: 'session',
    platforms: ['app'],
    requiresSession: false,
  },
  {
    name: 'compact',
    label: 'Compact context',
    labelZh: '压缩上下文',
    description: 'Compress conversation context to save tokens',
    descriptionZh: '压缩对话上下文以节省 token',
    category: 'session',
    platforms: ['app'],
    requiresSession: true,
  },
  {
    name: 'memory',
    label: 'Session memory',
    labelZh: '会话记忆',
    description: 'View or manage session memory',
    descriptionZh: '查看或管理会话记忆',
    category: 'session',
    platforms: ['app'],
    requiresSession: true,
  },
  {
    name: 'export',
    label: 'Export conversation',
    labelZh: '导出对话',
    description: 'Export conversation to markdown/json/html',
    descriptionZh: '将会话导出为 markdown/json/html',
    category: 'session',
    argsHint: '[format]',
    platforms: ['app'],
    requiresSession: true,
  },

  // ========================================================================
  // Info
  // ========================================================================
  {
    name: 'help',
    aliases: ['?'],
    label: 'Help',
    labelZh: '查看帮助',
    description: 'Show available commands',
    descriptionZh: '显示可用的命令列表',
    category: 'info',
    platforms: ['app', 'gateway'],
    requiresSession: false,
  },
  {
    name: 'status',
    label: 'Session status',
    labelZh: '会话状态',
    description: 'Show session info',
    descriptionZh: '查看当前会话信息',
    category: 'info',
    platforms: ['app', 'gateway'],
    requiresSession: false,
  },
  {
    name: 'cost',
    label: 'Token usage',
    labelZh: '用量统计',
    description: 'Show token usage statistics and estimated costs',
    descriptionZh: '查看 token 用量与费用估算',
    category: 'info',
    platforms: ['app'],
    requiresSession: true,
  },
  {
    name: 'recap',
    aliases: ['summary', 'catchup'],
    label: 'Recap conversation',
    labelZh: '回顾对话',
    description: 'Show a recap of the current conversation',
    descriptionZh: '生成当前对话的回顾摘要',
    category: 'info',
    platforms: ['app'],
    requiresSession: true,
  },

  // ========================================================================
  // Config
  // ========================================================================
  {
    name: 'model',
    label: 'Switch model',
    labelZh: '切换模型',
    description: 'Switch model for this session',
    descriptionZh: '为当前会话切换模型',
    category: 'config',
    argsHint: '[model]',
    platforms: ['app'],
    requiresSession: false,
  },

  // ========================================================================
  // Tools & Skills
  // ========================================================================
  {
    name: 'review',
    label: 'Review code',
    labelZh: '代码审查',
    description: 'Review code changes with detailed feedback',
    descriptionZh: '审查代码变更并给出详细反馈',
    category: 'tools',
    platforms: ['app'],
    requiresSession: true,
  },
  {
    name: 'simplify',
    label: 'Simplify code',
    labelZh: '简化代码',
    description: 'Simplify and refactor complex code',
    descriptionZh: '简化并重构复杂的代码',
    category: 'tools',
    platforms: ['app'],
    requiresSession: true,
  },
  {
    name: 'doctor',
    label: 'Diagnose project',
    labelZh: '项目诊断',
    description: 'Diagnose project issues and suggest fixes',
    descriptionZh: '诊断项目问题并给出修复建议',
    category: 'tools',
    platforms: ['app'],
    requiresSession: true,
  },
  {
    name: 'commit',
    label: 'Generate commit',
    labelZh: '生成提交',
    description: 'Generate smart Git commit messages',
    descriptionZh: '智能生成 Git 提交信息',
    category: 'tools',
    platforms: ['app'],
    requiresSession: true,
  },
  {
    name: 'plan',
    label: 'Enter plan mode',
    labelZh: '进入规划模式',
    description: 'Enter planning mode for complex tasks',
    descriptionZh: '为复杂任务进入规划模式',
    category: 'tools',
    platforms: ['app'],
    requiresSession: true,
  },
];

// ============================================================================
// Export
// ============================================================================

export const COMMAND_REGISTRY: readonly CommandDef[] = BUILT_IN_COMMANDS;

// ============================================================================
// Lookups
// ============================================================================

/**
 * Resolve a command name or alias to its CommandDef.
 * Accepts names with or without leading slash.
 */
export function resolveCommand(input: string): CommandDef | null {
  const name = input.toLowerCase().replace(/^\//, '');
  return COMMAND_REGISTRY.find(
    (cmd) => cmd.name === name || cmd.aliases?.includes(name)
  ) ?? null;
}

/**
 * Get all commands available for a specific platform.
 */
export function getCommandsForPlatform(platform: CommandPlatform): readonly CommandDef[] {
  return COMMAND_REGISTRY.filter(
    (cmd) => !cmd.platforms || cmd.platforms.includes(platform)
  );
}

/**
 * Get all command names and aliases for a platform (for quick lookup).
 */
export function getCommandNamesForPlatform(platform: CommandPlatform): ReadonlySet<string> {
  const names = new Set<string>();
  for (const cmd of getCommandsForPlatform(platform)) {
    names.add(cmd.name);
    cmd.aliases?.forEach((a) => names.add(a));
  }
  return names;
}

/**
 * Check if a command is known for a platform.
 */
export function isKnownCommand(input: string, platform: CommandPlatform): boolean {
  const name = input.toLowerCase().replace(/^\//, '');
  return getCommandNamesForPlatform(platform).has(name);
}

/**
 * Get commands grouped by category.
 */
export function getCommandsByCategory(platform: CommandPlatform): Map<string, CommandDef[]> {
  const map = new Map<string, CommandDef[]>();
  for (const cmd of getCommandsForPlatform(platform)) {
    const existing = map.get(cmd.category) ?? [];
    existing.push(cmd);
    map.set(cmd.category, existing);
  }
  return map;
}
