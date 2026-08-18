/**
 * ConfigHooksRunner tests (plan 426 follow-up).
 *
 * Non-loop event dispatch: matcher filtering, sequential hook execution,
 * fail-open isolation, verifier diagnostics, ${VAR} expansion at the
 * runner level. Hooks run as real `node -e` subprocesses (same pattern as
 * executor.test.ts); settings are injected (no fs access).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import { ConfigHooksRunner, type EventHookInput } from '../events.js';
import type { HooksSettings } from '../types.js';

const CWD = os.tmpdir();

function eventInput(hookEventName: string): EventHookInput {
  return { session_id: 's1', cwd: CWD, hook_event_name: hookEventName };
}

/** `node -e` script echoing a JSON object with the given additionalContext. */
function cmdJsonContext(ctx: string): string {
  return `node -e "process.stdout.write(JSON.stringify({additionalContext:'${ctx}'}))"`;
}

describe('ConfigHooksRunner', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns executed=0 when the event has no matchers', async () => {
    const runner = new ConfigHooksRunner({ settings: {}, cwd: CWD });
    expect(await runner.run('SessionStart', eventInput('SessionStart'))).toEqual({
      executed: 0,
      contexts: [],
    });
  });

  it('returns executed=0 when settings is absent', async () => {
    vi.stubEnv('DUYA_TEST', '1');
    vi.stubEnv('DUYA_TEST_NAMESPACE', 'hooks-events-test');
    const runner = new ConfigHooksRunner({ cwd: CWD });
    expect(await runner.run('Stop', eventInput('Stop'))).toEqual({ executed: 0, contexts: [] });
  });

  it('executes matched hooks in configured order and collects contexts', async () => {
    const settings: HooksSettings = {
      SessionStart: [
        { hooks: [{ type: 'command', command: cmdJsonContext('first') }] },
        { hooks: [{ type: 'command', command: cmdJsonContext('second') }] },
      ],
    };
    const runner = new ConfigHooksRunner({ settings, cwd: CWD });
    const result = await runner.run('SessionStart', eventInput('SessionStart'));
    expect(result.executed).toBe(2);
    expect(result.contexts).toEqual(['first', 'second']);
  });

  it('filters matchers by tool name for tool-scoped events', async () => {
    const settings: HooksSettings = {
      PreToolUse: [
        { matcher: '^Read$', hooks: [{ type: 'command', command: cmdJsonContext('read-ctx') }] },
        { hooks: [{ type: 'command', command: cmdJsonContext('any-ctx') }] },
      ],
    };
    const runner = new ConfigHooksRunner({ settings, cwd: CWD });
    const input = eventInput('PreToolUse');

    const onRead = await runner.run('PreToolUse', input, { toolName: 'Read' });
    expect(onRead.contexts).toEqual(['read-ctx', 'any-ctx']);

    const onBash = await runner.run('PreToolUse', input, { toolName: 'Bash' });
    expect(onBash.contexts).toEqual(['any-ctx']);

    const withoutTarget = await runner.run('PreToolUse', input);
    expect(withoutTarget.contexts).toEqual(['read-ctx', 'any-ctx']);
  });

  it('skips failing hooks (fail-open) and keeps successful contexts', async () => {
    const settings: HooksSettings = {
      Stop: [
        { hooks: [{ type: 'http', url: 'http://127.0.0.1:1/nope', timeout: 2 }] },
        { hooks: [{ type: 'command', command: cmdJsonContext('good-ctx') }] },
      ],
    };
    const runner = new ConfigHooksRunner({ settings, cwd: CWD });
    const result = await runner.run('Stop', eventInput('Stop'));
    expect(result.executed).toBe(2);
    expect(result.contexts).toEqual(['good-ctx']);
  });

  it('feeds verifier diagnostics from non-zero exits back as contexts', async () => {
    const settings: HooksSettings = {
      PostToolUseFailure: [
        {
          hooks: [
            {
              type: 'command',
              command: 'node -e "process.stderr.write(\'check failed@L3\');process.exit(2)"',
            },
          ],
        },
      ],
    };
    const runner = new ConfigHooksRunner({ settings, cwd: CWD });
    const result = await runner.run(
      'PostToolUseFailure',
      { ...eventInput('PostToolUseFailure'), tool_name: 'Edit', tool_use_id: 't1', error: 'boom' },
      { toolName: 'Edit' },
    );
    expect(result.executed).toBe(1);
    expect(result.contexts).toHaveLength(1);
    expect(result.contexts[0]).toContain('[verify:command]');
    expect(result.contexts[0]).toContain('exited with code 2');
    expect(result.contexts[0]).toContain('check failed@L3');
  });

  it('a throwing hook is isolated and does not stop later hooks', async () => {
    // Matcher regex on a tool name; one hook is fine, the "throw" is
    // simulated by a command that cannot spawn (fails open, WARN). A real
    // throw would be a bug in a configured hook — the runner wraps each
    // executeHook call, so we assert the failure path keeps going.
    const settings: HooksSettings = {
      PreToolUse: [
        {
          matcher: 'Edit',
          hooks: [
            { type: 'process', command: 'definitely-not-a-real-binary-xyz', args: [] },
            { type: 'command', command: cmdJsonContext('after-failure') },
          ],
        },
      ],
    };
    const runner = new ConfigHooksRunner({ settings, cwd: CWD });
    const result = await runner.run('PreToolUse', eventInput('PreToolUse'), { toolName: 'Edit' });
    expect(result.executed).toBe(2);
    expect(result.contexts).toEqual(['after-failure']);
  });

  it('expands ${VAR} placeholders in process hooks', async () => {
    const settings: HooksSettings = {
      SessionStart: [
        {
          hooks: [
            {
              type: 'process',
              command: 'node',
              args: ['-e', 'process.stdout.write(process.argv[1])', 'sess=${sessionId}'],
            },
          ],
        },
      ],
    };
    const runner = new ConfigHooksRunner({ settings, cwd: CWD, vars: { sessionId: 'abc-123' } });
    const result = await runner.run('SessionStart', eventInput('SessionStart'));
    expect(result.contexts).toEqual(['sess=abc-123']);
  });
});
