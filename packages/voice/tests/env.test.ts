/**
 * tests/env.test.ts — unit tests for voice environment detection:
 * PATH lookup separator handling, explicit binary_path override, and the
 * truncated-model sanity check in checkModel.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkModel,
  detectWhisperBinary,
  MIN_MODEL_BYTES,
} from '../src/env';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'duya-voice-env-'));
}

describe('detectWhisperBinary — PATH lookup', () => {
  it('finds the binary via the platform-native PATH separator', () => {
    const dir = makeTempDir();
    try {
      const name = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
      const binPath = join(dir, name);
      writeFileSync(binPath, 'fake binary');

      const sep = process.platform === 'win32' ? ';' : ':';
      const prevPath = process.env.PATH;
      process.env.PATH = `${dir}${sep}${prevPath ?? ''}`;
      try {
        const result = detectWhisperBinary(process.platform);
        // PATH hit must win over hardcoded candidate locations.
        expect(result.found).toBe(true);
        expect(result.path?.toLowerCase()).toBe(binPath.toLowerCase());
        expect(result.source).toBe('path');
      } finally {
        if (prevPath === undefined) delete process.env.PATH;
        else process.env.PATH = prevPath;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('honors an explicit binary_path before any other source', () => {
    const dir = makeTempDir();
    try {
      const p = join(dir, 'my-whisper.exe');
      writeFileSync(p, 'x');
      const result = detectWhisperBinary(process.platform, p);
      expect(result).toEqual({ found: true, path: p, source: 'config' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores a pip-installed Python `whisper` entry point on PATH', () => {
    const dir = makeTempDir();
    try {
      // Python openai-whisper ships this exact name; it is NOT whisper.cpp.
      const pyName = process.platform === 'win32' ? 'whisper.exe' : 'whisper';
      writeFileSync(join(dir, pyName), 'fake python entrypoint');

      const sep = process.platform === 'win32' ? ';' : ':';
      const prevPath = process.env.PATH;
      process.env.PATH = `${dir}${sep}${prevPath ?? ''}`;
      try {
        const result = detectWhisperBinary(process.platform);
        // Whatever is found, it must not be the Python entrypoint we planted.
        if (result.found && result.path) {
          expect(result.path.toLowerCase()).not.toContain(dir.toLowerCase());
        }
      } finally {
        if (prevPath === undefined) delete process.env.PATH;
        else process.env.PATH = prevPath;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('checkModel — truncated download sanity check', () => {
  it('reports not-ready for a sub-1MB leftover file', () => {
    const dir = makeTempDir();
    try {
      const p = join(dir, 'ggml-base.bin');
      writeFileSync(p, Buffer.alloc(1024)); // 1 KB leftover — clearly truncated
      const status = checkModel(p);
      expect(status.ready).toBe(false);
      expect(status.sizeMb).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports ready once the file reaches a plausible model size', () => {
    const dir = makeTempDir();
    try {
      const p = join(dir, 'ggml-base.bin');
      writeFileSync(p, Buffer.alloc(MIN_MODEL_BYTES));
      const status = checkModel(p);
      expect(status.ready).toBe(true);
      expect(status.sizeMb).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports not-ready when the file is absent', () => {
    const status = checkModel(join(makeTempDirNeverCreated(), 'missing.bin'));
    expect(status.ready).toBe(false);
  });

  function makeTempDirNeverCreated(): string {
    const base = makeTempDir();
    mkdirSync(base, { recursive: true });
    return join(base, 'nope');
  }
});
