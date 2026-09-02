import { describe, expect, it } from 'vitest';
import {
  toolSchemaTool,
  TRUNCATED_DESCRIPTION_SUFFIX,
  type ToolCatalogNamespace,
} from '../../src/tool/ToolSchemaTool/ToolSchemaTool.js';
import { toolInvokeTool } from '../../src/tool/ToolInvokeTool/ToolInvokeTool.js';
import { createToolInvokeDispatcherFromRegistry } from '../../src/tool/ToolInvokeTool/dispatcherFromRegistry.js';
import { createToolSchemaProviderFromRegistry } from '../../src/tool/ToolSchemaTool/catalogFromRegistry.js';
import { ToolRegistry, type ToolExecutor } from '../../src/tool/registry.js';
import type { Tool, ToolResult } from '../../src/types.js';

const LONG_DESCRIPTION = 'd'.repeat(500);

function makeCatalog(): ToolCatalogNamespace[] {
  return [
    {
      namespace: 'github',
      source: 'mcp',
      tools: [
        {
          name: 'create_issue',
          description: 'Create an issue in a repository',
          inputSchema: {
            type: 'object',
            properties: { title: { type: 'string' }, body: { type: 'string' } },
            required: ['title'],
          },
        },
        {
          name: 'list_pull_requests',
          description: LONG_DESCRIPTION,
          inputSchema: { type: 'object' },
        },
      ],
    },
    {
      namespace: 'slack',
      tools: [{ name: 'post_message', description: 'Post a message' }],
    },
  ];
}

function resultText(result: { result: string }): string {
  return result.result;
}

describe('tool_schema (Plan 480 P2.1)', () => {
  it('returns a not-configured error when no provider is set', async () => {
    toolSchemaTool.setProvider(undefined as never);
    const out = await toolSchemaTool.execute({});
    expect(out.error).toBe(true);
    expect(resultText(out)).toContain('not configured');
  });

  it('mode 4 — no arguments returns a catalog overview', async () => {
    toolSchemaTool.setProvider({ getCatalog: () => makeCatalog() });
    const out = await toolSchemaTool.execute({});
    expect(out.error).toBeUndefined();
    const text = resultText(out);
    expect(text).toContain('# Tool Schema Catalog');
    expect(text).toContain('`github`');
    expect(text).toContain('create_issue, list_pull_requests');
    expect(text).toContain('`slack`');
    // Overview never leaks full schemas.
    expect(text).not.toContain('input_schema');
    expect(text).not.toContain('"title"');
  });

  it('mode 1 — namespace lookup returns full schemas for every tool', async () => {
    toolSchemaTool.setProvider({ getCatalog: () => makeCatalog() });
    const out = await toolSchemaTool.execute({ namespace: 'github' });
    expect(out.error).toBeUndefined();
    const text = resultText(out);
    expect(text).toContain('# Tool Schema: `github`');
    expect(text).toContain('## Tool: `create_issue`');
    expect(text).toContain('"title"');
    expect(text).toContain('## Tool: `list_pull_requests`');
    // Full (untruncated) description in namespace mode.
    expect(text).toContain(LONG_DESCRIPTION);
  });

  it('mode 2 — single tool lookup returns its full schema', async () => {
    toolSchemaTool.setProvider({ getCatalog: () => makeCatalog() });
    const out = await toolSchemaTool.execute({
      namespace: 'github',
      tool: 'create_issue',
    });
    expect(out.error).toBeUndefined();
    const text = resultText(out);
    expect(text).toContain('# Tool Schema: `github` / `create_issue`');
    expect(text).toContain('"title"');
    expect(text).not.toContain('list_pull_requests');
  });

  it('mode 3 — pattern search matches tool names across namespaces', async () => {
    toolSchemaTool.setProvider({ getCatalog: () => makeCatalog() });
    const out = await toolSchemaTool.execute({ pattern: 'create|post' });
    expect(out.error).toBeUndefined();
    const text = resultText(out);
    expect(text).toContain('create_issue');
    expect(text).toContain('post_message');
    expect(text).not.toContain('list_pull_requests');
  });

  it('mode 3 — pattern search truncates long descriptions', async () => {
    toolSchemaTool.setProvider({ getCatalog: () => makeCatalog() });
    const out = await toolSchemaTool.execute({ pattern: 'pull' });
    const text = resultText(out);
    expect(text).toContain(TRUNCATED_DESCRIPTION_SUFFIX);
    expect(text).not.toContain(LONG_DESCRIPTION);
  });

  it('mode 3 — no matches returns an empty-result message, not an error', async () => {
    toolSchemaTool.setProvider({ getCatalog: () => makeCatalog() });
    const out = await toolSchemaTool.execute({ pattern: 'zzz_nothing' });
    expect(out.error).toBeUndefined();
    expect(resultText(out)).toContain('No matching tools found');
  });

  it('mode 3 — invalid regex returns a structured error', async () => {
    toolSchemaTool.setProvider({ getCatalog: () => makeCatalog() });
    const out = await toolSchemaTool.execute({ pattern: '(' });
    expect(out.error).toBe(true);
    expect(resultText(out)).toContain('Invalid pattern');
  });

  it('unknown namespace returns a structured error with available namespaces', async () => {
    toolSchemaTool.setProvider({ getCatalog: () => makeCatalog() });
    const out = await toolSchemaTool.execute({ namespace: 'notion' });
    expect(out.error).toBe(true);
    const text = resultText(out);
    expect(text).toContain('Unknown namespace');
    expect(text).toContain('`github`');
    expect(text).toContain('`slack`');
  });

  it('unknown tool returns a structured error with available tools', async () => {
    toolSchemaTool.setProvider({ getCatalog: () => makeCatalog() });
    const out = await toolSchemaTool.execute({
      namespace: 'github',
      tool: 'nope',
    });
    expect(out.error).toBe(true);
    const text = resultText(out);
    expect(text).toContain('Unknown tool');
    expect(text).toContain('`create_issue`');
  });

  it('rejects tool without namespace and conflicting pattern+namespace', async () => {
    toolSchemaTool.setProvider({ getCatalog: () => makeCatalog() });
    const toolOnly = await toolSchemaTool.execute({ tool: 'create_issue' });
    expect(toolOnly.error).toBe(true);
    expect(resultText(toolOnly)).toContain('`tool` requires `namespace`');

    const both = await toolSchemaTool.execute({ namespace: 'github', pattern: 'x' });
    expect(both.error).toBe(true);
  });
});

