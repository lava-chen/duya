/**
 * ipc-client.ts - IPC client for Electron renderer
 *
 * Provides typed wrappers around window.electronAPI database calls.
 * This module can be used in non-React contexts (e.g., Zustand stores).
 *
 * All IPC responses are converted from snake_case (database) to camelCase (frontend).
 */

import type { FileAttachment } from '@/types/message'
import type { ContentBlock } from '@/types/message'
import type { SendMessageCardMeta } from '@/types/message'
import type { MemoryEntry } from '@/types'
import type { UsageSummary } from '@/types/usage'

// Types matching the store's expected format (camelCase)
export interface Thread {
  id: string
  title: string
  workingDirectory: string | null
  projectName: string | null
  createdAt: number
  updatedAt: number
  model: string
  systemPrompt: string
  status: string
  mode: string
  permissionProfile: string
  providerId: string
  contextSummary: string
  contextSummaryUpdatedAt: number
  isDeleted: number
  generation: number
  agentProfileId: string | null
  parentId: string | null
  agentType: string
  agentName: string
  conductorModeEnabled?: number
  conductorCanvasId?: string | null
  /** Plan 413e: 1 = plan-task session toggle on, 0 = off. */
  planModeEnabled?: number
  /** Plan 413e: 1 = goal mode session toggle on, 0 = off. */
  goalModeEnabled?: number
  /** Plan 331 Phase 4: 1 = pinned to sidebar top, 0 = normal. */
  pinned?: number
}

export interface Message {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | ContentBlock[]
  name: string | null
  toolCallId: string | null
  tokenUsage: string | null
  msgType: string
  thinking: string | null
  toolName: string | null
  toolInput: string | null
  parentToolCallId: string | null
  vizSpec: string | null
  status: string
  seqIndex: number | null
  durationMs: number | null
  subAgentId: string | null
  attachments: FileAttachment[] | null
  createdAt: number
  /** User-facing prompt (with pasted-content markers) for user messages. */
  displayContent?: string | ContentBlock[]
  /** Plan 491 P1.2: Source of the message for bot-direct filtering. */
  source?: string | null;
  /** Plan 489 P2.2: SendMessage card payload (parsed from send_message_meta). */
  sendMessageMeta?: SendMessageCardMeta | null;
}

export interface Provider {
  id: string
  name: string
  alias?: string
  providerType: string
  baseUrl: string
  apiKey: string
  /** @deprecated Use isDefault. The single-active concept is gone;
   *  this is kept as a transitional alias. */
  isActive?: boolean
  /** Soft default — implicit fallback for chat/vision/etc. */
  isDefault?: boolean
  hasApiKey: boolean
  sortOrder: number
  extraEnv: string
  protocol: string
  headers: string
  options: string
  notes: string
  createdAt: number
  updatedAt: number
  /** Provider default model from options */
  defaultModel?: string
  /** Memory worker model override (null = auto-resolve from provider). */
  memoryModelId?: string | null
}

/**
 * Model information from provider options
 */
export interface ModelInfo {
  displayName?: string
  description?: string
  capabilities?: {
    supportsVision?: boolean
    supportsFunctionCalling?: boolean
    supportsStreaming?: boolean
    maxTokens?: number
    contextWindow?: number
  }
  pricing?: {
    inputCost?: number
    outputCost?: number
    currency?: string
  }
}

export interface ProjectGroup {
  workingDirectory: string
  projectName: string
  threadCount: number
  lastActivity: number
  createdAt: number
  isExpanded?: boolean
}

export interface PermissionRequest {
  id: string
  sessionId: string | null
  toolName: string
  toolInput: string | null
  status: string
  decision: string | null
  message: string | null
  updatedPermissions: string | null
  updatedInput: string | null
  createdAt: number
  resolvedAt: number | null
}

// Database format (snake_case)
interface DbThread {
  id: string
  title: string
  working_directory: string
  project_name: string
  created_at: number
  updated_at: number
  model: string
  system_prompt: string
  status: string
  mode: string
  permission_profile: string
  provider_id: string
  context_summary: string
  context_summary_updated_at: number
  is_deleted: number
  generation: number
  agent_profile_id: string | null
  parent_id: string | null
  agent_type: string
  agent_name: string
  conductor_mode_enabled: number
  conductor_canvas_id: string | null
  plan_mode_enabled?: number
  goal_mode_enabled?: number
  pinned: number
}

interface DbMessage {
  id: string
  session_id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  name: string | null
  tool_call_id: string | null
  token_usage: string | null
  msg_type: string
  thinking: string | null
  tool_name: string | null
  tool_input: string | null
  parent_tool_call_id: string | null
  viz_spec: string | null
  status: string
  seq_index: number | null
  duration_ms: number | null
  sub_agent_id: string | null
  attachments: string | null
  created_at: number
  /** User-facing prompt (with pasted-content markers) for user messages. */
  display_content: string | null
  /**
   * Plan 489 P0.1: message origin classifier. Null for legacy rows written
   * before the classifier existed.
   */
  source?: string | null
  /** Plan 489 P2.2: SendMessage card payload (JSON), from metadata.sendMessage. */
  send_message_meta?: string | null
}

