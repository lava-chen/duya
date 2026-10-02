/**
 * Plan 580 Phase 4B — breaker decoupling matrix.
 *
 * Reproduces the exact disposition wiring of chain A's `MCPClient.callTool`
 * catch block (classify → breakerDisposition → per-breaker recordFailure)
 * and asserts the availability matrix from plan 580 §D9:
 *
 *   | class     | disposition  | counter                    |
 *   |-----------|--------------|----------------------------|
 *   | transport | connection   | connection breaker         |
 *   | protocol  | connection   | connection breaker         |
 *   | timeout   | tool-scoped  | `${connection}:${tool}`    |
 *   | auth      | ignore       | none                       |
 *   | business  | ignore       | none                       |
 *
 * Thresholds mirror CircuitBreaker defaults (3 failures open, 30s cooldown).
 */

import { describe, it, expect } from 'vitest';
import { McpError } from '@duya/plugin-core/mcp/core/error-taxonomy';
import {
  classifyMcpError,
  breakerDisposition,
} from '@duya/plugin-core/mcp/core/error-taxonomy';
import { getCircuitBreakerManager } from '../circuit-breaker.js';

/** Mirror of the chain A catch-block wiring (mcp/index.ts callTool). */
function routeFailure(
  error: unknown,
  opts: { connection: string; tool: string },
): { cls: string; disposition: string } {
  const connectionBreaker = getCircuitBreakerManager().getBreaker(opts.connection);
  const toolScopedBreaker = getCircuitBreakerManager().getBreaker(`${opts.connection}:${opts.tool}`);
  const cls = classifyMcpError(error);
  const disposition = breakerDisposition(cls);
  switch (disposition) {
    case 'connection':
      connectionBreaker.recordFailure();
      break;
    case 'tool-scoped':
      toolScopedBreaker.recordFailure();
      break;
    case 'ignore':
      break;
  }
  return { cls, disposition };
}

const CONNECTION = 'breaker-matrix-server';
const TOOL = 'generate_chart';

describe('breaker decoupling matrix (plan 580 D9)', () => {
  it('business errors (JSON-RPC error responses) NEVER open any breaker', () => {
    const conn = getCircuitBreakerManager().getBreaker(`${CONNECTION}-biz`);
    const tool = getCircuitBreakerManager().getBreaker(`${CONNECTION}-biz:${TOOL}`);
    conn.reset();
    tool.reset();
    for (let i = 0; i < 10; i++) {
      const { disposition } = routeFailure(
        new McpError('MCP_TOOL_ERROR', 'Invalid database_id'),
        { connection: `${CONNECTION}-biz`, tool: TOOL },
      );
      expect(disposition).toBe('ignore');
    }
    expect(conn.canExecute()).toBe(true);
    expect(tool.canExecute()).toBe(true);
  });

  it('auth errors never open any breaker (reauth card contract)', () => {
    const conn = getCircuitBreakerManager().getBreaker(`${CONNECTION}-auth`);
    const tool = getCircuitBreakerManager().getBreaker(`${CONNECTION}-auth:${TOOL}`);
    conn.reset();
    tool.reset();
    for (let i = 0; i < 10; i++) {
      const { disposition } = routeFailure(
        new McpError('MCP_AUTH_REQUIRED', 'token expired'),
        { connection: `${CONNECTION}-auth`, tool: TOOL },
      );
      expect(disposition).toBe('ignore');
    }
    expect(conn.canExecute()).toBe(true);
    expect(tool.canExecute()).toBe(true);
  });

  it('timeouts open ONLY the tool-scoped breaker after 3 failures', () => {
    const connKey = `${CONNECTION}-timeout`;
    const conn = getCircuitBreakerManager().getBreaker(connKey);
    const tool = getCircuitBreakerManager().getBreaker(`${connKey}:${TOOL}`);
    conn.reset();
    tool.reset();
    for (let i = 0; i < 3; i++) {
      const { disposition } = routeFailure(
        new McpError('MCP_TIMEOUT', 'deadline exceeded'),
        { connection: connKey, tool: TOOL },
      );
      expect(disposition).toBe('tool-scoped');
    }
    expect(tool.canExecute()).toBe(false);
    // The connection breaker never saw a failure — other tools keep working.
    expect(conn.canExecute()).toBe(true);
  });

  it('transport failures open the connection breaker after 3 (tool-scoped untouched)', () => {
    const connKey = `${CONNECTION}-transport`;
    const otherTool = getCircuitBreakerManager().getBreaker(`${connKey}:other_tool`);
    otherTool.reset();
    for (let i = 0; i < 3; i++) {
      const { disposition } = routeFailure(
        new Error('fetch failed: ECONNRESET'),
        { connection: connKey, tool: TOOL },
      );
      expect(disposition).toBe('connection');
    }
    expect(getCircuitBreakerManager().getBreaker(connKey).canExecute()).toBe(false);
    expect(otherTool.canExecute()).toBe(true);
  });

  it('malformed responses (protocol) open the connection breaker after 3', () => {
    const connKey = `${CONNECTION}-protocol`;
    for (let i = 0; i < 3; i++) {
      const { disposition } = routeFailure(
        new Error('failed to parse response: unexpected end of JSON'),
        { connection: connKey, tool: TOOL },
      );
      expect(disposition).toBe('connection');
    }
    expect(getCircuitBreakerManager().getBreaker(connKey).canExecute()).toBe(false);
  });
});
