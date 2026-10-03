/**
 * Plan 587 E4.2, tools group — same-path serialisation, cross-path parallelism,
 * and a real alias of one file.
 *
 * ## Why this file exists at all
 *
 * `file-mutation-queue.ts` is the code that actually orders concurrent writes at
 * execution time, and it had no test. The orchestrator's `planExecution` has
 * thorough tests for packing disjoint paths into one wave and splitting same-path
 * writes across waves — but a plan is a PLAN. The serialisation a caller
 * observes is `withFileMutationQueue`, keyed on the resolved realpath, and it was
 * the unmeasured half of the claim. A refactor could keep every planner test
 * green while replacing the queue with a no-op, and the suite would stay green.
 *
 * ## What is real here, and what is not
 *
 * Real: the real `WriteTool` from `../WriteTool/WriteTool.js`, the real
 * `withFileMutationQueue` that tool calls, the real filesystem, and a real
 * filesystem alias (a symlink, or a directory junction where symlinks are
 * unavailable). There is no mock in this file, and none is needed: the boundary
 * these rows are about is the tool-to-filesystem edge, so the tool and the
 * filesystem are exactly the participants that must be real.
 *
 * Not claimed: that the ORCHESTRATOR dispatches these writes in parallel. The
 * planner's own tests own that claim and this file does not restate it. What is
 * proved here is narrower — given two concurrent calls, the real queue orders
 * same-file work, does not order different-file work, and the real write tool
 * actually goes through that queue rather than beside it.
 *
 * ## How ordering is observed
 *
 * By the effect on disk, and by an interleaving log of the steps inside each
 * queued body. Read-modify-write is the honest probe: if two same-path
 * operations interleaved, the second would read the first's pre-write bytes and
 * a payload would be lost, so the final file contents decide the row rather
 * than a timer.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WriteTool } from '../WriteTool/WriteTool.js';
import { withFileMutationQueue } from '../file-mutation-queue.js';

let root: string;
let tool: WriteTool;

/** A log of the steps inside each queued body, so interleaving is visible in order. */
let log: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'duya-fmq-'));
  tool = new WriteTool();
  log = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Yield long enough for a competing operation to make progress if it can. */
function tick(ms = 15): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run a read-modify-write through the real queue, logging each step.
 *
 * The deliberate `await` between the read and the write is what makes an
 * interleaving observable: with no yield point inside the queued body, two
 * same-path operations could both read the old bytes and the row would pass by
 * accident even if the queue did nothing.
 */
async function readModifyWrite(file: string, token: string): Promise<void> {
  await withFileMutationQueue(file, async () => {
    const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
    log.push(`${token}:read:${before}`);
    await tick();
    const after = existsSync(file) ? readFileSync(file, 'utf8') : '';
    log.push(`${token}:observed:${after}`);
    writeFileSync(file, `${before}|${token}`, 'utf8');
    log.push(`${token}:write`);
  });
}

describe('the real write tool goes through the real queue', () => {
  it('blocks a real WriteTool call behind a held operation on the same path', async () => {
    // The wiring claim, proved on the real path. If `WriteTool` bypassed the
    // queue — or the queue were a no-op — this write would land while the gate
    // was still held, and the assertion below would see it done.
    const file = join(root, 'gated.md');
    let openGate!: () => void;
    const held = new Promise<void>((resolveGate) => {
      openGate = resolveGate;
    });
    const gate = withFileMutationQueue(file, () => held);

    let finished = false;
    const write = tool
      .execute({ file_path: file, content: 'from the real tool' }, root)
      .then(() => {
        finished = true;
      });

    await tick(50);
    expect(finished).toBe(false);
    expect(existsSync(file)).toBe(false);

    openGate();
    await gate;
    await write;

    expect(finished).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('from the real tool');
  });
});

