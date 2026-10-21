import { StringDecoder } from 'node:string_decoder';

export interface OwnKeyEvent {
  readonly sequence: string;
  readonly name?: string;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
  readonly code?: string;
}

export interface OwnMouseEvent {
  readonly action: 'wheelup' | 'wheeldown' | 'mousedown' | 'mouseup';
  readonly x: number;
  readonly y: number;
  readonly button: number;
}

export interface OwnKeyParserHandlers {
  readonly keypress: (ch: string | undefined, key: OwnKeyEvent) => void;
  readonly paste?: (text: string) => void;
  readonly mouse?: (event: OwnMouseEvent) => void;
}

export interface OwnKeyParserOptions {
  readonly escapeTimeoutMs?: number;
  readonly sequenceTimeoutMs?: number;
}

const PASTE_START = Buffer.from('\x1b[200~', 'ascii');
const PASTE_END = Buffer.from('\x1b[201~', 'ascii');
const DEFAULT_ESCAPE_TIMEOUT_MS = 35;
const DEFAULT_SEQUENCE_TIMEOUT_MS = 1_000;
const MAX_ESCAPE_SEQUENCE_BYTES = 128;

/** Incremental terminal byte parser; input may split anywhere, including UTF-8. */
export class OwnKeyParser {
  private readonly handlers: OwnKeyParserHandlers;
  private readonly escapeTimeoutMs: number;
  private readonly sequenceTimeoutMs: number;
  private buffer = Buffer.alloc(0);
  private escapeTimer: ReturnType<typeof setTimeout> | null = null;
  private pasteDecoder: StringDecoder | null = null;
  private readonly pasteParts: string[] = [];
  private disposed = false;

  constructor(handlers: OwnKeyParserHandlers, options: OwnKeyParserOptions = {}) {
    this.handlers = handlers;
    this.escapeTimeoutMs = options.escapeTimeoutMs ?? DEFAULT_ESCAPE_TIMEOUT_MS;
    this.sequenceTimeoutMs = options.sequenceTimeoutMs ?? DEFAULT_SEQUENCE_TIMEOUT_MS;
  }

  feed(chunk: Buffer | Uint8Array | string): void {
    if (this.disposed) return;
    const bytes = typeof chunk === 'string'
      ? Buffer.from(chunk, 'utf8')
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (bytes.length === 0) return;
    this.clearEscapeTimer();
    this.buffer = this.buffer.length === 0 ? Buffer.from(bytes) : Buffer.concat([this.buffer, bytes]);
    this.drain();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearEscapeTimer();
    this.buffer = Buffer.alloc(0);
    this.pasteDecoder = null;
    this.pasteParts.length = 0;
  }

  private drain(): void {
    while (this.buffer.length > 0 && !this.disposed) {
      if (this.pasteDecoder !== null) {
        if (this.drainPaste()) continue;
        return;
      }

      if (this.buffer[0] === 0x1b) {
        if (this.buffer.length === 1) {
          this.armEscapeTimer();
          return;
        }
        if (this.buffer[1] === 0x5b) {
          if (!this.drainCsi()) {
            this.armEscapeTimer();
            return;
          }
          continue;
        }
        if (this.buffer[1] === 0x4f) {
          if (!this.drainSs3()) {
            this.armEscapeTimer();
            return;
          }
          continue;
        }
        if (!this.drainMetaCharacter()) return;
        continue;
      }

      if (!this.drainCharacter()) return;
    }
  }

  private drainCsi(): boolean {
    const legacyFunctionKey = this.buffer.length >= 3 && this.buffer[2] === 0x5b;
    const finalStart = legacyFunctionKey ? 3 : 2;
    let finalIndex = -1;
    for (let index = finalStart; index < this.buffer.length; index += 1) {
      const byte = this.buffer[index] as number;
      if (byte >= 0x40 && byte <= 0x7e) {
        finalIndex = index;
        break;
      }
    }
    if (finalIndex < 0) {
      if (this.buffer.length > MAX_ESCAPE_SEQUENCE_BYTES) {
        this.releaseMalformedEscape();
        return true;
      }
      return false;
    }

    const sequence = this.buffer.subarray(0, finalIndex + 1);
    this.buffer = this.buffer.subarray(finalIndex + 1);
    if (sequence.equals(PASTE_START)) {
      this.pasteDecoder = new StringDecoder('utf8');
      this.pasteParts.length = 0;
      return true;
    }
    this.parseCsi(sequence, legacyFunctionKey);
    return true;
  }

