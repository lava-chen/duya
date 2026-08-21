/**
 * mcp-runtime-store.test.ts
 *
 * Unit tests for the module-scope SSE snapshot cache that feeds the
 * capability-management aggregator.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  setLastMCpStatusSnapshot,
  getLatestMcpStatusByServer,
  getLastMcpStatusReceivedAt,
  _resetMcpRuntimeStore,
} from '../mcp-runtime-store';

describe('mcp-runtime-store', () => {
  beforeEach(() => {
    _resetMcpRuntimeStore();
  });

  it('ingests a worker snapshot and exposes a defensive copy', () => {
    setLastMCpStatusSnapshot({
      mcpStatus: {
        filesystem: {
          connectionStatus: 'connected',
          toolCount: 2,
          tools: [
            { name: 'list_directory', description: 'List a directory', annotations: { readOnly: true } },
            { name: 'delete_file', description: 'Delete a file', annotations: { destructive: true } },
          ],
        },
      },
    });

    const snapshot = getLatestMcpStatusByServer();
    expect(Object.keys(snapshot)).toEqual(['filesystem']);
    expect(snapshot.filesystem.connectionStatus).toBe('connected');
    expect(snapshot.filesystem.toolCount).toBe(2);
    expect(snapshot.filesystem.tools).toHaveLength(2);
    expect(snapshot.filesystem.tools[0]).toMatchObject({ name: 'list_directory', annotations: { readOnly: true } });
  });

  it('skips malformed entries and invalid connectionStatus values', () => {
    setLastMCpStatusSnapshot({
      mcpStatus: {
        good: { connectionStatus: 'connected', toolCount: 1, tools: [{ name: 't' }] },
        badStatus: { connectionStatus: 'bogus', toolCount: 1, tools: [] },
        // Non-array tools degrade to an empty list, not an error.
        badTools: { connectionStatus: 'connected', toolCount: 1, tools: 'nope' },
        notObject: 42,
      },
    });

    const snapshot = getLatestMcpStatusByServer();
    expect(Object.keys(snapshot)).toEqual(['good', 'badTools']);
    expect(snapshot.badTools.tools).toEqual([]);
  });

  it('normalizes missing tool name entries out of the tool list', () => {
    setLastMCpStatusSnapshot({
      mcpStatus: {
        s: {
          connectionStatus: 'connected',
          toolCount: 3,
          tools: [
            { name: 'ok', description: 'fine' },
            { description: 'no name' },
            null,
          ],
        },
      },
    });

    const snapshot = getLatestMcpStatusByServer();
    expect(snapshot.s.tools).toEqual([{ name: 'ok', description: 'fine', annotations: undefined }]);
  });

  it('returns {} for null / malformed payloads without throwing', () => {
    setLastMCpStatusSnapshot(null);
    setLastMCpStatusSnapshot('junk');
    setLastMCpStatusSnapshot({ noMcpStatus: true });
    expect(getLatestMcpStatusByServer()).toEqual({});
    expect(getLastMcpStatusReceivedAt()).toBe(0);
  });

  it('records the received timestamp on ingest', () => {
    expect(getLastMcpStatusReceivedAt()).toBe(0);
    setLastMCpStatusSnapshot({
      mcpStatus: { s: { connectionStatus: 'error', toolCount: 0, tools: [] } },
    });
    expect(getLastMcpStatusReceivedAt()).toBeGreaterThan(0);
  });
});
