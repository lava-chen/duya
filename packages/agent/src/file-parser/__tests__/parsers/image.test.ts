/**
 * image parser end-to-end test
 * Generates tiny PNGs in-memory to exercise the resize + base64 path.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImageParser } from '../../parsers/image.js';
import { Jimp } from 'jimp';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'duya-img-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Minimal valid PNG: 2x2 red pixel, written via Jimp. */
async function makePng(width: number, height: number, path: string): Promise<void> {
  const img = new Jimp({ width, height });
  // Fill with red (RGBA)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      img.setPixelColor(0xff0000ff, x, y);
    }
  }
  const buffer = await img.getBuffer('image/png');
  writeFileSync(path, buffer);
}

describe('ImageParser', () => {
  it('extracts vision content for PNG', async () => {
    const f = join(tmpDir, 'a.png');
    await makePng(100, 100, f);
    const result = await new ImageParser().parse(f);
    expect(result.extractMethod).toBe('vision');
    expect(result.images).toBeDefined();
    expect(result.images?.length).toBe(1);
    expect(result.images?.[0].base64).toBeTruthy();
    expect(result.thumbnail).toBeDefined();
  });

  it('produces a thumbnail smaller than the main image', async () => {
    const f = join(tmpDir, 'a.png');
    await makePng(800, 600, f);
    const result = await new ImageParser().parse(f);
    expect(result.thumbnail).toBeDefined();
    const mainSize = result.images![0].base64.length;
    const thumbSize = result.thumbnail!.base64.length;
    expect(thumbSize).toBeLessThan(mainSize);
  });

  it('rejects on empty file', async () => {
    const f = join(tmpDir, 'empty.png');
    writeFileSync(f, Buffer.alloc(0));
    await expect(new ImageParser().parse(f)).rejects.toThrow(/empty/);
  });
});
