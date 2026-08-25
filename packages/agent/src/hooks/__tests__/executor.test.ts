/**
 * Hook executor + config-loop bridge tests (plan 426 Phase 4).
 *
 * Command hooks run real `node -e` scripts (JSON additionalContext, plain
 * text, non-zero exit, timeout kill); http hooks run against a local
 * node:http server (2xx JSON, 500 fail-open); prompt/agent stubs fail open.
 * config-loop tests use deps.hooks injection (no fs) and drive the
 * registrations through a real LoopHookBus.
 */

import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest';
import * as http from 'node:http';
import * as os from 'node:os';
import { AddressInfo } from 'node:net';
import { executeHook, executeHookCommand, executeHttpHook, executeProcessHook, resolveProcessSpawn } from '../executor.js';
import { createConfiguredLoopHooks } from '../config-loop.js';
import { LoopHookBus } from '../loop.js';
import { expandHookTemplate } from '../types.js';
import type { BaseHookInput, HooksSettings } from '../types.js';
import { hookTaskRegistry } from '../task-registry.js';
import { hookCircuitBreaker } from '../circuit-breaker.js';

// The background completion path delivers via the mailbox — stub the DB write.
vi.mock('../../lifecycle/mailboxBackgroundNotification.js', () => ({
  sendBackgroundNotification: vi.fn().mockResolvedValue(undefined),
}));
import { sendBackgroundNotification } from '../../lifecycle/mailboxBackgroundNotification.js';

const CWD = os.tmpdir();

function baseInput(): BaseHookInput {
  return { session_id: 's1', cwd: CWD, hook_event_name: 'PreTurn', turnCount: 1 };
}

/** `node -e` script echoing a JSON object with the given additionalContext. */
function cmdJsonContext(ctx: string): string {
  return `node -e "process.stdout.write(JSON.stringify({additionalContext:'${ctx}'}))"`;
}

/** `node -e` script echoing plain text on stdout. */
function cmdPlain(text: string): string {
  return `node -e "process.stdout.write('${text}')"`;
}

