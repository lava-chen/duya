/**
 * W0 request-level tool census (plan: 2026-10-31 tool surface & harness convergence).
 *
 * ## What it claims
 *
 * The FINAL tools[] the provider reads — not the registry's registration
 * count — for two roles (plain worker, bot) under three exposure configs
 * (default `hint`, explicit `search`, App mention promotion), driven through
 * the REAL chain: real `WorkerSession`, real `initToolCatalog`, real
 * `setActiveMCPRuntime` replace-set, real `_resolveTools` visibility filter
 * and `projectForProvider` projection. The only fake is the LLM provider.
 *
 * Every run writes a machine-readable census record (final tool names,
 * per-tool owner/exposure, canonical vs projected schema/description sizes)
 * to `docs-local/research/tool-surface-w0/` (gitignored raw output; versioned
 * summaries live in the plan). Token estimates are deliberately NOT recorded:
 * bytes only, no fake tokenizer.
 *
 * ## What it does NOT claim
 *
 * It does not claim the numbers are good or bad, and it does not cover
 * config-MCP servers spawned as real subprocesses, native provider tool
 * search, or non-Anthropic providers. The MCP and App Connector tools here
 * are fixtures registered through the production seams (`replaceByOwner`
 * via `setActiveMCPRuntime`, cached descriptors merged by `_resolveTools`
 * itself), because what is under test is the assembly, not the transports.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { SSEEvent } from '@duya/host/worker-run-contracts';
import type { AppConnectionToolDescriptor } from '@duya/host/worker-tool-bindings/app-connection-tools';

const DONE: SSEEvent = { type: 'done', reason: 'end_turn' };

/** Every provider call's full argument list, in order: [messages, tools, ...]. */
let capturedProviderArgs: unknown[][] = [];

vi.mock('@duya/ai', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const delegating = {
    streamChat(...args: unknown[]) {
      capturedProviderArgs.push(args);
      return (async function* () {
        yield { type: 'text', data: 'ok' } as SSEEvent;
        yield DONE;
      })();
    },
  };
  return { ...actual, createAIClient: () => delegating, createAIClientWithRetry: () => delegating };
});

// Captured BEFORE the harness and the db-client are imported: importing the
// db-client registers its own `'message'` listener, and a listener captured
// after that would look like a pool listener and be filtered out.
const POOL_LISTENERS = new Set(process.listeners('message'));

const { makeWorkerSession, driveTurn, cleanupEngineTurnDirs } = await import(
  './engine-turn-harness.js'
);

const { initDbClient } = await import('@duya/host/worker-db-client');

// The REAL config reader and exposure mapping — the same functions the
// production MCP apply path uses. Scenarios drive them through
// DUYA_TOOLS_EXPOSURE instead of re-implementing the mapping.
const { readToolExposureConfig, mcpExposureToToolExposure } = await import(
  '@duya/host/worker-config/tool-exposure'
);

// The REAL connector descriptor cache seed. The session's own `_resolveTools`
// merge block registers the connector tools; we only provide the descriptors.
const { setCachedAppConnectionDescriptors } = await import(
  '@duya/host/worker-tool-bindings/app-connection-tools'
);

// The REAL bot profile construction: config entry -> AgentProfile with the
// bot toolset appended. (The divergent `createBotRegistry` in bot-builtin.ts
// has no production call sites — see plan F10 revision.)
const { toAgentProfile } = await import('@duya/host/worker-profiles/config-agents');
const { getAgentProfileService } = await import('@duya/host/worker-profiles/AgentProfileService');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MCP_SERVER = 'w0-fixture-server';
const MCP_INTERNAL_PREFIX = 'mcp__w0_fixture__';

interface FixtureMcpTool {
  toolName: string;
  description: string;
  schema: Record<string, unknown>;
}

