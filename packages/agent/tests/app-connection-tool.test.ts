/**
 * app-connection-tool.test.ts — Plan 312 Phase 3.
 *
 * Covers the agent-side AppConnectionTool:
 *   - createAppConnectionTool produces valid definition + executor + meta
 *   - executor calls ipcRequest with correct channel + payload
 *   - executor formats success response as JSON string
 *   - executor formats error response with actionable hint
 *   - executor with no context returns NO_IPC error
 *   - registerAppConnectionTools adds tools to a registry
 *   - setCachedAppConnectionDescriptors / getCachedAppConnectionDescriptors roundtrip
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ToolRegistry } from '../src/tool/registry';
import {
  createAppConnectionTool,
  registerAppConnectionTools,
  setCachedAppConnectionDescriptors,
  getCachedAppConnectionDescriptors,
  type AppConnectionToolDescriptor,
} from '../src/tool/AppConnectionTool/index';
import type { ToolUseContext } from '../src/types';

function makeDescriptor(overrides: Partial<AppConnectionToolDescriptor> = {}): AppConnectionToolDescriptor {
  return {
    name: 'google_drive_list_files',
    description: 'List files from Google Drive. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        pageSize: { type: 'number', description: 'Max results (1-100).' },
      },
      required: [],
    },
    inputSchemaSummary: 'pageSize?: number (1-100, default 20).',
    riskTier: 'read',
    provider: 'google',
    connectionId: 'conn-1',
    action: 'drive.list_files',
    ...overrides,
  };
}

function makeContext(ipcRequest?: ToolUseContext['ipcRequest']): ToolUseContext {
  return {
    toolUseId: 'tu-1',
    getAppState: () => ({} as never),
    setAppState: () => {},
    abortController: new AbortController(),
    options: {} as never,
    ipcRequest,
  } as unknown as ToolUseContext;
}

describe('AppConnectionTool', () => {
  describe('createAppConnectionTool', () => {
    it('produces a valid definition + executor + meta', () => {
      const desc = makeDescriptor();
      const { definition, executor, meta } = createAppConnectionTool(desc);

      expect(definition.name).toBe('google_drive_list_files');
      expect(definition.description).toContain('Google Drive');
      expect(definition.input_schema.type).toBe('object');
      expect(meta.exposeMode).toBe('discoverable');
      expect(meta.inputSchemaSummary).toBe(desc.inputSchemaSummary);
      expect(typeof executor.execute).toBe('function');
    });
  });

  describe('executor.execute', () => {
    it('calls ipcRequest with appConnection:invoke channel + connectionId/action/args', async () => {
      const desc = makeDescriptor();
      const { executor } = createAppConnectionTool(desc);

      const ipcRequest = vi.fn().mockResolvedValue({
        success: true,
        data: [{ id: 'f1', name: 'test.txt' }],
      });

      const result = await executor.execute(
        { pageSize: 10 },
        undefined,
        makeContext(ipcRequest),
      );

      expect(ipcRequest).toHaveBeenCalledWith(
        'appConnection:invoke',
        { connectionId: 'conn-1', action: 'drive.list_files', args: { pageSize: 10 } },
        { timeout: 60_000 },
      );
      expect(result.name).toBe('google_drive_list_files');
      expect(result.error).toBe(false);
      const parsed = JSON.parse(result.result);
      expect(parsed.success).toBe(true);
      expect(parsed.data).toEqual([{ id: 'f1', name: 'test.txt' }]);
    });

    it('returns error with actionable hint for connection_not_available', async () => {
      const desc = makeDescriptor();
      const { executor } = createAppConnectionTool(desc);

      const ipcRequest = vi.fn().mockResolvedValue({
        success: false,
        error: { code: 'connection_not_available', message: 'access token expired' },
      });

      const result = await executor.execute(
        {},
        undefined,
        makeContext(ipcRequest),
      );

      expect(result.error).toBe(true);
      const parsed = JSON.parse(result.result);
      expect(parsed.success).toBe(false);
      expect(parsed.error.code).toBe('connection_not_available');
      expect(parsed.error.message).toContain('reconnect');
    });

    it('returns NO_IPC error when context.ipcRequest is missing', async () => {
      const desc = makeDescriptor();
      const { executor } = createAppConnectionTool(desc);

      const result = await executor.execute(
        {},
        undefined,
        makeContext(undefined),
      );

      expect(result.error).toBe(true);
      const parsed = JSON.parse(result.result);
      expect(parsed.error.code).toBe('NO_IPC');
    });

    it('returns generic error for non-connection error codes', async () => {
      const desc = makeDescriptor();
      const { executor } = createAppConnectionTool(desc);

      const ipcRequest = vi.fn().mockResolvedValue({
        success: false,
        error: { code: 'provider_error', message: 'API rate limited' },
      });

      const result = await executor.execute(
        {},
        undefined,
        makeContext(ipcRequest),
      );

      expect(result.error).toBe(true);
      const parsed = JSON.parse(result.result);
      expect(parsed.error.code).toBe('provider_error');
      expect(parsed.error.message).toBe('API rate limited');
    });
  });

  describe('registerAppConnectionTools', () => {
    it('registers descriptors into a fresh registry', () => {
      const registry = new ToolRegistry();
      const descs = [
        makeDescriptor({ name: 'google_drive_list_files' }),
        makeDescriptor({ name: 'slack_search_messages', provider: 'slack', connectionId: 'conn-2' }),
      ];

      const result = registerAppConnectionTools(registry, descs);

      expect(result.added).toBe(2);
      expect(registry.has('google_drive_list_files')).toBe(true);
      expect(registry.has('slack_search_messages')).toBe(true);
      // discoverable tools are registered with meta
      expect(registry.getExposeMode('google_drive_list_files')).toBe('discoverable');
    });

    it('removes stale connector-prefixed tools not in the new set', () => {
      const registry = new ToolRegistry();
      // Pre-register a stale connector tool
      const staleDesc = makeDescriptor({ name: 'google_old_tool' });
      const { definition, executor, meta } = createAppConnectionTool(staleDesc);
      registry.register(definition, executor, meta);
      expect(registry.has('google_old_tool')).toBe(true);

      // Register new set without the stale tool
      const result = registerAppConnectionTools(registry, [
        makeDescriptor({ name: 'google_drive_list_files' }),
      ]);

      expect(result.removed).toBe(1);
      expect(registry.has('google_old_tool')).toBe(false);
      expect(registry.has('google_drive_list_files')).toBe(true);
    });
  });

  describe('descriptor cache', () => {
    it('setCachedAppConnectionDescriptors + getCachedAppConnectionDescriptors roundtrip', () => {
      const descs = [makeDescriptor(), makeDescriptor({ name: 'slack_search_messages' })];
      setCachedAppConnectionDescriptors(descs);
      const cached = getCachedAppConnectionDescriptors();
      expect(cached).toHaveLength(2);
      expect(cached[0]!.name).toBe('google_drive_list_files');
    });

    it('getCachedAppConnectionDescriptors returns empty array by default', () => {
      setCachedAppConnectionDescriptors([]);
      expect(getCachedAppConnectionDescriptors()).toEqual([]);
    });
  });
});
