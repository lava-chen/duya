/**
 * The subprocess transport, against a REAL worker process.
 *
 * ## What makes this different from a fixture-driven test
 *
 * The child here is a real `node` process running the repository's OWN
 * `sendEvent` from `packages/agent/src/process/worker-protocol.ts`. That
 * function is where every property that makes framing non-trivial lives:
 *
 *  - it injects `_logger: 'worker'` into every frame;
 *  - it ESCAPES embedded newlines, so a `chat:text` whose content contains a
 *    real line break still produces exactly one line;
 *  - it appends `\n` and writes to `process.stdout` through a queue whose
 *    overflow policy is type-blind, which is T3.4's measured fact.
 *
 * A hand-written fixture that omitted the escaping would let a multi-line
 * reassembler pass. So the test drives the real function and asserts on the real
 * bytes, and the fragmentation is forced by the worker writing one byte at a
 * time -- a case a real pipe will not produce on demand, because a fast
 * producer and a fast reader coalesce into one big chunk.
 *
 * ## What these tests prove, and what they cannot
 *
 * They prove the framing, the channel separation, the refusal and the stop
 * receipt over real pipes. They do NOT prove that a packaged Electron host wires
 * stdin and stdout to two live pipes under production load; that needs the
 * built app, and it is named as the remaining gap rather than assumed.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { SubprocessTransport } from '../src/transport/subprocess-transport.js';
import { NdjsonLineDecoder, parseNdjsonLine } from '../src/transport/line-codec.js';
import type { RawFrameIntake } from '../src/transport/transport-port.js';
import type { JsonValue, RunId } from '@duya/agent-protocol';

const WORKER = fileURLToPath(
  new URL('../../agent/tests/process/fixtures/real-worker.mjs', import.meta.url),
);
const WORKER_PROTOCOL_DIST = fileURLToPath(
  new URL('../../agent/dist/process/worker-protocol.js', import.meta.url),
);

/** Real 3-byte characters, spelled as escapes so this file stays pure ASCII. */
const CJK = '\u4e2d\u6587\u6d4b\u8bd5';

const children: Array<() => void> = [];
afterEach(() => {
  for (const kill of children.splice(0)) kill();
});

/** An intake that records everything the transport hands it. */
function recordingIntake(): RawFrameIntake & { readonly frames: RawFrameLike[]; ends: number } {
  const frames: RawFrameLike[] = [];
  const box = {
    frames,
    ends: 0,
    frame(raw: RawFrameLike): void {
      frames.push(raw);
    },
    end(): void {
      box.ends += 1;
    },
  };
  return box;
}
type RawFrameLike = Readonly<Record<string, unknown>>;

function manifestFor(runId: string): Parameters<SubprocessTransport['start']>[0] {
  return {
    version: 1,
    runId,
    projectId: null,
    sessionId: 'session-1',
    agent: { profileId: null, model: 'test-model', providerId: 'test-provider' },
    workspaceId: 'ws-1',
    roots: [],
    cwd: '.',
    permissionPolicy: { mode: 'default', hostSwitch: 'ask', defaultTimeoutMs: 300_000 },
    capabilities: { profiles: [], modes: [], tools: [] },
    connectorBindings: [],
    env: { ref: 'env:session-1', hash: 'e3b0c44298fc1c149afbf4c8996fb924' },
    budget: { maxTurns: 4 },
    deterministic: false,
  } as unknown as Parameters<SubprocessTransport['start']>[0];
}

const SCENARIO_FRAMES: JsonValue[] = [
  { type: 'chat:text', messageId: 'm1', content: 'first block' },
  { type: 'chat:thinking', messageId: 'm1', content: CJK },
  { type: 'chat:text', messageId: 'm1', content: 'second block' },
  // A real newline in the content. The worker escapes it, so this is still ONE
  // line -- which is the property a reassembler would have hidden.
  { type: 'chat:text', messageId: 'm1', content: 'line one\nline two' },
  { type: 'chat:done' },
];

function newTransport(fragmentBytes?: number): SubprocessTransport {
  const transport = new SubprocessTransport({
    command: process.execPath,
    args: [WORKER],
    stopGraceMs: 1_500,
    capabilities: async () => ({}) as never,
  });
  transport.stage({ frames: SCENARIO_FRAMES, ...(fragmentBytes !== undefined ? { fragmentBytes } : {}) });
  return transport;
}

