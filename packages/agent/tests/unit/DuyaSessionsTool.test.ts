import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DuyaSessionsTool,
  duyaSessionsTool,
} from '../../src/tool/DuyaSessionsTool/DuyaSessionsTool.js';
import { DUYA_SESSIONS_TOOL_NAME } from '../../src/tool/DuyaSessionsTool/constants.js';

const { mockSessionDb, mockSearchDb } = vi.hoisted(() => ({
  mockSessionDb: {
    list: vi.fn(),
    get: vi.fn(),
  },
  mockSearchDb: {
    sessions: vi.fn(),
  },
}));

vi.mock('../../src/ipc/db-client.js', () => ({
  sessionDb: mockSessionDb,
  searchDb: mockSearchDb,
}));

describe('DuyaSessionsTool', () => {
  let tool: DuyaSessionsTool;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = new DuyaSessionsTool();
  });

  describe('basic properties', () => {
    it('should have correct name', () => {
      expect(tool.name).toBe(DUYA_SESSIONS_TOOL_NAME);
    });

    it('should have input schema', () => {
      expect(tool.input_schema).toBeDefined();
      expect(tool.input_schema.type).toBe('object');
      expect(tool.input_schema.required).toContain('action');
      expect(tool.input_schema.properties).toHaveProperty('action');
    });
  });

  describe('execute - list', () => {
    it('should list sessions with default limit', async () => {
      mockSessionDb.list.mockResolvedValue([
        { id: 's1', title: 'Chat 1', model: 'gpt-4o', mode: 'chat', updated_at: 1700000000000, working_directory: '/tmp' },
        { id: 's2', title: 'Chat 2', model: 'claude', mode: 'auto', updated_at: 1700000001000, working_directory: '/tmp' },
      ]);

      const result = await tool.execute({ action: 'list' });
      expect(result.error).toBeFalsy();

      const parsed = JSON.parse(result.result);
      expect(parsed.count).toBe(2);
      expect(parsed.sessions[0].id).toBe('s1');
      expect(parsed.sessions[0].title).toBe('Chat 1');
    });

    it('should limit results', async () => {
      const sessions = Array.from({ length: 20 }, (_, i) => ({
        id: `s${i}`,
        title: `Chat ${i}`,
        model: 'gpt-4o',
        mode: 'chat',
        updated_at: 1700000000000 + i,
        working_directory: '/tmp',
      }));
      mockSessionDb.list.mockResolvedValue(sessions);

      const result = await tool.execute({ action: 'list', limit: 5 });
      const parsed = JSON.parse(result.result);
      expect(parsed.count).toBe(5);
    });

    it('should not crash with limit over 50', async () => {
      mockSessionDb.list.mockResolvedValue([]);
      const result = await tool.execute({ action: 'list', limit: 100 });
      expect(result.error).toBeFalsy();
    });

    it('should handle empty list', async () => {
      mockSessionDb.list.mockResolvedValue([]);

      const result = await tool.execute({ action: 'list' });
      const parsed = JSON.parse(result.result);
      expect(parsed.count).toBe(0);
    });
  });

  describe('execute - search', () => {
    it('should search sessions by query', async () => {
      mockSearchDb.sessions.mockResolvedValue([
        { id: 's1', title: 'API Design', model: 'gpt-4o', updated_at: 1700000000000 },
        { id: 's2', title: 'REST API Discussion', model: 'claude', updated_at: 1700000001000 },
      ]);

      const result = await tool.execute({ action: 'search', query: 'API' });
      const parsed = JSON.parse(result.result);
      expect(parsed.count).toBe(2);
      expect(parsed.query).toBe('API');
      expect(mockSearchDb.sessions).toHaveBeenCalledWith('API', 10);
    });

    it('should pass limit to search', async () => {
      mockSearchDb.sessions.mockResolvedValue([]);

      await tool.execute({ action: 'search', query: 'docker', limit: 5 });
      expect(mockSearchDb.sessions).toHaveBeenCalledWith('docker', 5);
    });

    it('should reject empty query', async () => {
      const result = await tool.execute({ action: 'search', query: '' });
      expect(result.error).toBe(true);
      expect(result.result).toContain('query is required');
    });

    it('should reject whitespace-only query', async () => {
      const result = await tool.execute({ action: 'search', query: '   ' });
      expect(result.error).toBe(true);
    });
  });

  describe('execute - info', () => {
    it('should get session info by id', async () => {
      mockSessionDb.get.mockResolvedValue({
        id: 's1',
        title: 'Important Chat',
        model: 'gpt-4o',
        mode: 'chat',
        provider_id: 'openai',
        working_directory: '/tmp',
        created_at: 1700000000000,
        updated_at: 1700000001000,
        status: 'active',
      });

      const result = await tool.execute({ action: 'info', sessionId: 's1' });
      const parsed = JSON.parse(result.result);
      expect(parsed.id).toBe('s1');
      expect(parsed.title).toBe('Important Chat');
      expect(parsed.model).toBe('gpt-4o');
    });

    it('should reject missing sessionId', async () => {
      const result = await tool.execute({ action: 'info' });
      expect(result.error).toBe(true);
    });

    it('should handle not found session', async () => {
      mockSessionDb.get.mockResolvedValue(null);

      const result = await tool.execute({ action: 'info', sessionId: 'nonexistent' });
      expect(result.error).toBe(true);
      expect(result.result).toContain('not found');
    });
  });

  describe('execute - invalid action', () => {
    it('should reject unknown action', async () => {
      const result = await tool.execute({ action: 'delete_session' });
      expect(result.error).toBe(true);
      expect(result.result).toContain('Invalid input');
    });
  });
});

describe('duyaSessionsTool singleton', () => {
  it('should be defined', () => {
    expect(duyaSessionsTool).toBeDefined();
    expect(duyaSessionsTool.name).toBe(DUYA_SESSIONS_TOOL_NAME);
  });
});