// Backend returns camelCase (via maskProvider in agent-communicator.ts)
interface BackendProvider {
  id: string
  name: string
  alias?: string
  providerType: string
  baseUrl: string
  apiKey: string
  isActive: boolean
  hasApiKey: boolean
  sortOrder: number
  extraEnv: string
  protocol: string
  headers: string
  options: string
  notes: string
  createdAt: number
  updatedAt: number
}

function backendProviderToProvider(db: BackendProvider): Provider {
  return {
    id: db.id,
    name: db.name,
    alias: db.alias,
    providerType: db.providerType,
    baseUrl: db.baseUrl,
    apiKey: db.apiKey,
    isActive: db.isActive,
    hasApiKey: db.hasApiKey,
    sortOrder: db.sortOrder,
    extraEnv: db.extraEnv,
    protocol: db.protocol,
    headers: db.headers,
    options: db.options,
    notes: db.notes,
    createdAt: db.createdAt,
    updatedAt: db.updatedAt,
  }
}

interface DbProjectGroup {
  working_directory: string
  project_name: string
  thread_count: number
  last_activity: number
  created_at?: number
}

// Conversion helpers
function dbThreadToThread(db: DbThread | null | undefined): Thread | null {
  if (!db) return null;
  return {
    id: db.id,
    title: db.title,
    workingDirectory: db.working_directory || null,
    projectName: db.project_name || null,
    createdAt: db.created_at,
    updatedAt: db.updated_at,
    model: db.model,
    systemPrompt: db.system_prompt,
    status: db.status,
    mode: db.mode,
    permissionProfile: db.permission_profile,
    providerId: db.provider_id,
    contextSummary: db.context_summary,
    contextSummaryUpdatedAt: db.context_summary_updated_at,
    isDeleted: db.is_deleted,
    generation: db.generation,
    agentProfileId: db.agent_profile_id || null,
    parentId: db.parent_id || null,
    agentType: db.agent_type || 'main',
    agentName: db.agent_name || '',
    conductorModeEnabled: db.conductor_mode_enabled,
    conductorCanvasId: db.conductor_canvas_id,
    planModeEnabled: db.plan_mode_enabled,
    goalModeEnabled: db.goal_mode_enabled,
    pinned: db.pinned,
  }
}

function dbMessageToMessage(db: DbMessage): Message {
  let attachments: FileAttachment[] | null = null;
  if (db.attachments) {
    try {
      attachments = JSON.parse(db.attachments) as FileAttachment[];
    } catch {
      attachments = null;
    }
  }

  let content: string | ContentBlock[] = db.content;
  if (typeof content === 'string' && content.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        content = parsed as ContentBlock[];
      }
    } catch {
      // keep as string
    }
  }

  return {
    id: db.id,
    sessionId: db.session_id,
    role: db.role,
    content,
    name: db.name,
    toolCallId: db.tool_call_id,
    tokenUsage: db.token_usage,
    msgType: db.msg_type || 'text',
    thinking: db.thinking,
    toolName: db.tool_name,
    toolInput: db.tool_input,
    parentToolCallId: db.parent_tool_call_id,
    vizSpec: db.viz_spec,
    status: db.status || 'done',
    seqIndex: db.seq_index,
    durationMs: db.duration_ms,
    subAgentId: db.sub_agent_id,
    attachments,
    createdAt: db.created_at,
    source: db.source ?? null,
    sendMessageMeta: db.send_message_meta
      ? (() => {
          try {
            return JSON.parse(db.send_message_meta) as SendMessageCardMeta;
          } catch {
            return null;
          }
        })()
      : null,
    // Surface the user-facing prompt (with pasted-content markers).
    // Falls back to `content` for legacy rows that pre-date the
    // `display_content` column — those rows had the prompt stored in
    // `content` directly.
    displayContent: db.display_content != null
      ? db.display_content
      : (typeof content === 'string' ? content : undefined),
  }
}

function backendProjectToProject(db: DbProjectGroup): ProjectGroup {
  return {
    workingDirectory: db.working_directory,
    projectName: db.project_name,
    threadCount: db.thread_count,
    lastActivity: db.last_activity,
    createdAt: db.created_at ?? db.last_activity,
    isExpanded: true,
  }
}

// Thread operations
export async function listThreadsIPC(): Promise<Thread[]> {
  const dbThreads = await window.electronAPI!.thread!.list() as DbThread[]
  return dbThreads.map(dbThreadToThread).filter((t): t is Thread => t !== null)
}

// Usage statistics — aggregated in the main process over core-db rollout
// files. Never aggregate renderer-side: the conversation store only holds
// transcripts of sessions opened during the current app run.
export async function getUsageSummaryIPC(): Promise<UsageSummary> {
  return window.electronAPI!.usage!.summary()
}

