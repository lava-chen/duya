/**
 * pointer-mood tests — lock the compass partition, proximity tiers and the
 * direction/proximity expression tables.
 */
import { describe, expect, it } from 'vitest';

import {
  AWAY_RADIUS,
  MOOD_BY_REGION,
  NEAR_RADIUS,
  expressionForRegion,
  lookFromPointer,
  lookMixForProximity,
  proximityOf,
  regionForPointer,
} from '../pointer-mood';
import { EXPRESSION_BY_ID } from '../../bot/expressions';

const p = (dx: number, dy: number, inside = false, dist = 0) => ({
  dx,
  dy,
  inside,
  dist,
  // 像素偏移默认与归一化坐标一致（50px 窗口）
  ox: dx * 50,
  oy: dy * 50,
});

describe('proximityOf', () => {
  it('tiers by absolute distance', () => {
    expect(proximityOf(p(0, 0, false, NEAR_RADIUS / 2))).toBe('near');
    expect(proximityOf(p(0, 0, false, NEAR_RADIUS + 10))).toBe('far');
    expect(proximityOf(p(0, 0, false, AWAY_RADIUS + 1))).toBe('away');
    expect(proximityOf(p(0.1, 0.1, true, 10))).toBe('inside');
  });
});

describe('regionForPointer', () => {
  it('returns c when the pointer is inside the window', () => {
    expect(regionForPointer(p(0.1, 0.1, true))).toBe('c');
  });

  it('returns away beyond AWAY_RADIUS', () => {
    expect(regionForPointer(p(1.6, 0, false, AWAY_RADIUS + 10))).toBe('away');
    expect(regionForPointer(p(0, -1.7, false, AWAY_RADIUS + 10))).toBe('away');
  });

  it('partitions the 3x3 compass around the window', () => {
    expect(regionForPointer(p(0, 0))).toBe('c');
    expect(regionForPointer(p(0.5, 0))).toBe('e');
    expect(regionForPointer(p(-0.5, 0))).toBe('w');
    expect(regionForPointer(p(0, 0.5))).toBe('s');
    expect(regionForPointer(p(0, -0.5))).toBe('n');
    expect(regionForPointer(p(0.5, -0.5))).toBe('ne');
    expect(regionForPointer(p(-0.5, -0.5))).toBe('nw');
    expect(regionForPointer(p(0.5, 0.5))).toBe('se');
    expect(regionForPointer(p(-0.5, 0.5))).toBe('sw');
  });

  it('keeps small offsets in the centre band', () => {
    expect(regionForPointer(p(0.2, -0.2))).toBe('c');
  });
});

describe('expressionForRegion', () => {
  it('every region maps to a real expression', () => {
    for (const region of MOOD_BY_REGION.keys()) {
      const id = expressionForRegion(region as never);
      expect(EXPRESSION_BY_ID.has(id)).toBe(true);
    }
  });

  it('picks from the primary + alternates pool', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(expressionForRegion('ne'));
    // alternates exist, so the pool should produce at least two ids
    expect(seen.size).toBeGreaterThan(1);
  });

  it('near proximity uses the eager pool', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) seen.add(expressionForRegion('c', 'near'));
    // the near pool for c = surpris/curieux/excite — never the far faces
    for (const id of seen) {
      expect(['surpris', 'curieux', 'excite']).toContain(id);
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('falls back to neutre for unknown regions', () => {
    expect(expressionForRegion('???' as never)).toBe('neutre');
  });
});

describe('lookFromPointer / lookMixForProximity', () => {
  it('maps screen offset to yaw/pitch with the right signs', () => {
    // 指针在右上方 → 看右上（yaw>0 右、pitch>0 上，屏幕 y 向下所以要取反）
    const { yaw, pitch } = lookFromPointer(p(1, -1));
    expect(yaw).toBeGreaterThan(0);
    expect(pitch).toBeGreaterThan(0);
  });

  it('anchors the gaze slightly above the equator when centered', () => {
    expect(lookFromPointer(p(0, 0))).toEqual({ yaw: 0, pitch: 10 });
  });

  it('scales with the full interaction radius, not the 50px window', () => {
    // bloub 尺度：光标在互动区边缘（320px）才打满 ±16°
    expect(lookFromPointer(p(6.4, 0, false, 320)).yaw).toBeCloseTo(16);
    // 光标在球边（50px）只转 ~2.5°，而不是旧实现的 45°
    expect(lookFromPointer(p(1, 0, false, 50)).yaw).toBeLessThan(3);
  });

  it('closer proximity mixes harder towards the pointer', () => {
    expect(lookMixForProximity(p(0, 0, true, 5))).toBe(0.9);
    expect(lookMixForProximity(p(0, 0, false, 50))).toBe(0.75);
    expect(lookMixForProximity(p(0, 0, false, 300))).toBe(0.5);
  });
});
