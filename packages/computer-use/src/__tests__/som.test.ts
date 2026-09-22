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

  it('sizes the SVG to the explicit dims instead of the legacy 1920x1080', async () => {
    const svgInputs: string[] = [];
    const sharp = makeSharpFake();
    // Wrap the adapter so every SVG input is recorded. The overlay SVG
    // arrives as a UTF-8 Buffer (Buffer.from(svg, 'utf-8')); the base
    // image is a plain pixel buffer.
    const recording = ((input: Buffer | string) => {
      if (Buffer.isBuffer(input) && input.toString('utf8').startsWith('<svg')) {
        svgInputs.push(input.toString('utf8'));
      }
      return sharp(input);
    }) as SharpAdapter;
    const image = Buffer.from([0x00]);
    const elements: SomElement[] = [
      { index: 1, bbox: { x: 5, y: 5, w: 50, h: 50 }, label: 'one' },
    ];
    await drawSomOverlay(recording, image, elements, {}, {
      width: 1440,
      height: 810,
    });
    expect(svgInputs.length).toBe(1);
    expect(svgInputs[0]).toContain('width="1440"');
    expect(svgInputs[0]).toContain('height="810"');
    expect(svgInputs[0]).not.toContain('width="1920"');
  });

  it('falls back to a metadata probe when dims are omitted and the fake exposes metadata', async () => {
    const svgInputs: string[] = [];
    const sharp = makeSharpFake();
    const recording = ((input: Buffer | string) => {
      if (Buffer.isBuffer(input) && input.toString('utf8').startsWith('<svg')) {
        svgInputs.push(input.toString('utf8'));
      }
      const pipe = sharp(input);
      if (typeof input !== 'string') {
        if (!Buffer.isBuffer(input) || !input.toString('utf8').startsWith('<svg')) {
          // Attach a metadata probe to the base-image pipeline only.
          return { ...pipe, metadata: async () => ({ width: 800, height: 600 }) };
        }
      }
      return pipe;
    }) as unknown as SharpAdapter;
    const image = Buffer.from([0x00]);
    const elements: SomElement[] = [
      { index: 1, bbox: { x: 5, y: 5, w: 50, h: 50 }, label: 'one' },
    ];
    await drawSomOverlay(recording, image, elements);
    expect(svgInputs[0]).toContain('width="800"');
    expect(svgInputs[0]).toContain('height="600"');
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

  // Plan 519 §3.4 / A2: AX tree fills the SOM with labeled elements.
  describe('with axInfo (plan 519 A2)', () => {
    it('emits one element per UIA input tagged axSource=uia with an extended kind', () => {
      const elements = detectSomElements({
        width: 1920,
        height: 1080,
        axInfo: {
          uia: [
            { name: 'url bar', controlType: 'Edit' },
            { name: 'Sign In', controlType: 'Button' },
            { name: 'tab 1', controlType: 'TabItem' },
          ],
          msaa: [],
        },
      });
      expect(elements.length).toBe(3);
      expect(elements.map((e) => e.axSource)).toEqual(['uia', 'uia', 'uia']);
      expect(elements.map((e) => e.kind)).toEqual(['Edit', 'Button', 'Tab']);
      expect(elements[0]?.label).toMatch(/Edit: 'url bar'/);
      expect(elements[1]?.label).toMatch(/Button: 'Sign In'/);
      expect(elements.map((e) => e.index)).toEqual([1, 2, 3]);
    });

    it('labels MSAA inputs with axSource=msaa after UIA', () => {
      const elements = detectSomElements({
        width: 1280,
        height: 720,
        axInfo: {
          uia: [{ name: 'search', controlType: 'Edit' }],
          msaa: [{ name: 'OK', value: 'OK' }],
        },
      });
      expect(elements.map((e) => e.axSource)).toEqual(['uia', 'msaa']);
      expect(elements[1]?.label).toMatch(/OK/);
    });

    it('keeps focused-entity as a distinct axSource when both are present', () => {
      const entity: FocusedEntity = {
        kind: 'Button',
        name: 'submit',
        bbox: { x: 0, y: 0, w: 80, h: 40 },
        redaction: { redacted: false, reasons: [] },
      } as unknown as FocusedEntity;
      const elements = detectSomElements({
        width: 1920,
        height: 1080,
        focusedEntity: entity,
        axInfo: {
          uia: [{ name: 'field', controlType: 'Edit' }],
          msaa: [],
        },
      });
      expect(elements[0]?.axSource).toBe('focused-entity');
      expect(elements[1]?.axSource).toBe('uia');
      expect(elements[0]?.index).toBe(1);
      expect(elements[1]?.index).toBe(2);
    });

    it('caps AX elements so the grid stays inside the viewport', () => {
      const many = Array.from({ length: 500 }, (_, i) => ({
        name: `f${i}`,
        controlType: 'Edit',
      }));
      const elements = detectSomElements({
        width: 1920,
        height: 1080,
        axInfo: { uia: many, msaa: [] },
      });
      expect(elements.length).toBeLessThan(500);
      expect(elements.length).toBeGreaterThan(0);
    });
  });

  // Plan 562 Phase 2: full-tree enumerated descriptors with REAL rects
  // take priority over the heuristic grid.
  describe('with axElements (plan 562 phase 2)', () => {
    function descriptor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return { source: 'uia-probe', name: 'Sign In', controlType: 'Button', rect: { x: 100, y: 200, w: 80, h: 32 }, ...overrides };
    }

    it('emits one element per descriptor at its REAL bbox tagged axSource=uia-tree', () => {
      const elements = detectSomElements({
        width: 1920,
        height: 1080,
        axElements: [
          descriptor() as never,
          descriptor({ name: 'url bar', controlType: 'Edit', rect: { x: 10, y: 10, w: 300, h: 24 } }) as never,
          descriptor({ name: 'tab 1', controlType: 'TabItem', rect: { x: 400, y: 0, w: 120, h: 28 } }) as never,
        ],
      });
      expect(elements.length).toBe(3);
      expect(elements.map((e) => e.axSource)).toEqual(['uia-tree', 'uia-tree', 'uia-tree']);
      expect(elements[0]?.bbox).toEqual({ x: 100, y: 200, w: 80, h: 32 });
      expect(elements[1]?.bbox).toEqual({ x: 10, y: 10, w: 300, h: 24 });
      expect(elements[0]?.label).toBe('Sign In');
      expect(elements[1]?.label).toBe('url bar');
      expect(elements.map((e) => e.kind)).toEqual(['Button', 'Edit', 'Tab']);
      expect(elements.map((e) => e.index)).toEqual([1, 2, 3]);
    });

    it('keeps the focused-entity element ahead of tree elements', () => {
      const entity: FocusedEntity = {
        kind: 'Button',
        name: 'submit',
        bbox: { x: 0, y: 0, w: 80, h: 40 },
        redaction: { redacted: false, reasons: [] },
      } as unknown as FocusedEntity;
      const elements = detectSomElements({
        width: 1920,
        height: 1080,
        focusedEntity: entity,
        axElements: [descriptor() as never],
      });
      expect(elements[0]?.axSource).toBe('focused-entity');
      expect(elements[0]?.index).toBe(1);
      expect(elements[1]?.axSource).toBe('uia-tree');
      expect(elements[1]?.index).toBe(2);
    });

    it('skips descriptors without a usable rect', () => {
      const elements = detectSomElements({
        width: 1920,
        height: 1080,
        axElements: [
          descriptor({ rect: undefined }) as never,
          descriptor({ name: 'Close', rect: { x: 5, y: 5, w: 30, h: 30 } }) as never,
          descriptor({ rect: { x: 0, y: 0, w: 0, h: 0 } }) as never,
        ],
      });
      expect(elements.length).toBe(1);
      expect(elements[0]?.label).toBe('Close');
    });

    it('degrades to the AxInfo grid when axElements is empty or absent', () => {
      const gridOnly = detectSomElements({
        width: 1920,
        height: 1080,
        axInfo: { uia: [{ name: 'field', controlType: 'Edit' }], msaa: [] },
      });
      expect(gridOnly.map((e) => e.axSource)).toEqual(['uia']);

      const emptyThenGrid = detectSomElements({
        width: 1920,
        height: 1080,
        axElements: [],
        axInfo: { uia: [{ name: 'field', controlType: 'Edit' }], msaa: [] },
      });
      expect(emptyThenGrid.map((e) => e.axSource)).toEqual(['uia']);
    });

    it('suppresses the grid when real-coordinate elements exist', () => {
      const elements = detectSomElements({
        width: 1920,
        height: 1080,
        axElements: [descriptor() as never],
        axInfo: { uia: [{ name: 'field', controlType: 'Edit' }], msaa: [] },
      });
      expect(elements.length).toBe(1);
      expect(elements[0]?.axSource).toBe('uia-tree');
    });

    it('honors axElementsSource=ax-tree for the macOS helper', () => {
      const elements = detectSomElements({
        width: 1920,
        height: 1080,
        axElements: [descriptor() as never],
        axElementsSource: 'ax-tree',
      });
      expect(elements[0]?.axSource).toBe('ax-tree');
    });
  });
});