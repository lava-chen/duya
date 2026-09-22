/**
 * element-matcher.test.ts — plan 556 Phase 4 gate: the three-layer hit
 * matrix. Every branch of `matchRecordedElement` is pinned here so a
 * future confidence tweak cannot silently turn an L3 into an 'exact'.
 */

import { describe, it, expect } from 'vitest';

import {
  matchRecordedElement,
  toSomCandidates,
  isSomRef,
  MAX_APPROX_DISTANCE_RATIO,
  type SomCandidate,
} from '../element-matcher.js';
import type { ElementDescriptor } from '@duya/computer-use';

function desc(overrides: Partial<ElementDescriptor> = {}): ElementDescriptor {
  return { source: 'uia-probe', ...overrides };
}

function cand(index: number, label: string, x: number, y: number, extra: Partial<SomCandidate> = {}): SomCandidate {
  return { index, label, bbox: { x, y, w: 40, h: 20 }, ...extra };
}

describe('L1 — label identity', () => {
  it('exact name match resolves to the fresh index with exact/verified', () => {
    const result = matchRecordedElement(
      { element: desc({ name: 'Submit', controlType: 'Button' }), point: { x: 100, y: 100 } },
      [cand(1, 'Cancel', 0, 0), cand(7, 'Submit', 90, 92)],
    );
    expect(result.layer).toBe('L1');
    expect(result.confidence).toBe('exact');
    expect(result.verification).toBe('verified');
    expect(result.somIndex).toBe(7);
    expect(result.ref).toBe('som:7');
  });

  it('multiple label hits pick the one nearest the recorded click point', () => {
    const result = matchRecordedElement(
      { element: desc({ name: 'Add' }), point: { x: 400, y: 400 } },
      [cand(2, 'Add', 0, 0), cand(3, 'Add', 380, 390), cand(4, 'Add', 5000, 5000)],
    );
    expect(result.somIndex).toBe(3);
    expect(result.reason).toContain('3 candidates');
  });

  it('accessibility provenance outranks raw proximity', () => {
    const result = matchRecordedElement(
      // Recorded click sits right on the heuristic candidate…
      { element: desc({ name: 'Save' }), point: { x: 10, y: 10 } },
      [
        cand(1, 'Save', 0, 0, { axSource: 'heuristic' }),
        // …but a UIA element with the same name is the trustworthy one.
        cand(2, 'Save', 600, 600, { axSource: 'uia' }),
      ],
    );
    expect(result.somIndex).toBe(2);
  });

  it('controlType agreement breaks an axSource tie', () => {
    const result = matchRecordedElement(
      { element: desc({ name: 'Invoice', controlType: 'Edit' }), point: { x: 5, y: 5 } },
      [
        cand(1, 'Invoice', 0, 0, { axSource: 'uia', kind: 'Text' }),
        cand(9, 'Invoice', 300, 300, { axSource: 'uia', kind: 'Edit' }),
      ],
    );
    expect(result.somIndex).toBe(9);
  });

  it('case and whitespace are the only tolerance applied', () => {
    const hit = matchRecordedElement(
      { element: desc({ name: '  Save   Changes ' }) },
      [cand(4, 'save changes', 0, 0)],
    );
    expect(hit.layer).toBe('L1');

    const miss = matchRecordedElement(
      { element: desc({ name: 'Save Change' }) },
      [cand(4, 'save changes', 0, 0), cand(5, 'other', 5000, 5000)],
    );
    expect(miss.layer).not.toBe('L1');
  });

  it('an unnamed element never matches on the empty string', () => {
    const result = matchRecordedElement(
      { element: desc({}), point: { x: 0, y: 0 } },
      [cand(1, '', 0, 0)],
    );
    expect(result.layer).toBe('L2');
    expect(result.somIndex).toBe(1);
  });
});

