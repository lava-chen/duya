/**
 * T12 — real PTY acceptance for `duya tui`, at 80 columns.
 *
 * ## What this is the only coverage of
 *
 * Everything else that exercises the TUI calls `TUIApp` in-process with a
 * synthetic stdin. That proves the state machine, not the terminal: it cannot
 * say whether a keystroke typed at a real prompt reaches the composer, whether
 * the permission picker is legible once a real terminal has wrapped it, or
 * whether the transcript survives the alternate screen. Those are the failures
 * a user hits first, and none of them are reachable without a PTY.
 *
 * ## Why a controlled Host and not the real one
 *
 * `duya tui` boots an ephemeral Host and a real worker, which needs real
 * credentials to answer a turn. `attachedHostFromEnv` (PR #296) is the seam
 * that makes this runnable: with `DUYA_TUI_ATTACH=1` plus
 * `DUYA_TUI_HOST_ORIGIN`, the TUI attaches to a Host the test started in this
 * process, backed by a fake worker that speaks native envelopes.
 *
 * Everything between the keystroke and the worker is production: the bundle is
 * the shipped artifact, the Host is the real HTTP+SSE server, permission
 * registration, expiry, persistence and resolution are the real ones.
 *
 * ## The control that gives the allow case teeth
 *
 * The fake worker only emits its final text block AFTER the Host relays a
 * `permission:resolve` back to it, and it quotes the decision it was given.
 * So `worker saw allow_once` on screen is not "a row was painted" — it is
 * proof that this exact keystroke became that exact HTTP request and reached
 * the worker. That is why the deny case exists too: with only the allow case,
 * an implementation that always sends `allow` passes everything.
 *
 * ## Reading the screen
 *
 * ConPTY paints with cursor positioning and SGR runs, so the raw byte stream
 * is not a screen. Escape sequences are stripped and whitespace collapsed;
 * every drawn string still survives, and the assertions name content the user
 * would actually see rather than bytes.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { IPty } from 'node-pty';
import pty from 'node-pty';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startLocalHost } from '@duya/host/local-host';
import { HostSessionHttpClient } from '@duya/host/http-client';

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const CLI_BUNDLE = path.join(REPO_ROOT, 'packages', 'cli', 'bundle', 'cli.cjs');

/** A command long enough that 80 columns has to wrap it somewhere. */
const LONG_COMMAND = 'echo pty-acceptance-with-a-long-argument-that-must-wrap-at-eighty-columns';

/**
 * Build the bundled CLI, but only when what it is built from has moved.
 *
 * The bundle is the artifact that ships, and it is self-contained — unlike
 * `packages/cli/dist`, whose workspace imports resolve through a `node_modules`
 * junction back to the SHARED checkout, which would silently test someone
 * else's copy of `@duya/host`.
 */
async function bundleIsStale(): Promise<boolean> {
  let built: number;
  try {
    built = (await fs.stat(CLI_BUNDLE)).mtimeMs;
  } catch {
    return true;
  }
  const cliPkg = JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'packages', 'cli', 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const sources = ['packages/cli/src', ...Object.keys(cliPkg.dependencies ?? {})
    .filter((name) => name.startsWith('@duya/'))
    .map((name) => `packages/${name.slice('@duya/'.length)}/src`)];
  for (const dir of sources) {
    for await (const entry of walk(path.join(REPO_ROOT, dir))) {
      if (!entry.endsWith('.ts')) continue;
      if ((await fs.stat(entry)).mtimeMs > built) return true;
    }
  }
  return false;
}

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

/**
 * Reconstruct what the terminal would show.
 *
 * The composer does not write spaces: it draws `run`, moves the cursor one
 * column right, draws `the`, moves again, draws `thing`. The cells between are
 * blank on screen but absent from the byte stream, so a plain strip-and-search
 * for `run the thing` cannot match a prompt the user can plainly see. Cursor
 * FORWARD is therefore expanded into that many blanks before the remaining
 * escapes are dropped; everything else (erase, colour, cursor moves back and
 * absolute positioning) is invisible text-wise and is discarded.
 */
