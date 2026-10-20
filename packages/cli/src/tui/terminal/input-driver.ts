/**
 * The terminal input driver: bytes in, `InputEvent`s out.
 *
 * ## Why this is a separate layer
 *
 * The app has to keep working with two renderers during the migration, and the
 * two disagree about who owns input. Blessed parses bytes itself, computes a
 * key NAME (`C-`, `M-`, `S-` prefixes plus `key.name || ch`) and dispatches on
 * that name string. The own renderer parses bytes with `OwnKeyParser` and then
 * — until now — re-injected them into blessed's event pipeline purely to reuse
 * blessed's name computation and its `.key()` table.
 *
 * That round trip is the thing this file removes. The driver produces the same
 * names without blessed, so the app's key table can be a plain `Map` and
 * blessed can go back to being only what it still is: a screen painter (and,
 * for the rollback switch, an alternative input path).
 *
 * ## The name computation is blessed's, minus one quirk
 *
 * `program.js:405-411` builds `key.full` as
 * `(ctrl ? 'C-' : '') + (meta ? 'M-' : '') + (shift && key.name ? 'S-' : '') +
 * (key.name || ch)`, and emits `keypress` BEFORE `key <full>`. Both are
 * reproduced here, with tests that assert the names the existing bindings are
 * written against. If they diverge, the symptom is a binding that silently
 * stops firing — the worst kind, because nothing errors.
 *
 * The one thing NOT reproduced is blessed's Enter alias, which makes a single
 * physical Enter fire two dispatches under two names. See `fullKeyName`.
 *
 * ## What it does NOT do
 *
 * It does not own the output stream, so it cannot enable or disable terminal
 * modes; the sequences live in `terminal/ansi.ts` and the app writes them. That
 * keeps the driver testable with a `PassThrough` and no TTY.
 */

import type { OwnKeyEvent, OwnMouseEvent } from './own-key-parser.js';
import { OwnKeyInput, OwnKeyParser } from './own-key-parser.js';

/**
 * A key, normalised to what the app dispatches on.
 *
 * `full` is the blessed-compatible name (`C-c`, `M-y`, `S-tab`, `enter`,
 * `pageup`, …) and is the ONLY field the binding table reads. The rest is kept
 * because the text handler needs `ch` and the overlays need to distinguish
 * modifiers.
 */
export interface NormalizedKey {
  /** The printable character, when the key produces one. */
  readonly ch?: string;
  readonly name?: string;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
  readonly sequence: string;
  readonly code?: string;
  /** blessed's `key.full`. What `bindKey()` matches on. */
  readonly full: string;
}

/** The terminal's mouse reports. Screens convert coordinates; this does not. */
export interface InputMouseEvent {
  readonly action: 'wheelup' | 'wheeldown' | 'mousedown' | 'mouseup';
  readonly x: number;
  readonly y: number;
  readonly button: number;
  /**
   * Reserved for hit-testing (plan 615 Phase 2.4).
   *
   * A screen cell cannot be named until the scene builder exists (Phase 3/4),
   * so nothing sets this yet. It is in the contract now so that adding
   * hit-testing later is a change at ONE place — where the driver builds the
   * event — rather than a change to every consumer's signature.
   */
  readonly hit?: { readonly row: number; readonly column: number };
}

export type InputEvent =
  | { readonly kind: 'key'; readonly key: NormalizedKey }
  | { readonly kind: 'paste'; readonly text: string }
  | { readonly kind: 'mouse'; readonly event: InputMouseEvent };

/** What the terminal can do, as far as we can tell without asking it. */
export interface TerminalCapabilities {
  /**
   * Whether the terminal speaks the kitty keyboard protocol (`CSI … u`).
   *
   * Inferred from the environment, not from a query/response handshake: a
   * handshake has to finish before raw mode starts reading, which means a
   * timeout on every launch and a wrong answer when the user is typing during
   * it. The environment is wrong less often than a race is.
   */
  readonly kitty: boolean;
  /**
   * Whether SGR mouse reporting is worth enabling. True everywhere we target;
   * a terminal that does not understand `?1006` ignores it, so the failure
   * mode of guessing wrong is "no wheel events", not a garbled screen.
   */
  readonly mouse: boolean;
  /** Whether bracketed paste (`?2004`) is worth enabling. Same reasoning. */
  readonly bracketedPaste: boolean;
}

export interface TerminalInputDriver {
  /** Attach to a stream and start delivering events. Idempotent per call. */
  start(input: NodeJS.ReadableStream, onEvent: (event: InputEvent) => void): void;
  /** Detach and restore the stream's previous raw-mode state. */
  stop(): void;
  capabilities(): TerminalCapabilities;
}

