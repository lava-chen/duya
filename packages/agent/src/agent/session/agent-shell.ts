/**
 * agent-shell.ts - Stateless shell helpers for `duyaAgent` (Plan 334 Phase 4+5).
 *
 * These were private methods of `DuyaAgent`. They are lifted out into pure
 * functions that read the agent's instance state through a typed
 * {@link AgentShellContext}. The host class stays a thin shell that owns the
 * state and delegates prompt/tool/permission/projection assembly to this
 * module, keeping the loop and the shell decoupled and unit-testable.
 */

import type { AIClient } from '@duya/ai';
import { getAgentProfileService } from '../../agent-profile/AgentProfileService.js';
import { isToolVisible, type ToolVisibilityConstraints } from '../../agent-profile/ToolFilter.js';
import type { AgentProfile } from '../../agent-profile/types.js';
import { buildAgentContext, extractLegacySystemSegments, projectModelMessages as projectModelMessagesCore } from '../../message/index.js';
import type { MessageTimelineEntry } from '../../message/index.js';
import { buildMCPCapabilityCatalog } from '../../mcp/capability-catalog.js';
import type { ToolPermissionCheckContext } from '../../permissions/permissions.js';
import { permissionRuleValueToString } from '../../permissions/rules.js';
import type {
  AdditionalWorkingDirectory,
  PermissionMode,
  PermissionRuleSource,
  ToolPermissionContext,
  ToolPermissionRulesBySource,
} from '../../permissions/types.js';
import {
  DEFAULT_PROMPT_PROFILE,
  getPromptProfileForAgentProfile,
  PromptsRegistry,
  resolvePromptSystemName,
} from '../../prompts/index.js';
import type { PromptSystem } from '../../prompts/index.js';
import type { ToolRegistry } from '../../tool/registry.js';
import type { AgentDefinition } from '../../tool/SubagentTool/index.js';
import type { ChatOptions, Message, MessageContent, SSEEvent, Tool, WidgetStyleSignature } from '../../types.js';
import { logger } from '../../utils/logger.js';
import { buildAgentIdentityBlock, EMPTY_DISCOVERED } from '../utils/agent-helpers.js';
import { toolSearchTool } from '../../tool/ToolSearchTool/ToolSearchTool.js';
import { searchToolsFromRegistry } from '../../tool/ToolSearchTool/searchTools.js';
import { collectActiveModes } from '../../modes/apply-modes.js';
import { modeModifierRegistry } from '../../modes/index.js';
import type { ModeModifier, ModeModifierContext, OrchestratorDeps, ToolRegistration } from '../../modes/index.js';

/**
 * The narrow slice of `duyaAgent` instance state these helpers read. Kept as a
 * single cohesive type so the host can build it once and pass it along.
 */
export interface AgentShellContext {
  sessionId?: string;
  workingDirectory?: string;
  defaultWorkspaceDirectory?: string;
  communicationPlatform?: import('../../prompts/types.js').CommunicationPlatform;
  language?: string;
  model: string;
  llmClient: AIClient;
  abortController: AbortController;
  permissionMode: PermissionMode;
  additionalWorkingDirectories: Map<string, AdditionalWorkingDirectory>;
  alwaysAllowRules: ToolPermissionRulesBySource;
  alwaysDenyRules: ToolPermissionRulesBySource;
  alwaysAskRules: ToolPermissionRulesBySource;
  blockedDomains: string[];
  browserBackendMode: 'auto' | 'extension' | 'built-in' | 'human-like';
  providerNameToInternalKey: Map<string, string>;
  activeMCPRegistry: ToolRegistry;
  messages: () => Message[];
  timelineSnapshot: () => readonly MessageTimelineEntry[];
  widgetStyleHistory: WidgetStyleSignature[];
}

/** Resolve an agent profile by id, logging the outcome. */
export function resolveAgentProfile(agentProfileId: string | undefined): AgentProfile | undefined {
  if (!agentProfileId) return undefined;
  const profile = getAgentProfileService().get(agentProfileId);
  if (profile) {
    logger.info(
      `[Agent] Applying agent profile: ${profile.name} (${profile.id}), promptSystem=${profile.promptSystem || 'general'}`,
    );
    return profile;
  }
  logger.warn(`[Agent] Agent profile not found: ${agentProfileId}`);
  return undefined;
}

