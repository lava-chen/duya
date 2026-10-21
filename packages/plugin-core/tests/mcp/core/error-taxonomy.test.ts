// Plan 580 Phase 1 — error taxonomy / breaker disposition matrix.
import { describe, expect, it } from 'vitest';
import {
  breakerDisposition,
  breakerDispositionForError,
  classifyMcpError,
  errorCodeForClass,
  McpError,
} from '../../../src/mcp/core/error-taxonomy.js';

describe('classifyMcpError (plan 580 D9)', () => {
  it('maps its own McpError codes authoritatively', () => {
    expect(classifyMcpError(new McpError('MCP_TRANSPORT', 'x'))).toBe('transport');
    expect(classifyMcpError(new McpError('MCP_TIMEOUT', 'x'))).toBe('timeout');
    expect(classifyMcpError(new McpError('MCP_PROTOCOL', 'x'))).toBe('protocol');
    expect(classifyMcpError(new McpError('MCP_AUTH_REQUIRED', 'x'))).toBe('auth');
    expect(classifyMcpError(new McpError('MCP_TOOL_ERROR', 'x'))).toBe('business');
  });

  it('classifies SDK UnauthorizedError as auth', () => {
    const err = Object.assign(new Error('Unauthorized'), { name: 'UnauthorizedError' });
    expect(classifyMcpError(err)).toBe('auth');
  });

  it('classifies JSON-RPC error responses (SDK McpError, numeric code) as business — NOT protocol', () => {
    const err = Object.assign(new Error('MCP error -32602: Invalid params'), { code: -32602 });
    expect(classifyMcpError(err)).toBe('business');
  });

  it('classifies timeout errors as timeout', () => {
    expect(classifyMcpError(new Error('Request timed out'))).toBe('timeout');
    expect(classifyMcpError(new Error('callTool "notion.search" timed out after 120000ms'))).toBe('timeout');
  });

  it('classifies malformed responses as protocol', () => {
    expect(classifyMcpError(new Error('Invalid response schema: missing content'))).toBe('protocol');
    expect(classifyMcpError(new Error('failed to parse JSON-RPC message'))).toBe('protocol');
  });

  it('classifies transport failures as transport', () => {
    for (const message of [
      'fetch failed',
      'ECONNRESET',
      'socket hang up',
      'connection closed before response',
      'transport closed',
      'ENOTFOUND mcp.example.com',
      'stream ended unexpectedly',
    ]) {
      expect(classifyMcpError(new Error(message)), message).toBe('transport');
    }
  });

  it('defaults unknown errors to transport (fail-closed availability)', () => {
    expect(classifyMcpError(new Error('something totally weird'))).toBe('transport');
    expect(classifyMcpError(undefined)).toBe('transport');
    expect(classifyMcpError('raw string')).toBe('transport');
  });
});

describe('breakerDisposition (plan 580 D9)', () => {
  it('routes transport/protocol → connection, timeout → tool-scoped, auth/business → ignore', () => {
    expect(breakerDisposition('transport')).toBe('connection');
    expect(breakerDisposition('protocol')).toBe('connection');
    expect(breakerDisposition('timeout')).toBe('tool-scoped');
    expect(breakerDisposition('auth')).toBe('ignore');
    expect(breakerDisposition('business')).toBe('ignore');
  });

  it('matrix: repeated business 4xx errors never justify opening the connection breaker', () => {
    for (let i = 0; i < 10; i++) {
      const { disposition } = breakerDispositionForError(
        Object.assign(new Error('MCP error -32602: invalid request'), { code: -32602 }),
      );
      expect(disposition).toBe('ignore');
    }
  });

  it('matrix: repeated timeouts only hit the tool-scoped counter', () => {
    const { cls, disposition } = breakerDispositionForError(new Error('Request timed out'));
    expect(cls).toBe('timeout');
    expect(disposition).toBe('tool-scoped');
  });

  it('matrix: malformed responses count toward the connection breaker', () => {
    const { cls, disposition } = breakerDispositionForError(new Error('Invalid response schema: x'));
    expect(cls).toBe('protocol');
    expect(disposition).toBe('connection');
  });

  it('stable code mapping is total over the five classes', () => {
    expect(errorCodeForClass('transport')).toBe('MCP_TRANSPORT');
    expect(errorCodeForClass('timeout')).toBe('MCP_TIMEOUT');
    expect(errorCodeForClass('protocol')).toBe('MCP_PROTOCOL');
    expect(errorCodeForClass('auth')).toBe('MCP_AUTH_REQUIRED');
    expect(errorCodeForClass('business')).toBe('MCP_TOOL_ERROR');
  });
});
