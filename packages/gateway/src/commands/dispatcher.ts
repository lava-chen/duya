/**
 * Gateway Command Dispatcher (plan 520)
 *
 * The gateway no longer executes slash commands locally. Detection only:
 * resolve the command against the shared registry, and wrap it as
 * `{ kind: 'command', command, args }` for the `gateway:inbound` IPC so the
 * Main Process executes it and answers through the same channel.
 */

import type { NormalizedMessage } from '../types.js';
import { resolveCommand } from './registry.js';

export interface DetectedCommand {
  command: string;
  args: string[];
}

/**
 * Detect a known slash command in an inbound message. Returns null when the
 * text is not a command or is not in the registry (unknown commands pass
 * through to the agent as plain prompts, matching the old behavior).
 */
export function detectCommand(msg: NormalizedMessage): DetectedCommand | null {
  const text = msg.text ?? '';
  if (!text.startsWith('/')) return null;

  const cmd = resolveCommand(text);
  if (!cmd) return null;

  const parts = text.slice(1).split(/\s+/);
  return {
    command: cmd.name,
    args: parts.slice(1),
  };
}

/**
 * Check if a message looks like a command that should be intercepted.
 */
export function shouldInterceptCommand(text: string): boolean {
  if (!text.startsWith('/')) return false;
  const name = text.slice(1).toLowerCase().split(/\s+/)[0];
  return resolveCommand(`/${name}`) !== null;
}
