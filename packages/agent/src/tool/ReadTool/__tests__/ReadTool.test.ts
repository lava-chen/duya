/**
 * ReadTool document-mode integration test
 *
 * Verifies the new dispatch path: text files keep the legacy behavior,
 * PDF/DOCX/PPTX/PNG route through NodeFileParser, errors are
 * consistently reported, and metadata flows through to UI.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ReadTool,
  _resetSharedParser,
  isMainModelMultimodal,
  type ReadInput,
} from '../ReadTool.js';
import { _resetFileParserConfig } from '../../../file-parser/config.js';
import { Jimp } from 'jimp';
import type { ToolUseContext, ToolUseContextOptions } from '../../../types.js';

let tmpDir: string;
let tool: ReadTool;

beforeEach(() => {
  _resetFileParserConfig();
  _resetSharedParser();
  tmpDir = mkdtempSync(join(tmpdir(), 'duya-readtool-'));
  tool = new ReadTool();
});

afterEach(() => {
  _resetFileParserConfig();
  _resetSharedParser();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function makePng(path: string, w = 100, h = 100): Promise<void> {
  const img = new Jimp({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      img.setPixelColor(0x00ff00ff, x, y);
    }
  }
  const buf = await img.getBuffer('image/png');
  writeFileSync(path, buf);
}

describe('ReadTool text mode (legacy)', () => {
  it('reads a small text file with cat -n formatting', async () => {
    const f = join(tmpDir, 'a.txt');
    writeFileSync(f, 'first\nsecond\nthird');
    const result = await tool.execute({ file_path: f });
    expect(result.error).toBeFalsy();
    expect(result.result).toContain('File:');
    expect(result.result).toContain('Lines: 1-3');
    expect(result.result).toContain('first');
    expect(result.result).toContain('second');
    expect(result.result).toContain('third');
  });

  it('honors line_range when provided', async () => {
    const f = join(tmpDir, 'a.txt');
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n');
    writeFileSync(f, lines);
    const result = await tool.execute({
      file_path: f,
      line_range: { start: 10, end: 12 },
    });
    expect(result.error).toBeFalsy();
    expect(result.result).toContain('line 10');
    expect(result.result).toContain('line 11');
    expect(result.result).toContain('line 12');
    expect(result.result).not.toContain('line 13');
  });

  it('rejects UNC paths', async () => {
    const result = await tool.execute({ file_path: '\\\\evil-share\\file.txt' });
    expect(result.error).toBe(true);
    expect(result.result).toContain('UNC');
  });

  it('reports missing file as error', async () => {
    const result = await tool.execute({ file_path: join(tmpDir, 'missing.txt') });
    expect(result.error).toBe(true);
    expect(result.result).toMatch(/not found|ENOENT/);
  });

  it('re-reads the same unmodified file deterministically (no dedup stub)', async () => {
    // Every read returns the full content — no "file unchanged" stub. This
    // keeps output byte-identical across calls so identical reads hit the
    // provider prompt cache instead of a short stub that breaks the prefix.
    const f = join(tmpDir, 'repeat.txt');
    writeFileSync(f, 'cached content\n');
    const first = await tool.execute({ file_path: f });
    expect(first.error).toBeFalsy();
    expect(first.result).toContain('cached content');

    const second = await tool.execute({ file_path: f });
    expect(second.error).toBeFalsy();
    expect(second.result).toContain('cached content');
    expect(second.result).not.toContain('File unchanged');
    expect(second.result).toBe(first.result);
  });

  it('returns fresh content after the file changes', async () => {
    const f = join(tmpDir, 'mod.txt');
    writeFileSync(f, 'first version');
    const first = await tool.execute({ file_path: f });
    expect(first.result).toContain('first version');

    writeFileSync(f, 'second version');
    const second = await tool.execute({ file_path: f });
    expect(second.result).toContain('second version');
    expect(second.result).not.toContain('first version');
  });

  it('blocks device files at validation time', async () => {
    const result = await tool.execute({ file_path: '/dev/zero' });
    expect(result.error).toBe(true);
    expect(result.result).toMatch(/device file|would block/);
  });

  it('refuses to read a binary file masquerading as text', async () => {
    // PNG magic bytes 89 50 4E 47 — flagged as binary by magic-byte check
    const f = join(tmpDir, 'looks-like.txt');
    writeFileSync(f, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]));
    const result = await tool.execute({ file_path: f });
    expect(result.error).toBe(true);
    expect(result.result).toMatch(/binary|security/i);
  });

  it('suggests a similar filename on ENOENT in the same directory', async () => {
    const f = join(tmpDir, 'config.json');
    writeFileSync(f, '{}');
    const result = await tool.execute({ file_path: join(tmpDir, 'confg.json') });
    expect(result.error).toBe(true);
    expect(result.result).toMatch(/Did you mean.*config\.json/);
  });
});

describe('ReadTool document mode (NodeFileParser)', () => {
  it('rejects image files and points at the vision_analyze tool', async () => {
    const f = join(tmpDir, 'img.png');
    await makePng(f, 200, 100);
    const result = await tool.execute({ file_path: f });
    expect(result.error).toBe(true);
    expect(result.result).toContain('image file');
    expect(result.result).toContain('`vision_analyze`');
  });

  it('rejects unsupported binary formats', async () => {
    const f = join(tmpDir, 'archive.zip');
    writeFileSync(f, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const result = await tool.execute({ file_path: f });
    expect(result.error).toBe(true);
    expect(result.result).toContain('unsupported binary format');
  });

  it('points .xlsx files at the xlsx skill', async () => {
    const f = join(tmpDir, 'grades.xlsx');
    writeFileSync(f, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const result = await tool.execute({ file_path: f });
    expect(result.error).toBe(true);
    expect(result.result).toContain('`xlsx` skill');
  });

  it('accepts .md via text mode path', async () => {
    const f = join(tmpDir, 'doc.md');
    writeFileSync(f, '# heading\n\nbody');
    const result = await tool.execute({ file_path: f });
    expect(result.error).toBeFalsy();
    expect(result.result).toContain('# heading');
  });

  it('ignores max_tokens in text mode (only document mode truncates)', async () => {
    // .txt is in TEXT_EXTENSIONS so isDocMode returns false → text mode.
    // Text mode (readFileContent) does NOT honor max_tokens — it returns
    // the full file. max_tokens only applies to document mode
    // (PDF/DOCX/etc.) via serializeParseResult. This test pins that
    // behavior so a future change doesn't silently start truncating
    // text reads based on max_tokens (full reads are capped only by the
    // fixed 2000-line / 50KB ceiling, independent of max_tokens).
    const f = join(tmpDir, 'long.txt');
    const content = 'small body line\nsecond line\n';
    writeFileSync(f, content);
    const result = await tool.execute({
      file_path: f,
      max_tokens: 100, // ~400 chars — would truncate in document mode
    });
    expect(result.error).toBeFalsy();
    // Text mode returns the full content; max_tokens is ignored.
    expect(result.result).toContain('File:');
    expect(result.result).toContain('Lines:');
    expect(result.result).toContain('small body line');
    expect(result.result).toContain('second line');
    // No truncation note because a small file is under every ceiling.
    expect(result.result).not.toMatch(/truncated/i);
  });

  it('truncates a full read at 2000 lines with metadata explaining the remainder', async () => {
    // More lines than FULL_READ_MAX_LINES but far under the 50KB byte
    // ceiling → only the line cap applies.
    const f = join(tmpDir, 'many-lines.txt');
    const lines = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`);
    writeFileSync(f, lines.join('\n'));
    const result = await tool.execute({ file_path: f });
    expect(result.error).toBeFalsy();
    expect(result.result).toContain('Lines: 1-2000');
    expect(result.result).toContain('line 2000');
    expect(result.result).not.toContain('line 2001');
    expect(result.result).toMatch(/\[Read metadata: returned 2000 of 3000 lines/);
    expect(result.result).toMatch(/truncated to first 2000 of 3000 lines/);
    expect(result.result).toMatch(/read the remaining lines/);
    expect(result.metadata).toMatchObject({ lineCount: 2000, totalLines: 3000 });
  });

  it('truncates a full read at 50KB for a file with very long lines', async () => {
    // One line containing 200KB of text → line cap is irrelevant, the
    // UTF-8 byte cap (50KB) must cut the output.
    const f = join(tmpDir, 'mono-line.txt');
    const content = 'x'.repeat(200_000);
    writeFileSync(f, content);
    const result = await tool.execute({ file_path: f });
    expect(result.error).toBeFalsy();
    expect(result.result).toContain('Lines: 1-1');
    expect(result.result).toContain('File:');
    expect(result.result).toMatch(/\[Read metadata: returned 1 of 1 lines/);
    expect(result.result).toMatch(/truncated at ~50KB/);
    expect(result.result).toMatch(/read the remaining lines/);
    // Truncated body must be far smaller than the 200KB source.
    expect(result.result.length).toBeLessThan(70_000);
    expect(result.metadata).toMatchObject({ lineCount: 1, totalLines: 1 });
  });

  it('returns the full content for a small file (under both ceilings)', async () => {
    const f = join(tmpDir, 'small.txt');
    const content = Array.from({ length: 5 }, (_, i) => `small ${i + 1}`).join('\n');
    writeFileSync(f, content);
    const result = await tool.execute({ file_path: f });
    expect(result.error).toBeFalsy();
    expect(result.result).toContain('small 1');
    expect(result.result).toContain('small 5');
    expect(result.result).not.toMatch(/truncated/i);
    expect(result.result).not.toMatch(/Read metadata/);
    expect(result.metadata).toMatchObject({ lineCount: 5, totalLines: 5 });
  });

  it('routes through text path when line_range is provided', async () => {
    const f = join(tmpDir, 'a.txt');
    writeFileSync(f, 'a\nb\nc\nd\ne');
    const result = await tool.execute({
      file_path: f,
      line_range: { start: 2, end: 3 },
    });
    expect(result.error).toBeFalsy();
    expect(result.result).toContain('b');
    expect(result.result).toContain('c');
  });
});

describe('ReadTool input validation (new fields)', () => {
  const base = { file_path: '/x' };

  it('accepts valid pages range', async () => {
    const result = await tool.execute({ ...base, pages: '1-5' });
    // file may not exist, but the validation should pass
    expect(result.error).not.toContain('pages must be');
  });

  it('rejects invalid pages format', async () => {
    const result = await tool.execute({ ...base, pages: 'abc' });
    expect(result.error).toBe(true);
    expect(result.result).toContain('pages must be');
  });

  it('rejects negative max_tokens', async () => {
    const result = await tool.execute({ ...base, max_tokens: -1 });
    expect(result.error).toBe(true);
    expect(result.result).toContain('max_tokens');
  });
});

describe('ReadTool kill switch (DUYA_FILE_PARSER_DISABLED)', () => {
  it('blocks document reads when disabled via env', async () => {
    process.env.DUYA_FILE_PARSER_DISABLED = '1';
    _resetFileParserConfig();
    _resetSharedParser();
    const f = join(tmpDir, 'img.png');
    await makePng(f);
    const result = await tool.execute({ file_path: f });
    expect(result.error).toBe(true);
    expect(result.result).toContain('DUYA_FILE_PARSER_DISABLED');
  });

  it('does NOT block text reads when disabled (text path is independent)', async () => {
    process.env.DUYA_FILE_PARSER_DISABLED = '1';
    _resetFileParserConfig();
    _resetSharedParser();
    const f = join(tmpDir, 'a.txt');
    writeFileSync(f, 'plain text content');
    const result = await tool.execute({ file_path: f });
    expect(result.error).toBeFalsy();
    expect(result.result).toContain('plain text content');
  });
});

describe('ReadTool.renderToolResultMessage', () => {
  it('renders error results as type=error', () => {
    const msg = tool.renderToolResultMessage({
      id: 'x',
      name: 'read',
      result: 'something failed',
      error: true,
    });
    expect(msg.type).toBe('error');
    expect(msg.content).toBe('something failed');
  });

  it('renders text results as type=text', () => {
    const msg = tool.renderToolResultMessage({
      id: 'x',
      name: 'read',
      result: 'File: /a.txt\n\nplain text',
    });
    expect(msg.type).toBe('text');
  });

  it('renders line-numbered results as type=code', () => {
    const msg = tool.renderToolResultMessage({
      id: 'x',
      name: 'read',
      result: '1: line one\n2: line two',
    });
    expect(msg.type).toBe('code');
    expect((msg.metadata as Record<string, unknown>)?.lineCount).toBe(2);
  });
});

describe('ReadTool.generateUserFacingDescription', () => {
  it('formats plain path', () => {
    expect(tool.generateUserFacingDescription({ file_path: '/a.txt' })).toBe('read: /a.txt');
  });

  it('formats line range', () => {
    expect(
      tool.generateUserFacingDescription({
        file_path: '/a.txt',
        line_range: { start: 1, end: 10 },
      }),
    ).toBe('read: /a.txt:1-10');
  });

  it('formats PDF pages', () => {
    expect(
      tool.generateUserFacingDescription({
        file_path: '/a.pdf',
        pages: '1-5',
      }),
    ).toBe('read: /a.pdf (pdf, pages 1-5)');
  });
});

describe('ReadTool allowedRoots sandbox', () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    _resetFileParserConfig();
    _resetSharedParser();
    root = mkdtempSync(join(tmpdir(), 'duya-read-roots-'));
    outside = mkdtempSync(join(tmpdir(), 'duya-read-out-'));
    mkdirSync(join(root, 'memory'), { recursive: true });
    writeFileSync(join(root, 'memory', 'inside.md'), 'inside content');
    writeFileSync(join(outside, 'outside.md'), 'outside content');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('rejects a read outside allowedRoots', async () => {
    const tool = new ReadTool({ allowedRoots: [join(root, 'memory')] });
    const result = await tool.execute({ file_path: join(outside, 'outside.md') });
    expect(result.error).toBe(true);
    expect(result.result).toContain('outside the allowed roots');
  });

  it('allows a read inside allowedRoots', async () => {
    const tool = new ReadTool({ allowedRoots: [join(root, 'memory')] });
    const result = await tool.execute({ file_path: join(root, 'memory', 'inside.md') });
    expect(result.error).toBeFalsy();
    expect(result.result).toContain('inside content');
  });

  it('accepts multiple roots and rejects a path outside all of them', async () => {
    const otherRoot = mkdtempSync(join(tmpdir(), 'duya-read-other-'));
    try {
      mkdirSync(join(otherRoot, 'cfg'), { recursive: true });
      writeFileSync(join(otherRoot, 'cfg', 'p.md'), 'cfg');
      const tool = new ReadTool({
        allowedRoots: [join(root, 'memory'), join(otherRoot, 'cfg')],
      });
      const ok = await tool.execute({ file_path: join(otherRoot, 'cfg', 'p.md') });
      expect(ok.error).toBeFalsy();
      const bad = await tool.execute({ file_path: join(outside, 'outside.md') });
      expect(bad.error).toBe(true);
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  it('behaves unchanged when allowedRoots is not set', async () => {
    const tool = new ReadTool();
    const result = await tool.execute({ file_path: join(outside, 'outside.md') });
    expect(result.error).toBeFalsy();
    expect(result.result).toContain('outside content');
  });

  it('still accepts the parser option alongside allowedRoots', async () => {
    const tool = new ReadTool({ allowedRoots: [join(root, 'memory')] });
    const result = await tool.execute({ file_path: join(root, 'memory', 'inside.md') });
    expect(result.error).toBeFalsy();
  });
});

function makeContext(model?: string): ToolUseContext {
  const options = { mainLoopModel: model ?? '' } as ToolUseContextOptions;
  return { options } as unknown as ToolUseContext;
}

describe('ReadTool multimodal direct-read (plan 428)', () => {
  beforeEach(() => {
    // Clear any kill-switch env leak from the 'DUYA_FILE_PARSER_DISABLED'
    // describe block above so document-mode reads actually run here.
    delete process.env.DUYA_FILE_PARSER_DISABLED;
    _resetFileParserConfig();
    _resetSharedParser();
  });

  it('returns image inline for a multimodal main model instead of rejecting', async () => {
    const f = join(tmpDir, 'photo.png');
    await makePng(f);
    const result = await tool.execute({ file_path: f }, undefined, makeContext('claude-sonnet-4'));
    expect(result.error).toBeFalsy();
    // Non-error read result produced for the multimodal model.
    expect(result.result).toContain('File:');
    expect(result.result).toContain('image/png');
    // Inline image payload present, base64 of the read file.
    expect(result.images).toBeDefined();
    expect(result.images?.length).toBe(1);
    expect(result.images?.[0]?.mediaType).toBe('image/png');
    expect(result.images?.[0]?.data).toBeTruthy();
    expect((result.images?.[0]?.data as string).length).toBeGreaterThan(0);
  });

  it('maps jpeg extension to image/jpeg media type', async () => {
    const f = join(tmpDir, 'photo.jpeg');
    await makePng(f);
    const result = await tool.execute({ file_path: f }, undefined, makeContext('gemini-2.0-flash'));
    expect(result.error).toBeFalsy();
    expect(result.images?.[0]?.mediaType).toBe('image/jpeg');
  });

  it('still rejects images and points at vision_analyze for a non-multimodal model', async () => {
    const f = join(tmpDir, 'img.png');
    await makePng(f);
    const result = await tool.execute({ file_path: f }, undefined, makeContext('deepseek-v3'));
    expect(result.error).toBe(true);
    expect(result.result).toContain('image file');
    expect(result.result).toContain('`vision_analyze`');
    expect(result.images).toBeUndefined();
  });

  it('keeps rejecting images when no model is known (conservative default)', async () => {
    const f = join(tmpDir, 'img.png');
    await makePng(f);
    // No context at all — same as the pre-existing behavior.
    const noContext = await tool.execute({ file_path: f });
    expect(noContext.error).toBe(true);
    expect(noContext.result).toContain('`vision_analyze`');
    // Empty-string model also stays conservative.
    const emptyModel = await tool.execute({ file_path: f }, undefined, makeContext(''));
    expect(emptyModel.error).toBe(true);
    expect(emptyModel.result).toContain('`vision_analyze`');
  });

  it('reports an error when the image file is missing', async () => {
    const result = await tool.execute(
      { file_path: join(tmpDir, 'missing.png') },
      undefined,
      makeContext('gpt-4o'),
    );
    expect(result.error).toBe(true);
  });
});

describe('ReadTool.isMainModelMultimodal', () => {
  it('matches known multimodal model names', () => {
    expect(isMainModelMultimodal('claude-sonnet-4-20250514')).toBe(true);
    expect(isMainModelMultimodal('gpt-4o')).toBe(true);
    expect(isMainModelMultimodal('gemini-1.5-pro')).toBe(true);
  });

  it('does not match known non-multimodal model names', () => {
    expect(isMainModelMultimodal('deepseek-chat')).toBe(false);
    expect(isMainModelMultimodal('gpt-3.5-turbo')).toBe(false);
  });

  it('returns false for undefined/empty model (conservative)', () => {
    expect(isMainModelMultimodal(undefined)).toBe(false);
    expect(isMainModelMultimodal('')).toBe(false);
  });
});