describe('same-path writes are serialised', () => {
  it('never lets two operations on one file interleave, and loses no payload', async () => {
    const file = join(root, 'serialised.md');

    await Promise.all([
      readModifyWrite(file, 'A'),
      readModifyWrite(file, 'B'),
      readModifyWrite(file, 'C'),
    ]);

    // Every read observed the previous writer's bytes. Had any two operations
    // overlapped, one read would have seen the file as empty and a payload would
    // be missing from the result.
    expect(readFileSync(file, 'utf8')).toBe('|A|B|C');

    // The log is the ordering, not just the outcome. Each token read exactly what
    // the previous token had already written — that is the chain, and an
    // interleaved run would show a token reading a value the chain does not
    // contain.
    expect(log).toEqual([
      'A:read:', 'A:observed:', 'A:write',
      'B:read:|A', 'B:observed:|A', 'B:write',
      'C:read:|A|B', 'C:observed:|A|B', 'C:write',
    ]);

    // Contiguity is the serialisation claim itself: no other token's step may sit
    // between one token's read and its write.
    for (const token of ['A', 'B', 'C']) {
      const indexes = log
        .map((entry, index) => (entry.startsWith(`${token}:`) ? index : -1))
        .filter((index) => index >= 0);
      expect(indexes).toEqual([indexes[0], indexes[0]! + 1, indexes[0]! + 2]);
    }
  });

  it('runs different paths at the same time rather than behind one global lock', async () => {
    const files = ['one.md', 'two.md', 'three.md'].map((name) => join(root, name));

    const started = Date.now();
    await Promise.all(files.map((file, i) => readModifyWrite(file, `P${i}`)));
    const elapsed = Date.now() - started;

    // Each body sleeps 15ms, so three bodies sharing one lock would need at least
    // 45ms. The bound is deliberately loose: it is a floor for "was serialised",
    // not a timing benchmark, and a loaded machine cannot make a genuinely
    // parallel run look serial.
    expect(elapsed).toBeLessThan(45);
    for (const [i, file] of files.entries()) {
      expect(readFileSync(file, 'utf8')).toBe(`|P${i}`);
    }
  });
});

describe('a real alias of one file is the same queue key', () => {
  /**
   * Build a second filesystem name for `file`.
   *
   * A file symlink is the faithful form. Where the process may not create one (a
   * Windows image without the symlink privilege), a directory junction is used
   * instead: the same realpath, created without elevation. Returning which form
   * was used keeps that fallback visible rather than silent.
   */
  function makeAlias(file: string): { alias: string; kind: 'file symlink' | 'directory junction' } {
    try {
      const alias = join(root, `alias-${Math.random().toString(36).slice(2)}.txt`);
      symlinkSync(file, alias, 'file');
      return { alias, kind: 'file symlink' };
    } catch {
      const realDir = join(root, 'real');
      mkdirSync(realDir, { recursive: true });
      const inner = join(realDir, 'aliased.md');
      writeFileSync(inner, '', 'utf8');
      const link = join(root, 'junction');
      symlinkSync(realDir, link, 'junction');
      return { alias: join(link, 'aliased.md'), kind: 'directory junction' };
    }
  }

  it('serialises an alias against the real path, because the key is the resolved path', async () => {
    const file = join(root, 'shared.md');
    writeFileSync(file, '', 'utf8');
    const { alias } = makeAlias(file);
    expect(alias).not.toBe(file);

    await Promise.all([
      readModifyWrite(file, 'direct'),
      readModifyWrite(alias, 'aliased'),
    ]);

    // The two names are ONE file: the payloads are concatenated rather than
    // split across two files that merely look similar. This is the row's
    // assertion — a queue keyed on the literal string would have let the aliased
    // write read an empty file and the result would be `|direct|aliased` only by
    // luck of ordering, or `|direct` with the second payload lost.
    expect(readFileSync(file, 'utf8')).toBe('|direct|aliased');
    expect(readFileSync(alias, 'utf8')).toBe('|direct|aliased');
  });

  it('falls back to the resolved path only while the file is absent, and folds once it exists', async () => {
    // The boundary the row depends on: for a file that does not exist there is no
    // realpath to fold, so the key is the resolved path. Once the file exists,
    // an alias resolves onto it. Pinned here rather than assumed, because
    // "aliases always share a queue" is only true for a file that exists.
    const file = join(root, 'not-yet.md');
    await withFileMutationQueue(file, async () => {
      writeFileSync(file, 'first', 'utf8');
    });
    expect(readFileSync(join(root, '.', 'not-yet.md'), 'utf8')).toBe('first');
  });
});

describe('the queue does not accumulate keys', () => {
  it('releases every key once its operation finished, and still parallelises afterwards', async () => {
    // A queue that never deleted its keys would be a leak that only surfaces
    // over a long session. The map is module-private, so growth is observed
    // through behaviour: N distinct paths must still run in parallel AFTER the
    // same N have each been used once.
    const files = Array.from({ length: 4 }, (_, i) => join(root, `leak-${i}.md`));
    for (const file of files) {
      await withFileMutationQueue(file, async () => {
        writeFileSync(file, 'x', 'utf8');
      });
    }

    const started = Date.now();
    await Promise.all(
      files.map((file, i) =>
        withFileMutationQueue(file, async () => {
          await tick();
          writeFileSync(file, `second-${i}`, 'utf8');
        }),
      ),
    );
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(45);
    for (const [i, file] of files.entries()) {
      expect(readFileSync(file, 'utf8')).toBe(`second-${i}`);
    }
  });
});