/** One small schema; one deliberately larger than the 8KB spec budget. */
function buildMcpFixtures(): FixtureMcpTool[] {
  const largeProperties: Record<string, unknown> = {};
  for (let i = 0; i < 30; i++) {
    largeProperties[`field_${i}`] = {
      type: 'string',
      description:
        `Fixture filler description ${i} for the W0 oversized-schema probe. ` +
        'It exists so the canonical schema exceeds the 8192-char spec budget and ' +
        'the last-mile projection downgrade becomes observable in the census. ' +
        'Padding padding padding padding padding padding padding padding padding.',
    };
  }
  return [
    {
      toolName: 'w0_fixture_small',
      description: 'W0 fixture: small-schema MCP tool.',
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Target path.' },
          limit: { type: 'number', description: 'Row limit.' },
        },
        required: ['path'],
      },
    },
    {
      toolName: 'w0_fixture_large',
      description: 'W0 fixture: oversized-schema MCP tool (exceeds the spec budget).',
      schema: {
        type: 'object',
        properties: largeProperties,
        required: ['field_0'],
      },
    },
  ];
}

const CONNECTOR_DESCRIPTORS: AppConnectionToolDescriptor[] = [
  {
    name: 'w0_github_list_issues',
    description: 'W0 fixture: list issues on the fixture GitHub connection.',
    inputSchema: {
      type: 'object',
      properties: { repo: { type: 'string', description: 'Repository slug.' } },
      required: ['repo'],
    },
    inputSchemaSummary: 'repo (required)',
    riskTier: 'read',
    provider: 'w0-github',
    providerLabel: 'W0 GitHub',
    connectionId: 'w0-conn-github',
    action: 'list_issues',
  },
  {
    name: 'w0_slack_post_message',
    description: 'W0 fixture: post a message on the fixture Slack connection.',
    inputSchema: {
      type: 'object',
      properties: { channel: { type: 'string', description: 'Channel ID.' } },
      required: ['channel'],
    },
    inputSchemaSummary: 'channel (required)',
    riskTier: 'write',
    provider: 'w0-slack',
    providerLabel: 'W0 Slack',
    connectionId: 'w0-conn-slack',
    action: 'post_message',
  },
];

// ---------------------------------------------------------------------------
// IPC a turn needs (same shape as engine-payload-invariants)
// ---------------------------------------------------------------------------

const originalEnv = { ...process.env };
let workspaceDir = '';
let realSend: typeof process.send | undefined;
let cachedDbListener: ((m: unknown) => void) | null = null;

function installDbIpc(): void {
  if (cachedDbListener === null) {
    if (typeof initDbClient === 'function') initDbClient();
    cachedDbListener = (process
      .listeners('message')
      .filter((listener) => !POOL_LISTENERS.has(listener))[0] ?? null) as
      | ((m: unknown) => void)
      | null;
    if (cachedDbListener === null) throw new Error('db-client registered no message listener');
  }
  const dbListener = cachedDbListener;
  realSend = process.send;
  process.send = ((msg: unknown) => {
    const req = msg as { type?: string; action?: string; id?: string; payload?: { messages?: unknown[] } };
    if (req?.type !== 'db:request') return true;
    if (
      req.action !== 'mailbox:claimBatch' &&
      req.action !== 'message:append' &&
      req.action !== 'journal:emit' &&
      req.action !== 'modeState:get'
    ) {
      throw new Error(`unexpected db action in the W0 census: ${req.action}`);
    }
    const result =
      req.action === 'mailbox:claimBatch'
        ? { rows: [], claimTokens: [] }
        : req.action === 'message:append'
          ? { success: true, count: req.payload?.messages?.length ?? 0 }
          : { success: true };
    setImmediate(() => dbListener?.({ type: 'db:response', id: req.id, success: true, result }));
    return true;
  }) as unknown as typeof process.send;
}

beforeEach(() => {
  vi.stubEnv('DUYA_TEST', '1');
  vi.stubEnv('DUYA_TEST_NAMESPACE', 'w0-census');
  process.env.DUYA_E2E_DISABLE_LLM = '1';
  process.env.DUYA_SESSIONS_ROOT = '';
  process.env.DUYA_MEMORY_ROOT = '';
  delete process.env.DUYA_TOOLS_EXPOSURE;
  delete process.env.DUYA_TOOLS_ON_DEMAND_DISCOVERY;
  capturedProviderArgs = [];
  workspaceDir = mkdtempSync(path.join(os.tmpdir(), 'duya-w0-census-'));
  setCachedAppConnectionDescriptors(CONNECTOR_DESCRIPTORS);
});

