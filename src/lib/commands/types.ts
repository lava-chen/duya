/**
 * Command System Types
 *
 * Unified command definitions for both App and Gateway.
 */

import type { Message } from '@/types';

// ============================================================================
// Platform
// ============================================================================

export type CommandPlatform = 'app' | 'gateway';

// ============================================================================
// Category
// ============================================================================

export type CommandCategory =
  | 'session'   // 会话管理: new, clear, reset
  | 'config'    // 配置: model, personality
  | 'info'      // 信息: help, status, cost, usage
  | 'tools'     // 工具和技能: review, commit, plan
  | 'exit';     // 退出 (App only)

// ============================================================================
// Command Definition
// ============================================================================

export interface CommandDef {
  /** Canonical name without slash: "new" */
  name: string;
  /** Alternative names: ["reset"] */
  aliases?: readonly string[];
  /** Human-readable description */
  description: string;
  /** Category for grouping */
  category: CommandCategory;
  /** Argument placeholder shown in help: "<prompt>", "[model]" */
  argsHint?: string;
  /** Tab-completable subcommands: ["on", "off"] */
  subcommands?: readonly string[];
  /** Available platforms */
  platforms?: readonly CommandPlatform[];
  /** Execute locally (App-side) */
  execute?: CommandExecutor;
  /** Gateway handler name (mutually exclusive with execute) */
  gatewayHandler?: string;
  /** Requires an active session to execute */
  requiresSession?: boolean;
  /** Config gate path: "display.toolProgress" */
  configGate?: string;
}

// ============================================================================
// Execution
// ============================================================================

export interface CommandContext {
  sessionId?: string;
  messages?: Message[];
  args: string[];
  platform?: string;
  platformChatId?: string;
  /** Clear all messages in the session */
  clearMessages?: () => void;
  /** Switch to a new session */
  resetSession?: () => Promise<{ oldSessionId: string; newSessionId: string }>;
  /** Send reply via adapter */
  sendReply?: (text: string) => Promise<void>;
}

export type CommandResult =
  | { type: 'text'; content: string }
  | { type: 'error'; message: string }
  | { type: 'session_reset'; newSessionId?: string }
  | { type: 'dismiss' }  // No output (handled internally)
  | { type: 'forward'; prompt: string };  // Forward to agent

export type CommandExecutor = (
  ctx: CommandContext
) => CommandResult | Promise<CommandResult>;

// ============================================================================
// Help Generation
// ============================================================================

export interface HelpEntry {
  name: string;
  description: string;
  argsHint?: string;
  aliases?: readonly string[];
}

export interface HelpSection {
  category: CommandCategory;
  entries: HelpEntry[];
}