export async function getThreadIPC(id: string): Promise<{ thread: Thread; messages: Message[] } | null> {
  const dbThread = await window.electronAPI!.thread!.get(id) as DbThread | undefined
  if (!dbThread) return null
  const dbMessages = await window.electronAPI!.message!.getBySession(id) as DbMessage[]
  return {
    thread: dbThreadToThread(dbThread)!,
    messages: dbMessages.map(dbMessageToMessage),
  }
}

export async function createThreadIPC(data: {
  id: string
  title?: string
  workingDirectory?: string
  projectName?: string
  model?: string
  mode?: string
  providerId?: string
  parentId?: string | null
  agentType?: string
  agentName?: string
}): Promise<Thread | null> {
  // permissionProfile 不在前端传, 由后端 query 层 (resolvePermissionProfile) 统一 fallback.
  // 避免前端忘传 / 误传导致权限路径不一致.
  const dbThread = await window.electronAPI!.thread!.create({
    id: data.id,
    title: data.title,
    working_directory: data.workingDirectory ?? '',
    project_name: data.projectName ?? '',
    model: data.model,
    mode: data.mode,
    provider_id: data.providerId,
    parent_id: data.parentId ?? null,
    agent_type: data.agentType ?? 'main',
    agent_name: data.agentName ?? '',
  }) as DbThread
  return dbThreadToThread(dbThread)
}

export async function updateThreadIPC(id: string, data: {
  title?: string
  workingDirectory?: string
  projectName?: string
  model?: string
  mode?: string
  permissionProfile?: string
  status?: string
  contextSummary?: string
  providerId?: string
  agent_profile_id?: string | null
}): Promise<Thread | null> {
  const dbThread = await window.electronAPI!.thread!.update(id, {
    title: data.title,
    working_directory: data.workingDirectory,
    project_name: data.projectName,
    model: data.model,
    mode: data.mode,
    permission_profile: data.permissionProfile,
    status: data.status,
    context_summary: data.contextSummary,
    provider_id: data.providerId,
    agent_profile_id: data.agent_profile_id,
  }) as DbThread
  return dbThreadToThread(dbThread)
}

export async function listThreadsByParentIdIPC(parentId: string): Promise<Thread[]> {
  const dbThreads = await window.electronAPI!.thread!.listByParentId(parentId) as DbThread[]
  return dbThreads.map(dbThreadToThread).filter((t): t is Thread => t !== null)
}

export async function deleteThreadIPC(id: string): Promise<boolean> {
  return window.electronAPI!.thread!.delete(id) as Promise<boolean>
}

export async function saveDraftIPC(sessionId: string, draft: string): Promise<void> {
  return window.electronAPI!.session!.saveDraft(sessionId, draft) as Promise<void>
}

export async function getDraftIPC(sessionId: string): Promise<string> {
  return window.electronAPI!.session!.getDraft(sessionId) as Promise<string>
}

// Message operations
export async function addMessageIPC(data: {
  id: string
  sessionId: string
  role: string
  content: string
  name?: string
  toolCallId?: string
  tokenUsage?: string
  msgType?: string
  thinking?: string | null
  toolName?: string | null
  toolInput?: string | null
  parentToolCallId?: string | null
  vizSpec?: string | null
  status?: string
  seqIndex?: number | null
  durationMs?: number | null
  subAgentId?: string | null
  attachments?: FileAttachment[]
}): Promise<Message | null> {
  const dbMessage = await window.electronAPI!.message!.add({
    id: data.id,
    session_id: data.sessionId,
    role: data.role,
    content: data.content,
    name: data.name,
    tool_call_id: data.toolCallId,
    token_usage: data.tokenUsage,
    msg_type: data.msgType,
    thinking: data.thinking,
    tool_name: data.toolName,
    tool_input: data.toolInput,
    parent_tool_call_id: data.parentToolCallId,
    viz_spec: data.vizSpec,
    status: data.status,
    seq_index: data.seqIndex,
    duration_ms: data.durationMs,
    sub_agent_id: data.subAgentId,
    attachments: data.attachments,
  }) as DbMessage
  return dbMessageToMessage(dbMessage)
}

export async function replaceMessagesIPC(
  sessionId: string,
  messages: unknown[],
  generation: number
): Promise<{ success: boolean; reason?: string }> {
  return window.electronAPI!.message!.replace(sessionId, messages, generation) as Promise<{
    success: boolean
    reason?: string
  }>
}

export async function getMessagesBySessionIPC(sessionId: string): Promise<Message[]> {
  const dbMessages = await window.electronAPI!.message!.getBySession(sessionId) as DbMessage[]
  return dbMessages.map(dbMessageToMessage)
}

/**
 * Plan 489 P0.3: fetch the bot-direct transcript. The main process applies
 * the source allowlist (`['send_message', 'user']`) inside MessageLog, so
 * only user-typed and SendMessage rows are ever returned.
 */
