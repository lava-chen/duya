/**
 * The gateway registry is a PROMISE to the user: every command in it is
 * advertised on the platform (the Telegram adapter uploads `COMMAND_REGISTRY`
 * as the bot's `/commands` menu) and is expected to run.
 *
 * It does not run locally. The gateway only DETECTS a command and forwards it
 * Main-side, where `handleGatewayCommand` (`apps/desktop/src/main/gateway/
 * message-bus.ts`) executes it. A command with no Main-side case falls into
 * that function's `default:` branch and answers `尚未在此构建中启用`.
 *
 * Before this test, the registry listed 34 commands of which Main-side
 * implemented 6 — so 28 entries were published in the bot's command menu and
 * could only fail.
 *
 * The list is a literal on purpose: a test built from the registry would
 * assert the registry agrees with itself.
 */
import { describe, expect, it } from 'vitest';

import { COMMAND_REGISTRY, getAllCommands, resolveCommand } from './registry.js';
import { detectCommand, shouldInterceptCommand } from './dispatcher.js';
import { generateHelpText } from './help.js';

describe('gateway command registry', () => {
  it('advertises exactly the commands Main-side can execute', () => {
    expect(COMMAND_REGISTRY.map((cmd) => cmd.name)).toEqual([
      'new',
      'clear',
      'stop',
      'help',
      'status',
    ]);
  });

  it('resolves the canonical names and their aliases', () => {
    expect(resolveCommand('/new')?.name).toBe('new');
    expect(resolveCommand('reset')?.name).toBe('new');
    expect(resolveCommand('/help')?.name).toBe('help');
    expect(resolveCommand('?')?.name).toBe('help');
    expect(resolveCommand('NOT-A-COMMAND')).toBeNull();
  });

  it('detects a command and splits its arguments', () => {
    const detected = detectCommand({ text: '/new' } as never);
    expect(detected).toEqual({ command: 'new', args: [] });
  });

  it('does not intercept text that is not a command', () => {
    expect(shouldInterceptCommand('hello')).toBe(false);
    expect(detectCommand({ text: 'hello' } as never)).toBeNull();
  });

  it('lists the same commands in the help text it publishes', () => {
    const help = generateHelpText('gateway');
    for (const cmd of getAllCommands()) {
      expect(help, cmd.name).toContain(`/${cmd.name}`);
    }
    // A command that was removed from the registry must not linger in the
    // help text either — that text is what the user reads on the platform.
    expect(help).not.toContain('/rollback');
    expect(help).not.toContain('/sethome');
  });
});
