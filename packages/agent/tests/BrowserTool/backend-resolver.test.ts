import { describe, it, expect } from 'vitest';
import { resolveBackend, type BrowserBackendMode } from '../../src/tool/BrowserTool/backend-resolver';

describe('resolveBackend', () => {
  it('auto mode: uses extension when online', () => {
    expect(resolveBackend('auto', true, true)).toBe('extension');
  });

  it('auto mode: falls back to webview when extension offline', () => {
    expect(resolveBackend('auto', false, true)).toBe('webview');
  });

  it('auto mode: falls back to static fetch when neither available', () => {
    expect(resolveBackend('auto', false, false)).toBe('fallback');
  });

  it('extension mode: always uses extension (no degradation)', () => {
    expect(resolveBackend('extension', false, false)).toBe('extension');
  });

  it('built-in mode: always uses webview (no degradation)', () => {
    expect(resolveBackend('built-in', true, true)).toBe('webview');
  });

  it('built-in mode: falls back to static fetch when renderer unavailable', () => {
    expect(resolveBackend('built-in', true, false)).toBe('fallback');
  });

  it('auto mode: prefers extension over webview when both available', () => {
    expect(resolveBackend('auto', true, true)).toBe('extension');
  });

  it('auto mode: uses webview when only renderer is available', () => {
    expect(resolveBackend('auto', false, true)).toBe('webview');
  });

  it('human-like mode: uses human-like backend when renderer available', () => {
    expect(resolveBackend('human-like', true, true)).toBe('human-like');
  });

  it('human-like mode: falls back to static fetch when renderer unavailable', () => {
    expect(resolveBackend('human-like', true, false)).toBe('fallback');
  });

  it('handles all mode values without throwing', () => {
    const modes: BrowserBackendMode[] = ['auto', 'extension', 'built-in', 'human-like'];
    for (const mode of modes) {
      expect(() => resolveBackend(mode, true, true)).not.toThrow();
      expect(() => resolveBackend(mode, false, false)).not.toThrow();
    }
  });
});
