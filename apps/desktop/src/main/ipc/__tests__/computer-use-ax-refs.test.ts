/**
 * computer-use-coords.ts — AX ref memory tests (plan 572).
 *
 * Companion to computer-use-coords.test.ts (the point-mapping suite):
 * covers the SOM index → AX handle/pid memory the IPC click case uses
 * to deliver background AX-action presses.
 */

import { describe, expect, it } from 'vitest';

import {
  clearCaptureAxRefs,
  getCaptureAxRef,
  rememberCaptureAxRefs,
} from '../computer-use-coords';

describe('capture AX refs (plan 572)', () => {
  it('remembers and resolves SOM index → handle + pid', () => {
    rememberCaptureAxRefs('s1', [
      { index: 1, handle: 'h1', pid: 42 },
      { index: 3, handle: 'h3', pid: 42 },
    ]);
    expect(getCaptureAxRef('s1', 1)).toEqual({ handle: 'h1', pid: 42 });
    expect(getCaptureAxRef('s1', 3)).toEqual({ handle: 'h3', pid: 42 });
    expect(getCaptureAxRef('s1', 2)).toBeNull();
  });

  it('is session-scoped', () => {
    rememberCaptureAxRefs('sA', [{ index: 1, handle: 'hA', pid: 1 }]);
    expect(getCaptureAxRef('sB', 1)).toBeNull();
  });

  it('drops malformed entries instead of storing them', () => {
    rememberCaptureAxRefs('s2', [
      { index: -1, handle: 'hNeg', pid: 7 },
      { index: 2, handle: '', pid: 7 },
      { index: 3, handle: 'hOK', pid: 0 },
    ]);
    expect(getCaptureAxRef('s2', -1)).toBeNull();
    expect(getCaptureAxRef('s2', 2)).toBeNull();
    expect(getCaptureAxRef('s2', 3)).toBeNull();
  });

  it('an empty replacement clears the session refs', () => {
    rememberCaptureAxRefs('s3', [{ index: 1, handle: 'h1', pid: 42 }]);
    rememberCaptureAxRefs('s3', []);
    expect(getCaptureAxRef('s3', 1)).toBeNull();
  });

  it('clearCaptureAxRefs forgets the session', () => {
    rememberCaptureAxRefs('s4', [{ index: 1, handle: 'h1', pid: 42 }]);
    clearCaptureAxRefs('s4');
    expect(getCaptureAxRef('s4', 1)).toBeNull();
  });

  it('tolerates a missing session (undefined key bucket)', () => {
    rememberCaptureAxRefs(undefined, [{ index: 2, handle: 'h2', pid: 9 }]);
    expect(getCaptureAxRef(undefined, 2)).toEqual({ handle: 'h2', pid: 9 });
  });
});