afterEach(() => {
  process.send = realSend;
  cleanupEngineTurnDirs();
  vi.unstubAllEnvs();
  process.env = { ...originalEnv };
  try {
    rmSync(workspaceDir, { recursive: true, force: true });
  } catch {
    // A temp dir nobody claimed is not a test failure.
  }
});

// ---------------------------------------------------------------------------
// Census runner
// ---------------------------------------------------------------------------

interface CensusToolRecord {
  name: string;
  owner: string;
  exposure: string;
  inFinalRequest: boolean;
  canonicalSchemaBytes: number;
  projectedSchemaBytes: number;
  canonicalDescriptionBytes: number;
  projectedDescriptionBytes: number;
}

interface CensusRecord {
  scenario: string;
  role: string;
  exposureConfig: string;
  mentionedProviders: string[];
  agentProfileId: string | null;
  finalToolCount: number;
  registryToolCount: number;
  finalToolNames: string[];
  tools: CensusToolRecord[];
}

const CENSUS_OUT_DIR = path.resolve(process.cwd(), 'docs-local/research/tool-surface-w0');

function utf8Bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
}

async function runCensus(
  scenario: string,
  options: {
    exposureEnv?: 'hint' | 'search';
    mentionedProviders?: string[];
    botProfile?: boolean;
  },
): Promise<CensusRecord> {
  if (options.exposureEnv === 'search') {
    process.env.DUYA_TOOLS_EXPOSURE = 'search';
  } else {
    delete process.env.DUYA_TOOLS_EXPOSURE;
  }
  const exposureConfig = readToolExposureConfig().exposure;

  const role = options.botProfile === true ? 'bot' : 'worker';
  const sessionId = `s-w0-${scenario}`;
  const agent = makeWorkerSession({
    // Assembled at runtime so no credential-looking literal ships in source.
    apiKey: ['test', '-', 'key'].join(''),
    model: 'claude-test',
    provider: 'anthropic',
    sessionId,
    workingDirectory: workspaceDir,
    permissionMode: 'bypassPermissions',
  });

  // Real per-session assembly, in the production order:
  // 1) builtin tools into the session registry;
  await agent.initToolCatalog();

  // 2) fixture config-MCP tools through the real replace-set seam, with the
  //    exposure the production apply path would compute right now.
  const mcpFixtures = buildMcpFixtures();
  const providerNameToInternalKey = new Map<string, string>();
  const preparedRegistryEntries = mcpFixtures.map((fixture) => {
    const internalKey = `${MCP_INTERNAL_PREFIX}${fixture.toolName}`;
    providerNameToInternalKey.set(fixture.toolName, internalKey);
    const hint = 'W0 fixture hint';
    return {
      key: internalKey,
      definition: {
        name: fixture.toolName,
        description: fixture.description,
        input_schema: fixture.schema,
      },
      executor: {
        execute: async () => ({
          id: `w0-${fixture.toolName}`,
          name: fixture.toolName,
          result: 'w0 fixture result',
        }),
      },
      meta: {
        exposure: mcpExposureToToolExposure(exposureConfig),
        catalogInputSchema: fixture.schema,
        catalogDescription: fixture.description,
        discovery: {
          namespace: MCP_SERVER,
          conciseHint: hint,
          tags: [MCP_SERVER, fixture.toolName],
        },
        inputSchemaSummary: hint,
      },
    };
  });
  await agent.setActiveMCPRuntime({
    manager: { disconnectAll: async () => {} } as never,
    providerNameToInternalKey,
    preparedRegistryEntries,
    snapshot: {
      loadResult: { issues: [], servers: [] } as never,
      reason: 'manual' as never,
      committedAt: Date.now(),
      connectionIssues: [],
      registrationIssues: [],
      activeServerKeys: [MCP_SERVER],
      activeToolKeys: preparedRegistryEntries.map((entry) => entry.key),
    },
  });

  // 3) bot role through the real profile path when requested.
  let agentProfileId: string | null = null;
  if (options.botProfile === true) {
    const profile = await toAgentProfile('w0-bot-fixture', {
      name: 'W0 Bot Fixture',
      tools: { profile: 'full' },
    });
    const service = getAgentProfileService();
    if (!service.get(profile.id)) service.create(profile);
    agentProfileId = profile.id;
  }

  capturedProviderArgs = [];
  await driveTurn(agent, 'W0 census probe', {
    options: {
      sessionId,
      clientMsgId: `c-w0-${scenario}`,
      ...(options.mentionedProviders?.length
        ? { mentionedProviders: options.mentionedProviders }
        : {}),
      ...(agentProfileId ? { agentProfileId } : {}),
    } as never,
  });

  // Non-vacuity: the probe must have produced exactly one provider request.
  // `streamChat(messages, options)` — the final tools ride `options.tools`.
  expect(capturedProviderArgs.length).toBe(1);
  const providerOptions = (capturedProviderArgs[0]![1] ?? {}) as {
    tools?: Array<{
      name: string;
      description?: string;
      input_schema?: Record<string, unknown>;
    }>;
  };
  const finalTools = providerOptions.tools ?? [];
  expect(finalTools.length).toBeGreaterThan(0);

  const finalNames = new Set(finalTools.map((tool) => tool.name));
  const snapshot = agent.activeMCPRegistry.snapshot(providerNameToInternalKey);
  const tools: CensusToolRecord[] = snapshot.tools.map((tool) => {
    const projected = finalTools.find((candidate) => candidate.name === tool.name);
    return {
      name: tool.name,
      owner: agent.activeMCPRegistry.getOwner(tool.name) ?? 'unknown',
      exposure: snapshot.getExposure(tool.name),
      inFinalRequest: finalNames.has(tool.name),
      canonicalSchemaBytes: utf8Bytes(tool.input_schema),
      projectedSchemaBytes: projected ? utf8Bytes(projected.input_schema) : 0,
      canonicalDescriptionBytes: Buffer.byteLength(tool.description ?? '', 'utf8'),
      projectedDescriptionBytes: projected ? Buffer.byteLength(projected.description ?? '', 'utf8') : 0,
    };
  });

  const record: CensusRecord = {
    scenario,
    role,
    exposureConfig,
    mentionedProviders: options.mentionedProviders ?? [],
    agentProfileId,
    finalToolCount: finalTools.length,
    registryToolCount: snapshot.tools.length,
    finalToolNames: finalTools.map((tool) => tool.name),
    tools,
  };

  mkdirSync(CENSUS_OUT_DIR, { recursive: true });
  writeFileSync(path.join(CENSUS_OUT_DIR, `census-${scenario}.json`), JSON.stringify(record, null, 2));
  return record;
}