export async function getBotDirectTranscriptIPC(
  sessionId: string
): Promise<{ messages: Message[] }> {
  const electronAPI = window.electronAPI as unknown as {
    message?: { botDirectGetTranscript?: (id: string) => Promise<unknown> }
  }
  if (!electronAPI.message?.botDirectGetTranscript) {
    // IPC not wired (jsdom test runner, web build) — the hook bails out
    // on the same guard, so an empty result keeps the contract observable.
    return { messages: [] }
  }
  const dbMessages = (await electronAPI.message.botDirectGetTranscript(sessionId)) as DbMessage[]
  return { messages: dbMessages.map(dbMessageToMessage) }
}

export async function truncateMessagesAfterIPC(
  sessionId: string,
  messageId: string
): Promise<{ deletedCount: number; restoredFiles?: string[] }> {
  return window.electronAPI!.message!.truncateAfter(sessionId, messageId) as Promise<{
    deletedCount: number
    restoredFiles?: string[]
  }>
}

export async function truncateMessagesFromInclusiveIPC(
  sessionId: string,
  messageId: string
): Promise<{ deletedCount: number; restoredFiles?: string[] }> {
  return window.electronAPI!.message!.truncateFromInclusive(sessionId, messageId) as Promise<{
    deletedCount: number
    restoredFiles?: string[]
  }>
}

// Provider operations
export async function listProvidersIPC(): Promise<Provider[]> {
  const raw = await window.electronAPI!.provider!.list() as BackendProvider[]
  return raw.map(backendProviderToProvider)
}

export async function getProviderIPC(id: string): Promise<Provider | null> {
  const raw = await window.electronAPI!.provider!.get(id) as BackendProvider | null
  return raw ? backendProviderToProvider(raw) : null
}

export async function getActiveProviderIPC(): Promise<Provider | null> {
  const raw = await window.electronAPI!.provider!.getActive() as BackendProvider | null
  return raw ? backendProviderToProvider(raw) : null
}

export async function upsertProviderIPC(data: {
  id: string
  name: string
  providerType?: string
  baseUrl?: string
  apiKey?: string
  isActive?: boolean
  options?: Record<string, unknown>
  notes?: string
}): Promise<Provider | null> {
  const raw = await window.electronAPI!.provider!.upsert({
    id: data.id,
    name: data.name,
    providerType: data.providerType,
    baseUrl: data.baseUrl,
    apiKey: data.apiKey,
    isActive: data.isActive,
    options: data.options,
    notes: data.notes,
  }) as BackendProvider | null
  return raw ? backendProviderToProvider(raw) : null
}

export async function updateProviderIPC(id: string, data: {
  name?: string
  providerType?: string
  baseUrl?: string
  apiKey?: string
  isActive?: boolean
  extraEnv?: string
  headers?: Record<string, string>
  options?: Record<string, unknown>
  notes?: string
}): Promise<Provider | null> {
  const raw = await window.electronAPI!.provider!.update(id, data) as BackendProvider | null
  return raw ? backendProviderToProvider(raw) : null
}

export async function deleteProviderIPC(id: string): Promise<boolean> {
  return window.electronAPI!.provider!.delete(id) as Promise<boolean>
}

export async function activateProviderIPC(id: string): Promise<Provider | null> {
  const raw = await window.electronAPI!.provider!.activate(id) as BackendProvider | null
  // Re-initialize agent with the new provider
  await window.electronAPI!.agent!.reinitProvider()
  return raw ? backendProviderToProvider(raw) : null
}

// =============================================================================
// Phase 2: LlmProvider-aware IPC wrappers
// =============================================================================
//
// These all return masked DTOs (no apiKey / accessToken). `provider:test`,
// `provider:testModel`, and `provider:syncModels` are used by the
// ProviderManager / ProviderModelEditor to integrate with the new
// ProviderHealthService and ModelSyncService. The `provider` field in
// the active config carries the runtime config so the agent runtime
// can adopt it incrementally.

export interface ProviderHealthDTO {
  providerId: string
  ok: boolean
  latencyMs?: number
  checkedAt: number
  errorKind?: 'auth' | 'network' | 'rate_limit' | 'invalid_model' | 'invalid_config' | 'unknown'
  message?: string
}

export interface ModelCapabilityDTO {
  providerId: string
  modelId: string
  displayName?: string
  contextWindow?: number
  maxOutputTokens?: number
  supportsToolUse?: boolean
  supportsVision?: boolean
  supportsReasoning?: boolean
  supportsPromptCache?: boolean
  /**
   * Per-model reasoning-effort options (LM Studio
   * `capabilities.reasoning.allowed_options` normalized). The chat
   * effort dropdown uses this list when non-empty, falling back to
   * the static catalog default. Empty / undefined means "no per-model
   * list — use the global options".
   */
  reasoningEffortOptions?: string[]
  /**
   * Whether the model is currently loaded into a local runtime (LM
   * Studio `loaded_instances.length > 0` or Ollama loaded state).
   * Surfaced as a small dot in model lists.
   */
  isLoaded?: boolean
  pricing?: Record<string, unknown>
  source: 'preset' | 'models-api' | 'user' | 'probe'
  updatedAt: number
}

