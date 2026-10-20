/**
 * The input driver (plan 615 Phase 2.1/2.3).
 *
 * ## What these tests are guarding
 *
 * The driver replaced a chain that looked like: own parser → re-inject into
 * blessed's event pipeline → blessed computes `key.full` → blessed's `.key()`
 * table. The risk in removing the middle is silent: a binding whose name no
 * longer matches simply never fires, and nothing throws. So the names are
 * asserted EXPLICITLY, one row per key the app binds, rather than implied by a
 * UI test that happens to pass.
 *
 * ## Why one Enter is one event
 *
 * blessed re-emits `return` as `enter` and then falls through, so one physical
 * Enter produced two dispatches. The app worked around it (`CONTENDED_BINDINGS`
 * binds `return`, `CONTENDED_ALIASES` swallows `enter`). The driver produces ONE
 * event named `return`, which is asserted here — if someone "restores" the
 * blessed quirk for symmetry, the popup's double-dispatch bug comes back and
 * this test is where it should fail.
 */

import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';

import {
  createInputDriver,
  detectCapabilities,
  fullKeyName,
  normalizeKey,
  type InputEvent,
} from '../input-driver.js';
import type { OwnKeyEvent } from '../own-key-parser.js';

class RawInput extends PassThrough {
  isRaw = false;

  setRawMode(mode: boolean): void {
    this.isRaw = mode;
  }
}

/** Attach a driver with fixed capabilities and collect its events. */
function createDriver(capabilities: { kitty?: boolean } = {}) {
  const input = new RawInput();
  const events: InputEvent[] = [];
  const driver = createInputDriver({
    capabilities: { kitty: capabilities.kitty ?? false, mouse: true, bracketedPaste: true },
  });
  driver.start(input, (event) => events.push(event));
  return { driver, input, events };
}

/** The names and modifiers of the key events collected so far. */
function keys(events: readonly InputEvent[]) {
  return events.flatMap((event) => (event.kind === 'key'
    ? [{
      full: event.key.full,
      ch: event.key.ch,
      ctrl: event.key.ctrl,
      meta: event.key.meta,
      shift: event.key.shift,
    }]
    : []));
}

describe('fullKeyName', () => {
  const key = (overrides: Partial<OwnKeyEvent>): OwnKeyEvent => ({
    sequence: '',
    ctrl: false,
    meta: false,
    shift: false,
    ...overrides,
  });

  it('prefixes modifiers in blessed’s order', () => {
    expect(fullKeyName(undefined, key({ name: 'c', ctrl: true }))).toBe('C-c');
    expect(fullKeyName(undefined, key({ name: 'y', meta: true }))).toBe('M-y');
    expect(fullKeyName(undefined, key({ name: 'tab', shift: true }))).toBe('S-tab');
    expect(fullKeyName(undefined, key({ name: 'right', ctrl: true, meta: true }))).toBe('C-M-right');
  });

  it('does not prefix a shift that the parser reported without a name', () => {
    // A shifted printable arrives as `ch: 'A'` with no name. blessed gives it no
    // `S-` prefix (its rule is `shift && key.name`), and neither may we: `S-A`
    // would never match a binding, while the text handler needs the plain `ch`.
    expect(fullKeyName('A', key({ shift: true }))).toBe('A');
    expect(fullKeyName('A', key({ name: 'a', shift: true }))).toBe('S-a');
  });

  it('keeps Enter as `return`, which is the name the app binds', () => {
    // See the module comment: blessed would rename this to `enter` and emit a
    // second event. The canonical binding is `return`, and this is the only
    // event it needs.
    expect(fullKeyName(undefined, key({ name: 'return', sequence: '\r' }))).toBe('return');
  });
});

describe('normalizeKey', () => {
  it('carries the printable character alongside the name', () => {
    const normalized = normalizeKey(' ', { sequence: ' ', name: 'space', ctrl: false, meta: false, shift: false });
    expect(normalized).toMatchObject({ ch: ' ', name: 'space', full: 'space' });
  });

  it('omits fields the parser did not report instead of setting them undefined', () => {
    const normalized = normalizeKey('中', { sequence: '中', ctrl: false, meta: false, shift: false });
    expect('name' in normalized).toBe(false);
    expect('code' in normalized).toBe(false);
    expect(normalized.full).toBe('中');
  });
});