  private drainSs3(): boolean {
    let finalIndex = -1;
    for (let index = 2; index < this.buffer.length; index += 1) {
      const byte = this.buffer[index] as number;
      if (byte >= 0x40 && byte <= 0x7e) {
        finalIndex = index;
        break;
      }
    }
    if (finalIndex < 0) {
      if (this.buffer.length > MAX_ESCAPE_SEQUENCE_BYTES) {
        this.releaseMalformedEscape();
        return true;
      }
      return false;
    }
    const sequence = this.buffer.subarray(0, finalIndex + 1);
    this.buffer = this.buffer.subarray(finalIndex + 1);
    this.parseSs3(sequence);
    return true;
  }

  private drainMetaCharacter(): boolean {
    if (this.buffer[1] === 0x1b) {
      this.buffer = this.buffer.subarray(2);
      this.emitKey('escape', '\x1b\x1b', { meta: true });
      return true;
    }
    const length = utf8Length(this.buffer[1] as number);
    if (this.buffer.length < length + 1) {
      this.armEscapeTimer();
      return false;
    }
    const sequence = this.buffer.subarray(0, length + 1).toString('utf8');
    const character = sequence.slice(1);
    this.buffer = this.buffer.subarray(length + 1);
    this.emitCharacter(character, sequence, { meta: true });
    return true;
  }

  private drainCharacter(): boolean {
    const first = this.buffer[0] as number;
    const length = utf8Length(first);
    if (this.buffer.length < length) return false;
    const bytes = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    const character = bytes.toString('utf8');
    this.emitCharacter(character, character);
    return true;
  }

  private drainPaste(): boolean {
    const endIndex = this.buffer.indexOf(PASTE_END);
    if (endIndex >= 0) {
      this.appendPasteBytes(this.buffer.subarray(0, endIndex));
      this.buffer = this.buffer.subarray(endIndex + PASTE_END.length);
      const decoder = this.pasteDecoder;
      this.pasteDecoder = null;
      const tail = decoder?.end() ?? '';
      if (tail !== '') this.pasteParts.push(tail);
      this.handlers.paste?.(this.pasteParts.join(''));
      this.pasteParts.length = 0;
      return true;
    }

    // Retain enough bytes to recognize an end marker split across chunks.
    const safeLength = Math.max(0, this.buffer.length - PASTE_END.length + 1);
    if (safeLength === 0) return false;
    this.appendPasteBytes(this.buffer.subarray(0, safeLength));
    this.buffer = this.buffer.subarray(safeLength);
    return false;
  }

  private appendPasteBytes(bytes: Buffer): void {
    if (bytes.length === 0 || this.pasteDecoder === null) return;
    const text = this.pasteDecoder.write(bytes);
    if (text !== '') this.pasteParts.push(text);
  }