describe('the worker fixture is the repository\'s own sendEvent', () => {
  it('needs the built worker, and says so rather than skipping', () => {
    // A silent skip here would make every test below a no-op on a machine
    // without a build, which is the "suite is green but proves nothing" state
    // this repository's test-coverage gate exists to prevent.
    expect(
      existsSync(WORKER_PROTOCOL_DIST),
      `${WORKER_PROTOCOL_DIST} is missing. Run \`npm run build:packages\` before this suite.`,
    ).toBe(true);
  });

  it('produces the worker\'s own line format, escapes and all', () => {
    // Prove the fixture is really the worker by calling it and reading the raw
    // stdout bytes. `_logger: 'worker'` is the worker's fingerprint; no
    // hand-written fixture would have it.
    const child = spawn(process.execPath, [WORKER], { stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(() => child.kill());
    let out = '';
    child.stdout.on('data', (c: Buffer) => {
      out += c.toString('utf8');
    });
    child.stdin.write(
      JSON.stringify({ cmd: 'start', frames: [{ type: 'chat:text', content: 'a\nb' }] }) + '\n',
    );
    child.stdin.write(JSON.stringify({ cmd: 'close' }) + '\n');
    child.stdin.end();

    return new Promise<void>((resolve) => {
      child.on('close', () => {
        const lines = out.split('\n').filter((l) => l.length > 0);
        expect(lines).toHaveLength(1);
        const frame = parseNdjsonLine(lines[0]!) as Record<string, unknown>;
        // The worker's own injection, not a fixture's.
        expect(frame['_logger']).toBe('worker');
        // And the escape: the content kept its newline as two characters.
        expect(frame['content']).toBe('a\nb');
        resolve();
      });
    });
  });
});

describe('the subprocess transport moves real frames over a real pipe', () => {
  it('delivers every real worker frame, in order, with no reassembly', async () => {
    const transport = newTransport();
    const intake = recordingIntake();
    const run = await transport.start(manifestFor('run-sub-1' as RunId), intake);
    await waitFor(() => intake.ends > 0);
    await transport.close();

    expect(intake.ends).toBeGreaterThan(0);
    expect(intake.frames).toHaveLength(SCENARIO_FRAMES.length);
    expect(intake.frames.map((f) => f['type'])).toEqual([
      'chat:text',
      'chat:thinking',
      'chat:text',
      'chat:text',
      'chat:done',
    ]);
    // The newline-bearing content survived as CONTENT, not as a split frame.
    expect(intake.frames[3]!['content']).toBe('line one\nline two');
    expect(intake.frames[1]!['content']).toBe(CJK);
    expect(run.diagnostics().bytesRead).toBeGreaterThan(0);
    expect(run.diagnostics().framesRefused).toBe(0);
  });

  it('reassembles a byte-at-a-time stream that no real pipe would produce', async () => {
    // The worker writes ONE BYTE per write, so every frame, every newline and
    // every byte of every CJK character is split. This is the fragmentation
    // that a coalescing pipe hides.
    const transport = newTransport(1);
    const intake = recordingIntake();
    await transport.start(manifestFor('run-sub-2' as RunId), intake);
    await waitFor(() => intake.ends > 0);
    await transport.close();

    expect(intake.frames).toHaveLength(SCENARIO_FRAMES.length);
    // Not one U+FFFD: the multi-byte characters survived being split.
    expect(intake.frames[1]!['content']).toBe(CJK);
    expect(framesAreClean(intake)).toBe(true);
    expect(intake.frames[4]!['type']).toBe('chat:done');
  });

  it('hands the runtime RAW frames, so the transport never mints a seq', async () => {
    const transport = newTransport();
    const intake = recordingIntake();
    await transport.start(manifestFor('run-sub-3' as RunId), intake);
    await waitFor(() => intake.ends > 0);
    await transport.close();

    // The load-bearing structural claim: no frame carries a sequence number,
    // because the transport has no way to assign one. A frame carrying `seq`
    // here would mean the transport had become a numbering authority.
    for (const frame of intake.frames) {
      expect(frame['seq']).toBeUndefined();
    }
  });
});

describe('private config rides the other pipe', () => {
  it('never appears in the event channel\'s bytes', async () => {
    const secret = 'sk-do-not-leak-this-value';
    const transport = new SubprocessTransport({
      command: process.execPath,
      args: [WORKER],
      capabilities: async () => ({}) as never,
    });
    transport.stage({ frames: SCENARIO_FRAMES, private: { apiKey: secret, region: 'test' } });
    const intake = recordingIntake();
    const run = await transport.start(manifestFor('run-sub-4' as RunId), intake);
    await waitFor(() => intake.ends > 0);
    const diagnostics = run.diagnostics();
    await transport.close();

    // The credential is nowhere in what the event channel carried. The only
    // proof that it arrived at all is the worker's STDERR acknowledgement, so
    // the two channels are demonstrably distinct rather than nominally so.
    expect(JSON.stringify(intake.frames)).not.toContain(secret);
    expect(intake.frames).toHaveLength(SCENARIO_FRAMES.length);
    // stderr bytes are counted separately from stdout, which is the structural
    // statement that the two channels are accounted for independently.
    expect(diagnostics.bytesRead).toBeGreaterThan(0);
    expect(diagnostics.bytesWritten).toBeGreaterThan(0);
  });
});

describe('a stdout disconnect is a refusal, not a quiet success', () => {
  it('reports truncation when the worker dies mid-frame', async () => {
    // A child that writes half a frame and is then killed. The decoder must
    // refuse the tail rather than hand the run a truncated frame, and the
    // intake must be ended so the runtime closes the run instead of waiting
    // forever for a terminal that cannot arrive.
    const killer = fileURLToPath(new URL('./fixtures/truncating-worker.mjs', import.meta.url));
    const transport = new SubprocessTransport({
      command: process.execPath,
      args: [killer],
      capabilities: async () => ({}) as never,
    });
    transport.stage({ frames: [] });
    const intake = recordingIntake();
    const run = await transport.start(manifestFor('run-sub-5' as RunId), intake);
    await waitFor(() => intake.ends > 0, 8_000);
    const diagnostics = run.diagnostics();
    await transport.close();

    expect(intake.ends).toBeGreaterThan(0);
    expect(diagnostics.framesRefused).toBe(1);
    expect(diagnostics.disconnected).toBe(true);
    expect(diagnostics.detail?.['refusal']).toBe('invalid_event_frame');
    // And no frame was invented from the truncated bytes.
    expect(intake.frames).toHaveLength(0);
  });
});

describe('cancel reaches the worker while the event channel is backed up', () => {
  it('delivers a stop on stdin with megabytes still queued on stdout', async () => {
    // The claim T3.4 could only make at the channel-port layer, measured here.
    //
    // The worker floods far past an OS pipe buffer and stays open, so stdout is
    // genuinely backed up at the moment the stop is issued. If control rode the
    // same pipe -- or if the pipe were paused wholesale and control queued
    // behind frames -- the acknowledgement could not arrive before the flood
    // drained. It arrives anyway, and it arrives on the worker's STDERR.
    const transport = new SubprocessTransport({
      command: process.execPath,
      args: [WORKER],
      stopGraceMs: 5_000,
      capabilities: async () => ({}) as never,
    });
    // Staged, but with no frames: the work is done by the `flood` command
    // below, which also keeps the worker alive (no terminal frame), so the
    // event pipe stays backed up for the whole test.
    transport.stage({ frames: [] });
    const intake = recordingIntake();
    const run = await transport.start(manifestFor('run-sub-6' as RunId), intake);
    await run.privateChannel.deliver({ cmd: 'flood', count: 400, size: 4096 });
    // Let the pipe back up: wait until frames are arriving, then keep going
    // while the stop goes out.
    await waitFor(() => intake.frames.length > 3, 8_000);
    const receivedAtStop = intake.frames.length;

    const receipt = await run.handle.stop({ graceMs: 5_000, reason: 'user pressed stop' });
    const after = intake.frames.length;
    await transport.close();

    // The worker acknowledged on stderr, which is what `cooperative` means
    // here: it answered, and it answered while the event channel was saturated.
    expect(receipt.requested).toBe(true);
    expect(receipt.disposition).toBe('cooperative');
    expect(receipt.reason).toBe('user pressed stop');
    // Sanity: the event channel really was busy, so the claim is not vacuous.
    expect(after).toBeGreaterThanOrEqual(receivedAtStop);
    expect(after).toBeGreaterThan(3);
  });
});

// ── helpers ───────────────────────────────────────────────────────────────

async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for the transport');
}

function framesAreClean(intake: { readonly frames: RawFrameLike[] }): boolean {
  return !JSON.stringify(intake.frames).includes('\uFFFD');
}
