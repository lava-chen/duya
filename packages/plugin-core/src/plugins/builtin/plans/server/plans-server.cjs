#!/usr/bin/env node
'use strict';
/**
 * plans-server.cjs — minimal MCP stdio server exposing the duya plans
 * tools (Plan 525 Phase 4):
 *
 *   plan_status    { projectId, status? }         — list a project's plans
 *   plan_search    { query, scope?, projectId? }  — keyword search across projects
 *   plan_complete  { projectId, planId }          — archive active → completed
 *
 * Hand-rolled newline-delimited JSON-RPC over stdio (the MCP stdio
 * transport wire format) with zero npm dependencies — see plans-core.cjs
 * for why the plugin ships unbundled. Supports exactly what the duya
 * MCP client needs: initialize / tools/list / tools/call / ping, and
 * ignores notifications.
 *
 * The storage root is resolved from the user home (~/.duya/projects,
 * DUYA_TEST-namespace aware), so no workspace injection is required —
 * projectId comes in with each tool call instead (plan 525 §4).
 */

const readline = require('readline');
const core = require('./plans-core.cjs');

const SERVER_INFO = { name: 'duya-plans', version: '0.1.0' };

const TOOLS = [
  {
    name: 'plan_status',
    description:
      'List the plans of one duya project from its global plans directory (~/.duya/projects/<projectId>/plans). ' +
      'Defaults to active plans; pass status "all" to include completed ones. This replaces reading the plans README.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project identifier (UUID or slug-style id).' },
        status: { type: 'string', enum: ['active', 'all'], description: 'Filter. Default: active.' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'plan_search',
    description:
      'Keyword search over duya plan indexes across all projects (title / slug / tags / id match). ' +
      'Returns projectId + file path so the plan document can be read with the ordinary file tools.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keyword to match (case-insensitive substring).' },
        scope: { type: 'string', enum: ['all', 'project'], description: 'Search scope. Default: all.' },
        projectId: { type: 'string', description: 'Required when scope is "project".' },
      },
      required: ['query'],
    },
  },
  {
    name: 'plan_complete',
    description:
      'Archive a duya plan: rewrite frontmatter status to "done" and move the file from plans/active/ to ' +
      'plans/completed/, updating index.json. The only write tool — creating or editing plan content stays ' +
      'with the ordinary file tools.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project identifier.' },
        planId: { type: 'number', description: 'Numeric id of the plan to archive.' },
      },
      required: ['projectId', 'planId'],
    },
  },
];

function dispatchTool(name, args) {
  const projectsRoot = core.resolveProjectsRoot();
  const input = { ...args, projectsRoot };
  switch (name) {
    case 'plan_status':
      return core.planStatus(input);
    case 'plan_search':
      return core.planSearch(input);
    case 'plan_complete':
      return core.planComplete(input);
    default:
      throw new core.PlansError(`unknown tool: ${name}`, 'unknown_tool');
  }
}

function textResult(payload, isError = false) {
  const result = { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  if (isError) result.isError = true;
  return result;
}

function handleMessage(message) {
  if (!message || typeof message !== 'object') return null;
  const { id, method, params } = message;

  // Notifications (no id) never get a response.
  if (id === undefined || id === null) return null;

  try {
    switch (method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05',
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
          },
        };
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
      case 'tools/call': {
        const name = typeof params?.name === 'string' ? params.name : '';
        const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
        try {
          return { jsonrpc: '2.0', id, result: textResult(dispatchTool(name, args)) };
        } catch (err) {
          const payload = {
            error: err instanceof Error ? err.message : String(err),
            code: err && typeof err.code === 'string' ? err.code : 'tool_error',
          };
          return { jsonrpc: '2.0', id, result: textResult(payload, true) };
        }
      }
      default:
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `method not found: ${method}` },
        };
    }
  } catch (err) {
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
    };
  }
}

function main() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return; // not JSON — drop the line, keep the server alive
    }
    const response = handleMessage(message);
    if (response) process.stdout.write(JSON.stringify(response) + '\n');
  });
  rl.on('close', () => process.exit(0));
}

if (require.main === module) main();

module.exports = { handleMessage, dispatchTool, TOOLS };