export async function listLlmProvidersIPC(): Promise<BackendProvider[]> {
  return (await window.electronAPI!.provider!.listLlm()) as BackendProvider[]
}

export async function getLlmProviderIPC(id: string): Promise<BackendProvider | null> {
  return (await window.electronAPI!.provider!.getLlm(id)) as BackendProvider | null
}

export async function upsertLlmProviderIPC(
  data: Record<string, unknown>,
): Promise<{ ok: boolean; provider?: BackendProvider; code?: string; message?: string }> {
  return (await window.electronAPI!.provider!.upsertLlm(data)) as {
    ok: boolean
    provider?: BackendProvider
    code?: string
    message?: string
  }
}

export async function deleteLlmProviderIPC(id: string): Promise<boolean> {
  return (await window.electronAPI!.provider!.deleteLlm(id)) as boolean
}

export async function setDefaultLlmProviderIPC(id: string | null): Promise<boolean> {
  return (await window.electronAPI!.provider!.setDefaultLlm({ id })) as boolean
}

export async function getDefaultLlmProviderIPC(): Promise<Provider | null> {
  return (await window.electronAPI!.provider!.getDefault()) as Provider | null
}

/**
 * Set the memory worker provider and optional model override.
 * When provider id is null, the memory worker falls back to the default
 * provider. When modelId is null/empty, the model is auto-resolved from
 * the provider's configured model list.
 */
export async function setMemoryLlmProviderIPC(
  id: string | null,
  modelId?: string | null,
): Promise<boolean> {
  return (await window.electronAPI!.provider!.setMemory({ id, modelId: modelId ?? null })) as boolean
}

/** Get the memory worker provider (masked DTO) + model override. */
export async function getMemoryLlmProviderIPC(): Promise<Provider | null> {
  return (await window.electronAPI!.provider!.getMemory()) as Provider | null
}

export function testProviderIPC(
  payload: { providerId: string; presetKey?: string },
): Promise<ProviderHealthDTO>
export function testProviderIPC(body: {
  provider_type?: string
  base_url?: string
  api_key?: string
  model?: string
  auth_style?: string
}): Promise<ProviderTestResult>
export async function testProviderIPC(
  payload:
    | { providerId: string; presetKey?: string }
    | {
        provider_type?: string
        base_url?: string
        api_key?: string
        model?: string
        auth_style?: string
      },
): Promise<ProviderHealthDTO | ProviderTestResult> {
  if ('providerId' in payload) {
    return (await window.electronAPI!.provider!.test(payload)) as ProviderHealthDTO
  }

  return window.electronAPI!.net.testProvider(payload)
}

export async function testModelIPC(
  payload: { providerId: string; modelId: string },
): Promise<ProviderHealthDTO> {
  return (await window.electronAPI!.provider!.testModel(payload)) as ProviderHealthDTO
}

export async function syncProviderModelsIPC(
  payload: { providerId: string; presetKey?: string },
): Promise<{ ok: boolean; models: ModelCapabilityDTO[]; source: string; message?: string }> {
  return (await window.electronAPI!.provider!.syncModels(payload)) as {
    ok: boolean
    models: ModelCapabilityDTO[]
    source: string
    message?: string
  }
}

export async function upsertModelCapabilityIPC(
  capability: Partial<ModelCapabilityDTO> & { providerId: string; modelId: string },
): Promise<{ ok: boolean; capability: ModelCapabilityDTO }> {
  const raw = (await window.electronAPI!.provider!.upsertModelCapability(capability)) as unknown as {
    ok: boolean
    capability: ModelCapabilityDTO
  };
  return raw;
}

// Phase 3: persistent model capability reads.
export async function listModelCapabilitiesIPC(
  payload: { providerId: string },
): Promise<ModelCapabilityDTO[]> {
  return (await window.electronAPI!.provider!.listModelCapabilities(payload)) as ModelCapabilityDTO[];
}

export async function getModelCapabilityIPC(
  payload: { providerId: string; modelId: string },
): Promise<ModelCapabilityDTO | null> {
  return (await window.electronAPI!.provider!.getModelCapability(payload)) as ModelCapabilityDTO | null;
}

export async function deleteModelCapabilityIPC(
  payload: { providerId: string; modelId: string },
): Promise<boolean> {
  return (await window.electronAPI!.provider!.deleteModelCapability(payload)) as boolean;
}

// Output Style operations
export async function listOutputStylesIPC(): Promise<Array<{ id: string; name: string; description?: string; prompt: string; keepCodingInstructions?: boolean; isBuiltin?: boolean }>> {
  return await window.electronAPI!.outputStyle!.list() as Array<{ id: string; name: string; description?: string; prompt: string; keepCodingInstructions?: boolean; isBuiltin?: boolean }>
}

