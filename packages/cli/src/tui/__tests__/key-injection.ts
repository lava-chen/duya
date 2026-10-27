/**
 * Press keys the way a terminal sends them: bytes, not semantically.
 *
 * ## Why the tests had to change
 *
 * These suites used to drive the UI with `program.emit('key down')` — injecting
 * a blessed event whose NAME blessed would normally have computed from bytes.
 * That worked while blessed was the input path, and it stopped working when
 * plan 615 Phase 2 gave the own renderer its own dispatcher: nothing is
 * registered on `program.on('key …')` any more, because blessed no longer parses
 * input for that renderer.
 *
 * Rather than re-expose blessed's event as a second dispatch channel — which
 * would keep the thing Phase 2 removed — the suites now write the bytes. That is
 * strictly better coverage: the assertion is no longer "the handler I wired to
 * this name ran" but "this keystroke, decoded by the real parser, reached the
 * handler the user would reach". A regression in the parser or in the driver's
 * name computation now fails these tests too, which is the point of routing the
 * tests through the same path as the user.
 *
 * ## Why a table and not a keypress encoder
 *
 * The sequences below are what the terminals we target actually emit, and each
 * one is a decision worth seeing in a test: `\x7f` for Backspace (not `\b`),
 * SS3 for F1–F4 but CSI for F5+, `\r` for Enter. Encoding them programmatically
 * from a name would invent a second, test-only protocol.
 */

/** Legacy (non-kitty) byte sequences for the keys the UI tests press. */
const KEY_BYTES: Readonly<Record<string, string>> = {
  return: '\r',
  enter: '\r',
  'C-m': '\r',
  escape: '\x1b',
  tab: '\t',
  'S-tab': '\x1b[Z',
  // A terminal sends the bare space; blessed and the own parser both name it
  // `space`, which is the name the panel's strip answers with ("go deeper").
  space: ' ',
  backspace: '\x7f',
  delete: '\x1b[3~',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  home: '\x1b[H',
  end: '\x1b[F',
  pageup: '\x1b[5~',
  pagedown: '\x1b[6~',
  insert: '\x1b[2~',
  f1: '\x1bOP',
  f2: '\x1bOQ',
  f3: '\x1bOR',
  f4: '\x1bOS',
  f5: '\x1b[15~',
  f6: '\x1b[17~',
  'C-a': '\x01',
  'C-c': '\x03',
  'C-d': '\x04',
  'C-e': '\x05',
  'C-k': '\x0b',
  'C-p': '\x10',
  'C-r': '\x12',
  'C-u': '\x15',
  'C-w': '\x17',
  'C-y': '\x19',
  'C-z': '\x1a',
};

/** One key's bytes. Throws rather than silently pressing nothing. */
export function bytesFor(key: string): string {
  const bytes = KEY_BYTES[key];
  if (bytes === undefined) {
    throw new Error(
      `no byte sequence for ${JSON.stringify(key)} — add it to KEY_BYTES if the ` +
        `terminal really sends one, rather than routing around the parser`,
    );
  }
  return bytes;
}

/** Minimal shape of the stream the app reads; a PassThrough satisfies it. */
export interface KeySink {
  write(chunk: string): unknown;
}

/** Press one key, or several in order. Delivery is synchronous. */
export function press(input: KeySink, ...keys: readonly string[]): void {
  for (const key of keys) input.write(bytesFor(key));
}
