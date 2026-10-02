// IPC contract gate (plan 583, ISS-06 / ISS-24).
//
// The renderer↔main channel contract is hand-maintained in two places with
// nothing checking they agree. Four fully implemented features were
// unreachable because `db-handlers.ts` registered `session:forkAt`,
// `rollout:reconcile` and `rollout:import` without the `db:` prefix the
// preload invokes, and eight more channels were exposed on the bridge with
// no handler at all. Every one of those failures is silent at runtime: the
// renderer gets a rejected promise and moves on.
//
// This test pins the invariant so the class cannot come back. It re-derives
// the census from source rather than trusting a stored list, and it covers
// all three registration mechanisms:
//
//   1. `ipcMain.handle('ch', ...)`
//   2. the lazy IpcRegistrar sink, `register('ch', ...)` inside a module
//      loaded by `registerLazyIpcHandlers`
//   3. the `channels: [...]` allowlist of a lazy group — `lazy-ipc-registry`
//      only forwards a handler whose channel appears in that list, so a
//      handler registered under a name missing from it is silently dropped
//
// If this test ever needs updating, fix the contract first. Adding a channel
// to the ignore list is only correct when the renderer genuinely calls it
// through a different transport, and that reasoning belongs in a comment.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

// This file lives at electron/ipc/__tests__/, so the repo root is three
// levels up.
const repoRoot = resolve(__dirname, '../../..');

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      out.push(...tsFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out;
}

const REGISTER = /ipcMain\.handle\(\s*[`'"]?([A-Za-z0-9:_-]+)[`'"]?/g;
const LAZY_REGISTER = /(?<![.\w])register\(\s*[`'"]([A-Za-z0-9:_-]+)[`'"]/g;
const LAZY_GROUP = /registerLazyIpcHandlers\(\s*\{[\s\S]*?channels:\s*\[([\s\S]*?)\]/g;
const QUOTED = /[`'"]([A-Za-z0-9:_-]+)[`'"]/g;
const INVOKE = /\.invoke\(\s*[`'"]([A-Za-z0-9:_-]+)[`'"]/g;
const LISTEN = /\.on\(\s*[`'"]([A-Za-z0-9:_-]+)[`'"]/g;

function collect(): { registered: Set<string>; invoked: Set<string>; listened: Set<string> } {
  const registered = new Set<string>();

  for (const file of tsFiles(join(repoRoot, 'electron'))) {
    const text = readFileSync(file, 'utf8');
    let m: RegExpExecArray | null;

    REGISTER.lastIndex = 0;
    while ((m = REGISTER.exec(text)) !== null) registered.add(m[1]);

    LAZY_REGISTER.lastIndex = 0;
    while ((m = LAZY_REGISTER.exec(text)) !== null) registered.add(m[1]);

    LAZY_GROUP.lastIndex = 0;
    while ((m = LAZY_GROUP.exec(text)) !== null) {
      QUOTED.lastIndex = 0;
      let q: RegExpExecArray | null;
      while ((q = QUOTED.exec(m[1])) !== null) registered.add(q[1]);
    }
  }

  const preload = readFileSync(join(repoRoot, 'electron/preload.ts'), 'utf8');
  const invoked = new Set<string>();
  const listened = new Set<string>();

  let m: RegExpExecArray | null;
  INVOKE.lastIndex = 0;
  while ((m = INVOKE.exec(preload)) !== null) invoked.add(m[1]);

  LISTEN.lastIndex = 0;
  while ((m = LISTEN.exec(preload)) !== null) listened.add(m[1]);

  return { registered, invoked, listened };
}

const { registered, invoked } = collect();
const unreachable = [...invoked].filter((ch) => !registered.has(ch)).sort();

describe('IPC contract: every channel the renderer can reach has a handler', () => {
  it('registers no channel as reachable-but-unhandled', () => {
    expect(
      unreachable,
      `These channels are exposed through contextBridge and invoked by the renderer, ` +
        `but no main-process handler registers them (checked ipcMain.handle, the lazy ` +
        `IpcRegistrar sink, and each lazy group's channels allowlist). Every call ` +
        `rejects at runtime:\n  ${unreachable.join('\n  ')}`,
    ).toEqual([]);
  });

  it('still covers a meaningful number of channels (census is not silently empty)', () => {
    // Guards against the census itself rotting — e.g. a regex change that
    // matches nothing would make the assertion above pass vacuously.
    expect(registered.size).toBeGreaterThan(300);
    expect(invoked.size).toBeGreaterThan(300);
  });

  it('registers every db: channel the preload invokes', () => {
    // The specific ISS-06 shape: a handler registered under a name that
    // differs from the invoked name only by its `db:` prefix.
    const missing = [...invoked]
      .filter((ch) => ch.startsWith('db:'))
      .filter((ch) => !registered.has(ch))
      .sort();
    expect(missing).toEqual([]);
  });
});

describe('IPC contract: no mutating Git control is exposed to the renderer', () => {
  // AGENTS.md "Code Review Workspace": the review surface is read-only and
  // must never offer stage / commit / push / reset. These were previously
  // exposed on the bridge with no handler; even with no handler today, a
  // future one must not become reachable from the renderer by accident.
  const forbidden = ['git:stage', 'git:commit', 'git:push', 'git:reset', 'git:switch-branch', 'git:create-branch'];

  it('does not expose any of them', () => {
    const exposed = forbidden.filter((ch) => invoked.has(ch));
    expect(exposed).toEqual([]);
  });
});
