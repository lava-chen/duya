import { describe, it, expect, vi } from 'vitest';
import { CycleDetector } from '../interagent-router';

describe('CycleDetector', () => {
  it('rejects self-call', () => {
    const detector = new CycleDetector();
    expect(detector.wouldCreateCycle('A', 'A')).toBe(true);
  });

  it('allows simple A→B call', () => {
    const detector = new CycleDetector();
    expect(detector.wouldCreateCycle('A', 'B')).toBe(false);
  });

  it('rejects A→B→A cycle', () => {
    const detector = new CycleDetector();
    detector.addInvoke('invoke-1', 'A', 'B');
    // B now tries to invoke A — cycle
    expect(detector.wouldCreateCycle('B', 'A')).toBe(true);
  });

  it('rejects A→B→C→A cycle (depth 3)', () => {
    const detector = new CycleDetector();
    detector.addInvoke('invoke-1', 'A', 'B');
    detector.addInvoke('invoke-2', 'B', 'C');
    // C now tries to invoke A — cycle
    expect(detector.wouldCreateCycle('C', 'A')).toBe(true);
  });

  it('allows A→B and C→B (no cycle, shared target)', () => {
    const detector = new CycleDetector();
    detector.addInvoke('invoke-1', 'A', 'B');
    expect(detector.wouldCreateCycle('C', 'B')).toBe(false);
  });

  it('removes invoke from graph on cleanup', () => {
    const detector = new CycleDetector();
    detector.addInvoke('invoke-1', 'A', 'B');
    detector.removeInvoke('invoke-1');
    // After cleanup, B→A is no longer a cycle
    expect(detector.wouldCreateCycle('B', 'A')).toBe(false);
  });
});