  private parseCsi(sequence: Buffer, legacyFunctionKey: boolean): void {
    const bodyStart = legacyFunctionKey ? 3 : 2;
    const body = sequence.subarray(bodyStart, sequence.length - 1).toString('ascii');
    const final = String.fromCharCode(sequence[sequence.length - 1] as number);
    const code = `${legacyFunctionKey ? '[[' : '['}${body}${final}`;

    if (body.startsWith('<') && (final === 'M' || final === 'm')) {
      this.parseSgrMouse(body.slice(1), final);
      return;
    }

    const parameters = body.split(';');
    const hasNumericModifiers = parameters.length === 2
      && parameters.every((parameter) => parameter.length > 0 && Number.isInteger(Number(parameter)));
    const numericKey = Number.parseInt(parameters[0] ?? '', 10);
    const modifierValue = Number.parseInt(parameters[1] ?? '1', 10);
    const modifier = Number.isFinite(modifierValue) && modifierValue > 0 ? modifierValue - 1 : 0;
    const flags = {
      shift: (modifier & 1) !== 0,
      meta: (modifier & 2) !== 0,
      ctrl: (modifier & 4) !== 0,
    };

    if (legacyFunctionKey) {
      const names: Readonly<Record<string, string>> = {
        A: 'f1', B: 'f2', C: 'f3', D: 'f4', E: 'f5',
      };
      const name = names[final];
      if (name !== undefined) this.emitKey(name, sequence.toString('ascii'), flags, code);
      return;
    }

    if (final === 'Z') {
      this.emitKey('tab', sequence.toString('ascii'), { ...flags, shift: true }, code);
      return;
    }

    const csiKeys: Readonly<Record<string, string>> = {
      A: 'up', B: 'down', C: 'right', D: 'left',
      E: 'clear', F: 'end', H: 'home',
      P: 'f1', Q: 'f2', R: 'f3', S: 'f4',
      a: 'up', b: 'down', c: 'right', d: 'left', e: 'clear',
    };
    if (body === '' || body === '1' || hasNumericModifiers) {
      const name = csiKeys[final];
      if (name !== undefined) {
        this.emitKey(name, sequence.toString('ascii'), flags, code);
        return;
      }
    }

    if (final === '~') {
      const names: Readonly<Record<number, string>> = {
        1: 'home', 2: 'insert', 3: 'delete', 4: 'end', 5: 'pageup', 6: 'pagedown',
        7: 'home', 8: 'end', 11: 'f1', 12: 'f2', 13: 'f3', 14: 'f4',
        15: 'f5', 17: 'f6', 18: 'f7', 19: 'f8', 20: 'f9', 21: 'f10',
        23: 'f11', 24: 'f12',
      };
      const name = names[numericKey];
      if (name !== undefined) this.emitKey(name, sequence.toString('ascii'), flags, code);
    }
  }

  private parseSs3(sequence: Buffer): void {
    const body = sequence.subarray(2, sequence.length - 1).toString('ascii');
    const final = String.fromCharCode(sequence[sequence.length - 1] as number);
    const names: Readonly<Record<string, string>> = {
      A: 'up', B: 'down', C: 'right', D: 'left',
      E: 'clear', F: 'end', H: 'home',
      P: 'f1', Q: 'f2', R: 'f3', S: 'f4',
      a: 'up', b: 'down', c: 'right', d: 'left', e: 'clear',
    };
    const name = names[final];
    if (name === undefined) return;
    const flags = body === '' ? {} : parseModifier(body);
    this.emitKey(name, sequence.toString('ascii'), flags, `O${body}${final}`);
  }

  private parseSgrMouse(body: string, final: string): void {
    const match = /^(\d+);(\d+);(\d+)$/.exec(body);
    if (match === null) return;
    const code = Number(match[1]);
    const x = Number(match[2]) - 1;
    const y = Number(match[3]) - 1;
    if (!Number.isFinite(code) || x < 0 || y < 0) return;
    const button = code & 3;
    const action = (code & 64) !== 0
      ? (button === 0 ? 'wheelup' : button === 1 ? 'wheeldown' : null)
      : (final === 'm' ? 'mouseup' : 'mousedown');
    if (action === null) return;
    this.handlers.mouse?.({ action, x, y, button });
  }

  private emitCharacter(
    character: string,
    sequence: string,
    flags: { readonly ctrl?: boolean; readonly meta?: boolean; readonly shift?: boolean } = {},
  ): void {
    const codePoint = character.codePointAt(0) ?? 0;
    if (flags.meta === true) {
      if (character === '\b' || codePoint === 0x7f) {
        this.emitKey('backspace', sequence, { ...flags });
        return;
      }
      if (character === ' ') {
        this.emitKey('space', sequence, { ...flags }, undefined);
      } else if (/^[A-Za-z]$/.test(character)) {
        this.emitKey(character.toLowerCase(), sequence, {
          ...flags,
          shift: character !== character.toLowerCase(),
        });
      } else {
        this.handlers.keypress(undefined, {
          sequence,
          ctrl: flags.ctrl === true,
          meta: true,
          shift: flags.shift === true,
        });
      }
      return;
    }

    if (character === '\r') return this.emitKey('return', sequence, flags);
    if (character === '\n') return this.emitKey('enter', sequence, flags);
    if (character === '\t') return this.emitKey('tab', sequence, flags);
    if (character === '\b' || codePoint === 0x7f) return this.emitKey('backspace', sequence, flags);
    if (character === ' ') return this.emitKey('space', sequence, flags);
    if (codePoint > 0 && codePoint <= 0x1a) {
      return this.emitKey(String.fromCharCode(codePoint + 0x60), sequence, { ...flags, ctrl: true }, undefined, character);
    }
    if (codePoint === 0 || (codePoint >= 0x1c && codePoint <= 0x1f)) {
      const name = codePoint === 0 ? '@' : String.fromCharCode(codePoint + 0x40);
      return this.emitKey(name, sequence, { ...flags, ctrl: true }, undefined, character);
    }
    if (/^[A-Z]$/.test(character)) {
      return this.handlers.keypress(character, {
        sequence,
        name: character.toLowerCase(),
        ctrl: false,
        meta: false,
        shift: true,
      });
    }
    if (/^[a-z]$/.test(character)) {
      return this.handlers.keypress(character, {
        sequence,
        name: character,
        ctrl: false,
        meta: false,
        shift: false,
      });
    }
    this.handlers.keypress(character, {
      sequence,
      ctrl: false,
      meta: false,
      shift: false,
    });
  }