describe('L2 — positional fallback', () => {
  it('the recorded point landing inside a fresh bbox wins', () => {
    const result = matchRecordedElement(
      { element: desc({ name: 'Rename me' }), point: { x: 120, y: 130 } },
      [cand(3, 'File', 110, 120, { bbox: { x: 110, y: 120, w: 60, h: 40 } }), cand(8, 'Edit', 900, 900)],
    );
    expect(result.layer).toBe('L2');
    expect(result.confidence).toBe('approx');
    expect(result.verification).toBe('unconfirmed');
    expect(result.somIndex).toBe(3);
  });

  it('accepts the nearest candidate inside the frame-diagonal budget', () => {
    const result = matchRecordedElement(
      { element: desc({ name: 'Renamed' }), point: { x: 500, y: 500 } },
      [cand(5, 'Target', 520, 510)],
      { frame: { width: 1000, height: 1000 } },
    );
    expect(result.layer).toBe('L2');
    expect(result.somIndex).toBe(5);
  });

  it('rejects a candidate outside the budget and falls through to L3', () => {
    const result = matchRecordedElement(
      { element: desc({ name: 'Renamed' }), point: { x: 100, y: 100 } },
      [cand(5, 'Far away', 900, 900)],
      { frame: { width: 1000, height: 1000 } },
    );
    expect(result.layer).toBe('none');
    expect(result.confidence).toBe('agent-fallback');
    expect(result.somIndex).toBeNull();
    expect(result.ref).toBeNull();
    expect(result.verification).toBe('unconfirmed');
  });

  it('uses the absolute threshold when no frame is known', () => {
    const near = matchRecordedElement(
      { element: desc({}), point: { x: 100, y: 100 } },
      [cand(5, 'x', 180, 100)],
    );
    expect(near.somIndex).toBe(5);

    const far = matchRecordedElement(
      { element: desc({}), point: { x: 100, y: 100 } },
      [cand(5, 'x', 400, 100)],
    );
    expect(far.layer).toBe('none');
  });

  it('projects the recorded point through frame normalization', () => {
    // Recorded on a 1000×1000 frame at (500, 500); replayed on a
    // 2000×2000 frame whose matching control sits at (1000, 1000).
    const result = matchRecordedElement(
      { element: desc({ name: 'Gone' }), point: { x: 500, y: 500 }, frame: { width: 1000, height: 1000 } },
      [cand(2, 'Moved', 990, 990)],
      { frame: { width: 2000, height: 2000 } },
    );
    expect(result.layer).toBe('L2');
    expect(result.somIndex).toBe(2);
  });

  it('falls back to the recorded rect centre when no click point was stored', () => {
    const result = matchRecordedElement(
      { element: desc({ name: 'Gone', rect: { x: 200, y: 300, w: 40, h: 20 } }) },
      [cand(6, 'Elsewhere', 200, 300, { bbox: { x: 200, y: 300, w: 40, h: 20 } })],
    );
    expect(result.somIndex).toBe(6);
  });
});

describe('L3 — nothing to match against', () => {
  it('empty candidate list', () => {
    const result = matchRecordedElement({ element: desc({ name: 'Submit' }), point: { x: 1, y: 2 } }, []);
    expect(result.layer).toBe('none');
    expect(result.reason).toContain('no SOM elements');
  });

  it('no name, no point, no rect', () => {
    const result = matchRecordedElement({ element: desc({ source: 'none' }) }, [cand(1, 'a', 0, 0)]);
    expect(result.layer).toBe('none');
    expect(result.reason).toContain('neither a usable element name nor a click point');
  });

  it('a named element with no geometry says so', () => {
    const result = matchRecordedElement({ element: desc({ name: 'Submit' }) }, [cand(1, 'a', 0, 0)]);
    expect(result.layer).toBe('none');
    expect(result.reason).toContain('no SOM label matched');
  });
});

describe('candidate parsing', () => {
  it('drops malformed elements instead of throwing', () => {
    const parsed = toSomCandidates([
      { index: 1, bbox: { x: 0, y: 0, w: 1, h: 1 }, label: 'ok', axSource: 'uia' },
      { index: 2, bbox: { x: 0, y: 0, w: 1, h: 1 }, label: 'no index' },
      { bbox: { x: 0, y: 0, w: 1, h: 1 }, label: 'missing index' },
      { index: 3, label: 'no bbox' },
      { index: 4, bbox: { x: 0, y: 0, w: 1 }, label: 'short bbox' },
      null,
      'nope',
    ]);
    expect(parsed.map((c) => c.index)).toEqual([1, 2]);
    expect(parsed[0]!.axSource).toBe('uia');
    expect(parsed[1]!.axSource).toBeUndefined();
  });

  it('preserves plan 562 tree sources through toSomCandidates', () => {
    const parsed = toSomCandidates([
      { index: 1, bbox: { x: 0, y: 0, w: 10, h: 10 }, label: 'OK', kind: 'Button', axSource: 'uia-tree' },
      { index: 2, bbox: { x: 0, y: 0, w: 10, h: 10 }, label: 'tab', axSource: 'ax-tree' },
      { index: 3, bbox: { x: 0, y: 0, w: 10, h: 10 }, label: 'bogus', axSource: 'bogus' },
    ]);
    expect(parsed[0]!.axSource).toBe('uia-tree');
    expect(parsed[1]!.axSource).toBe('ax-tree');
    // unknown sources are dropped (element kept) — the closed-union guard
    // must never silently discard a candidate wholesale
    expect(parsed[2]!.axSource).toBeUndefined();
    expect(parsed.map((c) => c.index)).toEqual([1, 2, 3]);
  });

  it('returns [] for a non-array payload', () => {
    expect(toSomCandidates(undefined)).toEqual([]);
    expect(toSomCandidates({ elements: [] })).toEqual([]);
  });

  it('recognizes som refs', () => {
    expect(isSomRef('som:12')).toBe(true);
    expect(isSomRef('som:')).toBe(false);
    expect(isSomRef('som:1.5')).toBe(false);
    expect(isSomRef(3)).toBe(false);
  });

  it('exposes the documented L2 budget', () => {
    expect(MAX_APPROX_DISTANCE_RATIO).toBeGreaterThan(0);
    expect(MAX_APPROX_DISTANCE_RATIO).toBeLessThan(0.5);
  });
});