/**
 * Resolve the effective tool set for a turn: pick the registry (custom or the
 * long-lived MCP catalog), merge App Connection tools, apply visibility
 * filters, and validate profile allow-lists.
 */
export async function resolveTools(
  ctx: AgentShellContext,
  options?: ChatOptions,
  appliedProfile?: AgentProfile,
): Promise<{
  tools: Tool[];
  registry: ToolRegistry;
  agentDefinitions: AgentDefinition[];
  constraints: ToolVisibilityConstraints;
}> {
  logger.info(`[Agent] streamChat: Loading tools...`);
  let registry = options?.toolRegistry;
  if (!registry) {
    registry = ctx.activeMCPRegistry;
    try {
      const { getCachedAppConnectionDescriptors, registerAppConnectionTools } =
        await import('../../tool/AppConnectionTool/index.js');
      const descriptors = getCachedAppConnectionDescriptors();
      if (descriptors.length > 0) registerAppConnectionTools(registry, descriptors);
    } catch (err) {
      logger.warn(`[Agent] Failed to merge App Connection tools: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const constraints: ToolVisibilityConstraints = {
    disabledTools: options?.disabledTools,
    allowedTools: options?.allowedTools,
    profileAllowedPatterns: appliedProfile?.allowedTools,
    profileDisallowedPatterns: appliedProfile?.disallowedTools,
  };
  const snapshot = registry.snapshot(ctx.providerNameToInternalKey);
  const allTools = snapshot.tools;
  const mcpToolCount = allTools.filter((t) => registry.getOwner(t.name) === 'mcp').length;
  logger.debug(`[Agent] Tool snapshot: ${allTools.length} total (${mcpToolCount} MCP, ${allTools.length - mcpToolCount} non-MCP)`);
  const tools: Tool[] = allTools.filter((t) =>
    isToolVisible(t.name, snapshot.getExposeMode(t.name), EMPTY_DISCOVERED, constraints),
  );
  logger.info(`[Agent] streamChat: ${tools.length}/${allTools.length} tools visible after visibility filter`);
  if (appliedProfile?.allowedTools?.length && tools.length === 0) {
    throw new Error(
      `Agent profile "${appliedProfile.id}" allowedTools matched zero tools ` +
      `(all ${allTools.length} tools were denied). ` +
      `Patterns: ${appliedProfile.allowedTools.join(', ')}. ` +
      `Check packages/agent/src/agent-profile/types.ts and the tool name constants.`,
    );
  }
  const { getAgentDefinitions } = await import('../../tool/SubagentTool/index.js');
  const agentDefinitions = getAgentDefinitions();
  logger.info(`[Agent] streamChat: Loaded ${agentDefinitions.length} agent definitions`);
  return { tools, registry, agentDefinitions, constraints };
}

/** Build the turn's system prompt (prompt system, MCP catalog, overrides, profile identity). */
export async function buildSystemPrompt(
  ctx: AgentShellContext,
  tools: Tool[],
  options?: ChatOptions,
  appliedProfile?: AgentProfile,
): Promise<string> {
  const sysName = resolvePromptSystemName(appliedProfile?.promptSystem);
  const promptProfile = appliedProfile
    ? getPromptProfileForAgentProfile(appliedProfile)
    : DEFAULT_PROMPT_PROFILE;
  const promptSystem: PromptSystem =
    PromptsRegistry.getOrCreate(sysName, promptProfile)
    ?? PromptsRegistry.getOrCreate('general', promptProfile)!;
  logger.info(`[Agent] Using prompt system '${sysName}'${appliedProfile ? ` for profile: ${appliedProfile.name}` : ' (default)'}`);

  let systemPromptContent: string;
  if (options?.disableSystemPrompt) {
    systemPromptContent = '';
  } else if (options?.systemPrompt) {
    systemPromptContent = options.systemPrompt;
  } else {
    const enabledToolNames = tools.map((t) => t.name);
    const context = promptSystem.buildContext({
      sessionId: ctx.sessionId,
      workingDirectory: ctx.workingDirectory,
      modelId: ctx.model,
      modelName: ctx.model,
      enabledTools: new Set(enabledToolNames),
      outputStyleConfig: options?.outputStyleConfig,
      researchIntent: options?.researchIntent,
      researchProjectId: options?.researchProjectId,
      communicationPlatform: ctx.communicationPlatform,
      language: ctx.language,
    });
    const systemPromptResult = await promptSystem.buildSystemPrompt(context);
    systemPromptContent = [...systemPromptResult].join('\n\n');
  }

  if (!options?.disableSystemPrompt) {
    const mcpCatalog = buildMCPCapabilityCatalog(
      ctx.activeMCPRegistry.getAllTools().filter(
        (tool) => ctx.activeMCPRegistry.getOwner(tool.name) === 'mcp',
      ),
    );
    if (mcpCatalog) {
      systemPromptContent = systemPromptContent ? `${systemPromptContent}\n\n${mcpCatalog}` : mcpCatalog;
    }
  }

  if (options?.systemPromptPrefix) {
    systemPromptContent = options.systemPromptPrefix + '\n\n' + systemPromptContent;
  }

  if (appliedProfile) {
    const identityBlock = buildAgentIdentityBlock(appliedProfile);
    systemPromptContent = identityBlock + '\n\n' + systemPromptContent;
  }

  return systemPromptContent;
}

/** Group permission rules by their source into the shape the checker expects. */
export function groupRulesBySource(
  rules: Array<{ source: PermissionRuleSource; ruleValue: { toolName: string; ruleContent?: string } }>,
): ToolPermissionRulesBySource {
  const grouped: ToolPermissionRulesBySource = {};
  for (const rule of rules) {
    const serialized = permissionRuleValueToString(rule.ruleValue);
    const list = grouped[rule.source] ?? [];
    list.push(serialized);
    grouped[rule.source] = list;
  }
  return grouped;
}

/** Build the permission-check context for the current turn. */
export function buildPermissionContext(
  ctx: AgentShellContext,
  registry?: ToolRegistry,
): ToolPermissionCheckContext {
  return {
    getAppState: () => ({
      toolPermissionContext: {
        mode: ctx.permissionMode,
        additionalWorkingDirectories: ctx.additionalWorkingDirectories,
        alwaysAllowRules: ctx.alwaysAllowRules,
        alwaysDenyRules: ctx.alwaysDenyRules,
        alwaysAskRules: ctx.alwaysAskRules,
        isBypassPermissionsModeAvailable: true,
        defaultWorkspaceDirectory: ctx.defaultWorkspaceDirectory,
        getToolRiskTier: registry
          ? (toolName: string) => registry.getMeta(toolName)?.riskTier
          : undefined,
      } as ToolPermissionContext,
    }),
    abortController: ctx.abortController,
    llmClient: ctx.llmClient,
    classifierModel: ctx.model,
    messages: ctx.messages(),
  };
}

/** Project the timeline to the model boundary (system content merged into the prompt). */
export function projectModelMessages(
  ctx: AgentShellContext,
  systemPromptContent: string,
): { systemPromptContent: string; messages: Message[] } {
  const snapshot = ctx.timelineSnapshot();
  const context = buildAgentContext(snapshot);
  const systemSegments = extractLegacySystemSegments(context.messages, context.compaction);
  const projection = projectModelMessagesCore(context.messages, { systemSegments });
  const systemFromProjection = typeof projection.system === 'string' ? projection.system : '';
  const merged = systemPromptContent && systemFromProjection
    ? `${systemPromptContent}\n\n---\n\n## Conversation Context\n\n${systemFromProjection}`
    : (systemPromptContent || systemFromProjection);
  logger.info(
    `[Agent] projectModelMessages: ${context.messages.length} agent messages → ${projection.messages.length} model messages, ${systemSegments.length} system segments`,
  );
  return { systemPromptContent: merged, messages: [...projection.messages] };
}

/**
 * Generator adapter that bridges a push-based `emit` event sink (the stateless
 * loop) back into an `AsyncGenerator`, preserving the outer `streamChat`
 * generator contract (plan 334 D1 / Phase 2.5). `onFinally` runs after the run
 * promise settles so the host can persist the loop's working state.
 */
export async function* streamLoopEvents<T, U>(
  run: (emit: (event: T) => void) => Promise<unknown>,
  onFinally?: () => void,
): AsyncGenerator<U, void, unknown> {
  const queue: T[] = [];
  let done = false;
  let error: unknown;
  let wakeResolve: (() => void) | null = null;
  const wake = () => wakeResolve?.();
  const emit = (event: T): void => {
    queue.push(event);
    wake();
  };
  const runPromise = (async () => {
    try {
      await run(emit);
    } catch (err) {
      error = err;
    } finally {
      done = true;
      wake();
    }
  })();
  try {
    while (true) {
      while (queue.length > 0) {
        yield queue.shift()! as U;
      }
      if (done) break;
      await new Promise<void>((resolve) => {
        wakeResolve = resolve;
        if (queue.length > 0 || done) resolve();
      });
      wakeResolve = null;
    }
  } finally {
    if (error) {
      logger.error('[Agent] runAgentLoop failed', error instanceof Error ? error : new Error(String(error)));
    }
    onFinally?.();
    await runPromise.catch(() => undefined);
  }
}

/**
 * Dispatch to an orchestrator-paradigm ModeModifier (plan 224 Phase 1.5+).
 * Yields SSE events directly to the stream.
 */
export async function* dispatchOrchestratorMode(
  ctx: AgentShellContext,
  mod: ModeModifier,
  prompt: string | MessageContent[],
  options?: ChatOptions,
): AsyncGenerator<SSEEvent, void, unknown> {
  const queryText = typeof prompt === 'string'
    ? prompt
    : prompt.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
  const toolRegistry = ctx.activeMCPRegistry;
  toolSearchTool.setSearchFn((query, limit) => searchToolsFromRegistry(toolRegistry, query, limit));

  const orchestratorActiveModes = collectActiveModes(options ?? {});
  const orchestratorResolved = orchestratorActiveModes.length > 0
    ? modeModifierRegistry.resolve(orchestratorActiveModes)
    : null;
  if (orchestratorResolved) {
    const ctxForModes: ModeModifierContext = {
      sessionId: ctx.sessionId ?? '',
      workingDirectory: ctx.workingDirectory ?? '',
      state: {
        conductorCanvasId: options?.conductorCanvasId,
        widgetStyleHistory: ctx.widgetStyleHistory,
      },
    };
    for (const inject of orchestratorResolved.tools.injects) {
      const items = typeof inject === 'function' ? inject(ctxForModes) : inject;
      for (const tr of items) {
        if (!toolRegistry.has(tr.definition.name)) toolRegistry.register(tr.definition, tr.executor);
      }
    }
  }

  const deps: OrchestratorDeps = {
    llmClient: ctx.llmClient,
    abortController: ctx.abortController,
    sessionId: ctx.sessionId,
    workingDirectory: ctx.workingDirectory,
    toolRegistry,
    chatOptions: options as Record<string, unknown> | undefined,
    blockedDomains: ctx.blockedDomains,
  };

  const modeCtx: ModeModifierContext = {
    sessionId: ctx.sessionId ?? '',
    workingDirectory: ctx.workingDirectory ?? '',
    state: {},
  };

  logger.info(`[Agent] Dispatching to orchestrator mode: ${mod.id}`);
  const orchestrator = mod.orchestrator;
  if (!orchestrator) {
    yield { type: 'error', data: `Mode "${mod.id}" has no orchestrator` } as SSEEvent;
    return;
  }

  try {
    yield* orchestrator.execute(queryText, modeCtx, deps);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`[Agent] Orchestrator mode "${mod.id}" execution failed: ${message}`);
    yield { type: 'error', data: `${mod.id} mode error: ${message}` } as SSEEvent;
  }
}