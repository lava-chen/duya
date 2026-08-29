/**
 * som.test.ts — SOM overlay renderer + element detector (plan 454 §6.1).
 *
 * Coverage:
 *   - `buildSomOverlaySvg` produces valid SVG markup with unique
 *     element indexes.
 *   - `drawSomOverlay` short-circuits on empty elements and uses
 *     the sharp pipeline when there are elements.
 *   - `detectSomElements` returns 1 element from a focusedEntity,
 *     falls back to a centered element when none is available.
 */

import { describe, it, expect } from 'vitest';

import {
  buildSomOverlaySvg,
  drawSomOverlay,
} from '../som/overlay.js';
import { detectSomElements } from '../som/element-detector.js';
import type { SharpAdapter, SharpPipeline } from '../backend/electron/win32.js';
import type { SomElement } from '../backend/types.js';
import type { FocusedEntity } from '@duya/computer-use-demo';

describe('buildSomOverlaySvg', () => {
  it('produces an SVG document with the requested dimensions', () => {
    const svg = buildSomOverlaySvg(1920, 1080, []);
    expect(svg).toContain('width="1920"');
    expect(svg).toContain('height="1080"');
    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
  });

  it('draws one rect + marker per element with unique indexes', () => {
    const elements: SomElement[] = [
      { index: 1, bbox: { x: 10, y: 10, w: 50, h: 50 }, label: 'a' },
      { index: 2, bbox: { x: 100, y: 100, w: 60, h: 60 }, label: 'b' },
      { index: 3, bbox: { x: 200, y: 200, w: 70, h: 70 }, label: 'c' },
    ];
    const svg = buildSomOverlaySvg(800, 600, elements);
    // Three rect class="cu-bbox" tags.
    const matches = svg.match(/class="cu-bbox"/g);
    expect(matches?.length).toBe(3);
    // Three label numbers appear in the markup.
    expect(svg).toContain('>1<');
    expect(svg).toContain('>2<');
    expect(svg).toContain('>3<');
  });

  it('honors custom borderWidth and markerSize', () => {
    const elements: SomElement[] = [
      { index: 1, bbox: { x: 0, y: 0, w: 10, h: 10 }, label: 'a' },
    ];
    const svg = buildSomOverlaySvg(400, 400, elements, {
      borderWidth: 4,
      markerSize: 36,
    });
    expect(svg).toContain('stroke-width: 4');
    // marker size appears as the corner rect dimensions
    expect(svg).toContain('width="36"');
    expect(svg).toContain('height="36"');
  });

  it('omits the center cross when showCenterCross is false', () => {
    const elements: SomElement[] = [
      { index: 1, bbox: { x: 0, y: 0, w: 10, h: 10 }, label: 'a' },
    ];
    const svg = buildSomOverlaySvg(100, 100, elements, { showCenterCross: false });
    expect(svg).not.toContain('class="cu-cross"');
  });
});

/**
 * Sharp fake for the overlay pipeline — records composite calls
 * and returns the input buffer as a stand-in for the encoded PNG.
 */
function makeSharpFake(): SharpAdapter & { compositeCalls: number } {
  const state = { compositeCalls: 0 };
  const adapter = ((input: Buffer | string) => {
    const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input));
    const pipe: SharpPipeline = {
      resize: () => pipe,
      composite: (images) => {
        state.compositeCalls++;
        expect(images.length).toBeGreaterThan(0);
        return pipe;
      },
      png: () => ({
        async toBuffer() {
          return buf;
        },
      }),
    };
    return pipe;
  }) as SharpAdapter & { compositeCalls: number };
  return new Proxy(adapter, {
    get(target, prop) {
      if (prop === 'compositeCalls') return state[prop];
      return Reflect.get(target, prop);
    },
    set(target, prop, value) {
      if (prop === 'compositeCalls') state.compositeCalls = value;
      else Reflect.set(target, prop, value);
      return true;
    },
  }) as SharpAdapter & { compositeCalls: number };
}

describe('drawSomOverlay', () => {
  it('returns the original buffer unchanged when elements are empty', async () => {
    const sharp = makeSharpFake();
    const image = Buffer.from([0xaa, 0xbb, 0xcc]);
    const result = await drawSomOverlay(sharp, image, []);
    expect(result).toBe(image);
    expect(sharp.compositeCalls).toBe(0);
  });

  it('composites the overlay onto the image when elements are present', async () => {
    const sharp = makeSharpFake();
    const image = Buffer.from([0x00]);
    const elements: SomElement[] = [
      { index: 1, bbox: { x: 5, y: 5, w: 50, h: 50 }, label: 'one' },
    ];
    const result = await drawSomOverlay(sharp, image, elements);
    expect(result).toBeDefined();
    expect(sharp.compositeCalls).toBe(1);
  });
});

describe('detectSomElements', () => {
  it('returns a centered fallback element when no focusedEntity is provided', () => {
    const elements = detectSomElements({ width: 1920, height: 1080 });
    expect(elements.length).toBe(1);
    expect(elements[0]?.index).toBe(1);
    expect(elements[0]?.label).toBe('primary');
    // Centered horizontally + vertically within the viewport.
    expect(elements[0]?.bbox.x).toBeGreaterThan(0);
    expect(elements[0]?.bbox.y).toBeGreaterThan(0);
  });

  it('uses focusedEntity bbox when present', () => {
    const entity: FocusedEntity = {
      kind: 'Button',
      name: 'submit',
      role: 'primary',
      bbox: { x: 100, y: 200, w: 80, h: 40 },
      redaction: { redacted: false, reasons: [] },
    } as unknown as FocusedEntity;
    const elements = detectSomElements({
      width: 1920,
      height: 1080,
      focusedEntity: entity,
    });
    expect(elements.length).toBe(1);
    expect(elements[0]?.bbox).toEqual({ x: 100, y: 200, w: 80, h: 40 });
    expect(elements[0]?.kind).toBe('Button');
    expect(elements[0]?.label).toMatch(/Button/);
  });

  it('falls back to centered element when focusedEntity has no bbox', () => {
    const entity = {
      kind: 'Text',
      redaction: { redacted: false, reasons: [] },
    } as unknown as FocusedEntity;
    const elements = detectSomElements({
      width: 800,
      height: 600,
      focusedEntity: entity,
    });
    expect(elements.length).toBe(1);
    expect(elements[0]?.label).toBe('primary');
  });

  it('returns 1-based indexes starting at 1', () => {
    const entity: FocusedEntity = {
      kind: 'Input',
      name: 'search',
      bbox: { x: 0, y: 0, w: 200, h: 32 },
      redaction: { redacted: false, reasons: [] },
    } as unknown as FocusedEntity;
    const elements = detectSomElements({
      width: 1920,
      height: 1080,
      focusedEntity: entity,
    });
    expect(elements[0]?.index).toBe(1);
  });
});