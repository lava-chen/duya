import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  attachmentChipLabel,
  extractPathPasteCandidate,
  findAttachmentLimitViolation,
  mimeTypeForExtension,
  resolveClipboardFileAttachment,
  resolvePathAttachment,
  stripSurroundingQuotes,
  takeAttachmentsForSubmit,
  toFileAttachments,
  MAX_ATTACHMENTS,
  type TuiDraftAttachment,
} from '../attachments.js';
import { buildClipboardScript, parseClipboardScriptOutput } from '../clipboard-image.js';

const tempRoot = await mkdtemp(join(tmpdir(), 'duya-tui-attachments-test-'));
afterAll(async () => {
  await import('node:fs/promises').then((fs) => fs.rm(tempRoot, { recursive: true, force: true }));
});

async function touch(name: string, bytes = 5): Promise<string> {
  const filePath = join(tempRoot, name);
  await writeFile(filePath, Buffer.alloc(bytes, 1));
  return filePath;
}

describe('stripSurroundingQuotes', () => {
  it('strips one matching pair of quotes', () => {
    expect(stripSurroundingQuotes('"C:\\my file\\a.png"')).toBe('C:\\my file\\a.png');
    expect(stripSurroundingQuotes("'/tmp/a b.png'")).toBe('/tmp/a b.png');
  });

  it('leaves mismatched or unquoted text alone', () => {
    expect(stripSurroundingQuotes('"abc')).toBe('"abc');
    expect(stripSurroundingQuotes('abc')).toBe('abc');
  });
});

describe('extractPathPasteCandidate', () => {
  it('accepts quoted windows and posix absolute paths', () => {
    expect(extractPathPasteCandidate('"E:\\shots\\a.png"\n')).toBe('E:\\shots\\a.png');
    expect(extractPathPasteCandidate(' /tmp/a.png ')).toBe('/tmp/a.png');
  });

  it('unescapes POSIX-style escaped spaces', () => {
    expect(extractPathPasteCandidate('/tmp/my\\ file.png')).toBe('/tmp/my file.png');
  });

  it('rejects multiline, relative and empty payloads', () => {
    expect(extractPathPasteCandidate('a.png\nb.png')).toBeNull();
    expect(extractPathPasteCandidate('relative/a.png')).toBeNull();
    expect(extractPathPasteCandidate('   ')).toBeNull();
  });
});

describe('resolvePathAttachment', () => {
  it('resolves an existing image with mime and kind', async () => {
    const filePath = await touch('shot.png');
    const attachment = await resolvePathAttachment(filePath);
    expect(attachment).not.toBeNull();
    expect(attachment?.kind).toBe('image');
    expect(attachment?.mimeType).toBe('image/png');
    expect(attachment?.size).toBe(5);
    expect(attachment?.name).toBe('shot.png');
  });

  it('resolves a document as kind file', async () => {
    const filePath = await touch('report.pdf');
    const attachment = await resolvePathAttachment(filePath);
    expect(attachment?.kind).toBe('file');
    expect(attachment?.mimeType).toBe('application/pdf');
  });

  it('rejects non-attachable extensions, directories and missing files', async () => {
    const code = await touch('app.ts');
    expect(await resolvePathAttachment(code)).toBeNull();
    expect(await resolvePathAttachment(tempRoot)).toBeNull();
    expect(await resolvePathAttachment(join(tempRoot, 'missing.png'))).toBeNull();
  });
});

describe('resolveClipboardFileAttachment', () => {
  it('accepts any extension with an explicit mime or a generic fallback', async () => {
    const video = await touch('clip.mp4');
    const attachment = await resolveClipboardFileAttachment(video, 'video/mp4');
    expect(attachment?.kind).toBe('file');
    expect(attachment?.mimeType).toBe('video/mp4');

    const unknown = await touch('blob.bin');
    const fallback = await resolveClipboardFileAttachment(unknown, null);
    expect(fallback?.mimeType).toBe('application/octet-stream');
  });
});