export async function getOutputStyleIPC(id: string): Promise<{ id: string; name: string; description?: string; prompt: string; keepCodingInstructions?: boolean; isBuiltin?: boolean } | null> {
  return await window.electronAPI!.outputStyle!.get(id) as { id: string; name: string; description?: string; prompt: string; keepCodingInstructions?: boolean; isBuiltin?: boolean } | null
}

export async function upsertOutputStyleIPC(data: { id: string; name: string; description?: string; prompt: string; keepCodingInstructions?: boolean }): Promise<{ id: string; name: string; description?: string; prompt: string; keepCodingInstructions?: boolean; isBuiltin?: boolean } | null> {
  return await window.electronAPI!.outputStyle!.upsert(data) as { id: string; name: string; description?: string; prompt: string; keepCodingInstructions?: boolean; isBuiltin?: boolean } | null
}

export async function deleteOutputStyleIPC(id: string): Promise<boolean> {
  return window.electronAPI!.outputStyle!.delete(id) as Promise<boolean>
}

// Project operations

/**
 * Canonical path of the shared no-project workspace (`~/.duya/workspace`).
 * Returns empty string when the IPC is unavailable (e.g. browser dev mode).
 */
export async function getNoProjectWorkspaceIPC(): Promise<string> {
  if (!window.electronAPI?.app?.getNoProjectWorkspace) return '';
  return window.electronAPI.app.getNoProjectWorkspace();
}

export async function getProjectGroupsIPC(): Promise<ProjectGroup[]> {
  const [dbProjectsRaw, noProjectWorkspace] = await Promise.all([
    window.electronAPI!.project.getGroups() as Promise<DbProjectGroup[]>,
    getNoProjectWorkspaceIPC(),
  ]);
  // No-project sessions share ~/.duya/workspace; they must not show up as a
  // regular project group — they are rendered in the flat "无项目" list.
  const isNoProject = (wd: string) => !wd || (noProjectWorkspace !== '' && wd === noProjectWorkspace);
  const dbProjects = dbProjectsRaw.filter((p) => !isNoProject(p.working_directory));
  const projects = dbProjects.map(backendProjectToProject)

  if (!window.electronAPI?.projects?.getRecentFolders) {
    return projects
  }

  const existingPaths = new Set(projects.map((project) => project.workingDirectory))
  const recentFolders = (await window.electronAPI.projects.getRecentFolders())
    .filter((wd) => !isNoProject(wd))
  const recentProjects = recentFolders
    .filter((workingDirectory) => workingDirectory && !existingPaths.has(workingDirectory))
    .map((workingDirectory, index) => ({
      workingDirectory,
      projectName: workingDirectory.split(/[\\/]/).pop() || 'Untitled',
      threadCount: 0,
      lastActivity: Date.now() - index,
      createdAt: Date.now() - index,
      isExpanded: true,
    }))

  return [...projects, ...recentProjects]
}

export async function addRecentFolderIPC(workingDirectory: string): Promise<ProjectGroup[]> {
  if (window.electronAPI?.projects?.addRecentFolder) {
    await window.electronAPI.projects.addRecentFolder(workingDirectory)
  }
  return getProjectGroupsIPC()
}

// Lock operations
export async function acquireLockIPC(
  sessionId: string,
  lockId: string,
  owner: string,
  ttlSec = 300
): Promise<boolean> {
  return window.electronAPI!.lock.acquire(sessionId, lockId, owner, ttlSec) as Promise<boolean>
}

export async function releaseLockIPC(sessionId: string, lockId: string): Promise<boolean> {
  return window.electronAPI!.lock.release(sessionId, lockId) as Promise<boolean>
}

export async function isLockedIPC(sessionId: string): Promise<boolean> {
  return window.electronAPI!.lock.isLocked(sessionId) as Promise<boolean>
}

// Settings operations
export async function getAllSettingsIPC(): Promise<Record<string, string>> {
  return window.electronAPI!.settingsDb.getAll() as Promise<Record<string, string>>
}

// Permission operations
export async function createPermissionRequestIPC(data: {
  id: string
  sessionId?: string
  toolName: string
  toolInput?: Record<string, unknown>
}): Promise<PermissionRequest | null> {
  return window.electronAPI!.permission.create(data) as Promise<PermissionRequest>
}

export async function resolvePermissionIPC(
  id: string,
  status: string,
  extra?: {
    message?: string
    updatedPermissions?: unknown[]
    updatedInput?: Record<string, unknown>
    sessionId?: string
  }
): Promise<PermissionRequest | null> {
  return window.electronAPI!.permission.resolve(id, status, extra) as Promise<PermissionRequest>
}

// Migration operations
export interface MigrationCheckResult {
  needed: boolean
  sourcePath: string | null
  targetExists: boolean
}

export async function checkMigrationNeededIPC(newDbPath: string): Promise<MigrationCheckResult> {
  return window.electronAPI!.migration.checkNeeded(newDbPath)
}

