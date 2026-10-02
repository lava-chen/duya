/**
 * ipc-channel-contract.test.ts — every channel the renderer invokes must exist.
 *
 * `preload.ts` is the only place a renderer's `ipcRenderer.invoke(...)` calls
 * are written, and `ipcMain.handle(...)` is the only place they are answered.
 * Nothing in TypeScript ties the two together: a channel name is just a string
 * on each side, so a rename on one side silently strands the other. The call
 * then rejects at runtime with `No handler registered for '<channel>'`.
 *
 * This has now happened four times, and every instance is invisible to the
 * existing gates:
 *
 *   - `db:session:unarchive` — fixed in 59ede12d (Plan 582, PR #80)
 *   - `db:session:forkAt`    — fixed in this change
 *   - `db:rollout:import`    — fixed in this change
 *   - `db:rollout:reconcile` — fixed in this change
 *
 * All four were caught by hand or by an E2E, never by a gate, because
 * `apps/desktop/tsconfig.main.json` is referenced by no npm script and no test compared
 * the two sides. This file is that comparison. It reads the source as text, so
 * it runs in the fast unit layer with no Electron process.
 *
 * Registration is not always a literal `ipcMain.handle`: `main.ts` also
 * declares lazy groups whose `channels` array is the authoritative list, and
 * the group's loader calls `register(...)` on a later invoke. Both forms are
 * collected here so the lazy groups do not read as missing.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// This file lives at apps/desktop/src/main/ipc/__tests__/, so the repo root is
// six levels up. Every path below MUST be re-derived if the app layout moves —
// a wrong root makes `electronSources()` return an empty array and the whole
// contract check passes vacuously instead of failing.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..', '..');
const DESKTOP_SRC = path.join(REPO_ROOT, 'apps/desktop/src');
const ELECTRON_DIR = path.join(DESKTOP_SRC, 'main');
const PRELOAD_PATH = path.join(DESKTOP_SRC, 'preload', 'index.ts');
const MAIN_PATH = path.join(ELECTRON_DIR, 'index.ts');
const SRC_DIR = path.join(DESKTOP_SRC, 'renderer');

/**
 * Channels the preload exposes that intentionally have no `ipcMain.handle`.
 *
 * Every entry is dead surface: the third test below fails if a caller appears,
 * so this list cannot quietly become a bug. It exists so a future reader can
 * tell "known and deliberate" apart from "unknown and broken" — the exact
 * confusion that let the four strandings above go unnoticed for months.
 */
const UNREGISTERED_BY_DESIGN: Record<string, string> = {
  // Both legacy pre-HTTP+SSE agent bindings (`agent:stream`,
  // `agent:interrupt`) were removed from the preload outright (plan 583
  // ISS-24) when the agent moved to the agent server, so neither belongs
  // here any more — the third test below fails on a stale entry.
  //
  // The four mutating `git:*` bindings used to sit here as exposed-but-
  // unhandled surface. They are gone too: the bridge no longer offers them
  // at all, which is a stronger expression of the AGENTS.md rule that the
  // Code Review Workspace is read-only and must never stage, commit, push
  // or switch branches. `ipc-contract.test.ts` now asserts their absence
  // directly, so a future re-introduction fails there rather than needing
  // an allowlist entry.
};

/** All `.ts` files under the Electron main process, minus tests and build output. */
function electronSources(dir = ELECTRON_DIR, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!/node_modules|bundle|__tests__|dist-electron/.test(full)) electronSources(full, acc);
    } else if (full.endsWith('.ts') && !full.includes('__tests__')) {
      acc.push(full);
    }
  }
  return acc;
}

/** Every channel a `ipcMain.handle('...')` call in the main process answers. */
function collectRegisteredChannels(): Map<string, string> {
  const registered = new Map<string, string>();
  for (const file of electronSources()) {
    const source = fs.readFileSync(file, 'utf8');
    for (const m of source.matchAll(/ipcMain\.handle\(\s*['"]([^'"]+)['"]/g)) {
      if (!registered.has(m[1])) registered.set(m[1], path.relative(ELECTRON_DIR, file));
    }
  }
  // Lazy groups: `main.ts` lists their channels up front and loads the real
  // implementation on first invoke, so there is no `ipcMain.handle` to find.
  const main = fs.readFileSync(MAIN_PATH, 'utf8');
  for (const group of main.matchAll(/channels:\s*\[([^\]]*)\]/g)) {
    for (const m of group[1].matchAll(/['"]([^'"]+)['"]/g)) {
      if (!registered.has(m[1])) registered.set(m[1], 'main.ts (lazy group)');
    }
  }
  return registered;
}