function readScreen(raw: string): string {
  return raw
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[(\d*)C/g, (_match, count: string) => ' '.repeat(count === '' ? 1 : Number(count)))
    .replace(/\u001b[\[\]][0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[@-Z\\-_]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/\s+/g, ' ');
}

const STEP_TIMEOUT_MS = 20_000;

/**
 * The fake worker. It answers a turn with a tool call that needs approval, and
 * says what it was told ONLY after the answer comes back.
 */
const FAKE_WORKER = `
let pending = '';
let seq = 0;
let lastRun = { sessionId: '', runId: '' };

// The Host publishes only native envelopes to a client (worker-process-entry
// sends { type: 'run:event', epoch, envelope } and readNativeWireFrame refuses
// anything without an integer epoch, runId and seq >= 1).
const emit = (payload) => process.send({
  type: 'run:event',
  epoch: 0,
  envelope: {
    sessionId: lastRun.sessionId,
    runId: lastRun.runId,
    seq: ++seq,
    timestamp: Date.now(),
    traceId: 'trace-pty',
    payload,
  },
});

process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
  pending += data;
  let end;
  while ((end = pending.indexOf('\\n')) >= 0) {
    const line = pending.slice(0, end);
    pending = pending.slice(end + 1);
    if (!line.trim()) continue;
    const command = JSON.parse(line);

    if (command.type === 'permission:resolve') {
      // The whole point: nothing below runs until the answer has made the
      // round trip through the TUI, the client and the Host.
      const allowed = command.decision.startsWith('allow');
      emit({
        type: 'permission.resolved',
        requestId: command.id,
        action: allowed ? 'allow' : 'deny',
        source: 'host',
        latencyMs: 1,
      });
      emit({
        type: 'tool.call_completed',
        toolCallId: 'call-pty',
        outcome: { outcome: allowed ? 'success' : 'failure' },
        content: allowed ? 'ran after approval' : 'never ran',
      });
      emit({ type: 'assistant.text_block', messageId: 'm-pty', index: 0, text: 'worker saw ' + command.decision });
      emit({ type: 'run.completed', status: 'completed' });
      continue;
    }

    if (command.type !== 'chat:start') continue;
    lastRun = { sessionId: command.sessionId, runId: command.runId };
    const toolInput = { command: ${JSON.stringify(LONG_COMMAND)} };
    emit({
      type: 'tool.call_started',
      toolCallId: 'call-pty',
      toolName: 'Bash',
      arguments: toolInput,
    });
    emit({
      type: 'permission.requested',
      requestId: 'req-pty',
      toolName: 'Bash',
      toolInput,
      mode: 'generic',
      kind: 'tool_use',
      startedAt: Date.now(),
      expiresAt: Date.now() + 300000,
    });
    // Registration is a SEPARATE channel: the envelope above is what a client
    // sees, this is what makes the request answerable at all
    // (run-execution.ts -> worker-permission-requests.request()).
    process.send({
      type: 'chat:permission',
      sessionId: command.sessionId,
      request: {
        id: 'req-pty',
        toolName: 'Bash',
        toolInput,
        mode: 'generic',
        kind: 'tool_use',
        expiresAt: Date.now() + 300000,
      },
    });
  }
});
process.on('disconnect', () => process.exit(0));
`;

describe('duya tui in a real 80-column PTY', () => {
  beforeAll(async () => {
    if (await bundleIsStale()) {
      // Invoked as `node <script>` rather than `npm run build:cli-bundle`,
      // because `execFile` cannot spawn `npm.cmd` on Windows — it throws at
      // spawn time, which surfaced as a suite that failed with an empty message
      // and every test reported as "skipped". The script is what the npm entry
      // runs anyway, so this loses nothing.
      await execFileAsync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'build-cli-bundle.mjs')], {
        cwd: REPO_ROOT,
        timeout: 300_000,
      });
    }
  }, 300_000);

  it.each([
    { key: 'y', decision: 'allow_once', label: 'approved' },
    { key: 'n', decision: 'deny', label: 'refused' },
  ])('takes a tool call through approval at 80 columns: $label', async ({ key, decision }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-tui-pty-'));
    const workerPath = path.join(root, 'worker.cjs');
    await fs.writeFile(workerPath, FAKE_WORKER);
    const host = await startLocalHost({ dataRoot: root, ephemeral: true, workerPath });
    const client = new HostSessionHttpClient(host.origin, host.token ?? '');
    const sessionId = `pty-${key}-${Date.now()}`;
    await client.createImportedSession({ sessionId, title: 'pty acceptance', workingDirectory: root, projectName: 'pty' });

    let raw = '';
    const term = pty.spawn(process.execPath, [CLI_BUNDLE, 'tui', '--session', sessionId], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: root,
      env: {
        ...process.env,
        DUYA_TUI_ATTACH: '1',
        DUYA_TUI_HOST_ORIGIN: host.origin,
        DUYA_TUI_HOST_TOKEN: host.token ?? '',
        DUYA_TUI_INLINE: '',
        DUYA_CLI_TUI: '1',
        CI: '',
        TERM: 'xterm-256color',
      },
    });
    term.onData((chunk: string) => { raw += chunk; });

    const screen = (): string => readScreen(raw);
    /**
     * Wait until the screen stops changing.
     *
     * ConPTY coalesces writes that land together, and a `\r` inside the SAME
     * burst as the text it follows is swallowed — measured here: writing
     * `run the thing\r` as one call leaves the composer holding the text and
     * the run never starts, while the same `\r` written after the app has
     * painted submits. A human pressing Enter produces two separate bursts, so
     * the test waits for the paint rather than for a wall-clock delay.
     */
    const settle = async (quietMs = 300): Promise<void> => {
      let previous = '';
      let quiet = 0;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        const current = screen();
        quiet = current === previous && current.length > 0 ? quiet + 50 : 0;
        previous = current;
        if (quiet >= quietMs) return;
      }
    };
    const until = async (check: () => boolean, what: string): Promise<void> => {
      const deadline = Date.now() + STEP_TIMEOUT_MS;
      while (!check()) {
        if (Date.now() >= deadline) {
          throw new Error(`timed out waiting for ${what}. Screen: ${screen()}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };

    try {
      // 1. Typed input reaches the composer and starts a run.
      await until(() => screen().includes('duya tui'), 'the TUI to boot');
      await settle();

      // 1a. The slash popup is driven by real terminal input bytes. Narrow to
      // one result, then send DEL and BS separately to broaden the candidates
      // again before deleting the trigger. Inspect only each newly painted
      // output segment: older ANSI transcript bytes are intentionally retained.
      const slashOffset = raw.length;
      term.write('/rev');
      await until(
        () => readScreen(raw.slice(slashOffset)).includes('previous session'),
        'the narrowed slash candidate frame',
      );
      await settle();
      const narrowedFrame = readScreen(raw.slice(slashOffset));
      expect(narrowedFrame).toContain('/resume');
      expect(narrowedFrame).not.toContain('/rename');
      const delOffset = raw.length;
      term.write('\x7f'); // DEL: /rev -> /re
      await until(() => raw.length > delOffset, 'the DEL redraw');
      await settle();
      const delFrame = readScreen(raw.slice(delOffset));
      expect(delFrame).toContain('/rename');
      const bsOffset = raw.length;
      term.write('\x08'); // BS: /re -> /r, widening the candidate set
      await until(() => raw.length > bsOffset, 'the BS redraw');
      await settle();
      // The popup repaints the rows that CHANGED, so a row that was already on
      // screen is not emitted a second time: `/resume`, `/rename` and
      // `/read-file` are byte-identical in both frames and do not appear here.
      // The two commands below are the ones the WIDER filter introduces —
      // neither matches `/re`, so neither was a candidate a keystroke earlier.
      const broadenedFrame = readScreen(raw.slice(bsOffset));
      expect(broadenedFrame).toContain('/fork');
      expect(broadenedFrame).toContain('/export');

      const closeOffset = raw.length;
      term.write('\x08'); // /r -> /
      await until(() => raw.length > closeOffset, 'the slash-only redraw');
      await settle();
      const removeTriggerOffset = raw.length;
      term.write('\x7f'); // / -> empty; popup must close
      await until(() => raw.length > removeTriggerOffset, 'the popup-close redraw');
      await settle();
      const closedFrame = readScreen(raw.slice(removeTriggerOffset));
      expect(closedFrame).not.toMatch(/\/(?:resume|rename)\b/);
      expect(await client.listAgentRunsBySession(sessionId)).toHaveLength(0);

      // 1b. Typed input reaches the composer and starts a run.
      term.write('run the thing');
      await until(() => screen().includes('run the thing'), 'the prompt to be echoed');
      await settle();
      term.write('\r');
      // A raw output transcript is append-only: a cleared composer remains in
      // its history. The permission picker is the observable proof that Enter
      // submitted and the run reached the worker.
      await until(() => screen().includes('Allow once'), 'the permission picker after submit');
      expect(await client.listAgentRunsBySession(sessionId)).toHaveLength(1);

      // 2. The permission request is on screen, and all three choices fit in
      //    80 columns. A picker that needs 100 columns would silently drop the
      //    bottom option, and there is no other way to see that.
      const withPicker = screen();
      expect(withPicker).toContain('[1] Allow once');
      expect(withPicker).toContain('[2] Always allow');
      expect(withPicker).toContain('[3] Deny');
      // The long command is what forced the wrap; it must still be readable.
      expect(withPicker).toContain('pty-acceptance-with-a-long-argument');

      // 3. The keystroke becomes a resolution the worker actually received.
      term.write(key);
      await until(() => screen().includes('worker saw ' + decision), 'the worker to report the decision');
      expect(screen()).toContain('run the thing');

      // 4. Ctrl+C twice leaves the terminal and the process ends on its own.
      term.write('\u0003');
      term.write('\u0003');
      const code = await exitCode(term);
      expect(code).toBe(0);
      expect(raw).toContain('\u001b[?1006l');
      expect(raw).toContain('\u001b[?1002l');
      expect(raw).toContain('\u001b[?2004l');
      expect(raw).toContain('\u001b[?1049l');
    } finally {
      try { term.kill(); } catch { /* already gone */ }
      await host.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 90_000);
});

function exitCode(term: IPty): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      term.kill();
      reject(new Error('the TUI did not exit on Ctrl+C'));
    }, STEP_TIMEOUT_MS);
    term.onExit(({ exitCode: code }) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}