describe('tool_invoke (Plan 480 P2.1)', () => {
  it('validates required parameters', async () => {
    toolInvokeTool.setDispatcher(undefined as never);
    expect((await toolInvokeTool.execute({})).error).toBe(true);
    expect(
      (await toolInvokeTool.execute({ namespace: 'github' })).error,
    ).toBe(true);
    expect(
      (
        await toolInvokeTool.execute({
          namespace: 'github',
          tool: 'create_issue',
        })
      ).error,
    ).toBe(true);
    expect(
      (
        await toolInvokeTool.execute({
          namespace: 'github',
          tool: 'create_issue',
          arguments: 'not-an-object',
        })
      ).error,
    ).toBe(true);
  });

  it('returns a not-configured error when no dispatcher is set', async () => {
    toolInvokeTool.setDispatcher(undefined as never);
    const out = await toolInvokeTool.execute({
      namespace: 'github',
      tool: 'create_issue',
      arguments: { title: 'x' },
    });
    expect(out.error).toBe(true);
    expect(resultText(out)).toContain('not configured');
  });

  it('forwards the request to the dispatcher and surfaces its result', async () => {
    let received: unknown;
    toolInvokeTool.setDispatcher({
      dispatch: async (request) => {
        received = request;
        return { result: 'ok: created issue 42' };
      },
    });
    const out = await toolInvokeTool.execute({
      namespace: 'github',
      tool: 'create_issue',
      arguments: { title: 'x' },
    });
    expect(out.error).toBeUndefined();
    expect(resultText(out)).toBe('ok: created issue 42');
    expect(received).toEqual({
      namespace: 'github',
      tool: 'create_issue',
      arguments: { title: 'x' },
    });
  });

  it('propagates error outcomes from the dispatcher', async () => {
    toolInvokeTool.setDispatcher({
      dispatch: async () => ({ result: 'Permission denied by policy.', error: true }),
    });
    const out = await toolInvokeTool.execute({
      namespace: 'github',
      tool: 'create_issue',
      arguments: { title: 'x' },
    });
    expect(out.error).toBe(true);
    expect(resultText(out)).toContain('Permission denied');
  });

  it('catches dispatcher exceptions into a structured error', async () => {
    toolInvokeTool.setDispatcher({
      dispatch: async () => {
        throw new Error('server disconnected');
      },
    });
    const out = await toolInvokeTool.execute({
      namespace: 'github',
      tool: 'create_issue',
      arguments: {},
    });
    expect(out.error).toBe(true);
    expect(resultText(out)).toContain('Tool Invoke Failed');
    expect(resultText(out)).toContain('server disconnected');
  });
});

