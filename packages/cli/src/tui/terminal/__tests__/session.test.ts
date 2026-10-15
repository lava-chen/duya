import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { TerminalSession } from '../session.js';

function ttyOutput(rows = 31, columns = 97): PassThrough & {
  isTTY: boolean;
  rows: number;
  columns: number;
} {
  return Object.assign(new PassThrough(), { isTTY: true, rows, columns });
}

describe('TerminalSession', () => {
  it('forwards resize from the injected TTY through the real writer emitter', () => {
    const output = ttyOutput();
    const session = new TerminalSession({ output });
    const listener = vi.fn();
    session.writer.on('resize', listener);

    output.emit('resize');

    expect(listener).toHaveBeenCalledOnce();
    expect(session.writer.columns).toBe(97);
    expect(session.writer.rows).toBe(31);
    session.dispose();
    output.destroy();
  });

  it('prefers injected TTY geometry and lets an explicit size provider override it', () => {
    const output = ttyOutput(42, 116);
    const session = new TerminalSession({ output });
    expect(session.size()).toEqual({ rows: 42, columns: 116 });

    const explicit = new TerminalSession({
      output,
      size: () => ({ rows: 18, columns: 60 }),
    });
    expect(explicit.size()).toEqual({ rows: 18, columns: 60 });
    expect(explicit.writer.rows).toBe(18);
    expect(explicit.writer.columns).toBe(60);

    session.dispose();
    explicit.dispose();
    output.destroy();
  });

  it('uses process.stdout for geometry and resize when injected output has no TTY geometry', () => {
    const output = new PassThrough();
    const before = process.stdout.listenerCount('resize');
    const session = new TerminalSession({ output });
    const listener = vi.fn();
    session.writer.on('resize', listener);

    expect(process.stdout.listenerCount('resize')).toBe(before + 1);
    expect(session.size()).toEqual({
      rows: process.stdout.rows ?? 24,
      columns: process.stdout.columns ?? 80,
    });
    process.stdout.emit('resize');
    expect(listener).toHaveBeenCalledOnce();

    session.dispose();
    expect(process.stdout.listenerCount('resize')).toBe(before);
    output.destroy();
  });

  it('removes each resize listener on repeated disposal', () => {
    const output = ttyOutput();
    const before = output.listenerCount('resize');
    const sessions = Array.from({ length: 4 }, () => new TerminalSession({ output }));

    expect(output.listenerCount('resize')).toBe(before + sessions.length);
    for (const session of sessions) {
      session.dispose();
      session.dispose();
    }
    expect(output.listenerCount('resize')).toBe(before);

    output.destroy();
  });

  it('flushes held output once when disposed', () => {
    const output = ttyOutput();
    const written: string[] = [];
    output.on('data', (chunk: Buffer) => written.push(chunk.toString('utf8')));
    const session = new TerminalSession({ output });

    session.writer.write('\u001b[31');
    expect(written).toEqual([]);

    session.dispose();
    session.dispose();

    expect(written.join('')).toBe('\u001b[31');
    output.destroy();
  });
});
