import { describe, expect, it } from 'vitest';
import { truncatePathMiddle } from './path-display';

describe('truncatePathMiddle', () => {
  it('keeps a short path untouched', () => {
    expect(truncatePathMiddle('src/a.ts', 64)).toBe('src/a.ts');
  });

  it('truncates in the middle, keeping the head and the file name', () => {
    const path = 'E:\\Projects\\duya\\packages\\ui\\src\\components\\chat\\ToolActionsGroup.tsx';
    const out = truncatePathMiddle(path, 40);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out).toContain('…');
    expect(out.startsWith('E:\\Projects')).toBe(true);
    expect(out.endsWith('ToolActionsGroup.tsx')).toBe(true);
  });

  it('returns an empty string for an empty path', () => {
    expect(truncatePathMiddle('', 40)).toBe('');
  });
});
