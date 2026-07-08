/**
 * Performance benchmarks for layout algorithms.
 *
 * Runs four scenarios: small (10), medium (50), large (200), stress (500).
 * CI gate: medium < 8ms, large < 16ms, stress < 32ms.
 *
 * Run manually: npx vitest run --config vitest.bench.config.ts packages/conductor/src/renderer/domain/canvas/__bench__/
 * (Or just `npm test -- layout.bench`)
 */
import { describe, it, expect } from 'vitest';
import { binPack } from '../layout/binPack';
import { flowLayout } from '../layout/flowLayout';
import { zoomToFit, viewportAwarePack } from '../layout/viewport';
import { CanvasSpatialIndex } from '../spatialIndex';
import { hitTest } from '../hitTest';
import { computeSnap } from '../snap';
import { pushAside } from '../collision';
import type { CanvasElement } from '../../../types/conductor';

function makeElement(id: string, x: number, y: number, w: number, h: number): CanvasElement {
  return {
    id,
    canvasId: 'canvas-1',
    elementKind: 'native/sticky',
    position: { x, y, w, h, zIndex: 0, rotation: 0 },
    config: {},
    state: 'idle',
    dataVersion: 0,
    createdAt: 0,
    updatedAt: 0,
    vizSpec: null,
    sourceCode: null,
    permissions: { agentCanRead: true, agentCanWrite: true, agentCanDelete: true },
    metadata: { label: '', tags: [], createdBy: 'user' as const },
  };
}

function generateElements(count: number): CanvasElement[] {
  const els: CanvasElement[] = [];
  for (let i = 0; i < count; i++) {
    const col = i % 10;
    const row = Math.floor(i / 10);
    els.push(makeElement(`el-${i}`, col * 4, row * 4, 3, 2));
  }
  return els;
}

const SCENARIOS = [
  { name: 'small', count: 10, budget: 2 },
  { name: 'medium', count: 50, budget: 8 },
  { name: 'large', count: 200, budget: 16 },
  { name: 'stress', count: 500, budget: 32 },
];

describe('layout performance', () => {
  for (const scenario of SCENARIOS) {
    it(`binPack ${scenario.name} (${scenario.count} elements) under ${scenario.budget}ms`, () => {
      const els = generateElements(scenario.count);
      const start = performance.now();
      binPack(els, { viewport: { width: 40, height: 30 }, gap: 0.25, preserveLocked: true, maxFreeRects: 32 });
      const elapsed = performance.now() - start;
      // Log so CI can capture it.
      console.log(`binPack ${scenario.name}: ${elapsed.toFixed(2)}ms`);
      expect(elapsed).toBeLessThan(scenario.budget);
    });

    it(`flowLayout ${scenario.name} under ${scenario.budget}ms`, () => {
      const els = generateElements(scenario.count);
      const start = performance.now();
      flowLayout(els, { viewport: { width: 40 }, gap: 0.25, rowAlign: 'start', preserveLocked: true });
      const elapsed = performance.now() - start;
      console.log(`flowLayout ${scenario.name}: ${elapsed.toFixed(2)}ms`);
      expect(elapsed).toBeLessThan(scenario.budget);
    });

    it(`zoomToFit ${scenario.name} under ${scenario.budget}ms`, () => {
      const els = generateElements(scenario.count);
      const start = performance.now();
      zoomToFit(els, { viewport: { width: 40, height: 30 }, minZoom: 0.2, maxZoom: 1.5, padding: 1, respectMinSize: false });
      const elapsed = performance.now() - start;
      console.log(`zoomToFit ${scenario.name}: ${elapsed.toFixed(2)}ms`);
      expect(elapsed).toBeLessThan(scenario.budget);
    });

    it(`spatialIndex rebuild + hitTest ${scenario.name} under ${scenario.budget}ms`, () => {
      const els = generateElements(scenario.count);
      const idx = new CanvasSpatialIndex();
      const start = performance.now();
      idx.rebuild(els);
      idx.hitTest({ x: 5, y: 5 }, 0.1);
      const elapsed = performance.now() - start;
      console.log(`spatialIndex ${scenario.name}: ${elapsed.toFixed(2)}ms`);
      expect(elapsed).toBeLessThan(scenario.budget);
    });

    it(`computeSnap ${scenario.name} under ${scenario.budget}ms`, () => {
      const els = generateElements(scenario.count);
      const dragged = els[0];
      const start = performance.now();
      computeSnap(dragged, els, { threshold: 0.1 });
      const elapsed = performance.now() - start;
      console.log(`computeSnap ${scenario.name}: ${elapsed.toFixed(2)}ms`);
      expect(elapsed).toBeLessThan(scenario.budget);
    });

    it(`pushAside ${scenario.name} under ${scenario.budget}ms`, () => {
      const els = generateElements(scenario.count);
      const idx = new CanvasSpatialIndex();
      idx.rebuild(els);
      const start = performance.now();
      pushAside(els[0], { dx: 1, dy: 0 }, idx, { gap: 0.25, cascade: true, maxDepth: 3 });
      const elapsed = performance.now() - start;
      console.log(`pushAside ${scenario.name}: ${elapsed.toFixed(2)}ms`);
      expect(elapsed).toBeLessThan(scenario.budget);
    });
  }
});
