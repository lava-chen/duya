/**
 * Command System
 *
 * Unified slash command system for App and Gateway.
 *
 * @example
 * import { resolveCommand, getCommandsForPlatform } from '@/lib/commands';
 *
 * const cmd = resolveCommand('/help');
 * if (cmd) {
 *   console.log(cmd.description);
 * }
 */

export * from './types';
export * from './registry';
export * from './help';
export * from './parser';