describe('tool_invoke registry dispatcher (Plan 480 P2.2)', () => {
  function makeTool(name: string, serverName: string, toolName: string): Tool {
    return {
      name,
      description: toolName,
      input_schema: { type: 'object' },
      mcpInfo: { serverName, toolName, source: 'settings' },
    };
  }

  function fakeExecutor(resultText: string): ToolExecutor {
    return {
      async execute(): Promise<ToolResult> {
        return { id: crypto.randomUUID(), name: 'x', result: resultText };
      },
    };
  }

  function makeRegistry(): ToolRegistry {
    const registry = new ToolRegistry();
    registry.registerWithKey(
      'mcp_github_create_issue',
      makeTool('mcp_github_create_issue', 'github', 'create_issue'),
      fakeExecutor('created issue 7'),
    );
    registry.registerWithKey(
      'mcp_slack_post_message',
      makeTool('mcp_slack_post_message', 'slack', 'post_message'),
      fakeExecutor('posted'),
    );
    return registry;
  }

  function dispatcher(
    registry: ToolRegistry,
    behavior: 'allow' | 'deny' | 'ask' = 'allow',
  ) {
    return createToolInvokeDispatcherFromRegistry({
      registry,
      checkPermission: async () => ({
        behavior,
        ...(behavior !== 'allow' ? { message: 'policy says no' } : {}),
      }),
    });
  }

  it('resolves namespace+tool and executes through the real executor', async () => {
    const fresh = new ToolRegistry();
    let executed = false;
    fresh.registerWithKey(
      'mcp_github_create_issue',
      makeTool('mcp_github_create_issue', 'github', 'create_issue'),
      {
        async execute(input: Record<string, unknown>): Promise<ToolResult> {
          executed = true;
          expect(input.title).toBe('x');
          return { id: crypto.randomUUID(), name: 'x', result: 'ok: 42' };
        },
      },
    );
    const out = await dispatcher(fresh).dispatch({
      namespace: 'github',
      tool: 'create_issue',
      arguments: { title: 'x' },
    });
    expect(out.error).toBeUndefined();
    expect(out.result).toBe('ok: 42');
    expect(executed).toBe(true);
  });

  it('denies when the permission chain denies, carrying the message', async () => {
    const out = await dispatcher(makeRegistry(), 'deny').dispatch({
      namespace: 'github',
      tool: 'create_issue',
      arguments: {},
    });
    expect(out.error).toBe(true);
    expect(out.result).toContain('Permission denied');
    expect(out.result).toContain('policy says no');
  });

  it('does not execute when the permission chain asks', async () => {
    const registry = makeRegistry();
    const out = await dispatcher(registry, 'ask').dispatch({
      namespace: 'github',
      tool: 'create_issue',
      arguments: {},
    });
    expect(out.error).toBe(true);
    expect(out.result).toContain('Approval required');
  });

  it('reports an unknown namespace with available namespaces', async () => {
    const out = await dispatcher(makeRegistry()).dispatch({
      namespace: 'notion',
      tool: 'search',
      arguments: {},
    });
    expect(out.error).toBe(true);
    const text = out.result;
    expect(text).toContain('Unknown namespace');
    expect(text).toContain('`github`');
    expect(text).toContain('`slack`');
  });

  it('reports an unknown tool with available tools in that namespace', async () => {
    const out = await dispatcher(makeRegistry()).dispatch({
      namespace: 'github',
      tool: 'nope',
      arguments: {},
    });
    expect(out.error).toBe(true);
    const text = out.result;
    expect(text).toContain('Unknown tool');
    expect(text).toContain('`create_issue`');
  });

  it('reports when no MCP tools are connected', async () => {
    const registry = new ToolRegistry();
    const out = await dispatcher(registry).dispatch({
      namespace: 'github',
      tool: 'create_issue',
      arguments: {},
    });
    expect(out.error).toBe(true);
    expect(out.result).toContain('No tools are reachable through tool_invoke');
  });

  it('turns executor exceptions into structured errors', async () => {
    const registry = new ToolRegistry();
    registry.registerWithKey(
      'mcp_github_create_issue',
      makeTool('mcp_github_create_issue', 'github', 'create_issue'),
      {
        async execute(): Promise<ToolResult> {
          throw new Error('server 500');
        },
      },
    );
    const out = await dispatcher(registry).dispatch({
      namespace: 'github',
      tool: 'create_issue',
      arguments: {},
    });
    expect(out.error).toBe(true);
    expect(out.result).toContain('server 500');
  });
});

