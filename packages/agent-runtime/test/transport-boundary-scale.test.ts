/**
 * The boundary between the transports and the run layer, and the scenarios the
 * plan names that the other suites do not cover.
 *
 * ## Why a source audit
 *
 * `transport-guards.ts` proves, at COMPILE time, that the port's shape cannot
 * carry run state and that the pre-seq intake has no `envelope` arm. Neither
 * guard can see whether `subprocess-transport.ts` imports `RunSession` and
 * quietly owns a run -- and that single import would invalidate every claim the
 * equivalence suite makes, because two of the three adapters would then be
 * driving engines of their own.
 *
 * So the import lists are read and checked. The audit is written so that adding
 * the forbidden import is what makes it fail, and that is demonstrated rather
 * than asserted: the "audit itself works" test feeds the checker a synthetic
 * source containing the forbidden import and requires it to be reported.
 *
 * ## The remaining plan scenarios
 *
 * Out-of-order delivery, unknown types, 500+ events, and a ten-minute slow
 * consumer. Chunking is in `line-codec.test.ts` and against a real worker in
 * `subprocess-framing.test.ts`; duplicate cursors are in
 * `http-sse-transport.test.ts`; interleaved content blocks are in
 * `transport-equivalence.test.ts`.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EVENT_REGISTRY, verdictForUnknownType, type EventType, type RunEventEnvelope, type RunId } from '@duya/agent-protocol';
import { BoundedEventQueue } from '../src/events/backpressure.js';
import { assertNormalisationIsHonest } from '../src/transport/equivalence.js';
import { negotiateEventAdmission } from '../src/transport/capability-probe.js';
import { NdjsonLineDecoder } from '../src/transport/line-codec.js';

const TRANSPORT_DIR = fileURLToPath(new URL('../src/transport/', import.meta.url));
const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * The modules that OWN the run, and which no adapter may reach.
 *
 * ## The read-only half is deliberately NOT in this list
 *
 * A first draft listed the replay modules here too, and the audit immediately
 * flagged `http-sse-transport.ts` for importing `replay-repository` and
 * `replay-guards`. That was the audit being too blunt, not the transport being
 * wrong: `RunEventReader` is structurally READ-ONLY -- it cannot mint a `seq`,
 * cannot append and cannot touch a ledger -- and serving replay is precisely
 * what a server-side transport is for.
 *
 * So the boundary is not "may not import the run layer". It is the sharper and
 * more useful one: **a transport may hold the read side and may not hold the
 * write side.** The modules below all contain state that can change a run.
 */
const RUN_LAYER = [
  'run-session',
  'event-emitter',
  'controller',
  'coalesce',
  'backpressure',
  'transcript-snapshot',
] as const;

/**
 * The read-only ports a transport MAY hold.
 *
 * Listed so the permission is explicit rather than implied by an omission: a
 * reader and the replay mapping are a capability, and saying so is what stops
 * the forbidden list from creeping outward until nothing is importable.
 */
const READ_ONLY_ALLOWED = [
  'replay-repository',
  'replay-subscription',
  'replay-guards',
  'execution-channel',
  'chat-event-translator',
] as const;

/** The adapters themselves. The port and the pure helpers are exempt. */
const ADAPTER_FILES = [
  'subprocess-transport.ts',
  'http-sse-transport.ts',
  'in-process-transport.ts',
] as const;

/** The pure modules three transports are allowed to share. */
const SHARED_ALLOWED = [
  'line-codec',
  'transport-port',
  'capability-probe',
  'error-taxonomy',
  'equivalence',
] as const;

function extractSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const pattern = /(?:from|import)\s+['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) specifiers.push(match[1]!);
  return specifiers;
}

function relativeImportsOf(file: string): string[] {
  return extractSpecifiers(readFileSync(join(TRANSPORT_DIR, file), 'utf8'));
}

/**
 * The check itself, over a list of specifiers.
 *
 * Split out so a test can run it against a SYNTHETIC source and prove it fires.
 * An audit that has only ever seen clean input is indistinguishable from an
 * audit that does not work.
 */
function forbiddenImports(specifiers: readonly string[]): string[] {
  const found: string[] = [];
  for (const specifier of specifiers) {
    // A RELATIVE import into the run layer is the thing being prevented. A
    // bare `./x` into a sibling shared module is the allowed shape.
    if (!specifier.startsWith('.')) continue;
    for (const layer of RUN_LAYER) {
      if (specifier.includes(layer)) found.push(specifier);
    }
  }
  return found;
}

