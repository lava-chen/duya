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
}

export interface Provider {
  id: string
  name: string
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
  /** Provider default model from options */
  defaultModel?: string
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
}

// Backend returns camelCase (via maskProvider in agent-communicator.ts)
interface BackendProvider {
  id: string
  name: string
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
}

// Conversion helpers
function dbThreadToThread(db: DbThread): Thread {
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
  }
}

function backendProjectToProject(db: DbProjectGroup): ProjectGroup {
  return {
    workingDirectory: db.working_directory,
    projectName: db.project_name,
    threadCount: db.thread_count,
    lastActivity: db.last_activity,
  }
}

// Thread operations
export async function listThreadsIPC(): Promise<Thread[]> {
  const dbThreads = await window.electronAPI!.thread!.list() as DbThread[]
  return dbThreads.map(dbThreadToThread)
}

export async function getThreadIPC(id: string): Promise<{ thread: Thread; messages: Message[] } | null> {
  const dbThread = await window.electronAPI!.thread!.get(id) as DbThread | undefined
  if (!dbThread) return null
  const dbMessages = await window.electronAPI!.message!.getBySession(id) as DbMessage[]
  return {
    thread: dbThreadToThread(dbThread),
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
  return dbThreads.map(dbThreadToThread)
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

export async function truncateMessagesAfterIPC(
  sessionId: string,
  messageId: string
): Promise<{ deletedCount: number }> {
  return window.electronAPI!.message!.truncateAfter(sessionId, messageId) as Promise<{
    deletedCount: number
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
}): Promise<Provider | null> {
  const raw = await window.electronAPI!.provider!.upsert({
    id: data.id,
    name: data.name,
    providerType: data.providerType,
    baseUrl: data.baseUrl,
    apiKey: data.apiKey,
    isActive: data.isActive,
    options: data.options,
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

export async function setActiveLlmProviderIPC(id: string): Promise<boolean> {
  return (await window.electronAPI!.provider!.setActiveLlm(id)) as boolean
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
export async function getProjectGroupsIPC(): Promise<ProjectGroup[]> {
  const dbProjects = await window.electronAPI!.project.getGroups() as DbProjectGroup[]
  const projects = dbProjects.map(backendProjectToProject)

  if (!window.electronAPI?.projects?.getRecentFolders) {
    return projects
  }

  const existingPaths = new Set(projects.map((project) => project.workingDirectory))
  const recentFolders = await window.electronAPI.projects.getRecentFolders()
  const recentProjects = recentFolders
    .filter((workingDirectory) => workingDirectory && !existingPaths.has(workingDirectory))
    .map((workingDirectory, index) => ({
      workingDirectory,
      projectName: workingDirectory.split(/[\\/]/).pop() || 'Untitled',
      threadCount: 0,
      lastActivity: Date.now() - index,
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