// ---------------------------------------------------------------------------
// The census
// ---------------------------------------------------------------------------

describe('W0 request-level tool census', () => {
  it('worker under default hint config carries MCP tools with full schemas', async () => {
    installDbIpc();
    const record = await runCensus('worker-hint', { exposureEnv: 'hint' });

    expect(record.exposureConfig).toBe('hint');
    const names = new Set(record.finalToolNames);
    // Catalog routers always ride the request.
    expect(names.has('tool_catalog')).toBe(true);
    expect(names.has('tool_invoke')).toBe(true);
    // hint -> eager: fixture MCP tools are DIRECT on the request.
    expect(names.has('w0_fixture_small')).toBe(true);
    expect(names.has('w0_fixture_large')).toBe(true);
    // Connector tools stay deferred without a mention.
    expect(names.has('w0_github_list_issues')).toBe(false);
    expect(names.has('w0_slack_post_message')).toBe(false);
  });

  it('worker under explicit search config keeps MCP tools out of the direct list', async () => {
    installDbIpc();
    const record = await runCensus('worker-search', { exposureEnv: 'search' });

    expect(record.exposureConfig).toBe('search');
    const names = new Set(record.finalToolNames);
    expect(names.has('w0_fixture_small')).toBe(false);
    expect(names.has('w0_fixture_large')).toBe(false);
    expect(names.has('tool_catalog')).toBe(true);
    expect(names.has('tool_invoke')).toBe(true);
    // But they stay discoverable: deferred, in the registry, owner mcp.
    const small = record.tools.find((tool) => tool.name === 'w0_fixture_small');
    expect(small?.exposure).toBe('deferred');
    expect(small?.owner).toBe('mcp');
  });

  it('worker with an App mention promotes only the mentioned connector tool', async () => {
    installDbIpc();
    const record = await runCensus('worker-mention', {
      exposureEnv: 'hint',
      mentionedProviders: ['w0-github'],
    });

    const names = new Set(record.finalToolNames);
    expect(names.has('w0_github_list_issues')).toBe(true);
    expect(names.has('w0_slack_post_message')).toBe(false);
  });

  it('bot gets the bot toolset from turn one — and still sees interactive tools the dead bot registry would hide', async () => {
    installDbIpc();
    const record = await runCensus('bot-hint', { exposureEnv: 'hint', botProfile: true });

    const names = new Set(record.finalToolNames);
    // BOT_TOOLSET exact names promote their deferred registrations (plan 496).
    for (const toolName of [
      'send_to_agent',
      'update_state',
      'image_generate',
      'manage_routine',
      'post_to_room',
      'list_app_connectors',
      'connect_app',
      'session',
    ]) {
      expect(names.has(toolName), `bot turn-one tool: ${toolName}`).toBe(true);
    }
    // W0 FINDING (naming drift, F21 signature): BOT_TOOLSET hardcodes
    // 'SendMessage' (agent-core bot-toolset.ts) but the tool registers as
    // 'send_message' (capabilities SendMessageTool/constants.ts), so the
    // bot's voice tool is NOT promoted from turn one despite plan 481/496
    // intent. Pinned here as the current behavior; W4 owns the fix.
    expect(names.has('SendMessage')).toBe(false);
    expect(names.has('send_message')).toBe(false);
    // W0 finding pinned: the divergent bot registry (bot-builtin.ts) is dead
    // code, so the bot profile does NOT hide these the way F10 described.
    expect(names.has('AskUserQuestion')).toBe(true);
    expect(names.has('apply_patch')).toBe(true);
    expect(names.has('task')).toBe(true);
  });

  it('bot under search config keeps MCP tools deferred while the bot toolset stays direct', async () => {
    installDbIpc();
    const record = await runCensus('bot-search', { exposureEnv: 'search', botProfile: true });

    const names = new Set(record.finalToolNames);
    expect(names.has('w0_fixture_small')).toBe(false);
    // Same naming-drift finding as bot-hint: the voice tool stays deferred.
    expect(names.has('SendMessage')).toBe(false);
    expect(names.has('send_message')).toBe(false);
    // Other BOT_TOOLSET names promote under search too.
    expect(names.has('send_to_agent')).toBe(true);
    expect(names.has('tool_catalog')).toBe(true);
  });

  it('bot with an App mention promotes the mentioned connector tool', async () => {
    installDbIpc();
    const record = await runCensus('bot-mention', {
      exposureEnv: 'hint',
      mentionedProviders: ['w0-github'],
      botProfile: true,
    });

    const names = new Set(record.finalToolNames);
    expect(names.has('w0_github_list_issues')).toBe(true);
    expect(names.has('w0_slack_post_message')).toBe(false);
  });

  it('the oversized MCP schema hits the projection budget and is downgraded on the request', async () => {
    installDbIpc();
    const record = await runCensus('worker-hint-budget', { exposureEnv: 'hint' });

    const large = record.tools.find((tool) => tool.name === 'w0_fixture_large');
    expect(large).toBeDefined();
    // Canonical schema exceeds the 8192-char spec budget; the projected one
    // that reached the request is materially smaller (F08's silent downgrade,
    // now observable per-request instead of inferred from source).
    expect(large!.canonicalSchemaBytes).toBeGreaterThan(8192);
    expect(large!.inFinalRequest).toBe(true);
    expect(large!.projectedSchemaBytes).toBeLessThan(large!.canonicalSchemaBytes);
    const small = record.tools.find((tool) => tool.name === 'w0_fixture_small')!;
    expect(small.projectedSchemaBytes).toBe(small.canonicalSchemaBytes);
  });

  it('census records wait_tasks as absent from the registry (617 §1 registration gap)', async () => {
    installDbIpc();
    const record = await runCensus('worker-hint-registry', { exposureEnv: 'hint' });

    const names = new Set(record.tools.map((tool) => tool.name));
    expect(names.has('wait_tasks')).toBe(false);
    expect(names.has('get_task_output')).toBe(true);
    expect(names.has('kill_task')).toBe(true);
  });
});