describe('dispatch — keys', () => {
  it('names every key the app binds, from real bytes', () => {
    const { driver, input, events } = createDriver();
    // Ctrl+C, Alt+Y, Shift+Tab, Enter, Ctrl+Left, F1 — one from each family the
    // parser has to handle, written as the terminal writes them.
    input.write('\x03');
    input.write('\x1by');
    input.write('\x1b[Z');
    input.write('\r');
    input.write('\x1b[1;5D');
    input.write('\x1bOP');
    driver.stop();

    expect(keys(events)).toEqual([
      { full: 'C-c', ch: '\x03', ctrl: true, meta: false, shift: false },
      { full: 'M-y', ch: undefined, ctrl: false, meta: true, shift: false },
      { full: 'S-tab', ch: undefined, ctrl: false, meta: false, shift: true },
      { full: 'return', ch: undefined, ctrl: false, meta: false, shift: false },
      { full: 'C-left', ch: undefined, ctrl: true, meta: false, shift: false },
      { full: 'f1', ch: undefined, ctrl: false, meta: false, shift: false },
    ]);
  });

  it('produces one event per Enter, not blessed’s two', () => {
    const { driver, input, events } = createDriver();
    input.write('\r');
    driver.stop();
    expect(keys(events).map((entry) => entry.full)).toEqual(['return']);
  });

  it('delivers a committed ideograph with no name, so the text handler takes it', () => {
    const { driver, input, events } = createDriver();
    input.write('中');
    driver.stop();
    expect(keys(events)).toEqual([
      { full: '中', ch: '中', ctrl: false, meta: false, shift: false },
    ]);
  });

  it('keeps a Space as Space and a Space as text', () => {
    // The Phase 0 regression in one assertion: a space with no `ch` was
    // silently dropped, and a space with no name looked like an unbound key.
    const { driver, input, events } = createDriver();
    input.write(' ');
    driver.stop();
    expect(keys(events)).toEqual([
      { full: 'space', ch: ' ', ctrl: false, meta: false, shift: false },
    ]);
  });
});

describe('dispatch — paste', () => {
  it('delivers a bracketed paste as one literal event', () => {
    const { driver, input, events } = createDriver();
    input.write('\x1b[200~first\r\n第二\x1b[A\x1b[201~');
    driver.stop();

    expect(events).toHaveLength(1);
    const [paste] = events;
    expect(paste?.kind).toBe('paste');
    // Escape sequences and newlines inside the payload are CONTENT: a paste must
    // never be re-read as keys, or pasting a log would execute it.
    expect(paste?.kind === 'paste' ? paste.text : '').toBe('first\r\n第二\x1b[A');
    expect(keys(events)).toEqual([]);
  });

  it('survives a marker split across chunks and a multibyte character split with it', () => {
    const { driver, input, events } = createDriver();
    // The START marker split, then the END marker split, with a payload either
    // side. A parser that matched markers per chunk would deliver the marker
    // bytes as keys and the payload as two fragments.
    input.write(Buffer.from('\x1b[20', 'ascii'));
    input.write(Buffer.from('0~a\x1b[20', 'ascii'));
    input.write(Buffer.from('1~b', 'ascii'));
    driver.stop();

    expect(events.map((event) => (event.kind === 'paste' ? `paste:${event.text}` : `key:${event.kind === 'key' ? event.key.full : ''}`)))
      .toEqual(['paste:a', 'key:b']);
  });
});

describe('dispatch — mouse', () => {
  it('reports the wheel with zero-based coordinates and leaves hit unset', () => {
    const { driver, input, events } = createDriver();
    input.write('\x1b[<64;12;8M\x1b[<65;12;8M');
    driver.stop();

    expect(events).toEqual([
      { kind: 'mouse', event: { action: 'wheelup', x: 11, y: 7, button: 0 } },
      { kind: 'mouse', event: { action: 'wheeldown', x: 11, y: 7, button: 1 } },
    ]);
  });
});

