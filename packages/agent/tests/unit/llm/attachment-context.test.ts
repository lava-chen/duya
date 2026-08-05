import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { FileAttachment } from '../../../src/types.js';
import {
  MAX_INLINE_PASTE_LENGTH,
  buildAttachmentContext,
  getAttachmentsRootDir,
  persistLargePastedAttachments,
} from '../../../src/utils/attachment-context.js';

function makeAttachment(overrides: Partial<FileAttachment> = {}): FileAttachment {
  return {
    id: 'att-1',
    kind: 'pasted-text',
    name: 'paste.txt',
    type: 'text/plain',
    url: '',
    size: 0,
    text: 'some pasted content',
    ...overrides,
  };
}

describe('MAX_INLINE_PASTE_LENGTH / getAttachmentsRootDir', () => {
  it('exposes the inline threshold and the ~/.duya/attachments root', () => {
    expect(MAX_INLINE_PASTE_LENGTH).toBe(8000);
    expect(getAttachmentsRootDir()).toBe(path.join(os.homedir(), '.duya', 'attachments'));
  });
});

describe('persistLargePastedAttachments', () => {
  it('keeps small pasted text unchanged (inline)', async () => {
    const small = makeAttachment({ id: 's1', text: 'short' });
    const result = await persistLargePastedAttachments([small], '/tmp/attachments');
    expect(result).toEqual([small]);
  });

  it('keeps non-pasted attachments unchanged', async () => {
    const file = makeAttachment({ id: 'f1', kind: 'file', text: 'x'.repeat(9000) });
    const result = await persistLargePastedAttachments([file], '/tmp/attachments');
    expect(result).toEqual([file]);
  });

  it('persists large pasted text to disk and rewrites it as a path pointer', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-att-'));
    try {
      const large = makeAttachment({ id: 'big-1', text: 'x'.repeat(MAX_INLINE_PASTE_LENGTH + 1) });
      const result = await persistLargePastedAttachments([large], dir);

      expect(result).toHaveLength(1);
      const persisted = result[0];
      expect(persisted.id).toBe('big-1');
      expect(persisted.kind).toBe('pasted-text');
      expect(persisted.text).toBeUndefined();
      expect(persisted.path).toBe(path.join(dir, 'pasted-big-1.txt'));
      expect(persisted.size).toBe(MAX_INLINE_PASTE_LENGTH + 1);

      const onDisk = await fs.readFile(persisted.path!, 'utf8');
      expect(onDisk).toBe('x'.repeat(MAX_INLINE_PASTE_LENGTH + 1));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('falls back to the unchanged attachment when the write fails', async () => {
    const large = makeAttachment({ id: 'big-2', text: 'y'.repeat(MAX_INLINE_PASTE_LENGTH + 1) });
    const mkdirSpy = vi.spyOn(fs, 'mkdir').mockRejectedValueOnce(new Error('denied'));
    try {
      const result = await persistLargePastedAttachments([large], '/definitely/not/writable');
      expect(result).toEqual([large]);
    } finally {
      mkdirSpy.mockRestore();
    }
  });
});

describe('buildAttachmentContext', () => {
  it('inlines small pasted text as parsed content', () => {
    const small = makeAttachment({ id: 's1', text: 'hello world' });
    const context = buildAttachmentContext([small]);
    expect(context).toBeTruthy();
    expect(context).toContain('hello world');
    expect(context).not.toContain('Pasted Text');
  });

  it('surfaces a file pointer for a persisted pasted-text attachment', () => {
    const persisted = makeAttachment({
      id: 'big-1',
      text: undefined,
      path: '/tmp/attachments/pasted-big-1.txt',
    });
    const context = buildAttachmentContext([persisted]);
    expect(context).toBeTruthy();
    expect(context).toContain('[System Attached File - Pasted Text]');
    expect(context).toContain('/tmp/attachments/pasted-big-1.txt');
    expect(context).toContain('Read the file');
  });
});