export interface TerminalInputDriverOptions {
  readonly capabilities?: Partial<TerminalCapabilities>;
  /** Escape-sequence ambiguity window, forwarded to `OwnKeyParser`. */
  readonly escapeTimeoutMs?: number;
}

/**
 * blessed's `key.full`, minus one quirk that is deliberately not reproduced.
 *
 * The prefix rule is blessed's (`program.js:405-406`): `C-`, `M-`, and `S-` for
 * a NAMED key — a shifted printable keeps its casing in `ch` and gets no
 * prefix, which is why `Shift+A` arrives as `S-a` only when the parser named
 * it.
 *
 * What is NOT reproduced is blessed's Enter alias (`program.js:397-399`), where
 * `return` re-emits itself as `enter` and then falls through. The effect there
 * is one physical Enter producing TWO dispatches under two names, which is why
 * the app has `CONTENDED_BINDINGS`/`CONTENDED_ALIASES` at all. Here one key
 * produces one event, named `return`, and the canonical binding the app already
 * chose (`return`, not `enter`) fires exactly once.
 *
 * That is equivalent for every binding and strictly better for the text
 * handler: the duplicate that `CONTENDED_ALIASES` exists to swallow is never
 * generated. The alias handling stays in place because the BLESSED path still
 * goes through blessed's parser and still sees the duplicate.
 */
export function fullKeyName(ch: string | undefined, key: OwnKeyEvent): string {
  const name = key.name;
  const prefix = `${key.ctrl ? 'C-' : ''}${key.meta ? 'M-' : ''}${key.shift && name ? 'S-' : ''}`;
  return prefix + (name ?? ch ?? '');
}

/** Lower one parser callback into the driver's normalised key. */
export function normalizeKey(ch: string | undefined, key: OwnKeyEvent): NormalizedKey {
  return {
    ...(ch === undefined ? {} : { ch }),
    ...(key.name === undefined ? {} : { name: key.name }),
    ctrl: key.ctrl,
    meta: key.meta,
    shift: key.shift,
    sequence: key.sequence,
    ...(key.code === undefined ? {} : { code: key.code }),
    full: fullKeyName(ch, key),
  };
}

/** Terminals whose environment advertises the kitty keyboard protocol. */
const KITTY_TERM = /(?:^|[-_])kitty$/u;

/** Detect capabilities from the environment. Pure, so it can be tested. */
export function detectCapabilities(env: NodeJS.ProcessEnv = process.env): TerminalCapabilities {
  const term = env['TERM'] ?? '';
  const program = env['TERM_PROGRAM'] ?? '';
  const kitty = KITTY_TERM.test(term)
    || env['KITTY_WINDOW_ID'] !== undefined
    || env['WEZTERM_PANE'] !== undefined
    || program === 'WezTerm'
    || program === 'ghostty';
  return { kitty, mouse: true, bracketedPaste: true };
}

/**
 * Build a driver.
 *
 * Construction is cheap and side-effect free: nothing is read until `start`,
 * because a driver that grabs the terminal at import time is untestable and
 * makes the "should the TUI run at all" decision impossible to keep upstream
 * (`tty.ts`).
 */
export function createInputDriver(options: TerminalInputDriverOptions = {}): TerminalInputDriver {
  const capabilities: TerminalCapabilities = {
    ...detectCapabilities(),
    ...options.capabilities,
  };
  let attached: OwnKeyInput | null = null;

  return {
    start(input: NodeJS.ReadableStream, onEvent: (event: InputEvent) => void): void {
      if (attached !== null) return;
      const parser = new OwnKeyParser({
        keypress: (ch, key) => {
          onEvent({ kind: 'key', key: normalizeKey(ch, key) });
        },
        paste: (text) => {
          onEvent({ kind: 'paste', text });
        },
        mouse: (event) => {
          onEvent({ kind: 'mouse', event });
        },
      }, {
        ...(options.escapeTimeoutMs === undefined ? {} : { escapeTimeoutMs: options.escapeTimeoutMs }),
      });
      // `OwnKeyInput` owns the raw-mode dance (set, and restore to whatever it
      // was), which is the one part of stdin handling that has a correct answer
      // only if it remembers the previous state.
      attached = new OwnKeyInput(input, parser);
    },
    stop(): void {
      attached?.dispose();
      attached = null;
    },
    capabilities(): TerminalCapabilities {
      return capabilities;
    },
  };
}

export type { OwnMouseEvent };
