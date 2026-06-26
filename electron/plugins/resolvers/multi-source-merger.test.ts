import { describe, it, expect } from 'vitest';
import { mergePluginsByPriority } from './multi-source-merger';
import type {
  PluginPriority,
  PluginSource,
  PrioritizedPlugin,
} from './types';

function mockEntry(id: string, name: string, version: string) {
  return {
    id,
    name,
    version,
    enabled: true,
    installPath: `/plugins/${id}`,
    dataPath: `/data/${id}`,
    source: 'marketplace' as const,
    trustLevel: 'untrusted' as const,
    installedAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    grantedPermissions: [],
    setupState: 'complete' as const,
    health: { status: 'ready' as const, reasons: [], checkedAt: '2026-01-01T00:00:00Z' },
  };
}

function mockSource(): PluginSource {
  return { type: 'github', identifier: 'test' };
}

function p(id: string, priority: PluginPriority): PrioritizedPlugin {
  return {
    entry: mockEntry(id, id, '1.0.0'),
    source: mockSource(),
    priority,
  };
}

describe('multi-source-merger', () => {
  describe('mergePluginsByPriority', () => {
    it('keeps highest priority when two plugins have same id', () => {
      const result = mergePluginsByPriority([
        p('plugin-a', 'builtin'),
        p('plugin-a', 'user'),
      ]);
      expect(result).toHaveLength(1);
      expect(result[0].priority).toBe('user');
    });

    it('handles multi-source plugins with no conflicts', () => {
      const result = mergePluginsByPriority([
        p('plugin-a', 'builtin'),
        p('plugin-b', 'user'),
        p('plugin-c', 'project'),
      ]);
      expect(result).toHaveLength(3);
    });

    it('session priority overrides everything', () => {
      const result = mergePluginsByPriority([
        p('plugin-x', 'builtin'),
        p('plugin-x', 'user'),
        p('plugin-x', 'session'),
      ]);
      expect(result).toHaveLength(1);
      expect(result[0].priority).toBe('session');
    });

    it('managed lock prevents override', () => {
      const result = mergePluginsByPriority(
        [
          p('plugin-locked', 'builtin'),
          p('plugin-locked', 'user'),
        ],
        { managedLockedIds: new Set(['plugin-locked']) },
      );
      expect(result).toHaveLength(1);
      expect(result[0].priority).toBe('builtin');
    });

    it('multiple plugins with no overlapping ids', () => {
      const result = mergePluginsByPriority([
        p('a', 'user'),
        p('b', 'project'),
        p('c', 'builtin'),
        p('d', 'session'),
      ]);
      expect(result).toHaveLength(4);
    });

    it('lower priority does not replace higher', () => {
      const result = mergePluginsByPriority([
        p('plugin-z', 'user'),
        p('plugin-z', 'builtin'),
      ]);
      expect(result).toHaveLength(1);
      expect(result[0].priority).toBe('user');
    });
  });
});