export async function migrateDatabaseIPC(sourcePath: string, targetPath: string): Promise<{ success: boolean }> {
  return window.electronAPI!.migration.migrate(sourcePath, targetPath)
}

// Network operations (external API calls via Electron main process)
export interface ProviderTestResult {
  success: boolean
  message?: string
  error?: {
    code: string
    message: string
    suggestion?: string
  }
}

export interface OllamaModel {
  id: string
  name: string
  size?: number
  modified_at?: string
}

export interface OllamaModelsResult {
  success: boolean
  models?: OllamaModel[]
  error?: string
}

export async function getOllamaModelsIPC(baseUrl: string): Promise<OllamaModelsResult> {
  return window.electronAPI!.net.getOllamaModels(baseUrl)
}

/**
 * Plan 205 Phase H1: list available models for a provider. Used
 * by `ProviderEditView` so the user can pick a model from a
 * dropdown (the OpenAI-compatible `/v1/models` shape, normalized
 * across vendors).
 */
export interface FetchedModel {
  id: string;
  ownedBy: string | null;
  /**
   * Active context window (tokens) for the model. LM Studio distinguishes
   * the model's absolute cap (`max_context_length`) from the currently
   * loaded instance's config (`loaded_instances[0].config.context_length`).
   * We prefer the loaded value so the renderer can show what is actually
   * hot, and fall back to `max_context_length` when the model is not
   * loaded. Lets the renderer seed a per-model context window instead of
   * assuming 200K/1M.
   */
  contextLength?: number;
  /**
   * Absolute context-window ceiling of the model (tokens), independent of
   * whether it is currently loaded. Sourced from LM Studio
   * `max_context_length`. When this is larger than `contextLength`, the
   * user can increase the loaded context up to this limit. `undefined`
   * when the source API does not expose it (e.g. plain OpenAI `/v1/models`).
   */
  contextWindowMax?: number;
  /**
   * Per-request output ceiling (tokens), when the source API exposes it
   * (e.g. OpenRouter `top_provider.max_completion_tokens`). Persisted to
   * the capability table so the agent can size max_tokens correctly
   * instead of falling back to the built-in default — critical for
   * reasoning models whose thinking shares the output budget.
   */
  maxOutputTokens?: number;
  /**
   * Whether the model accepts image input. Sourced from LM Studio
   * `capabilities.vision`. `undefined` when the source does not expose
   * it (e.g. plain OpenAI `/v1/models`).
   */
  supportsVision?: boolean;
  /**
   * Whether the model is trained for function/tool calling. Sourced from
   * LM Studio `capabilities.trained_for_tool_use`. `undefined` when the
   * source does not expose it. Critical for agent mode — a text-only
   * chat model MUST NOT be wired with the tool-use loop.
   */
  supportsToolUse?: boolean;
  /**
   * Whether the model emits a separate reasoning/thinking stream.
   * Sourced from LM Studio `capabilities.reasoning.allowed_options`
   * (when at least one non-`off` option is listed) or
   * `capabilities.reasoning.default` (when no `allowed_options`). Used
   * by the agent loop to decide whether to surface `<thinking>` blocks
   * and whether to send `reasoning_effort` in the request.
   */
  supportsReasoning?: boolean;
  /**
   * Model quantization/format family (e.g. `'gguf'`, `'mlx'` for LM
   * Studio). Display-only — surfaced as a small badge in the settings
   * model list so users can tell CPU-optimized GGUF from Apple-Silicon
   * MLX variants at a glance.
   */
  format?: string | null;
  /**
   * Whether the model is currently loaded into the LM Studio / Ollama
   * runtime. Sourced from `loaded_instances.length > 0` (with at least
   * one valid numeric `context_length`). Lets the user tell "this
   * model is hot and ready" from "this is a known model that the user
   * has to load first". Surfaced as a small dot in the chat dropdown.
   */
  isLoaded?: boolean;
  /**
   * The actual reasoning-effort options the model accepts, sourced from
   * LM Studio `capabilities.reasoning.allowed_options` (after
   * normalization: lowercased / trimmed / deduped, excluding `'off'`
   * and `'on'` which are binary toggles not effort levels). Drives the
   * chat-side effort dropdown so e.g. a model with `[low, medium]`
   * shows only those two options instead of the static `[minimal,
   * low, medium, high, xhigh, max]` fallback. Empty array when the
   * source did not enumerate options or the model does not reason.
   */
  reasoningEffortOptions?: string[];
}

export interface FetchProviderModelsResult {
  success: boolean;
  models?: FetchedModel[];
  error?: {
    code: string;
    message: string;
    suggestion?: string;
  };
}

