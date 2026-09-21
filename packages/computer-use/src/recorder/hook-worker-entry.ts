/**
 * hook-worker-entry.ts — global input hook child process (plan 556 Phase 1).
 *
 * Runs under a plain Node runtime (ELECTRON_RUN_AS_NODE) so uiohook-napi's
 * N-API prebuild loads without any Electron ABI rebuild (design decision
 * D2/D3). Emits one JSON object per line on stdout:
 *
 *   {"kind":"mousedown","ts":...,"x":...,"y":...,"button":1,"clicks":1}
 *   {"kind":"mouseup","ts":...,"x":...,"y":...,"button":1}
 *   {"kind":"keydown","ts":...,"keycode":30,"name":null,"char":"a",
 *    "shiftKey":false,"ctrlKey":false,"altKey":false,"metaKey":false}
 *   {"kind":"keyup","ts":...,"keycode":30,...}
 *   {"kind":"wheel","ts":...,"rotation":1,"amount":3}
 *   {"kind":"heartbeat","type":"heartbeat","ts":...}  — every 30s
 *
 * Deliberately NOT emitted: mousemove (hundreds/sec of noise; the main
 * process takes coordinates from neighboring events). Deliberately NOT
 * imported: anything from this package beyond the dependency-free keymap —
 * the packaged worker is a single file plus node_modules/uiohook-napi.
 *
 * Lifecycle: the parent kills this process to stop recording. A failing
 * stdout write (EPIPE) exits nonzero. `--self-test` verifies the native
 * module loads without ever grabbing the global hook (used as the npm
 * install smoke check from the risk table).
 */

import { uIOhook, type UiohookKeyboardEvent, type UiohookMouseEvent, type UiohookWheelEvent } from 'uiohook-napi';

import { resolveChar, KEYCODE_TO_NAME } from './keymap.js';

interface EmitLine {
  kind: string;
  ts: number;
  [key: string]: unknown;
}

function emit(line: EmitLine): void {
  process.stdout.write(JSON.stringify(line) + '\n');
}

/**
 * Resolve the char for a keydown. Null means "no US-layout mapping" —
 * the main-side aggregator decides whether that becomes a `<key:N>`
 * placeholder (unmapped printable) or a `key` event (named key).
 */
function charForKeycode(e: UiohookKeyboardEvent): string | null {
  return resolveChar(e.keycode, e.shiftKey);
}

function emitKeyboardEvent(e: UiohookKeyboardEvent, kind: 'keydown' | 'keyup'): void {
  emit({
    kind,
    ts: Date.now(),
    keycode: e.keycode,
    name: KEYCODE_TO_NAME.get(e.keycode) ?? null,
    char: kind === 'keydown' ? charForKeycode(e) : null,
    shiftKey: e.shiftKey,
    ctrlKey: e.ctrlKey,
    altKey: e.altKey,
    metaKey: e.metaKey,
  });
}

function emitMouseEvent(e: UiohookMouseEvent, kind: 'mousedown' | 'mouseup'): void {
  // libuiohook button numbering: 1=left 2=right 3=middle 4/5=extra.
  const button = typeof e.button === 'number' ? e.button : 0;
  emit({
    kind,
    ts: Date.now(),
    x: e.x,
    y: e.y,
    button,
    clicks: kind === 'mousedown' ? e.clicks : 0,
  });
}

function emitWheelEvent(e: UiohookWheelEvent): void {
  emit({
    kind: 'wheel',
    ts: Date.now(),
    rotation: e.rotation,
    amount: e.amount,
  });
}

function main(): void {
  if (process.argv.includes('--self-test')) {
    // Loading the module above already exercised the N-API prebuild.
    emit({ kind: 'self-test', ts: Date.now(), ok: true });
    process.exit(0);
  }

  uIOhook.on('mousedown', (e) => emitMouseEvent(e, 'mousedown'));
  uIOhook.on('mouseup', (e) => emitMouseEvent(e, 'mouseup'));
  uIOhook.on('keydown', (e) => emitKeyboardEvent(e, 'keydown'));
  uIOhook.on('keyup', (e) => emitKeyboardEvent(e, 'keyup'));
  uIOhook.on('wheel', (e) => emitWheelEvent(e));

  // Heartbeat: the parent declares the worker dead after 90s of silence.
  // The `type` field is what the computer-use-daemon dead-man timer
  // recognizes (this worker shares its spawn pipeline); `kind` keeps the
  // shape consistent with the other worker lines.
  const heartbeatTimer = setInterval(() => {
    emit({ kind: 'heartbeat', type: 'heartbeat', ts: Date.now() });
  }, 30_000);
  heartbeatTimer.unref?.();

  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') {
      process.exit(1);
    }
    throw err;
  });

  // Stop channel: the parent kills the process (SIGTERM on POSIX,
  // TerminateProcess on Windows). stdin is ignored by the parent's
  // stdio config, so it carries no signal here.
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));

  uIOhook.start();
}

main();