/** Renderer sources, as one blob. */
function rendererSources(): string {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(full)) files.push(full);
    }
  };
  walk(SRC_DIR);
  return files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
}

/**
 * Channel -> the preload method names that invoke it.
 *
 * The renderer never sees channel strings; it calls `window.electronAPI.<ns>.<method>()`.
 * So "is this dead binding really uncalled?" has to be answered at the method
 * level, which means resolving each invoke back to the property it sits under.
 */
function collectChannelMethods(): Map<string, string[]> {
  const preload = fs.readFileSync(PRELOAD_PATH, 'utf8');
  const byChannel = new Map<string, string[]>();
  // `name: (…) => ipcRenderer.invoke('channel'` and the same split across lines.
  const re = /(\w+)\s*:\s*(?:async\s*)?\([^)]*\)\s*=>\s*ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(preload))) {
    const [, method, channel] = m;
    const list = byChannel.get(channel) ?? [];
    list.push(method);
    byChannel.set(channel, list);
  }
  return byChannel;
}

describe('IPC channel contract', () => {
  const registered = collectRegisteredChannels();
  const preload = fs.readFileSync(PRELOAD_PATH, 'utf8');
  const invoked = [...preload.matchAll(/ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g)].map(
    (m) => m[1],
  );

  it('parses both sides of the bridge', () => {
    // Guards the parsers themselves: a bad path or a regex that stops
    // matching would make the assertion below pass vacuously.
    expect(registered.size).toBeGreaterThan(100);
    expect(invoked.length).toBeGreaterThan(100);
  });

  it('every channel preload invokes has a registered handler', () => {
    const stranded = invoked
      .filter((c) => !registered.has(c) && !(c in UNREGISTERED_BY_DESIGN))
      .sort();

    expect(
      stranded,
      stranded.length
        ? `preload.ts invokes these channels but nothing registers a handler for them, so ` +
            `each call rejects at runtime with "No handler registered". Either the handler ` +
            `was renamed (check the "db:" prefix — every handler in db-handlers.ts is ` +
            `namespaced) or the binding is dead and should be deleted. If the absence is ` +
            `deliberate, add it to UNREGISTERED_BY_DESIGN with a reason. Offenders: ${stranded.join(', ')}`
        : '',
    ).toEqual([]);
  });

  it('every allowlisted dead binding really is uncalled by the renderer', () => {
    const byChannel = collectChannelMethods();
    const renderer = rendererSources();

    // An allowlist entry claims "nothing calls this". The renderer never sees
    // channel strings — it calls `window.electronAPI.<ns>.<method>()`, so the
    // check has to be the QUALIFIED call. Matching a bare `.push(` would match
    // `parts.push(...)` in half the codebase and prove nothing.
    const actuallyCalled = Object.keys(UNREGISTERED_BY_DESIGN).filter((channel) => {
      const methods = byChannel.get(channel) ?? [];
      if (methods.length === 0) {
        // No method resolved — the binding is malformed rather than dead.
        throw new Error(
          `UNREGISTERED_BY_DESIGN lists '${channel}' but no preload method invokes it. ` +
            `Either the channel name is stale or the parser needs updating.`,
        );
      }
      const ns = channel.split(':')[0];
      return methods.some((method) =>
        new RegExp(`electronAPI\\s*[?.]{1,2}\\s*${ns}\\s*[?.]{1,2}\\s*${method}\\s*\\(`).test(
          renderer,
        ),
      );
    });

    expect(
      actuallyCalled,
      actuallyCalled.length
        ? `These channels are on the "unregistered by design" list but the renderer now ` +
            `calls them, so they need a real handler instead: ${actuallyCalled.join(', ')}`
        : '',
    ).toEqual([]);
  });
});