describe('builtin namespace (plan 480 P2.3 D-1)', () => {
  it('tool_schema provider lists discoverable built-ins under builtin', () => {
    const registry = new ToolRegistry();
    registry.register(
      {
        name: 'image_generate',
        description: 'Generate an image',
        input_schema: { type: 'object', properties: { prompt: { type: 'string' } } },
      },
      { async execute() { return { id: '1', name: 'x', result: 'img' }; } },
      { exposeMode: 'discoverable' },
    );
    const catalog = createToolSchemaProviderFromRegistry(registry).getCatalog();
    const builtin = catalog.find((ns) => ns.namespace === 'builtin');
    expect(builtin).toBeDefined();
    expect(builtin!.tools.map((t) => t.name)).toEqual(['image_generate']);
  });

  it('tool_invoke dispatcher executes a discoverable built-in via builtin namespace', async () => {
    const registry = new ToolRegistry();
    let executed = false;
    registry.register(
      {
        name: 'image_generate',
        description: 'Generate an image',
        input_schema: { type: 'object', properties: { prompt: { type: 'string' } } },
      },
      {
        async execute(input: Record<string, unknown>) {
          executed = true;
          expect(input.prompt).toBe('a cat');
          return { id: '1', name: 'image_generate', result: 'image ok' };
        },
      },
      { exposeMode: 'discoverable' },
    );
    const dispatcher = createToolInvokeDispatcherFromRegistry({
      registry,
      checkPermission: async () => ({ behavior: 'allow' }),
    });
    const out = await dispatcher.dispatch({
      namespace: 'builtin',
      tool: 'image_generate',
      arguments: { prompt: 'a cat' },
    });
    expect(out.error).toBeUndefined();
    expect(out.result).toBe('image ok');
    expect(executed).toBe(true);
  });

  it('unknown builtin tool lists available builtin tools', async () => {
    const registry = new ToolRegistry();
    registry.register(
      { name: 'image_generate', description: 'x', input_schema: { type: 'object' } },
      { async execute() { return { id: '1', name: 'x', result: 'r' }; } },
      { exposeMode: 'discoverable' },
    );
    const dispatcher = createToolInvokeDispatcherFromRegistry({
      registry,
      checkPermission: async () => ({ behavior: 'allow' }),
    });
    const out = await dispatcher.dispatch({
      namespace: 'builtin',
      tool: 'nope',
      arguments: {},
    });
    expect(out.error).toBe(true);
    expect(out.result).toContain('Unknown tool');
    expect(out.result).toContain('`image_generate`');
  });
});