describe('attachmentChipLabel', () => {
  it('labels images and files differently and embeds the sequence', () => {
    const base = { id: '1', name: 'a.png', mimeType: 'image/png', size: 1, filePath: '/a.png' };
    expect(attachmentChipLabel({ ...base, kind: 'image' }, 3)).toBe('[Image #3 a.png]');
    expect(attachmentChipLabel({ ...base, kind: 'file' }, 4)).toBe('[File #4 a.png]');
  });
});

describe('findAttachmentLimitViolation', () => {
  const attachment = (size: number): TuiDraftAttachment => ({
    id: 'x', kind: 'file', name: 'a.bin', mimeType: 'application/octet-stream', size, filePath: '/a.bin', label: '[File #1 a.bin]',
  });

  it('flags the count ceiling', () => {
    const full = Array.from({ length: MAX_ATTACHMENTS }, (_, i) => attachment(i));
    expect(findAttachmentLimitViolation(full, 0)).toBe('count');
  });

  it('flags the total size ceiling', () => {
    expect(findAttachmentLimitViolation([attachment(99 * 1024 * 1024)], 2 * 1024 * 1024)).toBe('total-size');
    expect(findAttachmentLimitViolation([attachment(1024)], 1024)).toBeNull();
  });
});

describe('toFileAttachments', () => {
  it('maps the draft onto the protocol shape with the path in url and path', () => {
    const [file] = toFileAttachments([{
      id: 'id-1', kind: 'image', name: 'a.png', mimeType: 'image/png', size: 7, filePath: '/tmp/a.png',
    }]);
    expect(file).toEqual({
      id: 'id-1', kind: 'image', name: 'a.png', type: 'image/png', url: '/tmp/a.png', size: 7, path: '/tmp/a.png',
    });
  });
});

describe('takeAttachmentsForSubmit', () => {
  it('keeps attachments whose chip label survived and drops the rest', () => {
    const kept: TuiDraftAttachment = {
      id: 'k', kind: 'image', name: 'k.png', mimeType: 'image/png', size: 1, filePath: '/k.png', label: '[Image #1 k.png]',
    };
    const dropped: TuiDraftAttachment = {
      id: 'd', kind: 'file', name: 'd.pdf', mimeType: 'application/pdf', size: 1, filePath: '/d.pdf', label: '[File #2 d.pdf]',
    };
    const submitted = 'look at [Image #1 k.png] please';
    expect(takeAttachmentsForSubmit([kept, dropped], submitted)).toEqual(toFileAttachments([kept]));
  });
});

describe('mimeTypeForExtension', () => {
  it('covers images, documents and rejects unknown extensions', () => {
    expect(mimeTypeForExtension('C:\\a\\b.PNG')).toBe('image/png');
    expect(mimeTypeForExtension('/a/b.docx')).toContain('wordprocessingml');
    expect(mimeTypeForExtension('/a/b.ts')).toBeNull();
  });
});

describe('clipboard script', () => {
  it('single-quotes the save path for PowerShell', () => {
    const script = buildClipboardScript('C:\\temp\\x.png');
    expect(script).toContain('$img.Save(\'C:\\temp\\x.png\'');
  });

  it('parses the image, file list and empty outcomes', () => {
    expect(parseClipboardScriptOutput('IMAGE C:\\t\\a.png\r\n')).toEqual({ kind: 'image', filePath: 'C:\\t\\a.png' });
    expect(parseClipboardScriptOutput('FILE C:\\t\\a b.mp4\r\nFILE C:\\t\\c.pdf\r\n')).toEqual({
      kind: 'files',
      paths: ['C:\\t\\a b.mp4', 'C:\\t\\c.pdf'],
    });
    expect(parseClipboardScriptOutput('EMPTY\r\n')).toEqual({ kind: 'empty' });
    expect(parseClipboardScriptOutput('')).toEqual({ kind: 'empty' });
  });
});

describe('clipboard temp files', () => {
  it('resolves a clipboard image written into the temp root', async () => {
    const dir = await mkdir(join(tempRoot, 'clip'), { recursive: true });
    const filePath = await touch(join('clip', 'clipboard-1.png'));
    void dir;
    const attachment = await resolveClipboardFileAttachment(filePath, 'image/png');
    expect(attachment?.kind).toBe('image');
  });
});