export interface FetchProviderModelsBody {
  protocol?: string;
  base_url?: string;
  api_key?: string;
  auth_style?: 'api_key' | 'auth_token' | 'env_only' | 'custom_header';
  /**
   * Plan 209 fix-up: when the renderer is editing an existing
   * provider and the user has NOT typed a new key, the on-disk
   * key is used to drive the fetch. The renderer never sees the
   * raw key, so it has to ask the main process to look it up.
   *
   * The IPC handler resolves this in priority order:
   *   1. If `api_key` is a non-empty, non-masked string, use it
   *      (the user retyped).
   *   2. Else if `provider_id` is set and the on-disk provider
   *      has a real key, use the on-disk key.
   *   3. Else fall back to whatever was sent (likely empty →
   *      NO_CREDENTIALS).
   */
  provider_id?: string;
}

export async function fetchProviderModelsIPC(
  body: FetchProviderModelsBody,
): Promise<FetchProviderModelsResult> {
  return window.electronAPI!.net.getProviderModels(body);
}

export interface BridgeTestResult {
  success: boolean
  message: string
  details?: string
}

export async function testBridgeChannelIPC(channel: string): Promise<BridgeTestResult> {
  return window.electronAPI!.net.testBridgeChannel(channel)
}

// Weixin QR Login
export interface WeixinQrStartResult {
  success: boolean
  sessionId?: string
  qrImage?: string
  error?: string
}

export interface WeixinQrPollResult {
  success: boolean
  status?: string
  qr_image?: string
  account_id?: string
  error?: string
}

export async function weixinQrStartIPC(): Promise<WeixinQrStartResult> {
  return window.electronAPI!.net.weixinQrStart()
}

export async function weixinQrPollIPC(sessionId: string): Promise<WeixinQrPollResult> {
  return window.electronAPI!.net.weixinQrPoll(sessionId)
}

export async function weixinQrCancelIPC(sessionId: string): Promise<{ success: boolean }> {
  return window.electronAPI!.net.weixinQrCancel(sessionId)
}

// Weixin Account Management
export interface WeixinAccount {
  account_id: string
  user_id: string
  name: string
  base_url: string
  cdn_base_url: string
  token: string
  enabled: number
  last_login_at: number
}

export async function getWeixinAccountsIPC(): Promise<WeixinAccount[]> {
  return window.electronAPI!.weixin.getAccounts() as Promise<WeixinAccount[]>
}

export async function upsertWeixinAccountIPC(data: {
  accountId: string
  userId?: string
  name?: string
  baseUrl?: string
  cdnBaseUrl?: string
  token: string
  enabled?: boolean
}): Promise<WeixinAccount> {
  return window.electronAPI!.weixin.upsertAccount(data) as Promise<WeixinAccount>
}

export async function updateWeixinAccountIPC(accountId: string, data: {
  enabled?: boolean
  name?: string
}): Promise<WeixinAccount | null> {
  return window.electronAPI!.weixin.updateAccount(accountId, data) as Promise<WeixinAccount | null>
}

export async function deleteWeixinAccountIPC(accountId: string): Promise<boolean> {
  return window.electronAPI!.weixin.deleteAccount(accountId) as Promise<boolean>
}

// Gateway Session operations
export interface GatewaySession {
  id: string
  title: string
  platform: string
  platformUserId: string
  platformChatId: string
  createdAt: number
  updatedAt: number
}

export async function listGatewaySessionsIPC(): Promise<GatewaySession[]> {
  return window.electronAPI!.gateway.listSessions() as Promise<GatewaySession[]>
}

export async function getGatewaySessionIPC(id: string): Promise<GatewaySession | null> {
  return window.electronAPI!.gateway.getSession(id) as Promise<GatewaySession | null>
}

export async function listMemoryIPC(): Promise<{ entries: MemoryEntry[]; enabled: boolean }> {
  return window.electronAPI!.memory.list()
}

/**
 * Fetch the memory system log (Phase 1 + Phase 2 activity) for the
 * Settings → Memory → Activity view.
 */
export interface MemorySystemLogEntry {
  ts: number;
  phase: 'phase1' | 'phase2' | 'phase3' | 'system';
  event_type: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  detail: Record<string, unknown> | null;
  rollout_id?: string | null;
  run_id?: string | null;
  session_id?: string | null;
}

export interface ListMemorySystemLogIPCArgs {
  limit?: number;
  phase?: 'phase1' | 'phase2' | 'phase3' | 'system';
  runId?: string;
  since?: number;
}

export interface RagRebuildIPCResult {
  ok: boolean;
  error?: string;
  documents?: number;
  embedded?: number;
  scanRoots?: string[];
  durationMs?: number;
}

/** Trigger an on-demand rebuild of the retrievable memory (RAG) index. */
export async function ragRebuildMemoryIPC(): Promise<RagRebuildIPCResult> {
  return window.electronAPI!.memory.ragRebuild()
}

export async function listMemorySystemLogIPC(
  opts?: ListMemorySystemLogIPCArgs
): Promise<{ entries: MemorySystemLogEntry[]; total: number }> {
  return window.electronAPI!.memory.systemLog({ ...(opts ?? {}) })
}