  private emitKey(
    name: string,
    sequence: string,
    flags: { readonly ctrl?: boolean; readonly meta?: boolean; readonly shift?: boolean } = {},
    code?: string,
    ch?: string,
  ): void {
    this.handlers.keypress(ch, {
      sequence,
      name,
      ctrl: flags.ctrl === true,
      meta: flags.meta === true,
      shift: flags.shift === true,
      ...(code === undefined ? {} : { code }),
    });
  }

  private armEscapeTimer(): void {
    if (this.escapeTimer !== null) return;
    const timeout = this.buffer.length === 1 ? this.escapeTimeoutMs : this.sequenceTimeoutMs;
    this.escapeTimer = setTimeout(() => {
      this.escapeTimer = null;
      if (this.buffer[0] !== 0x1b) return;
      if (this.buffer.length === 1) {
        this.buffer = Buffer.alloc(0);
        this.emitKey('escape', '\x1b');
        return;
      }
      this.buffer = this.buffer.subarray(1);
      this.emitKey('escape', '\x1b');
      this.drain();
    }, timeout);
  }

  private clearEscapeTimer(): void {
    if (this.escapeTimer === null) return;
    clearTimeout(this.escapeTimer);
    this.escapeTimer = null;
  }

  private releaseMalformedEscape(): void {
    this.buffer = this.buffer.subarray(1);
    this.emitKey('escape', '\x1b');
  }
}

type RawReadable = NodeJS.ReadableStream & {
  readonly isRaw?: boolean;
  setRawMode?: (mode: boolean) => void;
  pause?: () => unknown;
  resume?: () => unknown;
};

/** Connects the parser to a stream and restores its prior raw-mode state. */
export class OwnKeyInput {
  private readonly input: RawReadable;
  private readonly parser: OwnKeyParser;
  private readonly wasRaw: boolean;
  private disposed = false;
  private readonly onData = (chunk: Buffer | Uint8Array | string): void => {
    this.parser.feed(chunk);
  };

  constructor(input: NodeJS.ReadableStream, parser: OwnKeyParser) {
    this.input = input as RawReadable;
    this.parser = parser;
    this.wasRaw = this.input.isRaw === true;
    this.input.on('data', this.onData);
    if (this.input.setRawMode !== undefined) {
      if (!this.wasRaw) this.input.setRawMode(true);
      this.input.resume?.();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.input.removeListener('data', this.onData);
    this.parser.dispose();
    if (this.input.setRawMode !== undefined && !this.wasRaw) {
      if (this.input.isRaw === true) this.input.setRawMode(false);
      this.input.pause?.();
    }
  }
}

function utf8Length(firstByte: number): number {
  if (firstByte <= 0x7f) return 1;
  if (firstByte >= 0xc2 && firstByte <= 0xdf) return 2;
  if (firstByte >= 0xe0 && firstByte <= 0xef) return 3;
  if (firstByte >= 0xf0 && firstByte <= 0xf4) return 4;
  return 1;
}

function parseModifier(value: string): { ctrl: boolean; meta: boolean; shift: boolean } {
  const parsed = Number.parseInt(value.split(';').at(-1) ?? '1', 10);
  const modifier = Number.isFinite(parsed) && parsed > 0 ? parsed - 1 : 0;
  return {
    shift: (modifier & 1) !== 0,
    meta: (modifier & 2) !== 0,
    ctrl: (modifier & 4) !== 0,
  };
}
