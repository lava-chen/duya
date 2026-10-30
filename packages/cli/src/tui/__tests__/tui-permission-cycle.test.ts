/**
 * The Shift+Tab permission cycle, driven through the real app.
 *
 * The keyboard path is the real one — synthetic stdin, the same bytes a
 * terminal ships — because the routing is exactly where a state-level test
 * would lie: the chord has to arrive under the name the app binds, and the
 * panel that owns Shift+Tab while it is open has to keep it.
 *
 * What is pinned here is the SAFETY property, not the drawing: `bypass` gives
 * the agent the whole machine, so it must take two presses, and every other
 * mode must take one.
 */

import { describe, it, expect } from 'vitest';
import { Writable, PassThrough } from 'stream';
import { TUIApp } from '../TUIApp.js';
import type { TuiPermissionMode } from '../permission-mode.js';

function sink(): { stream: Writable; text: () => string } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });
  return { stream, text: () => Buffer.concat(chunks).toString('utf8') };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function makeApp(
  options: Partial<ConstructorParameters<typeof TUIApp>[0]> = {},
  stdin: PassThrough = new PassThrough(),
) {
  const out = sink();
  const app = new TUIApp({
    output: out.stream,
    input: stdin,
    onSubmit: () => {},
    // Default the override map to EMPTY: a test that asserts on the DEFAULT
    // bindings must not depend on the developer's own `~/.duya/config.toml`.
    keyOverrides: {},
    ...options,
  });
  return { app, out, stdin };
}

/** Shift+Tab, the bytes a terminal ships for it. */
const SHIFT_TAB = '\x1b[Z';

describe('TUIApp permission cycle', () => {
  it('moves ask → auto on one Shift+Tab', async () => {
    const cycles: TuiPermissionMode[] = [];
    const { app, stdin } = makeApp({
      permissionMode: () => 'ask',
      onPermissionCycle: (mode) => cycles.push(mode),
    });
    app.start();
    await settle();
    stdin.write(SHIFT_TAB);
    await settle();
    expect(cycles).toEqual(['auto']);
    app.stop();
  });

  it('leaves a plain Tab to the editor', async () => {
    const cycles: TuiPermissionMode[] = [];
    const { app, stdin } = makeApp({
      permissionMode: () => 'ask',
      onPermissionCycle: (mode) => cycles.push(mode),
    });
    app.start();
    await settle();
    stdin.write('\t');
    await settle();
    expect(cycles).toEqual([]);
    app.stop();
  });

  it('takes two presses to reach bypass', async () => {
    const cycles: TuiPermissionMode[] = [];
    const { app, stdin } = makeApp({
      permissionMode: () => 'auto',
      onPermissionCycle: (mode) => cycles.push(mode),
    });
    app.start();
    await settle();
    stdin.write(SHIFT_TAB);
    await settle();
    // Staged, not applied: the mode that grants everything is not reachable
    // by one stray press.
    expect(cycles).toEqual([]);
    stdin.write(SHIFT_TAB);
    await settle();
    expect(cycles).toEqual(['bypass']);
    app.stop();
  });

  it('says what the second press does while bypass waits for it', async () => {
    const { app, out, stdin } = makeApp({
      inline: true,
      permissionMode: () => 'auto',
      onPermissionCycle: () => {},
    });
    app.start();
    await settle();
    stdin.write(SHIFT_TAB);
    await settle();
    expect(out.text()).toContain('again');
    app.stop();
  });

  it('shows the mode in force in the badge', async () => {
    const { app, out, stdin } = makeApp({
      inline: true,
      permissionMode: () => 'ask',
      onPermissionCycle: () => {},
    });
    app.start();
    await settle();
    expect(out.text()).toContain('[ask]');
    app.stop();
  });

  it('shows the badge in the full-screen presentation too', async () => {
    const { app, out, stdin } = makeApp({
      permissionMode: () => 'bypass',
      onPermissionCycle: () => {},
    });
    app.start();
    await settle();
    expect(out.text()).toContain('[bypass]');
    app.stop();
  });

  it('does nothing when the surface does not track a mode', async () => {
    const cycles: TuiPermissionMode[] = [];
    const { app, stdin } = makeApp({
      onPermissionCycle: (mode) => cycles.push(mode),
    });
    app.start();
    await settle();
    stdin.write(SHIFT_TAB);
    await settle();
    expect(cycles).toEqual([]);
    app.stop();
  });
});
