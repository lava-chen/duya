import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { validateImagePaths, isUnsupportedInsertTextError } from '../actions/twitterPost.js';
import { SchemaGenerator, ActionRegistry, getAllActions } from '../actions/index.js';

describe('twitter_post is hidden from the schema yet still callable', () => {
  it('omits twitter_post from the auto-generated operation enum and fields', () => {
    const { inputSchema } = SchemaGenerator.generate(getAllActions());
    const enumList = (inputSchema.properties?.operation as { enum?: string[] })?.enum ?? [];
    expect(enumList).not.toContain('twitter_post');

    // No anyOf variant and no merged properties for the hidden action
    // (`images` is twitter_post-specific; A shared `text` field exists from the
    // generic `type` action, so assert on the twitter-only field instead).
    const variants = (inputSchema as { anyOf?: Array<{ properties?: { operation?: { enum?: string[] } } }> }).anyOf ?? [];
    expect(variants.some((v) => v.properties?.operation?.enum?.includes('twitter_post'))).toBe(false);
    expect(inputSchema.properties).not.toHaveProperty('images');
  });

  it('still resolves twitter_post through the ActionRegistry by operation name', () => {
    const registry = new ActionRegistry();
    registry.registerAll(getAllActions());
    expect(registry.get('twitter_post')).toBeDefined();
    expect(registry.get('twitter_post')?.hidden).toBe(true);
  });
});

describe('twitterPost validation', () => {
  it('normalizes supported image paths to absolute paths', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-twitter-'));
    const png = path.join(dir, 'a.png');
    fs.writeFileSync(png, 'x');
    const jpg = path.join(dir, 'b.jpg');
    fs.writeFileSync(jpg, 'x');
    try {
      const out = validateImagePaths([path.join(dir, 'a.png'), './b.jpg'.replace('./', dir + path.sep)]);
      expect(out[0]).toBe(png);
      expect(out[1]).toBe(jpg);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects unsupported image extensions', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-twitter-'));
    const pdf = path.join(dir, 'a.pdf');
    fs.writeFileSync(pdf, 'x');
    try {
      expect(() => validateImagePaths([pdf])).toThrow(/Unsupported image format/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects more than 4 images', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-twitter-'));
    const files = Array.from({ length: 5 }, (_, i) => `${i}.png`);
    for (const f of files) fs.writeFileSync(path.join(dir, f), 'x');
    try {
      expect(() => validateImagePaths(files.map((f) => path.join(dir, f)))).toThrow(/Too many images/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects paths that point to nothing or to directories', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-twitter-'));
    const pngDir = path.join(dir, 'fold.png');
    fs.mkdirSync(pngDir);
    try {
      expect(() => validateImagePaths([path.join(dir, 'missing.png')])).toThrow(/Not a valid file/);
      expect(() => validateImagePaths([pngDir])).toThrow(/Not a valid file/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('isUnsupportedInsertTextError', () => {
  it.each([
    ['Unknown action: foo', true],
    ['The insertText action is not supported', true],
    ['No matching signature', true],
    ['not permitted', true],
    ['Some unrelated diff error', false],
  ])('detects %s as %s', (msg, expected) => {
    expect(isUnsupportedInsertTextError(new Error(msg))).toBe(expected);
  });
});