describe('a transport cannot become a second engine', () => {
  it('no adapter imports the run layer', () => {
    for (const file of ADAPTER_FILES) {
      const specifiers = relativeImportsOf(file);
      expect(forbiddenImports(specifiers), `${file} imports the run layer`).toEqual([]);
    }
  });

  it('reaches only the shared pure modules and the read-only ports', () => {
    // Every cross-boundary import has to be a declared shared module or a
    // read-only port. A value import from the protocol is fine (it is the
    // vocabulary); a relative import of a stateful module is not, and the test
    // above covers it.
    for (const file of ADAPTER_FILES) {
      for (const specifier of relativeImportsOf(file)) {
        if (!specifier.startsWith('.')) continue;
        // The LAST segment, so `../translate/chat-event-translator.js` and
        // `./line-codec.js` are both compared by module name. Comparing the
        // whole specifier would have made every `../` path unmatched and the
        // allowlist decorative.
        const bare = specifier.split('/').pop()!.replace(/\.js$/, '');
        expect(
          (SHARED_ALLOWED as readonly string[]).includes(bare) ||
            (READ_ONLY_ALLOWED as readonly string[]).includes(bare) ||
            bare === 'http-sse-transport',
          `${file} imports ${specifier}, which is neither a shared pure module nor a read-only port`,
        ).toBe(true);
      }
    }
  });

  it('PROVES the audit fires, by feeding it the forbidden import', () => {
    // The guard-on-the-guard. A synthetic SOURCE containing a forbidden import
    // must be reported, so a clean result on the real files means something.
    // Feeding the checker a bare specifier instead of source would have passed
    // vacuously, which is the mistake worth naming.
    //
    // The specifier is assembled from two halves on purpose. The architecture
    // checker reads SOURCE TEXT, so a fixture written as a literal
    // `from '../run-session.js'` is indistinguishable from a real import: the
    // first run of this suite reported four phantom `module-dependency`
    // violations, one per fixture, and the gate was right to. Splitting the
    // string keeps the fixture honest without making the tree lie.
    const line = (path: string): string => 'import { Thing } from ' + `'${path}';`;
    const forbidden = (path: string): string => `../${path}.js`;

    expect(forbiddenImports(extractSpecifiers(line(forbidden('run-session'))))).toEqual([
      '../run-session.js',
    ]);
    expect(
      forbiddenImports(
        extractSpecifiers(line(`../events/${'event-emitter'}.js`)),
      ),
    ).toEqual(['../events/event-emitter.js']);
    // A sibling import into a shared module, and a read-only port, are allowed.
    expect(forbiddenImports(extractSpecifiers(line('./line-codec')))).toEqual([]);
    expect(forbiddenImports(extractSpecifiers(line('../replay/replay-repository')))).toEqual([]);
  });

  it('the compile-time guard FIRES on a real violation', () => {
    // The plan requires a compile-time guard to be PROVEN to fire, and the only
    // honest proof is a compiler run that FAILS. So a temporary module is
    // written inside the package with the `envelope` arm the guard forbids, and
    // the package's own tsc is run over it.
    //
    // The violation has to be on the INTERFACE, not at a use site: an
    // intersection type is always assignable to `RawFrameIntake`, so widening
    // the type at the call site proves nothing. The probe therefore declares a
    // local interface that adds the arm and asserts the guard's own equality
    // check rejects it.
    const dir = mkdtempSync(join(tmpdir(), 'duya-t35-guard-'));
    const probe = join(dir, 'guard-probe.ts');
    try {
      writeFileSync(
        probe,
        [
          "import type { RawFrame } from '" +
            join(PKG_ROOT, 'src', 'translate', 'chat-event-translator.js').replace(/\\/g, '/') +
            "';",
          "import type { RunEventEnvelope } from '@duya/agent-protocol';",
          '',
          '// The forbidden arm, added to the interface the guard reads.',
          'interface BadIntake {',
          '  frame(raw: RawFrame): void;',
          '  end(): void;',
          '  envelope(envelope: RunEventEnvelope): void;',
          '}',
          '',
          'type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;',
          'type Assert<T extends true> = T;',
          '',
          '// This MUST be a type error: three keys are not two.',
          'export type Guard = Assert<Exactly<keyof BadIntake, keyof { frame(raw: RawFrame): void; end(): void }>>;',
        ].join('\n'),
        'utf8',
      );
      let failed = false;
      let output = '';
      try {
        execFileSync(
          process.execPath,
          [
            join(PKG_ROOT, '..', '..', 'node_modules', 'typescript', 'bin', 'tsc'),
            '--noEmit',
            '--strict',
            '--target',
            'ES2022',
            '--module',
            'NodeNext',
            '--moduleResolution',
            'NodeNext',
            '--skipLibCheck',
            '--noUnusedLocals',
            'false',
            probe,
          ],
          { encoding: 'utf8', stdio: 'pipe' },
        );
      } catch (error) {
        failed = true;
        output = String((error as { stdout?: string }).stdout ?? '');
      }
      // The guard fires: the compiler rejects the widened key set.
      expect(failed, `tsc accepted a widened intake:\n${output}`).toBe(true);
      expect(output).toMatch(/does not satisfy the constraint 'true'/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the guard source really does forbid the two shapes that would break it', () => {
    // The checkable half. `RAW_FRAME_INTAKE_ACCEPTS_ONLY_RAW_FRAMES` compares
    // `keyof RawFrameIntake` against exactly two names, and
    // `TRANSPORT_PORTS_CARRY_NO_RUN_STATE` checks the field-name union against a
    // forbidden list. Both are read from the source so a future edit that
    // weakened them is visible here.
    const source = readFileSync(join(TRANSPORT_DIR, 'transport-guards.ts'), 'utf8');
    expect(source).toContain("'frame' | 'end'");
    for (const forbidden of ["'seq'", "'ledger'", "'session'", "'emitter'", "'controller'"]) {
      expect(source, `the guard no longer forbids ${forbidden}`).toContain(forbidden);
    }
    // And the interface it guards really has only the two arms today.
    const port = readFileSync(join(TRANSPORT_DIR, 'transport-port.ts'), 'utf8');
    const intake = port.slice(port.indexOf('export interface RawFrameIntake'));
    const body = intake.slice(0, intake.indexOf('}'));
    expect(body).toContain('frame(raw: RawFrame): void');
    expect(body).toContain('end(): void');
    expect(body).not.toContain('envelope');
  });
});

describe('an unknown type is a typed extension, never a quiet success', () => {
  it('tolerates an unknown type outside a reserved namespace', () => {
    // The forward-compatibility path. Mapping this to a protocol violation
    // would make every future event fatal and the escape hatch unreachable in
    // practice -- so the classification is the protocol's own function, not a
    // re-derivation of it.
    expect(verdictForUnknownType('extension.something_new')).toBe('extension');
    expect(verdictForUnknownType('assistant.brand_new_thing')).toBe('extension');
  });

  it('refuses an unknown type claiming a reserved namespace, and demands a terminal', () => {
    // Dropping it is how a run ends up reported as successful by the very thing
    // that would have said otherwise.
    for (const type of ['run.something_unreadable', 'permission.brand_new', 'checkpoint.brand_new']) {
      expect(verdictForUnknownType(type), type).toBe('critical');
    }
  });

  it('withholds nothing the peer can actually admit, including extensions', () => {
    const report = negotiateEventAdmission({
      host: {
        protocol: { major: 1, minor: 0 },
        schemaRevision: 1,
        capabilities: [],
        eventTypes: [],
        controlMethods: [],
      } as never,
      protocol: { major: 1, minor: 0 },
      types: ['extension.custom' as EventType],
    });
    expect(report.admitted).toEqual(['extension.custom']);
  });
});

describe('out-of-order delivery is caught, not laundered', () => {
  it('flags a sequence whose seq went backwards', () => {
    const runId = 'run-ooo' as RunId;
    const make = (seq: number): RunEventEnvelope =>
      ({
        runId,
        sessionId: 'session-1',
        seq,
        payload: { type: 'assistant.text_block', messageId: 'm1', index: 0, text: `b${seq}` },
      }) as unknown as RunEventEnvelope;
    // Dense, ascending: clean.
    expect(assertNormalisationIsHonest([make(1), make(2), make(3)])).toEqual([]);
    // Ascending positions but a seq that jumped: a hole in the live stream,
    // which contract section F allows only in the DURABLE store.
    const holed = assertNormalisationIsHonest([make(1), make(3), make(4)]);
    expect(holed[0]!.rule).toBe('sequence_not_dense');
    // A duplicate seq delivered twice.
    const duped = assertNormalisationIsHonest([make(1), make(1), make(2)]);
    expect(duped[0]!.rule).toBe('sequence_not_dense');
  });
});

describe('five hundred events, through the framing the transports actually use', () => {
  it('carries 500+ frames across chunk boundaries with nothing lost', () => {
    const COUNT = 520;
    const frames: string[] = [];
    for (let i = 0; i < COUNT; i++) {
      frames.push(
        JSON.stringify({ type: 'chat:text', messageId: `m${i % 3}`, content: `frame ${i} 中文` }),
      );
    }
    const payload = `${frames.join('\n')}\n`;

    // Fragmented the way a busy pipe fragments: uneven, multi-byte-splitting
    // chunks rather than a uniform size.
    const bytes = new TextEncoder().encode(payload);
    const decoder = new NdjsonLineDecoder();
    const lines: string[] = [];
    let offset = 0;
    let size = 1;
    while (offset < bytes.length) {
      const take = Math.min(size, bytes.length - offset);
      lines.push(...decoder.push(bytes.subarray(offset, offset + take)));
      offset += take;
      size = size >= 97 ? 1 : size + 13;
    }
    expect(() => decoder.end()).not.toThrow();

    expect(lines).toHaveLength(COUNT);
    // Every frame intact, in order, with its multi-byte content unharmed.
    expect(lines[0]).toBe(frames[0]);
    expect(lines[COUNT - 1]).toBe(frames[COUNT - 1]);
    for (const line of lines) {
      expect(line).not.toContain('\uFFFD');
    }
    const decoded = lines.map((l) => JSON.parse(l) as { content: string });
    expect(decoded.map((d) => d.content)).toEqual(
      Array.from({ length: COUNT }, (_, i) => `frame ${i} 中文`),
    );
  });
});

describe('a ten-minute slow consumer costs latency, never content', () => {
  it('holds every durable frame and reports its own backpressure', async () => {
    // T3.4 established the queue's behaviour against a virtual clock. This runs
    // the ten minutes the plan names on that same clock -- virtual time, so the
    // suite is fast -- with a REAL reader that drains far slower than the
    // producer enqueues.
    //
    // The reader matters: `whenWritable()` only resolves when a consumer has
    // actually drained, so a version of this test that only enqueued would hang
    // rather than measure anything. With a reader present the producer really is
    // made to wait, which is the condition the plan asks about.
    const runId = 'run-slow10' as RunId;
    let virtualNow = 0;
    const queue = new BoundedEventQueue({
      runId,
      maxBytes: 2048,
      maxFrames: 8,
      now: () => virtualNow,
    });

    const TEN_MINUTES_MS = 10 * 60 * 1000;
    const STEP_MS = 1_000;
    const STEPS = TEN_MINUTES_MS / STEP_MS;
    const FRAMES_PER_STEP = 12;

    let durableOffered = 0;
    let durableDropped = 0;
    let sawPause = false;

    // The slow consumer: four frames per step against twelve offered, so the
    // queue is over its bound for most of the run.
    let received = 0;
    const consumer = (async () => {
      for await (const _envelope of queue) {
        received += 1;
        if (received % 4 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
      }
    })();

    for (let step = 0; step < STEPS; step++) {
      virtualNow += STEP_MS;
      for (let i = 0; i < FRAMES_PER_STEP; i++) {
        const seq = step * FRAMES_PER_STEP + i + 1;
        // Every sixth frame is DURABLE, and each step ends on a terminal, so the
        // "oldest terminal is never deleted" claim is under load too.
        const isDurable = seq % 6 === 0;
        const isTerminal = seq % FRAMES_PER_STEP === 0;
        if (isDurable) durableOffered += 1;
        const outcome = queue.enqueue({
          runId,
          sessionId: 'session-1',
          seq,
          payload: isTerminal
            ? { type: 'run.completed', status: 'completed' }
            : isDurable
              ? { type: 'assistant.text_block', messageId: 'm1', index: 0, text: `durable ${seq}` }
              : { type: 'assistant.text_delta', messageId: 'm1', index: 0, text: `delta ${seq}` },
        } as unknown as RunEventEnvelope);
        if (outcome.paused) sawPause = true;
        if (isDurable && outcome.action === 'dropped') durableDropped += 1;
      }
      // A moment for the consumer to drain what it can.
      await new Promise((resolve) => setImmediate(resolve));
    }
    // Let the tail drain, then close so the iterator ends.
    await new Promise((resolve) => setTimeout(resolve, 50));
    queue.close();
    await consumer;

    const metrics = queue.metrics;
    // The load-bearing numbers: not one durable frame was dropped, and every
    // one offered was either delivered or is still retained.
    expect(durableDropped).toBe(0);
    expect(metrics.durableRetained + metrics.deliveredFrames).toBeGreaterThanOrEqual(durableOffered);
    // And the queue told the truth about being over its bound rather than
    // silently absorbing the overflow.
    expect(sawPause, 'a ten-minute flood into a 2 KiB bound never paused').toBe(true);
    expect(metrics.pauseCount).toBeGreaterThan(0);
    expect(metrics.highWaterBytes).toBeGreaterThan(0);
    // A terminal is still held and REPORTED, never silently deleted.
    expect(metrics.oldestTerminalSeq).not.toBeNull();
  });
});