describe('kitty keyboard protocol', () => {
  it('parses a control chord reported as a code point', () => {
    const { driver, input, events } = createDriver({ kitty: true });
    input.write('\x1b[99;5u');
    driver.stop();
    expect(keys(events)).toEqual([
      { full: 'C-c', ch: '\x03', ctrl: true, meta: false, shift: false },
    ]);
  });

  it('parses Enter, Tab and Escape as the names the table uses', () => {
    const { driver, input, events } = createDriver({ kitty: true });
    input.write('\x1b[13u\x1b[9u\x1b[27u');
    driver.stop();
    expect(keys(events).map((entry) => entry.full)).toEqual(['return', 'tab', 'escape']);
  });

  it('treats the protocol’s meta bit as alt', () => {
    const { driver, input, events } = createDriver({ kitty: true });
    // `;33` is shift+meta (modifier 32 means alt in kitty's "report all keys"
    // mode), which some terminals send instead of `;3`.
    input.write('\x1b[121;33u');
    driver.stop();
    expect(keys(events)).toEqual([
      { full: 'M-y', ch: undefined, ctrl: false, meta: true, shift: false },
    ]);
  });

  it('drops release events and keys outside the vocabulary', () => {
    const { driver, input, events } = createDriver({ kitty: true });
    // `:3` is a release; 57441 is in kitty's functional range (media keys).
    input.write('\x1b[97;1:3u');
    input.write('\x1b[57441u');
    driver.stop();
    expect(events).toEqual([]);
  });

  it('does not need the protocol to be enabled to parse it', () => {
    // Recognition is unconditional; only ASKING for the protocol is gated. A
    // terminal that sends these without being asked must still be understood.
    const { driver, input, events } = createDriver({ kitty: false });
    input.write('\x1b[97u');
    driver.stop();
    expect(keys(events)).toEqual([
      { full: 'a', ch: 'a', ctrl: false, meta: false, shift: false },
    ]);
  });
});

describe('capabilities', () => {
  it('detects kitty from the environment, not from a handshake', () => {
    expect(detectCapabilities({ TERM: 'xterm-kitty' }).kitty).toBe(true);
    expect(detectCapabilities({ KITTY_WINDOW_ID: '1' }).kitty).toBe(true);
    expect(detectCapabilities({ WEZTERM_PANE: '2' }).kitty).toBe(true);
    expect(detectCapabilities({ TERM_PROGRAM: 'WezTerm' }).kitty).toBe(true);
    expect(detectCapabilities({ TERM_PROGRAM: 'ghostty' }).kitty).toBe(true);
  });

  it('does not mistake a plain xterm for a kitty terminal', () => {
    expect(detectCapabilities({ TERM: 'xterm-256color' }).kitty).toBe(false);
    expect(detectCapabilities({ TERM: 'screen-256color' }).kitty).toBe(false);
    // `xterm-kitty` ends the TERM string in `-kitty`; `kitty-something` must not
    // match, or an unrelated TERM would silently enable a different protocol.
    expect(detectCapabilities({ TERM: 'kitty-like' }).kitty).toBe(false);
  });

  it('always asks for mouse and bracketed paste, because the failure mode is silent', () => {
    // A terminal that ignores `?1006` / `?2004` simply sends nothing extra.
    // Declining to ask would lose the wheel on every terminal that does support
    // them.
    expect(detectCapabilities({})).toMatchObject({ mouse: true, bracketedPaste: true });
  });
});

describe('lifecycle', () => {
  it('takes raw mode and restores it on stop', () => {
    const { driver, input } = createDriver();
    expect(input.isRaw).toBe(true);
    driver.stop();
    expect(input.isRaw).toBe(false);
    expect(input.listenerCount('data')).toBe(0);
  });

  it('ignores a second start instead of doubling every event', () => {
    const { driver, input, events } = createDriver();
    driver.start(input, (event) => events.push(event));
    input.write('a');
    driver.stop();
    expect(keys(events)).toHaveLength(1);
  });

  it('stops delivering after stop', () => {
    const { driver, input, events } = createDriver();
    driver.stop();
    input.write('a');
    expect(events).toEqual([]);
  });
});
