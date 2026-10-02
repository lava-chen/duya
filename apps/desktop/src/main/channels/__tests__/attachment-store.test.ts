/**
 * attachment-store.test.ts — unit tests for the inbound channel attachment
 * store (plan 507 P1.2).
 *
 * The shared agents root (plan 526) is resolved through the ConfigStore
 * singleton, so a temp store is injected per test and persistence runs
 * against a real filesystem without touching the app data. The electron
 * mock stays in place for the module import chain.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mocks = vi.hoisted(() => ({
  userDataDir: '',
}));

vi.mock('electron', () => ({
  app: {
    getPath: (_name: string) => mocks.userDataDir,
  },
}));

import { ConfigStore } from '../../config/store';
import { _setConfigStoreForTest } from '../../config/store-instance';
import {
  persistInboundAttachment,
  persistInboundAttachments,
  inboundAttachmentDir,
  sanitizeFileName,
  attachmentKindOf,
} from '../attachment-store';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-attachment-store-'));
  mocks.userDataDir = tmpRoot;
  _setConfigStoreForTest(
    new ConfigStore({
      configPath: path.join(tmpRoot, 'config.toml'),
      secretsPath: path.join(tmpRoot, 'secrets.json'),
    }),
  );
});

afterEach(() => {
  _setConfigStoreForTest(undefined);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('sanitizeFileName', () => {
  it('keeps normal names intact', () => {
    expect(sanitizeFileName('report.xlsx')).toBe('report.xlsx');
  });

  it('replaces path separators and control characters', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('etc_passwd');
    expect(sanitizeFileName('a/b\\c:d')).toBe('a_b_c_d');
  });

  it('falls back to a generic name when everything is stripped', () => {
    expect(sanitizeFileName('???')).toBe('file');
    expect(sanitizeFileName('')).toBe('file');
  });
});

describe('attachmentKindOf', () => {
  it('classifies by MIME prefix', () => {
    expect(attachmentKindOf('image/png')).toBe('image');
    expect(attachmentKindOf('audio/ogg')).toBe('audio');
    expect(attachmentKindOf('video/mp4')).toBe('video');
    expect(attachmentKindOf('application/pdf')).toBe('document');
    expect(attachmentKindOf('text/csv')).toBe('document');
  });
});

describe('persistInboundAttachment', () => {
  it('persists a buffer source with a stable path and metadata', async () => {
    const result = await persistInboundAttachment('bot-1', 'telegram', {
      kind: 'buffer',
      buffer: Buffer.from('hello'),
    }, 'notes.txt');

    expect(result.skippedReason).toBeUndefined();
    expect(result.attachment).not.toBeNull();
    const att = result.attachment!;
    expect(att.name).toBe('notes.txt');
    expect(att.mimeType).toBe('text/plain');
    expect(att.kind).toBe('document');
    expect(att.size).toBe(5);
    expect(att.path).toBe(
      path.join(
        inboundAttachmentDir('bot-1', 'telegram'),
        path.basename(att.path),
      ),
    );
    expect(fs.existsSync(att.path)).toBe(true);
    expect(fs.readFileSync(att.path, 'utf-8')).toBe('hello');
    // No leftover temp files.
    expect(fs.readdirSync(path.dirname(att.path))).toEqual([path.basename(att.path)]);
  });

  it('persists a path source by copying from the temp cache', async () => {
    const src = path.join(tmpRoot, 'cache-photo.jpg');
    fs.writeFileSync(src, Buffer.from([0xff, 0xd8, 0xff, 0x00]));

    const result = await persistInboundAttachment('bot-1', 'weixin', {
      kind: 'path',
      path: src,
    }, 'photo.jpg');

    expect(result.attachment!.kind).toBe('image');
    expect(result.attachment!.mimeType).toBe('image/jpeg');
    // Source copy is untouched; the persisted file is separate.
    expect(result.attachment!.path).not.toBe(src);
    expect(fs.existsSync(result.attachment!.path)).toBe(true);
  });

  it('skips oversize attachments with a reason', async () => {
    // 11 MB buffer against the 10 MB image cap (image inferred from .png).
    const big = Buffer.alloc(11 * 1024 * 1024);
    const result = await persistInboundAttachment('bot-1', 'telegram', {
      kind: 'buffer',
      buffer: big,
    }, 'huge.png');

    expect(result.attachment).toBeNull();
    expect(result.skippedReason).toContain('exceeds the 10 MB limit');
  });

  it('skips an unreadable path source with a reason', async () => {
    const result = await persistInboundAttachment('bot-1', 'telegram', {
      kind: 'path',
      path: path.join(tmpRoot, 'does-not-exist.bin'),
    }, 'gone.bin');

    expect(result.attachment).toBeNull();
    expect(result.skippedReason).toContain('could not read source');
  });

  it('throws on identifiers that could escape the agents directory', async () => {
    await expect(
      persistInboundAttachment('../evil', 'telegram', { kind: 'buffer', buffer: Buffer.from('x') }, 'x.txt'),
    ).rejects.toThrow(/invalid ownerId/);
    await expect(
      persistInboundAttachment('bot-1', 'a/b', { kind: 'buffer', buffer: Buffer.from('x') }, 'x.txt'),
    ).rejects.toThrow(/invalid platform/);
  });

  it('applies the 25 MB limit to video kinds', async () => {
    const big = Buffer.alloc(25 * 1024 * 1024 + 1);
    const result = await persistInboundAttachment('bot-1', 'telegram', {
      kind: 'buffer',
      buffer: big,
    }, 'clip.mp4');

    expect(result.attachment).toBeNull();
    expect(result.skippedReason).toContain('25 MB');
  });
});

describe('persistInboundAttachments', () => {
  it('persists entries in order and keeps going after a skip', async () => {
    const results = await persistInboundAttachments('bot-1', 'feishu', [
      { source: { kind: 'buffer', buffer: Buffer.from('a') }, name: 'a.txt' },
      { source: { kind: 'buffer', buffer: Buffer.alloc(0) }, name: 'empty.txt' },
      { source: { kind: 'buffer', buffer: Buffer.from('c') }, name: 'c.csv' },
    ]);

    expect(results).toHaveLength(3);
    expect(results[0].attachment!.name).toBe('a.txt');
    expect(results[1].attachment).toBeNull();
    expect(results[1].skippedReason).toContain('empty');
    expect(results[2].attachment!.name).toBe('c.csv');
  });
});
