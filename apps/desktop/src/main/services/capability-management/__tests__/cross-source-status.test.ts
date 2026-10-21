/**
 * cross-source-status.test.ts
 *
 * Unit tests for `resolveMcpStatusFields` — the pure decision that
 * fills `CapabilityMcpFields.connectionStatus` / `toolCount` /
 * `tools` / `lastIssue` from the live runtime snapshot, falling back
 * to the last-apply issue list.
 */

import { describe, expect, it } from 'vitest';
import { resolveMcpStatusFields } from '../cross-source';

const issue = (phase: 'connection' | 'registration' | 'discovery') => ({
  phase,
  humanMessage: `issue: ${phase}`,
  severity: 'warning' as const,
});

describe('resolveMcpStatusFields', () => {
  it('prefers live connected runtime + passes tools through', () => {
    const fields = resolveMcpStatusFields({
      rawName: 'fs',
      scopedServerName: 'fs',
      runtimeByName: {
        fs: {
          connectionStatus: 'connected',
          toolCount: 2,
          tools: [
            { name: 'list_directory', description: 'List', annotations: { readOnly: true } },
            { name: 'delete', description: 'Delete', annotations: { destructive: true } },
          ],
        },
      },
      lastIssue: issue('connection'),
    });

    expect(fields.connectionStatus).toBe('connected');
    expect(fields.toolCount).toBe(2);
    expect(fields.tools).toHaveLength(2);
    expect(fields.tools?.[0].annotations).toEqual({ readOnly: true });
    // lastIssue is still surfaced for diagnostics even when live.
    expect(fields.lastIssue?.phase).toBe('connection');
  });

  it('maps live statuses to the capability enum', () => {
    const cases: Array<[string, string]> = [
      ['connecting', 'connecting'],
      ['error', 'error'],
      ['disconnected', 'disconnected'],
    ];
    for (const [live, expected] of cases) {
      const fields = resolveMcpStatusFields({
        rawName: 's',
        scopedServerName: 's',
        runtimeByName: { s: { connectionStatus: live as never, toolCount: 0, tools: [] } },
      });
      expect(fields.connectionStatus).toBe(expected);
    }
  });

  it('matches plugin-scoped server names via scopedServerName', () => {
    const fields = resolveMcpStatusFields({
      rawName: 'notion',
      scopedServerName: 'plugin:com.duya.notion:notion',
      runtimeByName: {
        'plugin:com.duya.notion:notion': {
          connectionStatus: 'connected',
          toolCount: 1,
          tools: [{ name: 'query', description: '' }],
        },
      },
    });

    expect(fields.connectionStatus).toBe('connected');
    expect(fields.tools?.[0].name).toBe('query');
  });

  it('falls back to raw name when scoped lookup misses', () => {
    const fields = resolveMcpStatusFields({
      rawName: 'fs',
      scopedServerName: 'plugin:x:fs',
      runtimeByName: {
        fs: { connectionStatus: 'error', toolCount: 0, tools: [] },
      },
    });

    expect(fields.connectionStatus).toBe('error');
  });

  it('falls back to lastIssue when no live runtime entry', () => {
    const conn = resolveMcpStatusFields({
      rawName: 'a',
      scopedServerName: 'a',
      runtimeByName: {},
      lastIssue: issue('connection'),
    });
    expect(conn.connectionStatus).toBe('error');
    expect(conn.tools).toBeUndefined();

    const reg = resolveMcpStatusFields({
      rawName: 'b',
      scopedServerName: 'b',
      runtimeByName: {},
      lastIssue: issue('registration'),
    });
    expect(reg.connectionStatus).toBe('disconnected');
  });

  it('returns unknown when neither live nor issue is present', () => {
    const fields = resolveMcpStatusFields({
      rawName: 'c',
      scopedServerName: 'c',
      runtimeByName: {},
    });
    expect(fields.connectionStatus).toBe('unknown');
    expect(fields.tools).toBeUndefined();
    expect(fields.toolCount).toBeUndefined();
  });

  it('does not set tools when live runtime has an empty list', () => {
    const fields = resolveMcpStatusFields({
      rawName: 'd',
      scopedServerName: 'd',
      runtimeByName: { d: { connectionStatus: 'connected', toolCount: 0, tools: [] } },
    });
    expect(fields.connectionStatus).toBe('connected');
    expect(fields.toolCount).toBe(0);
    expect(fields.tools).toBeUndefined();
  });
});
