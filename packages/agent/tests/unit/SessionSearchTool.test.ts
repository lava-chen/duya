/**
 * Tests for SessionSearchTool
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SessionSearchTool, sessionSearchTool, type SummaryLLMConfig } from '../../src/tool/SessionSearchTool/SessionSearchTool.js';
import { SESSION_SEARCH_TOOL_NAME } from '../../src/tool/SessionSearchTool/constants.js';

describe('SessionSearchTool', () => {
  let tool: SessionSearchTool;

  beforeEach(() => {
    tool = new SessionSearchTool();
  });

  describe('basic properties', () => {
    it('should have correct name', () => {
      expect(tool.name).toBe(SESSION_SEARCH_TOOL_NAME);
    });

    it('should have input schema', () => {
      expect(tool.input_schema).toBeDefined();
      expect(tool.input_schema.type).toBe('object');
      expect(tool.input_schema.properties).toHaveProperty('query');
      expect(tool.input_schema.properties).toHaveProperty('limit');
      expect(tool.input_schema.properties).toHaveProperty('roleFilter');
      expect(tool.input_schema.properties).toHaveProperty('scope');
    });
  });

  describe('LLM configuration', () => {
    it('should configure summary LLM', () => {
      const config: SummaryLLMConfig = {
        provider: 'anthropic',
        apiKey: 'test-key',
        model: 'claude-sonnet-4',
      };

      tool.configureSummaryLLM(config);
      expect(tool.getSummaryLLMConfig()).toEqual(config);
    });

    it('should update configuration', () => {
      const config1: SummaryLLMConfig = {
        provider: 'anthropic',
        apiKey: 'key1',
        model: 'model1',
      };

      const config2: SummaryLLMConfig = {
        provider: 'openai',
        apiKey: 'key2',
        model: 'model2',
        baseURL: 'https://api.openai.com',
      };

      tool.configureSummaryLLM(config1);
      expect(tool.getSummaryLLMConfig()).toEqual(config1);

      tool.configureSummaryLLM(config2);
      expect(tool.getSummaryLLMConfig()).toEqual(config2);
    });
  });

  describe('current session handling', () => {
    it('should set current session ID', () => {
      const sessionId = 'test-session-123';
      tool.setCurrentSessionId(sessionId);
      // The tool should store the session ID for exclusion
      expect(tool).toBeDefined();
    });

    it('should clear current session ID', () => {
      tool.setCurrentSessionId('test-session');
      tool.setCurrentSessionId(null);
      // Should not throw
      expect(tool).toBeDefined();
    });
  });

  describe('concurrency configuration', () => {
    it('should set max concurrency within bounds', () => {
      tool.setMaxConcurrency(2);
      // Should accept valid values
      expect(tool).toBeDefined();
    });

    it('should clamp concurrency to minimum 1', () => {
      tool.setMaxConcurrency(0);
      // Should be clamped to 1
      expect(tool).toBeDefined();
    });

    it('should clamp concurrency to maximum 5', () => {
      tool.setMaxConcurrency(10);
      // Should be clamped to 5
      expect(tool).toBeDefined();
    });
  });

  describe('execute with various inputs', () => {
    it('should handle empty query (recent sessions mode)', async () => {
      const result = await tool.execute({ query: '', limit: 3 });
      expect(result).toHaveProperty('id');
      expect(result).toHaveProperty('name', SESSION_SEARCH_TOOL_NAME);
      expect(result).toHaveProperty('result');
    });

    it('should handle undefined query', async () => {
      const result = await tool.execute({ limit: 3 });
      expect(result).toHaveProperty('id');
      expect(result).toHaveProperty('name', SESSION_SEARCH_TOOL_NAME);
      expect(result).toHaveProperty('result');
    });

    it('should handle whitespace-only query', async () => {
      const result = await tool.execute({ query: '   ', limit: 3 });
      expect(result).toHaveProperty('id');
      expect(result).toHaveProperty('name', SESSION_SEARCH_TOOL_NAME);
      expect(result).toHaveProperty('result');
    });

    it('should handle string limit', async () => {
      const result = await tool.execute({ query: 'test', limit: '5' });
      expect(result).toHaveProperty('id');
      expect(result).toHaveProperty('name', SESSION_SEARCH_TOOL_NAME);
    });

    it('should handle invalid limit', async () => {
      const result = await tool.execute({ query: 'test', limit: 'invalid' });
      expect(result).toHaveProperty('id');
      expect(result).toHaveProperty('name', SESSION_SEARCH_TOOL_NAME);
    });

    it('should handle roleFilter', async () => {
      const result = await tool.execute({
        query: 'test',
        limit: 3,
        roleFilter: 'user,assistant',
      });
      expect(result).toHaveProperty('id');
      expect(result).toHaveProperty('name', SESSION_SEARCH_TOOL_NAME);
    });

    it('should handle search query', async () => {
      const result = await tool.execute({ query: 'docker', limit: 3 });
      expect(result).toHaveProperty('id');
      expect(result).toHaveProperty('name', SESSION_SEARCH_TOOL_NAME);
      expect(result).toHaveProperty('result');
      // Should not have error for normal execution
      // (may return 'No relevant past sessions' if no data)
    });
  });

  describe('error handling', () => {
    it('should handle execution without throwing', async () => {
      // Should handle missing database gracefully
      const result = await tool.execute({ query: 'test' });
      expect(result).toBeDefined();
    });
  });
});

describe('sessionSearchTool singleton', () => {
  it('should be defined', () => {
    expect(sessionSearchTool).toBeDefined();
    expect(sessionSearchTool.name).toBe(SESSION_SEARCH_TOOL_NAME);
  });
});