/** Poll until the predicate passes or the timeout elapses. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs: number = 5000,
  intervalMs: number = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor: condition not met before timeout');
}

// ============================================================================
// background executor (async: true)
// ============================================================================

describe('executeHookBackground', () => {
  afterEach(() => {
    hookTaskRegistry.clear();
    hookCircuitBreaker.clear();
    vi.mocked(sendBackgroundNotification).mockClear();
  });

  it('launches async command hooks without blocking and settles the registry', async () => {
    const started = Date.now();
    const result = await executeHook(
      { type: 'command', command: cmdJsonContext('bg-ctx'), async: true, asyncRewake: true },
      { ...baseInput(), hook_event_name: 'UserPromptSubmit' },
      { cwd: CWD },
    );
    expect(Date.now() - started).toBeLessThan(500); // not awaited
    expect(result.ok).toBe(true);
    expect(result.backgroundTaskId).toBeDefined();
    const taskId = result.backgroundTaskId!;

    await waitFor(() => hookTaskRegistry.getTask(taskId)?.status !== 'running');
    const task = hookTaskRegistry.getTask(taskId);
    expect(task?.status).toBe('completed');
    expect(task?.exitCode).toBe(0);
    expect(task?.rewake).toBe(true);
    expect(task?.event).toBe('UserPromptSubmit');

    // Output landed in the task output file.
    const out = hookTaskRegistry.readOutput(taskId);
    expect(out?.text).toContain('bg-ctx');

    // asyncRewake → the completion notification was delivered.
    expect(vi.mocked(sendBackgroundNotification)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(sendBackgroundNotification).mock.calls[0][0];
    expect(call.sessionId).toBe('s1');
    expect(call.taskId).toBe(taskId);
    expect(call.xml).toContain('task-notification');
    expect(call.xml).toContain('bg-ctx');
  });

  it('launches async process hooks with ${VAR} expansion', async () => {
    const result = await executeHook(
      {
        type: 'process',
        command: 'node',
        args: ['-e', 'process.stdout.write(JSON.stringify({additionalContext:"proc-bg"}))'],
        async: true,
      },
      { ...baseInput(), hook_event_name: 'SessionStart' },
      { cwd: CWD },
    );
    expect(result.ok).toBe(true);
    const taskId = result.backgroundTaskId!;
    await waitFor(() => hookTaskRegistry.getTask(taskId)?.status !== 'running');
    const task = hookTaskRegistry.getTask(taskId);
    expect(task?.status).toBe('completed');
    // No rewake → no notification.
    expect(vi.mocked(sendBackgroundNotification)).not.toHaveBeenCalled();
  });

  it('marks non-zero exits as error tasks WITHOUT notifying the agent', async () => {
    const result = await executeHook(
      {
        type: 'command',
        command: 'node -e "process.exit(3)"',
        async: true,
        asyncRewake: true,
      },
      { ...baseInput(), hook_event_name: 'Stop' },
      { cwd: CWD },
    );
    expect(result.ok).toBe(true);
    const taskId = result.backgroundTaskId!;
    await waitFor(() => hookTaskRegistry.getTask(taskId)?.status !== 'running');
    const task = hookTaskRegistry.getTask(taskId);
    expect(task?.status).toBe('error');
    expect(task?.exitCode).toBe(3);
    // A crashed / failed background hook is NEVER delivered to the agent
    // (bug report 2026-08-19 #8) — the failure stays in the task registry
    // and the log, but no <task-notification> reaches the model.
    expect(vi.mocked(sendBackgroundNotification)).not.toHaveBeenCalled();
  });

  it('spawn failure surfaces as a killed task and fails open', async () => {
    const result = await executeHook(
      {
        type: 'command',
        command: 'definitely-not-a-real-binary-xyz',
        async: true,
        asyncRewake: true,
      },
      { ...baseInput(), hook_event_name: 'Stop' },
      { cwd: CWD },
    );
    // With shell:true the shell reports the missing binary as exit 1, so
    // the task settles as error (fail-open, like bash background tasks).
    expect(result.ok).toBe(true);
    expect(result.backgroundTaskId).toBeDefined();
    const taskId = result.backgroundTaskId!;
    await waitFor(() => hookTaskRegistry.getTask(taskId)?.status !== 'running');
    expect(hookTaskRegistry.getTask(taskId)?.status).toBe('error');
    expect(hookTaskRegistry.getTask(taskId)?.exitCode).toBe(1);
  });
});

// ============================================================================
// command executor
// ============================================================================

describe('resolveProcessSpawn', () => {
  it('re-execs a `node` process hook via the host binary with ELECTRON_RUN_AS_NODE', () => {
    const resolved = resolveProcessSpawn({ command: 'node', args: ['x.mjs'], shell: false });
    expect(resolved.command).toBe(process.execPath);
    expect(resolved.env?.ELECTRON_RUN_AS_NODE).toBe('1');
  });

  it('handles node.exe and case variants', () => {
    for (const cmd of ['node.exe', 'NODE.EXE', 'C:\\Tools\\node.exe']) {
      const resolved = resolveProcessSpawn({ command: cmd, args: [], shell: false });
      expect(resolved.command).toBe(process.execPath);
      expect(resolved.env?.ELECTRON_RUN_AS_NODE).toBe('1');
    }
  });

  it('leaves non-node commands untouched and does not inject the env var', () => {
    const resolved = resolveProcessSpawn({ command: 'python', args: ['s.py'], shell: false });
    expect(resolved.command).toBe('python');
    expect(resolved.env).toBeUndefined();
  });

  it('never rewrites shell-wrapped commands', () => {
    const resolved = resolveProcessSpawn({ command: 'node -e \"x()\"', args: [], shell: true });
    expect(resolved.command).toBe('node -e \"x()\"');
    expect(resolved.env).toBeUndefined();
  });
});

describe('executeHookCommand', () => {
  it('uses additionalContext from JSON stdout on exit 0', async () => {
    const result = await executeHookCommand(
      { type: 'command', command: cmdJsonContext('ctx-from-json') },
      baseInput(),
      { cwd: CWD },
    );
    expect(result.ok).toBe(true);
    expect(result.additionalContext).toBe('ctx-from-json');
  });

  it('uses plain stdout verbatim when it is not additionalContext JSON', async () => {
    const result = await executeHookCommand(
      { type: 'command', command: cmdPlain('plain hook text') },
      baseInput(),
      { cwd: CWD },
    );
    expect(result.ok).toBe(true);
    expect(result.additionalContext).toBe('plain hook text');
  });

  it('returns ok without context when stdout is empty', async () => {
    const result = await executeHookCommand(
      { type: 'command', command: 'node -e ""' },
      baseInput(),
      { cwd: CWD },
    );
    expect(result.ok).toBe(true);
    expect(result.additionalContext).toBeUndefined();
  });

  it('fails open on non-zero exit and reports the exit code', async () => {
    const result = await executeHookCommand(
      { type: 'command', command: 'node -e "process.exit(3)"' },
      baseInput(),
      { cwd: CWD },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('exited with code 3');
    expect(result.exitCode).toBe(3);
  });

  it('pipes the hook input as JSON on stdin', async () => {
    const command =
      'node -e "var d=\'\';process.stdin.on(\'data\',function(c){d+=c});' +
      'process.stdin.on(\'end\',function(){' +
      'process.stdout.write(JSON.stringify({additionalContext:\'got:\'+JSON.parse(d).hook_event_name}))})"';
    const result = await executeHookCommand({ type: 'command', command }, baseInput(), {
      cwd: CWD,
    });
    expect(result.ok).toBe(true);
    expect(result.additionalContext).toBe('got:PreTurn');
  });

  it('kills the process and fails open on timeout', async () => {
    const start = Date.now();
    const result = await executeHookCommand(
      { type: 'command', command: 'node -e "setTimeout(function(){},8000)"', timeout: 1 },
      baseInput(),
      { cwd: CWD },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('timed out');
    expect(result.exitCode).toBeUndefined();
    // 1s timeout (plus scheduling slack) — not the 8s the script would run.
    expect(Date.now() - start).toBeLessThan(6000);
  });
});

// ============================================================================
// http executor
// ============================================================================

describe('executeHttpHook', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c));
      req.on('end', () => {
        if (req.url === '/ok') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ additionalContext: `http-ctx:${JSON.parse(body).session_id}` }));
        } else {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('boom');
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('POSTs the input and reads additionalContext from a 2xx JSON body', async () => {
    const result = await executeHttpHook({ type: 'http', url: `${baseUrl}/ok` }, baseInput());
    expect(result.ok).toBe(true);
    expect(result.additionalContext).toBe('http-ctx:s1');
  });

  it('fails open on a 500 response', async () => {
    const result = await executeHttpHook({ type: 'http', url: `${baseUrl}/err` }, baseInput());
    expect(result.ok).toBe(false);
    expect(result.error).toContain('500');
  });

  it('fails open on a network error', async () => {
    const result = await executeHttpHook(
      { type: 'http', url: 'http://127.0.0.1:1/nope', timeout: 2 },
      baseInput(),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

// ============================================================================
// process executor (ZCode hooks.json alignment)
// ============================================================================

describe('executeProcessHook', () => {
  it('uses additionalContext from JSON stdout on exit 0', async () => {
    const result = await executeProcessHook(
      {
        type: 'process',
        command: 'node',
        args: ['-e', "process.stdout.write(JSON.stringify({additionalContext:'proc-ctx'}))"],
      },
      baseInput(),
      { cwd: CWD },
    );
    expect(result.ok).toBe(true);
    expect(result.additionalContext).toBe('proc-ctx');
  });

  it('passes args through verbatim and pipes the hook input on stdin', async () => {
    const script =
      `var d='';process.stdin.on('data',function(c){d+=c});` +
      `process.stdin.on('end',function(){` +
      `process.stdout.write(JSON.stringify({additionalContext:'got:'+JSON.parse(d).hook_event_name+':'+process.argv[1]}))})`;
    const result = await executeProcessHook(
      { type: 'process', command: 'node', args: ['-e', script, 'MARKER'] },
      baseInput(),
      { cwd: CWD },
    );
    expect(result.ok).toBe(true);
    expect(result.additionalContext).toBe('got:PreTurn:MARKER');
  });

  it('fails open on non-zero exit and reports the exit code', async () => {
    const result = await executeProcessHook(
      { type: 'process', command: 'node', args: ['-e', 'process.exit(4)'] },
      baseInput(),
      { cwd: CWD },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('exited with code 4');
    expect(result.exitCode).toBe(4);
  });

  it('kills the process and fails open on timeoutMs', async () => {
    const start = Date.now();
    const result = await executeProcessHook(
      {
        type: 'process',
        command: 'node',
        args: ['-e', 'setTimeout(function(){},8000)'],
        timeoutMs: 1000,
      },
      baseInput(),
      { cwd: CWD },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('timed out');
    expect(result.exitCode).toBeUndefined();
    // 1s timeout (plus scheduling slack) — not the 8s the script would run.
    expect(Date.now() - start).toBeLessThan(6000);
  });

  it('spawns without a shell (metacharacters arrive as literal args)', async () => {
    const script =
      `var d='';process.stdin.on('data',function(c){d+=c});` +
      `process.stdin.on('end',function(){` +
      `process.stdout.write(JSON.stringify({additionalContext:process.argv[1]}))})`;
    const result = await executeProcessHook(
      { type: 'process', command: 'node', args: ['-e', script, '$LITERAL|a;b'] },
      baseInput(),
      { cwd: CWD },
    );
    expect(result.ok).toBe(true);
    expect(result.additionalContext).toBe('$LITERAL|a;b');
  });

  it('expands ${KEY} placeholders in command and args', async () => {
    const script = `process.stdout.write(JSON.stringify({additionalContext:process.argv[1]}))`;
    const result = await executeProcessHook(
      { type: 'process', command: 'node', args: ['-e', script, '${sessionId}|${cwd}'] },
      baseInput(),
      { cwd: CWD, vars: { sessionId: 'sess-1', cwd: CWD } },
    );
    expect(result.ok).toBe(true);
    expect(result.additionalContext).toBe(`sess-1|${CWD}`);
  });

  it('leaves unknown and unsafe ${KEY} placeholders untouched', async () => {
    const script = `process.stdout.write(JSON.stringify({additionalContext:process.argv[1]}))`;
    const result = await executeProcessHook(
      { type: 'process', command: 'node', args: ['-e', script, '${UNKNOWN}:${sessionId}'] },
      baseInput(),
      { cwd: CWD, vars: { sessionId: 'bad value; rm -rf' } },
    );
    expect(result.ok).toBe(true);
    expect(result.additionalContext).toBe('${UNKNOWN}:${sessionId}');
  });
});

// ============================================================================
// ${VAR} template expansion (pure function)
// ============================================================================

describe('expandHookTemplate', () => {
  it('replaces known safe keys', () => {
    expect(expandHookTemplate('a${k}b', { k: 'X' })).toBe('aXb');
  });

  it('leaves unknown keys verbatim', () => {
    expect(expandHookTemplate('${unknown}', {})).toBe('${unknown}');
  });

  it('rejects values containing unsafe characters', () => {
    expect(expandHookTemplate('${k}', { k: 'a b;rm -rf' })).toBe('${k}');
    expect(expandHookTemplate('${k}', { k: '$HOME' })).toBe('${k}');
    expect(expandHookTemplate('${k}', { k: '`id`' })).toBe('${k}');
  });

  it('allows path-like safe values', () => {
    expect(expandHookTemplate('${root}/x', { root: 'C:/Users/a/.duya' })).toBe('C:/Users/a/.duya/x');
  });

  it('expands repeated keys', () => {
    expect(expandHookTemplate('${a}-${a}', { a: '1' })).toBe('1-1');
  });
});

// ============================================================================
// dispatcher
// ============================================================================

describe('executeHook dispatcher', () => {
  it('routes process type to the process executor', async () => {
    const result = await executeHook(
      { type: 'process', command: 'node', args: ['-e', "process.stdout.write('dispatched')"] },
      baseInput(),
      { cwd: CWD },
    );
    expect(result.ok).toBe(true);
    expect(result.additionalContext).toBe('dispatched');
  });

  it('prompt type fails open with the not-implemented error', async () => {
    const result = await executeHook({ type: 'prompt', prompt: 'x' }, baseInput(), { cwd: CWD });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not implemented');
  });

  it('agent type fails open with the not-implemented error', async () => {
    const result = await executeHook({ type: 'agent', prompt: 'x' }, baseInput(), { cwd: CWD });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not implemented');
  });
});

// ============================================================================
// config-loop bridge
// ============================================================================

describe('createConfiguredLoopHooks', () => {
  const TEST_NS = 'hooks-executor-test';

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function busOf(regs: ReturnType<typeof createConfiguredLoopHooks>): LoopHookBus {
    const bus = new LoopHookBus();
    for (const r of regs) bus.register(r);
    return bus;
  }

  it('emits one registration per bridged event with configured matchers', () => {
    const settings: HooksSettings = {
      PreTurn: [{ hooks: [{ type: 'command', command: 'echo a' }] }],
      PostTurn: [{ hooks: [{ type: 'command', command: 'echo b' }] }],
    };
    const regs = createConfiguredLoopHooks({ hooks: settings, cwd: CWD });
    expect(regs.map((r) => r.id).sort()).toEqual(['config.PostTurn', 'config.PreTurn']);
    for (const r of regs) {
      expect(r.priority).toBe(400);
      expect(r.events).toHaveLength(1);
    }
  });

  it('returns [] when nothing is configured', () => {
    expect(createConfiguredLoopHooks({ hooks: {}, cwd: CWD })).toEqual([]);
  });

  it('returns [] for events not bridged onto the loop bus', () => {
    // SessionStart is dispatched by ConfigHooksRunner (events.ts), not the
    // loop bus; PreFinalize is unbridged (no external veto path). Neither
    // should produce a loop registration.
    const settings: HooksSettings = {
      SessionStart: [{ hooks: [{ type: 'command', command: 'echo x' }] }],
      PreFinalize: [{ hooks: [{ type: 'command', command: 'echo y' }] }],
    };
    expect(createConfiguredLoopHooks({ hooks: settings, cwd: CWD })).toEqual([]);
  });

  it('reads undefined (no fs config) when deps.hooks is omitted', () => {
    // Namespace isolation so the real ~/.duya/config.toml cannot leak in.
    vi.stubEnv('DUYA_TEST', '1');
    vi.stubEnv('DUYA_TEST_NAMESPACE', TEST_NS);
    expect(createConfiguredLoopHooks({ cwd: CWD })).toEqual([]);
  });

  it('PreTurn registration collects command additionalContext into a custom inject', async () => {
    const settings: HooksSettings = {
      PreTurn: [{ hooks: [{ type: 'command', command: cmdJsonContext('pre-turn-ctx') }] }],
    };
    const bus = busOf(createConfiguredLoopHooks({ hooks: settings, cwd: CWD }));
    const effects = await bus.dispatch('PreTurn', {
      sessionId: 's1',
      turnCount: 2,
      seqIndex: 0,
      messages: [],
    });
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({ type: 'inject', source: 'custom', dedupKey: 'config.PreTurn' });
    const preInj = (effects[0] as { injection: string }).injection;
    expect(preInj).toContain('<hook-context event="PreTurn"');
    expect(preInj).toContain('pre-turn-ctx');
  });

  it('PostToolUse matcher filters by tool name; no matcher matches everything', async () => {
    const settings: HooksSettings = {
      PostToolUse: [
        { matcher: '^Read$', hooks: [{ type: 'command', command: cmdJsonContext('read-ctx') }] },
        { hooks: [{ type: 'command', command: cmdJsonContext('any-ctx') }] },
      ],
    };
    const bus = busOf(createConfiguredLoopHooks({ hooks: settings, cwd: CWD }));

    const withRead = await bus.dispatch('PostToolUse', {
      sessionId: 's1',
      turnCount: 1,
      seqIndex: 0,
      messages: [],
      toolCalls: [
        { name: 'Read', input: {} },
        { name: 'Bash', input: {} },
      ],
    });
    expect(withRead).toHaveLength(1);
    expect(withRead[0]).toMatchObject({ type: 'inject', source: 'custom', dedupKey: 'config.PostToolUse' });
    const withReadInj = (withRead[0] as { injection: string }).injection;
    expect(withReadInj).toContain('read-ctx');
    expect(withReadInj).toContain('any-ctx');

    const withoutRead = await bus.dispatch('PostToolUse', {
      sessionId: 's1',
      turnCount: 1,
      seqIndex: 0,
      messages: [],
      toolCalls: [{ name: 'Bash', input: {} }],
    });
    expect(withoutRead).toHaveLength(1);
    const withoutReadInj = (withoutRead[0] as { injection: string }).injection;
    expect(withoutReadInj).toContain('any-ctx');
    expect(withoutReadInj).not.toContain('read-ctx');
  });

  it('failed hooks are skipped (fail-open), successful ones still inject', async () => {
    const settings: HooksSettings = {
      PostTurn: [
        { hooks: [{ type: 'http', url: 'http://127.0.0.1:1/nope', timeout: 2 }] },
        { hooks: [{ type: 'command', command: cmdJsonContext('good-ctx') }] },
      ],
    };
    const bus = busOf(createConfiguredLoopHooks({ hooks: settings, cwd: CWD }));
    const effects = await bus.dispatch('PostTurn', {
      sessionId: 's1',
      turnCount: 1,
      seqIndex: 0,
      messages: [],
    });
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({ type: 'inject', source: 'custom', dedupKey: 'config.PostTurn' });
    expect((effects[0] as { injection: string }).injection).toContain('good-ctx');
  });

  it('omits hook context once the run-level injection budget is exhausted', async () => {
    // ~60 tokens of context per dispatch; cap at 150 → two dispatches fit
    // (120), the third degrades to the omission marker. Content is generated
    // at runtime so the hook attribute (command line) stays short.
    const filler = 'x'.repeat(240);
    const settings: HooksSettings = {
      PreTurn: [{ hooks: [{ type: 'command', command: `node -e "process.stdout.write(JSON.stringify({additionalContext:'x'.repeat(240)}))"` }] }],
    };
    const bus = busOf(createConfiguredLoopHooks({
      hooks: settings,
      cwd: CWD,
      runInjectionBudgetTokens: 150,
    }));

    const dispatchOnce = () => bus.dispatch('PreTurn', {
      sessionId: 's1',
      turnCount: 1,
      seqIndex: 0,
      messages: [],
    });

    const first = await dispatchOnce();
    expect(first).toHaveLength(1);
    const firstInj = (first[0] as { injection: string }).injection;
    expect(firstInj).toContain(filler);

    const second = await dispatchOnce();
    expect((second[0] as { injection: string }).injection).toContain(filler);

    const third = await dispatchOnce();
    const thirdInj = (third[0] as { injection: string }).injection;
    expect(thirdInj).not.toContain(filler);
    expect(thirdInj).toContain('budget exhausted');
    expect(thirdInj).toContain('<hook-context event="PreTurn"');
  });

  it('injects a non-zero-exit command diagnostic back to the model (verifier)', async () => {
    const settings: HooksSettings = {
      PostTurn: [
        { hooks: [{ type: 'command', command: 'node -e "process.stderr.write(\'lint error@L1\');process.exit(2)"' }] },
      ],
    };
    const bus = busOf(createConfiguredLoopHooks({ hooks: settings, cwd: CWD }));
    const effects = await bus.dispatch('PostTurn', {
      sessionId: 's1',
      turnCount: 1,
      seqIndex: 0,
      messages: [],
    });
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({ type: 'inject', source: 'custom' });
    const injection = (effects[0] as { injection: string }).injection;
    expect(injection).toContain('[verify:command]');
    expect(injection).toContain('exited with code 2');
    expect(injection).toContain('lint error@L1');
  });

  it('returns no effect when matched hooks produce no context', async () => {
    const settings: HooksSettings = {
      PreTurn: [{ hooks: [{ type: 'command', command: 'node -e ""' }] }],
    };
    const bus = busOf(createConfiguredLoopHooks({ hooks: settings, cwd: CWD }));
    const effects = await bus.dispatch('PreTurn', {
      sessionId: 's1',
      turnCount: 1,
      seqIndex: 0,
      messages: [],
    });
    expect(effects).toHaveLength(0);
  });
});
