import { describe, expect, it, vi } from 'vitest';
import {
  OwnKeyInput,
  OwnKeyParser,
  type OwnKeyEvent,
  type OwnMouseEvent,
} from '../own-key-parser.js';
import { PassThrough } from 'node:stream';

interface KeyRecord {
  readonly ch: string | undefined;
  readonly key: OwnKeyEvent;
}

function createParser() {
  const keys: KeyRecord[] = [];
  const pastes: string[] = [];
  const mouse: OwnMouseEvent[] = [];
  const parser = new OwnKeyParser({
    keypress: (ch, key) => keys.push({ ch, key }),
    paste: (text) => pastes.push(text),
    mouse: (event) => mouse.push(event),
  });
  return { parser, keys, pastes, mouse };
}

describe('OwnKeyParser', () => {
  it('decodes committed UTF-8 code points split across byte chunks', () => {
    const { parser, keys } = createParser();
    const bytes = Buffer.from('中文😀', 'utf8');
    parser.feed(bytes.subarray(0, 2));
    parser.feed(bytes.subarray(2, 6));
    parser.feed(bytes.subarray(6));

    expect(keys.map(({ ch, key }) => [ch, key.name])).toEqual([
      ['中', undefined],
      ['文', undefined],
      ['😀', undefined],
    ]);
    parser.dispose();
  });

  it('parses Ctrl, Alt, modified CSI keys, and Shift+Tab from raw bytes', () => {
    const { parser, keys } = createParser();
    parser.feed(Buffer.concat([
      Buffer.from([0x03]),
      Buffer.from('\x1bx', 'ascii'),
      Buffer.from('\x1b[1;5D', 'ascii'),
      Buffer.from('\x1b[1;3A', 'ascii'),
      Buffer.from('\x1b[1;7C', 'ascii'),
      Buffer.from('\x1b[Z', 'ascii'),
      Buffer.from('\x1b[[A', 'ascii'),
    ]));

    expect(keys.map(({ ch, key }) => ({
      ch,
      name: key.name,
      ctrl: key.ctrl,
      meta: key.meta,
      shift: key.shift,
    }))).toEqual([
      { ch: '\x03', name: 'c', ctrl: true, meta: false, shift: false },
      { ch: undefined, name: 'x', ctrl: false, meta: true, shift: false },
      { ch: undefined, name: 'left', ctrl: true, meta: false, shift: false },
      { ch: undefined, name: 'up', ctrl: false, meta: true, shift: false },
      { ch: undefined, name: 'right', ctrl: true, meta: true, shift: false },
      { ch: undefined, name: 'tab', ctrl: false, meta: false, shift: true },
      { ch: undefined, name: 'f1', ctrl: false, meta: false, shift: false },
    ]);
    parser.dispose();
  });

  it('holds a lone Escape until the ambiguity timeout', () => {
    vi.useFakeTimers();
    const { parser, keys } = createParser();
    parser.feed(Buffer.from([0x1b]));
    expect(keys).toEqual([]);

    vi.advanceTimersByTime(34);
    expect(keys).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(keys.map(({ ch, key }) => [ch, key.name])).toEqual([[undefined, 'escape']]);

    parser.dispose();
    vi.useRealTimers();
  });

  it('keeps bracketed paste literal across split markers and multibyte chunks', () => {
    const { parser, keys, pastes, mouse } = createParser();
    parser.feed(Buffer.from('\x1b[20', 'ascii'));
    parser.feed(Buffer.from('0~line one\r\n中\x1b[A\x1b[20', 'utf8'));
    parser.feed(Buffer.from('1~\x1b[<64;12;8M', 'ascii'));

    expect(pastes).toEqual(['line one\r\n中\x1b[A']);
    expect(keys).toEqual([]);
    expect(mouse).toEqual([{ action: 'wheelup', x: 11, y: 7, button: 0 }]);
    parser.dispose();
  });

  it('reports SGR mouse wheel events with zero-based coordinates', () => {
    const { parser, mouse } = createParser();
    parser.feed(Buffer.from('\x1b[<64;12;8M\x1b[<65;12;8M', 'ascii'));

    expect(mouse).toEqual([
      { action: 'wheelup', x: 11, y: 7, button: 0 },
      { action: 'wheeldown', x: 11, y: 7, button: 1 },
    ]);
    parser.dispose();
  });

  it('restores the original raw-mode state when detached', () => {
    class RawInput extends PassThrough {
      isRaw = false;

      setRawMode(mode: boolean): void {
        this.isRaw = mode;
      }
    }

    const input = new RawInput();
    const { parser } = createParser();
    const attached = new OwnKeyInput(input, parser);
    expect(input.isRaw).toBe(true);

    attached.dispose();
    expect(input.isRaw).toBe(false);
    expect(input.listenerCount('data')).toBe(0);
  });
});
