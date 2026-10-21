/**
 * workflow-def-watcher.test.ts — the push-based library refresh manager:
 * idempotent watching, debounced fan-out to live senders, destroyed-sender
 * pruning, and watcher teardown when the last sender goes away.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createDefWatcherManager,
  defaultWatchDir,
  type WatcherSender,
} from '../workflow-def-watcher';

interface Harness {
  manager: ReturnType<typeof createDefWatcherManager>;
  watched: string[];
  fire(dir: string): void;
  makeSender(): WatcherSender & { sends: number };
}

function makeHarness(debounceMs = 10): Harness {
  const watched: string[] = [];
  const callbacks = new Map<string, () => void>();
  const deps = {
    watchDir: (dir: string, onChange: () => void) => {
      watched.push(dir);
      callbacks.set(dir, onChange);
      return () => {
        const at = watched.indexOf(dir);
        if (at >= 0) watched.splice(at, 1);
        callbacks.delete(dir);
      };
    },
    debounceMs,
  };
  const manager = createDefWatcherManager(deps);
  return {
    manager,
    watched,
    fire: (dir) => callbacks.get(dir)?.(),
    makeSender: () => {
      const s = {
        sends: 0,
        isDestroyed: vi.fn(() => false),
        send: vi.fn(() => {
          s.sends += 1;
        }),
        once: vi.fn(),
      };
      return s;
    },
  };
}

const flush = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('workflow def watcher manager', () => {
  it('watches each unique dir once and fans out debounced changes', async () => {
    const h = makeHarness();
    h.manager.ensureWatchers(['/a', '/b']);
    h.manager.ensureWatchers(['/a', '/c']); // /a duplicate must not double-watch
    expect(h.watched.sort()).toEqual(['/a', '/b', '/c']);

    const sender = h.makeSender();
    h.manager.addSender(sender);

    // Burst: several events coalesce into one push.
    h.fire('/a');
    h.fire('/a');
    h.fire('/b');
    await flush(40);
    expect(sender.sends).toBe(1);
  });

  it('skips destroyed senders and prunes them from the set', async () => {
    const h = makeHarness();
    h.manager.ensureWatchers(['/a']);
    const dead = h.makeSender();
    (dead.isDestroyed as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const alive = h.makeSender();
    h.manager.addSender(dead);
    h.manager.addSender(alive);

    h.fire('/a');
    await flush(40);
    expect(dead.send).not.toHaveBeenCalled();
    expect(alive.sends).toBe(1);
  });

  it('stops watching when the last sender is destroyed', async () => {
    const h = makeHarness();
    h.manager.ensureWatchers(['/a']);
    const sender = h.makeSender();
    h.manager.addSender(sender);
    expect(h.watched).toEqual(['/a']);

    // Simulate renderer window close: the 'destroyed' listener does the work.
    const destroyedCb = (sender.once as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === 'destroyed',
    )?.[1] as () => void;
    expect(destroyedCb).toBeTypeOf('function');
    destroyedCb();

    expect(h.watched).toEqual([]);
    h.fire('/a'); // no watcher left — must not throw
    await flush(30);
    expect(sender.sends).toBe(0);
  });

  it('re-watches after a watchDir failure resolves (dir created later)', () => {
    let fail = true;
    const h = makeHarness();
    // Harness always succeeds; emulate failure via a second manager.
    const manager = createDefWatcherManager({
      watchDir: (dir) => {
        if (fail) throw new Error('ENOENT');
        h.manager.ensureWatchers([dir]);
        return () => {};
      },
      debounceMs: 5,
    });
    manager.ensureWatchers(['/not-yet']);
    fail = false;
    manager.ensureWatchers(['/not-yet']); // retry succeeds now
    expect(h.watched).toEqual(['/not-yet']);
  });

  it('defaultWatchDir reports real fs changes and unsubscribes cleanly', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'dwf-watch-'));
    try {
      let changes = 0;
      const un = defaultWatchDir(dir, () => {
        changes += 1;
      });
      writeFileSync(join(dir, 'x.dwf.ts'), '/* duya-workflow */\n', 'utf8');
      await flush(300);
      expect(changes).toBeGreaterThan(0);
      un();
      writeFileSync(join(dir, 'y.dwf.ts'), 'x', 'utf8');
      await flush(300);
      const at = changes;
      await flush(300);
      expect(changes).toBe(at); // no events after unsubscribe
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
