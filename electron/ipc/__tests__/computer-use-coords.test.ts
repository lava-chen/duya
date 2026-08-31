/**
 * computer-use-coords.test.ts — Unit tests for the model-image-space →
 * physical-screen coordinate mapping used by click / drag.
 *
 * The capture image the model sees is in logical DIPs while nut.js
 * mouse calls expect physical pixels; on a 1.25-scaled display an
 * unscaled click lands 20% up-left of the target. These tests pin the
 * mapping: zoom-crop rebasing + scaleFactor scaling + fallbacks.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearZoomOrigin,
  modelPointToScreen,
  rememberZoomOrigin,
  zoomOriginKey,
} from '../computer-use-coords.js';

describe('zoomOriginKey', () => {
  it('uses a stable bucket when sessionId is missing', () => {
    expect(zoomOriginKey(undefined)).toBe(zoomOriginKey(undefined));
    expect(zoomOriginKey('s1')).toBe('s1');
  });
});

describe('modelPointToScreen', () => {
  beforeEach(() => {
    clearZoomOrigin(undefined);
    clearZoomOrigin('s1');
  });

  it('scales logical image coords to physical pixels', () => {
    // 1.25-scaled display: image center (1024,576) must land on the
    // physical (1280,720), not physical (1024,576) as before.
    expect(modelPointToScreen({ x: 1024, y: 576 }, 's1', 1.25)).toEqual({
      x: 1280,
      y: 720,
    });
  });

  it('is a no-op at scaleFactor 1', () => {
    expect(modelPointToScreen({ x: 300, y: 200 }, 's1', 1)).toEqual({
      x: 300,
      y: 200,
    });
  });

  it('rounds to integer cursor positions', () => {
    const p = modelPointToScreen({ x: 101, y: 51 }, 's1', 1.25);
    expect(p).toEqual({ x: 126, y: 64 });
    expect(Number.isInteger(p.x)).toBe(true);
    expect(Number.isInteger(p.y)).toBe(true);
  });

  it('falls back to unscaled when scaleFactor is missing or invalid', () => {
    expect(modelPointToScreen({ x: 300, y: 200 }, 's1', 0)).toEqual({ x: 300, y: 200 });
    expect(modelPointToScreen({ x: 300, y: 200 }, 's1', Number.NaN)).toEqual({
      x: 300,
      y: 200,
    });
  });

  it('re-adds the remembered zoom crop origin before scaling', () => {
    // Zoom crop starts at logical (700,800); the model points at
    // (50,60) inside the cropped image → full-image (750,860).
    rememberZoomOrigin('s1', { x: 700, y: 800 });
    expect(modelPointToScreen({ x: 50, y: 60 }, 's1', 1.25)).toEqual({
      x: Math.round(750 * 1.25),
      y: Math.round(860 * 1.25),
    });
  });

  it('tracks zoom origins per session', () => {
    rememberZoomOrigin('s1', { x: 700, y: 800 });
    // Another session has no crop — plain scaling applies.
    expect(modelPointToScreen({ x: 50, y: 60 }, 's2', 1.25)).toEqual({
      x: 63,
      y: 75,
    });
    // Missing sessionId uses its own bucket.
    expect(modelPointToScreen({ x: 50, y: 60 }, undefined, 1.25)).toEqual({
      x: 63,
      y: 75,
    });
  });

  it('clearZoomOrigin returns the session to full-image coords', () => {
    rememberZoomOrigin('s1', { x: 700, y: 800 });
    clearZoomOrigin('s1');
    expect(modelPointToScreen({ x: 50, y: 60 }, 's1', 1.25)).toEqual({
      x: 63,
      y: 75,
    });
  });

  it('applies the origin for the no-session bucket too', () => {
    rememberZoomOrigin(undefined, { x: 100, y: 100 });
    expect(modelPointToScreen({ x: 10, y: 10 }, undefined, 1.25)).toEqual({
      x: 138,
      y: 138,
    });
  });
});
