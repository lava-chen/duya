import { contextBridge, ipcRenderer } from 'electron'
import type { MCPInventorySnapshotDTO } from '../src/lib/mcp-inventory-types'
import type {
  ProjectDatabaseChangeEvent,
  ProjectDatabaseRequest,
} from '../packages/conductor/src/database/types'
import type { BashBackgroundTaskSnapshot } from '../src/types/bash-task'
// Plan 312 — App Connection status DTO is the only shape returned to the
// renderer. Token fields never appear here.
import type { AppConnectionStatusDTO } from './services/app-connections/types'

// webUtils.getPathForFile is exposed from Electron 30+. On older versions
// (e.g. Electron 28 in this project) `File.path` still works for dragged
// files, so the renderer falls back to that. We require it lazily so the
// preload keeps loading on versions that don't expose it.
let webUtilsGetPathForFile: ((file: File) => string) | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { webUtils } = require('electron') as typeof import('electron') & { webUtils?: { getPathForFile: (f: File) => string } };
  if (webUtils?.getPathForFile) {
    webUtilsGetPathForFile = (file: File) => webUtils.getPathForFile(file);
  }
} catch {
  // webUtils unavailable — renderer uses File.path fallback
}

// Preload script initialized

export interface AgentAPI {
  streamChat: (prompt: string, options?: Record<string, unknown>) => Promise<unknown>
  interrupt: () => Promise<unknown>
  reinitProvider: () => Promise<unknown>
}

export interface SyncAPI {
  notifyThreadsChanged: () => void
  onThreadsChanged: (callback: () => void) => () => void
}

// MessagePort API for config communication
export interface ConfigPortAPI {
  getConfig: (key: string) => void
  setConfig: (key: string, value: unknown) => void
  subscribe: () => void
  onConfigUpdate: (callback: (config: unknown) => void) => () => void
  onConfigResponse: (callback: (data: { key: string; value: unknown }) => void) => () => void
}

export interface ConductorPortAPI {
  onStatePatch: (callback: (data: Record<string, unknown>) => void) => () => void
  onCanvasChanged: (callback: (data: {
    operation: 'create' | 'switch' | 'rename'
    sessionId?: string
    canvas: Record<string, unknown>
    currentCanvasId?: string
  }) => void) => () => void
  /** Listen for canvas capture requests from the agent (via main process). */
  onCaptureRequest: (callback: (data: { requestId: string; canvasId: string; scope: string; elementId?: string; region?: { x: number; y: number; w: number; h: number } }) => void) => () => void
  /** Send a capture response back to the main process (which forwards to the agent). */
  sendCaptureResponse: (data: { requestId: string; result?: unknown; error?: string }) => void
}

export interface ProjectDatabaseAPI {
  invoke: (request: ProjectDatabaseRequest) => Promise<unknown>
  onChanged: (callback: (event: ProjectDatabaseChangeEvent) => void) => () => void
}

export interface ThreadAPI {
  list: () => Promise<unknown[]>
  get: (id: string) => Promise<unknown>
  create: (data: Record<string, unknown>) => Promise<unknown>
  update: (id: string, data: Record<string, unknown>) => Promise<unknown>
  delete: (id: string) => Promise<boolean>
  listByParentId: (parentId: string) => Promise<unknown[]>
  getTasks: (sessionId: string) => Promise<unknown[]>
  createTask: (data: Record<string, unknown>) => Promise<unknown>
  updateTask: (id: string, data: Record<string, unknown>) => Promise<unknown>
  deleteTask: (id: string) => Promise<boolean>
}

export interface SessionAPI {
  saveDraft: (sessionId: string, draft: string) => Promise<void>
  getDraft: (sessionId: string) => Promise<string>
  setConductorMode: (sessionId: string, enabled: boolean, canvasId?: string | null) => Promise<unknown>
}

export interface MessageAPI {
  add: (data: Record<string, unknown>) => Promise<unknown>
  getBySession: (sessionId: string) => Promise<unknown[]>
  replace: (sessionId: string, messages: unknown[], generation: number) => Promise<unknown>
  truncateAfter: (sessionId: string, messageId: string) => Promise<{ deletedCount: number }>
  truncateFromInclusive: (sessionId: string, messageId: string) => Promise<{ deletedCount: number }>
}

export interface SettingsAPI {
  get: (key: string) => Promise<string | null>
  set: (key: string, value: string) => Promise<void>
  getAll: () => Promise<Record<string, string>>
  getJson: <T>(key: string, defaultValue: T) => Promise<T>
  setJson: <T>(key: string, value: T) => Promise<void>
}

export interface MigrationAPI {
  checkNeeded: (newDbPath: string) => Promise<{ needed: boolean; sourcePath: string | null; targetExists: boolean }>
  migrate: (sourcePath: string, targetPath: string) => Promise<{ success: boolean }>
  getDefaultPath: () => Promise<string>
  databaseExists: (dbPath: string) => Promise<boolean>
  getDatabaseSize: (dbPath: string) => Promise<string>
  updateBootAndRestart: (newDbPath: string) => Promise<{ success: boolean; error?: string }>
}

export interface SafeModeAPI {
  getStatus: () => Promise<{ isSafeMode: boolean; reason: string | null; currentDbPath: string }>
  relocateDatabase: (newDir: string) => Promise<{ success: boolean; newPath?: string; error?: string }>
  resetToDefaultPath: () => Promise<{ success: boolean; newPath?: string; error?: string }>
  getStats: () => Promise<{ success: boolean; stats?: { path: string; sizeBytes: number; sizeFormatted: string; messageCount: number; sessionCount: number; walSizeBytes: number }; error?: string; warning?: string | null }>
}

export interface SkillsAPI {
  list: () => Promise<{ success: boolean; skills: unknown[]; error?: string }>
  getEnabledOverrides: () => Promise<{ success: boolean; overrides: Record<string, boolean>; error?: string }>
  setEnabled: (skillName: string, enabled: boolean) => Promise<{ success: boolean; overrides?: Record<string, boolean>; error?: string }>
  getSecurityBypass: () => Promise<{ success: boolean; skills: string[]; error?: string }>
  setSecurityBypass: (skillName: string, bypass: boolean) => Promise<{ success: boolean; skills: string[]; error?: string }>
  uploadSkill: (filePath: string) => Promise<{ success: boolean; skillName?: string; error?: string }>
}

export interface ProviderAPI {
  list: () => Promise<unknown[]>
  get: (id: string) => Promise<unknown>
  getActive: () => Promise<unknown>
  upsert: (data: Record<string, unknown>) => Promise<unknown>
  update: (id: string, data: Record<string, unknown>) => Promise<unknown>
  delete: (id: string) => Promise<boolean>
  activate: (id: string) => Promise<unknown>
  // Get full provider config (unmasked API key) for agent initialization
  getActiveProviderConfig: () => Promise<{
    apiKey: string
    baseUrl?: string
    providerType: string
    model: string
    provider: string
    authStyle: string
    runtimeConfig?: Record<string, unknown>
  } | null>
  // Get unmasked provider config by ID for title generation model resolution
  getConfig: (providerId: string, model: string) => Promise<{
    apiKey: string
    baseUrl?: string
    model: string
    provider: string
    authStyle: string
    runtimeConfig?: Record<string, unknown>
  } | null>
  // Phase 2: new LlmProvider-aware channels. All return masked DTOs
  // (no apiKey / accessToken). Health/test endpoints return
  // ProviderHealthStatus; syncModels returns ModelCapability[].
  listLlm: () => Promise<unknown[]>
  getLlm: (id: string) => Promise<unknown | null>
  upsertLlm: (data: Record<string, unknown>) => Promise<{ ok: boolean; provider?: unknown; code?: string; message?: string }>
  deleteLlm: (id: string) => Promise<boolean>
  /** New soft-default channel. The default is the implicit fallback
   *  used by chat/vision/etc when no per-thread provider is set. */
  setDefaultLlm: (payload: { id: string | null }) => Promise<boolean>
  /** Get the current default provider (masked DTO). */
  getDefault: () => Promise<unknown | null>
  /** Set the memory worker provider. When null, falls back to default. */
  setMemory: (payload: { id: string | null }) => Promise<boolean>
  /** Get the memory worker provider (masked DTO). */
  getMemory: () => Promise<unknown | null>
  test: (payload: { providerId: string; presetKey?: string }) => Promise<{
    providerId: string
    ok: boolean
    latencyMs?: number
    checkedAt: number
    errorKind?: 'auth' | 'network' | 'rate_limit' | 'invalid_model' | 'invalid_config' | 'unknown'
    message?: string
  }>
  testModel: (payload: { providerId: string; modelId: string }) => Promise<{
    providerId: string
    ok: boolean
    latencyMs?: number
    checkedAt: number
    errorKind?: 'auth' | 'network' | 'rate_limit' | 'invalid_model' | 'invalid_config' | 'unknown'
    message?: string
  }>
  syncModels: (payload: { providerId: string; presetKey?: string }) => Promise<{
    ok: boolean
    models: Array<{
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
    }>
    source: string
    message?: string
  }>
  upsertModelCapability: (capability: Record<string, unknown>) => Promise<{ ok: boolean; capability: Record<string, unknown> }>
  // Phase 3: persistent model capability reads.
  listModelCapabilities: (payload: { providerId: string }) => Promise<Array<{
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
  }>>
  getModelCapability: (payload: { providerId: string; modelId: string }) => Promise<{
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
  } | null>
  deleteModelCapability: (payload: { providerId: string; modelId: string }) => Promise<boolean>
}

export interface OutputStyleAPI {
  list: () => Promise<unknown[]>
  get: (id: string) => Promise<unknown>
  upsert: (data: Record<string, unknown>) => Promise<unknown>
  delete: (id: string) => Promise<boolean>
}

export interface VisionAPI {
  get: () => Promise<{
    provider: string
    model: string
    baseUrl: string
    apiKey: string
    enabled: boolean
  }>
  set: (config: {
    provider?: string
    model?: string
    baseUrl?: string
    apiKey?: string
    enabled?: boolean
  }) => Promise<{
    provider: string
    model: string
    baseUrl: string
    apiKey: string
    enabled: boolean
  }>
}

export interface MemoryAPI {
  list: () => Promise<{
    entries: import('../src/types').MemoryEntry[]
    enabled: boolean
  }>
}

export interface PermissionAPI {
  create: (data: Record<string, unknown>) => Promise<unknown>
  get: (id: string) => Promise<unknown>
  resolve: (id: string, status: string, extra?: Record<string, unknown>) => Promise<unknown>
}

export interface ProjectAPI {
  getGroups: () => Promise<unknown[]>
}

export interface LockAPI {
  acquire: (sessionId: string, lockId: string, owner: string, ttlSec?: number) => Promise<boolean>
  release: (sessionId: string, lockId: string) => Promise<boolean>
  isLocked: (sessionId: string) => Promise<boolean>
}

export interface NetAPI {
  testProvider: (body: {
    provider_type?: string
    base_url?: string
    api_key?: string
    model?: string
    auth_style?: string
  }) => Promise<{
    success: boolean
    message?: string
    error?: {
      code: string
      message: string
      suggestion?: string
    }
  }>
  getProviderUsage: (body: {
    provider_type?: string
    base_url?: string
    api_key?: string
  }) => Promise<{
    success: boolean
    plan?: string
    quotas?: Record<string, {
      used: number
      total: number
      remaining: number
      remainingPercentage: number
      resetAt: string | null
      unlimited: boolean
    }>
    message?: string
    error?: {
      code: string
      message: string
    }
  }>
  getOllamaModels: (baseUrl: string) => Promise<{
    success: boolean
    models?: Array<{ id: string; name: string; size?: number; modified_at?: string }>
    error?: string
  }>
  /**
   * Plan 205 Phase H1: list available models for a provider so
   * the user can pick from a dropdown in `ProviderEditView`.
   * Returns the OpenAI-compatible `/v1/models` shape, normalized
   * across vendors.
   */
  getProviderModels: (body: {
    protocol?: string
    base_url?: string
    api_key?: string
    auth_style?: string
    /**
     * Plan 209 fix-up: when set, the main process resolves the
     * real on-disk api_key for the provider and uses it to drive
     * the fetch. See `FetchProviderModelsBody` in
     * `src/lib/ipc-client.ts` for the full resolution rules.
     */
    provider_id?: string
  }) => Promise<{
    success: boolean
    models?: Array<{ id: string; ownedBy: string | null }>
    error?: {
      code: string
      message: string
      suggestion?: string
    }
  }>
  testBridgeChannel: (channel: string) => Promise<{
    success: boolean
    message: string
    details?: string
  }>
  weixinQrStart: () => Promise<{
    success: boolean
    sessionId?: string
    qrImage?: string
    error?: string
  }>
  weixinQrPoll: (sessionId: string) => Promise<{
    success: boolean
    status?: string
    qr_image?: string
    account_id?: string
    error?: string
  }>
  weixinQrCancel: (sessionId: string) => Promise<{ success: boolean }>
}

export interface GatewayAPI {
  start: () => Promise<{ success: boolean; error?: string }>
  stop: () => Promise<{ success: boolean; error?: string }>
  reload: () => Promise<{ success: boolean; error?: string }>
  getStatus: () => Promise<{ running: boolean; adapters: unknown[]; autoStart: boolean }>
  testChannel: (channel: string) => Promise<{ success: boolean; message: string; details?: string }>
  getProxyStatus: () => Promise<{
    success: boolean
    error?: string
    status: {
      configured: string | undefined
      env: string | undefined
      system: string | undefined
      effective: string | undefined
    }
  }>
  listSessions: () => Promise<Array<{
    id: string
    title: string
    platform: string
    platformUserId: string
    platformChatId: string
    createdAt: number
    updatedAt: number
  }>>
  getSession: (sessionId: string) => Promise<{
    id: string
    title: string
    platform: string
    platformUserId: string
    platformChatId: string
    createdAt: number
    updatedAt: number
  } | null>
  pairingList: () => Promise<{ pending: unknown[]; approved: unknown[] }>
  pairingApprove: (platform: string, code: string) => Promise<{ approved: boolean; error?: string }>
  pairingRevoke: (platform: string, platformUserId: string) => Promise<{ revoked: boolean }>
  feishuQrBegin: () => Promise<{ success: boolean; result?: { qr_url?: string; device_code?: string; user_code?: string; interval?: number; expire_in?: number }; error?: string }>
  feishuQrPoll: (begin: { device_code: string; interval: number; expire_in: number }) => Promise<{ success: boolean; result?: { app_id?: string; app_secret?: string; open_id?: string; domain?: string }; error?: string }>
}

export interface AutomationAPI {
  listCrons: () => Promise<unknown[]>
  createCron: (data: Record<string, unknown>) => Promise<unknown>
  updateCron: (id: string, patch: Record<string, unknown>) => Promise<unknown>
  deleteCron: (id: string) => Promise<{ success: boolean }>
  runCron: (id: string) => Promise<unknown>
  listCronRuns: (input: { cronId: string; limit?: number; offset?: number }) => Promise<unknown[]>
  listTemplates: () => Promise<unknown[]>
}

export interface FileTreeNode {
  name: string
  path: string
  type: 'directory' | 'file'
  extension?: string
  children?: FileTreeNode[]
}

export interface FilesAPI {
  browse: (dirPath: string, maxDepth?: number) => Promise<{ success: boolean; error?: string; tree: FileTreeNode[] }>
  preview: (targetPath: string, rootPath: string) => Promise<{
    success: boolean
    error?: string
    kind?: 'text' | 'image' | 'pdf' | 'unsupported'
    name?: string
    path?: string
    size?: number
    modifiedAt?: number
    extension?: string
    content?: string
    data?: string
    mediaType?: string
    truncated?: boolean
    tooLarge?: boolean
  }>
  delete: (targetPath: string) => Promise<{ success: boolean; error?: string }>
  rename: (targetPath: string, newName: string) => Promise<{ success: boolean; error?: string; newPath?: string }>
}

export interface ReferenceEntry {
  name: string
  relativePath: string
  absolutePath: string
  size: number
  isDirectory: boolean
  mtime: number
  extension?: string
}

export interface ReferencesAPI {
  list: (workingDirectory: string) => Promise<{ success: boolean; data?: ReferenceEntry[]; error?: string }>
  pickFiles: (options?: { title?: string; defaultPath?: string }) => Promise<{ canceled: boolean; filePaths: string[] }>
  add: (workingDirectory: string, filePaths: string[]) => Promise<{ success: boolean; data?: string[]; error?: string }>
  delete: (workingDirectory: string, relativePath: string) => Promise<{ success: boolean; error?: string }>
  open: (workingDirectory: string, relativePath: string) => Promise<{ success: boolean; error?: string }>
}

export interface GitStatusFileChange {
  path: string;
  additions: number;
  removals: number;
}

export interface GitStatusTotals {
  additions: number;
  removals: number;
  fileCount: number;
}

export interface GitStatusResult {
  isGitRepo: boolean;
  fileChanges?: GitStatusFileChange[];
  totals?: GitStatusTotals;
}

export type GitReviewFileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';

export interface GitReviewFile extends GitStatusFileChange {
  status: GitReviewFileStatus;
  oldPath?: string;
}

export interface GitReviewResult {
  isGitRepo: boolean;
  branch?: string;
  baseRef?: string;
  files?: GitReviewFile[];
  totals?: GitStatusTotals;
}

export interface GitReviewDiffResult {
  isGitRepo: boolean;
  path?: string;
  patch?: string;
  binary?: boolean;
  truncated?: boolean;
  error?: string;
}

export interface GitReviewFullDiffResult {
  isGitRepo: boolean;
  patch?: string;
  binary?: boolean;
  truncated?: boolean;
  error?: string;
}

export interface GitTurnReview {
  id: string;
  sessionId: string;
  turnId: string;
  workingDirectory: string;
  files: GitReviewFile[];
  totals: GitStatusTotals;
  patch: string;
  binary: boolean;
  truncated: boolean;
  capturedAt: number;
}

export interface GitLatestTurnReviewResult {
  isGitRepo: boolean;
  review?: GitTurnReview;
  error?: string;
}

export interface GitAPI {
  status: (cwd: string) => Promise<GitStatusResult>;
  review: (cwd: string) => Promise<GitReviewResult>;
  reviewDiff: (cwd: string, filePath: string) => Promise<GitReviewDiffResult>;
  reviewFullDiff: (cwd: string) => Promise<GitReviewFullDiffResult>;
  reviewLatestTurn: (sessionId: string, cwd: string) => Promise<GitLatestTurnReviewResult>;
}

export interface PortStatusAPI {
  isConfigPortReady: () => boolean
}

// SessionPort API for per-session MessagePort communication
export interface SessionPortAPI {
  send: (type: string, payload?: unknown) => void
  onMessage: (handler: (data: unknown) => void) => () => void
  close: () => void
}

export interface WeixinAccountAPI {
  getAccounts: () => Promise<unknown[]>
  upsertAccount: (data: Record<string, unknown>) => Promise<unknown>
  updateAccount: (accountId: string, data: Record<string, unknown>) => Promise<unknown>
  deleteAccount: (accountId: string) => Promise<boolean>
  getContextToken: (accountId: string, peerUserId: string) => Promise<string | null>
  setContextToken: (accountId: string, peerUserId: string, contextToken: string) => Promise<void>
}

export interface AgentProfileAPI {
  list: () => Promise<unknown[]>
  get: (id: string) => Promise<unknown>
  create: (data: Record<string, unknown>) => Promise<unknown>
  update: (id: string, data: Record<string, unknown>) => Promise<unknown>
  delete: (id: string) => Promise<boolean>
}

export interface BrowserExtensionStatus {
  daemonRunning: boolean;
  extensionConnected: boolean;
  extensionVersion: string | null;
  extensionName: string | null;
  extensionId: string | null;
  pendingExtensionApproval: {
    extensionId: string | null;
    extensionName: string;
    extensionVersion: string | null;
    requestedAt: number;
  } | null;
  pendingCommands: number;
  port: number;
}

export interface BrowserExtensionAPI {
  getStatus: () => Promise<{ success: boolean; status?: BrowserExtensionStatus; error?: string }>
  getExtensionPath: () => Promise<string>
  approvePending: () => Promise<{ success: boolean; status?: BrowserExtensionStatus; error?: string }>
  denyPending: () => Promise<{ success: boolean; status?: BrowserExtensionStatus; error?: string }>
}

export interface BrowserWebviewAPI {
  registerWebview: (sessionId: string, webContentsId: number) => Promise<{ ok: boolean; error?: string }>
  unregisterWebview: (sessionId: string) => Promise<{ ok: boolean; error?: string }>
  closeAgentBrowser: (sessionId: string) => Promise<{ ok: boolean; error?: string }>
  onOpenAgentTab: (callback: (sessionId: string, focus: boolean) => void) => () => void
  onCloseAgentTab: (callback: (sessionId: string) => void) => () => void
  onActivateAgentTab: (callback: (sessionId: string, focus: boolean) => void) => () => void
}

export interface BrowserCookieAPI {
  importCookies: (browser: 'chrome' | 'edge', profile?: string) => Promise<{ ok: boolean; count?: number; failed?: number; unsupported?: number; source?: 'extension'; error?: string; errorCode?: 'COOKIE_DATABASE_BUSY' | 'APP_BOUND_EXTENSION_UNAVAILABLE' }>
  clearData: () => Promise<{ ok: boolean; error?: string }>
}

export interface BrowserBackendAPI {
  updateMode: (mode: 'auto' | 'extension' | 'built-in' | 'human-like') => Promise<{ success: boolean; reason?: string }>
}

export interface DocumentParserAPI {
  parse: (filePath: string, options?: { timeout?: number }) => Promise<{
    fileHash: string
    sessionId: string
    filename: string
    charCount: number
    chunks: Array<
      | { type: 'text'; index: number; text: string }
      | { type: 'image'; index: number; base64: string; mediaType: string }
    >
    extractMethod?: 'text' | 'vision' | 'hybrid'
    metadata?: Record<string, unknown>
    thumbnail?: { base64: string; mediaType: string }
    parsedAt: number
  }>
  getCapabilities: () => Promise<{
    parsers: Record<string, string | boolean>
    libreoffice_path: string | null
    version: string
  } | null>
  isReady: () => Promise<boolean>
}

export type LiteratureCitationStyle = 'bibtex' | 'apa' | 'gbt7714'

export interface LiteratureSourceSummary {
  id: string
  kind: string
  title: string
  authors: string[]
  year?: number
  venue?: string
  doi?: string
  arxivId?: string
  url?: string
  filePath?: string
  fileHash?: string
  citationKey?: string
  bibtex?: string
  projectIds: string[]
  tags: string[]
  parseStatus: string
  parseError?: string
  parseMetadata: Record<string, unknown>
  chunkCount: number
  createdAt: number
  updatedAt: number
}

export interface LiteratureDocumentChunk {
  id: string
  sourceId: string
  chunkIndex: number
  pageNumber: number | null
  sectionLabel: string | null
  text: string
  charCount: number
  createdAt: number
}

export interface LiteratureEvidenceSummary {
  id: string
  sourceId: string
  chunkId?: string
  chunkIndex?: number
  pageNumber: number | null
  sectionLabel: string | null
  text: string
  quote?: string
  createdAt: number
}

export interface LiteraturePaperCardSummary {
  id: string
  sourceId: string
  card: {
    researchProblem: string
    methodSummary: string
    datasets: string[]
    metrics: string[]
    keyFindings: string[]
    limitations: string[]
    reusableIdeas: string[]
    analysisMeta?: {
      scope: 'partial_context' | 'full_context'
      truncated: boolean
      generatedBy: 'agent'
      verificationStatus: 'unverified' | 'user_verified'
      analyzedChunkCount: number
      totalChunkCount: number
    }
  }
  evidenceSpanIds: string[]
  createdAt: number
  updatedAt: number
}

export interface LiteratureAPI {
  ingestParsedDocument: (input: {
    filePath: string
    parseResult: Awaited<ReturnType<DocumentParserAPI['parse']>>
  }) => Promise<{ action: 'created' | 'updated'; source: LiteratureSourceSummary }>
  listSources: () => Promise<LiteratureSourceSummary[]>
  getSource: (sourceId: string) => Promise<LiteratureSourceSummary | null>
  listChunks: (sourceId: string, limit?: number) => Promise<LiteratureDocumentChunk[]>
  getPaperCard: (sourceId: string) => Promise<LiteraturePaperCardSummary | null>
  listEvidence: (sourceId: string) => Promise<LiteratureEvidenceSummary[]>
  saveEvidence: (input: {
    sourceId: string
    chunkId?: string
    chunkIndex?: number
    pageNumber?: number | null
    sectionLabel?: string | null
    text: string
    quote: string
  }) => Promise<{ action: 'created' | 'existing'; evidence: LiteratureEvidenceSummary }>
  getCitation: (sourceId: string, style: LiteratureCitationStyle) => Promise<string>
}

export interface MailboxAPI {
  send: (params: {
    sessionId: string;
    content: string;
    kind: string;
    submittedDuringRunId: string;
    attachments?: unknown[];
    clientMsgId: string;
    source?: string;
    constraintsJson?: string;
  }) => Promise<unknown>;
  edit: (id: string, patch: { content?: string; kind?: string }) => Promise<unknown>;
  guide: (id: string) => Promise<unknown>;
  promoteQueued: (id: string) => Promise<unknown>;
  cancel: (id: string, reason?: string) => Promise<unknown>;
  list: (sessionId: string, opts?: { status?: string[]; limit?: number }) => Promise<unknown[]>;
  listForSession: (sessionId: string) => Promise<unknown[]>;
  onEvent: (handler: (event: unknown) => void) => () => void;
}

export interface RecapAPI {
  request: (sessionId: string) => Promise<{ success: boolean; recap: string | null; error?: string }>
  setActiveSession: (sessionId: string) => Promise<void>
  getSettings: () => Promise<{ enabled: boolean; inactivityThreshold: number }>
  setSettings: (settings: { enabled?: boolean; inactivityThreshold?: number }) => Promise<void>
  onRecapResult: (callback: (data: { sessionId: string; recap: string; timestamp: number }) => void) => () => void
}

export interface PluginCatalogEntry {
  id: string
  name: string
  version: string
  description: string
  author: { name: string; url?: string }
  icon?: string
  source: 'bundled' | 'marketplace' | 'local'
  category: string
  capabilityCounts: {
    skills: number
    mcpServers: number
    cli: number
    ui: number
    hooks: number
  }
}

export interface PluginRegistryEntry {
  id: string
  name: string
  version: string
  description: string
  author: { name: string; url?: string }
  icon?: string
  enabled: boolean
  installPath: string
  installedAt: string
  updatedAt?: string
  source: 'bundled' | 'marketplace' | 'local'
  runtimeStatus: 'enabled' | 'disabled' | 'needs_setup' | 'failed_to_load' | 'update_available'
  permissionsGranted: string[]
  permissionDenied: string[]
  setupRequired: boolean
  setupFields: Array<{
    key: string
    label: string
    type: 'text' | 'password' | 'path' | 'url' | 'select' | 'boolean'
    required: boolean
    description?: string
    defaultValue?: string | boolean
    options?: Array<{ label: string; value: string }>
    placeholder?: string
  }>
  manifest: Record<string, unknown>
}

export interface PluginHealthIssue {
  type: string
  severity: 'error' | 'warning'
  message: string
  detail?: string
  actionable: boolean
  action?: string
}

export interface PluginHealthReport {
  pluginId: string
  healthy: boolean
  issues: PluginHealthIssue[]
  lastCheckedAt: string
}

export interface PluginAPI {
  catalog: {
    list: (filters?: {
      search?: string
      category?: string
      source?: string
      installed?: boolean
    }) => Promise<{ success: boolean; data: PluginCatalogEntry[]; error?: string }>
  }
  registry: {
    list: () => Promise<{ success: boolean; data: PluginRegistryEntry[]; error?: string }>
  }
  detail: {
    get: (pluginId: string) => Promise<{ success: boolean; data: PluginCatalogEntry | null; error?: string }>
  }
  health: {
    list: () => Promise<{ success: boolean; data: PluginHealthReport[]; error?: string }>
  }
  install: (payload: { pluginId: string; scope?: string; autoUpdate?: boolean }) => Promise<{ success: boolean; data?: PluginRegistryEntry; error?: string }>
  installLocal: (payload: { pluginPath: string; scope?: string; autoUpdate?: boolean }) => Promise<{ success: boolean; data?: PluginRegistryEntry; error?: string }>
  enable: (pluginId: string) => Promise<{ success: boolean; data?: PluginRegistryEntry; error?: string }>
  disable: (pluginId: string) => Promise<{ success: boolean; data?: PluginRegistryEntry; error?: string }>
  remove: (payload: { pluginId: string; deleteData?: boolean }) => Promise<{ success: boolean; data?: { removed: boolean }; error?: string }>
  doctor: (pluginId?: string) => Promise<{ success: boolean; data: PluginHealthReport[]; error?: string }>
  capabilityIndex: () => Promise<{ success: boolean; data: Array<{
    pluginId: string; name: string; version: string; status: string;
    capabilities: { skills: number; mcpServers: number; cli: number; ui: number; hooks: number; workflows: number };
    permissionSummary: { granted: string[]; denied: string[] };
    // Plan 311 — workflow template summaries (id/name/description/tier).
    // Prompt body is fetched on demand via `workflowGet`.
    workflows?: Array<{ id: string; name: string; description: string; permissionTier: string }>;
  }>; error?: string }>
  cacheStats: () => Promise<{ success: boolean; data?: { totalPlugins: number; totalVersions: number; totalSizeBytes: number }; error?: string }>
  cacheCleanup: (payload: { marketplace: string; pluginId: string; keepLatest?: number }) => Promise<{ success: boolean; data?: { removed: string[] }; error?: string }>
  // Plan 311 — fetch the full workflow template (including prompt body)
  // for a given plugin + workflow id. Returns null when not found.
  workflowGet: (payload: { pluginId: string; workflowId: string }) => Promise<{ success: boolean; data?: unknown; error?: string }>
}

export interface MarketplaceEntry {
  key: string
  name: string
  url: string
  description?: string
  autoUpdate: boolean
  trusted?: boolean
}

/**
 * App Connection API — Plan 312.
 *
 * Renderer-facing surface for OAuth App Connections. All methods
 * return status DTOs only; tokens NEVER cross this boundary.
 */
export interface AppConnectionAPI {
  list: () => Promise<{ success: boolean; data?: AppConnectionStatusDTO[]; error?: string }>
  providers: () => Promise<{
    success: boolean
    data?: Array<{
      id: string
      label: string
      configured: boolean
      configurationHint?: string
      monogram: string
      description: string
      scopes?: string[]
    }>
    error?: string
  }>
  status: (connectionId: string) => Promise<{
    success: boolean
    data?: AppConnectionStatusDTO
    error?: string
    errorCode?: string
  }>
  connect: (payload: { provider: string; scopes?: string[] }) => Promise<{
    success: boolean
    data?: AppConnectionStatusDTO
    error?: string
    errorCode?: string
  }>
  configureProvider: (payload: {
    provider: string
    clientId: string
    clientSecret?: string
  }) => Promise<{
    success: boolean
    data?: { id: string; label: string; configured: boolean; configurationHint?: string; monogram: string; description: string; scopes?: string[] }
    error?: string
    errorCode?: string
  }>
  disconnect: (connectionId: string) => Promise<{
    success: boolean
    data?: { disconnected: boolean }
    error?: string
  }>
}

export interface MarketplaceAPI {
  list: () => Promise<{ success: boolean; data: MarketplaceEntry[]; error?: string }>
  add: (payload: { key: string; entry: { name: string; url: string; description?: string; autoUpdate: boolean; trusted?: boolean } }) =>
    Promise<{ success: boolean; data?: MarketplaceEntry; error?: string }>
  update: (payload: { key: string; entry: { name?: string; url?: string; description?: string; autoUpdate?: boolean; trusted?: boolean } }) =>
    Promise<{ success: boolean; data?: MarketplaceEntry; error?: string }>
  remove: (payload: { key: string }) => Promise<{ success: boolean; data?: { removed: boolean }; error?: string }>
  reset: () => Promise<{ success: boolean; data: MarketplaceEntry[]; error?: string }>
  checkName: (name: string) => Promise<{ success: boolean; data?: { name: string; blocked: boolean }; error?: string }>
}

export interface TerminalAPI {
  [key: string]: unknown
  spawn: (params: {
    id?: string
    shell?: string
    cwd?: string
    cols?: number
    rows?: number
    title?: string
  }) => Promise<{ ok: boolean; [key: string]: unknown }>
  list: () => Promise<{ ok: boolean; [key: string]: unknown }>
  snapshot: (id: string) => Promise<{ ok: boolean; [key: string]: unknown }>
  write: (id: string, data: string) => Promise<{ ok: boolean; [key: string]: unknown }>
  resize: (id: string, cols: number, rows: number) => Promise<{ ok: boolean; [key: string]: unknown }>
  kill: (id: string) => Promise<{ ok: boolean; [key: string]: unknown }>
  suggest: (
    prefix: string,
    shell?: string,
    cwd?: string,
    limit?: number
  ) => Promise<{ ok: boolean; [key: string]: unknown }>
  record: (
    command: string,
    shell: string,
    cwd: string,
    source?: string
  ) => Promise<{ ok: boolean; [key: string]: unknown }>
}

export interface ElectronAPI {
  versions: {
    electron: string
    node: string
    chrome: string
    platform: string
  }
  dialog: {
    openFolder: (options?: { defaultPath?: string; title?: string }) =>
      Promise<{ canceled: boolean; filePaths: string[] }>
    openOfficeFiles: (options?: { defaultPath?: string; title?: string }) =>
      Promise<{ canceled: boolean; filePaths: string[] }>
    selectDownloadFolder: (options?: { defaultPath?: string; title?: string }) =>
      Promise<{ canceled: boolean; filePaths: string[] }>
  }
  shell: {
    openPath: (folderPath: string) => Promise<string>
    showItemInFolder: (filePath: string) => Promise<string>
    openExternal: (url: string) => Promise<string>
  }
  notification: {
    show: (options: {
      title: string
      body: string
      sessionId?: string
      type?: 'message' | 'permission'
      actions?: { id: string; label: string }[]
      replyPlaceholder?: string
      permissionId?: string
      toolName?: string
    }) => Promise<boolean>
  }
  onNotificationClicked: (callback: (data: { sessionId?: string }) => void) => () => void
  onNotificationAction: (callback: (data: {
    sessionId?: string
    type: 'message' | 'permission'
    permissionId?: string
    toolName?: string
    actionId: string
    reply?: string
  }) => void) => () => void
  onBackgroundTaskReady: (callback: (data: { sessionId: string }) => void) => () => void
  onBashTaskUpdate: (callback: (data: { sessionId: string; tasks: BashBackgroundTaskSnapshot[] }) => void) => () => void
  app: {
    getVersion: () => Promise<string>
    quit: () => Promise<void>
    getDefaultWorkspace: () => Promise<string>
    createProjectFolder: (projectName: string) => Promise<{ success: boolean; error: string; path: string }>
  }
  system: {
    getLocation: () => Promise<{
      locale: string
      localeCountryCode: string | null
      timezone: string
    }>
  }
  agent: AgentAPI
  projects: {
    getRecentFolders: () => Promise<string[]>
    addRecentFolder: (path: string) => Promise<string[]>
  }
  sync: SyncAPI
  settings: {
    setAutoStart: (enabled: boolean) => Promise<{ success: boolean; supported: boolean; error?: string }>
    getAutoStartStatus: () => Promise<{ enabled: boolean; canChange: boolean; supported: boolean; platform: string; error?: string }>
    getMcpServers: () => Promise<{ success: boolean; data: Array<{ name: string; command: string; args?: string[]; env?: Record<string, string>; enabled?: boolean }>; error?: string }>
    setMcpServers: (servers: Array<{ name: string; command: string; args?: string[]; env?: Record<string, string>; enabled?: boolean }>) => Promise<{ success: boolean; error?: string }>
  }
  mcpInventory: {
    snapshot: () => Promise<{ success: boolean; data?: MCPInventorySnapshotDTO; error?: string }>
    tools: (serverId: string) => Promise<{ success: boolean; data?: Array<{ name: string; description?: string }>; error?: string }>
  }
  // Functions to get port APIs (called dynamically, not getters)
  getConfigPort: () => ConfigPortAPI | null
  getConductorPort: () => ConductorPortAPI | null
  // Agent Server port for SSE client (Phase 7.1 - plan 53)
  getAgentServerPort: () => Promise<number | null>
  // Port status API for checking if ports are ready
  portStatus: PortStatusAPI
  // Session port API for per-session MessagePort communication
  getSessionPort: (sessionId: string) => SessionPortAPI | null
  closeAllSessionPorts: () => void
  // Database IPC APIs
  conductor: {
    listCanvases: () => Promise<unknown[]>
    getCanvasByProjectPath: (projectPath: string) => Promise<unknown>
    createCanvas: (data: { name: string; description?: string; projectPath?: string | null }) => Promise<unknown>
    updateCanvas: (
      id: string,
      data: { name?: string; description?: string | null; layoutConfig?: Record<string, unknown>; sortOrder?: number }
    ) => Promise<unknown>
    deleteCanvas: (id: string) => Promise<boolean>
    snapshot: (canvasId: string) => Promise<unknown>
    action: (request: Record<string, unknown>) => Promise<unknown>
    undo: (canvasId: string) => Promise<unknown>
    redo: (canvasId: string) => Promise<unknown>
    uploadAsset: (payload: { canvasId: string; buffer: ArrayBuffer; fileName: string; mimeType?: string }) => Promise<unknown>
    captureLinkSnapshot: (payload: {
      canvasId: string
      elementId: string
      url: string
      mode: 'desktop-head' | 'desktop-full' | 'mobile-head' | 'mobile-full'
    }) => Promise<unknown>
  }
  projectDatabase: ProjectDatabaseAPI
  thread: ThreadAPI
  session: SessionAPI
  message: MessageAPI
  settingsDb: SettingsAPI
  migration: MigrationAPI
  provider: ProviderAPI
  outputStyle: OutputStyleAPI
  permission: PermissionAPI
  project: ProjectAPI
  lock: LockAPI
  net: NetAPI
  gateway: GatewayAPI
  automation: AutomationAPI
  safeMode: SafeModeAPI
  skills: SkillsAPI
  files: FilesAPI
  references: ReferencesAPI
  git: GitAPI
  weixin: WeixinAccountAPI
  browserExtension: BrowserExtensionAPI
  browserWebview: BrowserWebviewAPI
  browserCookie: BrowserCookieAPI
  browserBackend: BrowserBackendAPI
  parser: DocumentParserAPI
  literature: LiteratureAPI
  agentProfile: AgentProfileAPI
  plugin: PluginAPI
  appConnection: AppConnectionAPI
  marketplace: MarketplaceAPI
  terminal: TerminalAPI
  onTerminalOutput: (callback: (event: { id: string; data: string }) => void) => () => void
  onTerminalExit: (callback: (event: { id: string; code: number | null }) => void) => () => void
  recap: RecapAPI
  mailbox: MailboxAPI
  // Agent Server API
  agentServer: {
    getPort: () => Promise<number | null>
    getUrl: () => Promise<string | null>
  }
  // Vision API
  vision: VisionAPI
  // Memory API
  memory: MemoryAPI
  // Session management
  getInterruptedSessions: () => Promise<string[]>
  // Logger API
  logger: {
    export: () => Promise<{ success: boolean; logs?: string; error?: string }>
    exportToFile: (targetPath: string) => Promise<{ success: boolean; error?: string }>
    getPath: () => Promise<{ logPath: string; logDir: string; size: number; sizeFormatted: string }>
    clear: () => Promise<{ success: boolean; error?: string }>
  }
  // Updater API
  updater: {
    check: () => Promise<{ success: boolean; updateAvailable?: boolean; error?: string }>
    download: () => Promise<{ success: boolean; error?: string }>
    install: () => Promise<{ success: boolean }>
    getState: () => Promise<{
      isChecking: boolean
      isDownloading: boolean
      updateInfo: unknown
      downloadProgress: unknown
      error: string | null
    }>
    onChecking: (callback: () => void) => () => void
    onAvailable: (callback: (e: unknown, info: unknown) => void) => () => void
    onNotAvailable: (callback: (e: unknown, info: unknown) => void) => () => void
    onDownloading: (callback: (data: { version: string }) => void) => () => void
    onProgress: (callback: (data: { percent: number; transferred: number; total: number }) => void) => () => void
    onReady: (callback: (data: { version: string; releaseNotes?: string }) => void) => () => void
    onDownloaded: (callback: (e: unknown, info: unknown) => void) => () => void
    onError: (callback: (e: unknown, msg: string) => void) => () => void
  }
  capabilityManagement: {
    snapshot: () => Promise<
      | { success: true; data: unknown }
      | { success: false; error: string }
    >
  }
  sse?: {
    onAgentServerEvent?: (callback: (event: unknown) => void) => () => void;
  }
  import: ImportAPI
}

interface ImportAPI {
  detect: () => Promise<{ claude: boolean; codex: boolean }>
  scan: (params: { source: string; projectPath?: string }) => Promise<unknown>
  apply: (params: unknown) => Promise<unknown>
  rollback: (params: { batchId: string }) => Promise<void>
  history: () => Promise<unknown[]>
}

// Callback registry for sync events
const syncCallbacks = new Set<() => void>()

// Config port handlers
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let configPort: any = null
let configPortHandlers: {
  onConfigUpdate?: (config: unknown) => void
  onConfigResponse?: (data: { key: string; value: unknown }) => void
} = {}

// Conductor port handlers
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let conductorPort: any = null
const conductorPortHandlers: Map<string, Set<(data: unknown) => void>> = new Map()

// Port handlers shared by session-port communication
const agentPortHandlers: Map<string, Set<(data: unknown) => void>> = new Map()

// Config port readiness flag (config-port is the only remaining MessagePort listener)
let isConfigPortReadyFlag = false

// Session port tracking (per-session MessagePorts)
interface SessionPortInfo {
  port: MessagePort
  sessionId: string
}
const sessionPorts = new Map<string, SessionPortInfo>()
const DEBUG_IPC = process.env.DUYA_DEBUG_IPC === 'true'

function debugLog(...args: unknown[]): void {
  if (DEBUG_IPC) {
    console.log('[preload][DEBUG]', ...args)
  }
}

// Helper to register agent port handlers
function registerAgentPortHandler(type: string, handler: (data: unknown) => void): () => void {
  let handlers = agentPortHandlers.get(type)
  if (!handlers) {
    handlers = new Set()
    agentPortHandlers.set(type, handlers)
  }
  handlers.add(handler)
  return () => {
    handlers?.delete(handler)
  }
}

// Handle session port messages (per-session MessagePort communication)
function handleSessionPortMessage(sessionId: string, data: Record<string, unknown>): void {
  const { type, ...payload } = data
  const handlers = agentPortHandlers.get(type as string)
  if (handlers) {
    handlers.forEach(handler => {
      try {
        handler(payload)
      } catch (error) {
              }
    })
  }
}

// Listen for session-port events from main process (per-session MessagePort)
ipcRenderer.on('session-port', (event, sessionId: string) => {
  const [port] = event.ports
  if (port) {
    sessionPorts.set(sessionId, { port, sessionId })
    port.onmessage = (e) => {
      handleSessionPortMessage(sessionId, e.data)
    }
    port.start()
  }
})

// Listen for config port from main process
ipcRenderer.on('config-port', (event) => {
  const [port] = event.ports
  if (port) {
    configPort = port
    isConfigPortReadyFlag = true
    port.onmessage = (e) => {
      const { type, ...data } = e.data
      if (type === 'config:update' && configPortHandlers.onConfigUpdate) {
        configPortHandlers.onConfigUpdate(data.config)
      } else if (type === 'config:response' && configPortHandlers.onConfigResponse) {
        configPortHandlers.onConfigResponse(data as { key: string; value: unknown })
      }
    }
    port.start()
  }
})

// Listen for conductor port from main process
ipcRenderer.on('conductor-port', (event) => {
  console.log('[preload] conductor-port received, ports count:', event.ports?.length, 'time:', Date.now());
  const [port] = event.ports
  if (port) {
    conductorPort = port
    conductorPortReady = true;
    console.log('[preload] conductorPort assigned, time:', Date.now());
    port.onmessage = (e) => {
      console.log('[preload] conductorPort.onmessage:', e.data?.type, 'time:', Date.now());
      const { type, ...payload } = e.data
      const handlers = conductorPortHandlers.get(type as string)
      if (handlers) {
        handlers.forEach(handler => {
          try {
            handler(payload)
          } catch (err) {
            console.error('[preload] conductorPort handler error:', err);
          }
        })
      }
    }
    port.onmessageerror = (e) => {
      console.error('[preload] conductorPort messageerror:', e, '— port may be detached or closed');
    }
    try {
      console.log('[preload] calling port.start()...');
      port.start()
      console.log('[preload] port.start() succeeded');
    } catch (err) {
      console.error('[preload] port.start() FAILED:', err);
    }
    // Dispatch event to notify renderer that conductorPort is ready
    console.log('[preload] dispatching conductor-port-ready event, time:', Date.now());
    window.dispatchEvent(new CustomEvent('conductor-port-ready'));
  } else {
    console.error('[preload] ERROR: conductor-port received but no ports in event!');
  }
})

// Listen for sync events from main process
ipcRenderer.on('sync:threads-changed', () => {
  syncCallbacks.forEach(callback => {
    try {
      callback()
    } catch {
      // ignore callback errors
    }
  })
})

// Listen for daemon disconnected events
ipcRenderer.on('daemon:disconnected', (_event, data: { code: number; source: string }) => {
    window.dispatchEvent(new CustomEvent('daemon-disconnected', { detail: data }))
})

// Helper functions for configPort API
function getConfigPortAPI(): ConfigPortAPI | null {
  if (!configPort) return null;
  return {
    getConfig: (key: string) => {
      configPort?.postMessage({ type: 'config:get', key })
    },
    setConfig: (key: string, value: unknown) => {
      configPort?.postMessage({ type: 'config:set', key, value })
    },
    subscribe: () => {
      configPort?.postMessage({ type: 'config:subscribe' })
    },
    onConfigUpdate: (callback: (config: unknown) => void) => {
      configPortHandlers.onConfigUpdate = callback
      return () => {
        configPortHandlers.onConfigUpdate = undefined
      }
    },
    onConfigResponse: (callback: (data: { key: string; value: unknown }) => void) => {
      configPortHandlers.onConfigResponse = callback
      return () => {
        configPortHandlers.onConfigResponse = undefined
      }
    },
  };
}

// Helper functions for conductorPort API
let conductorPortReady = false;
function getConductorPortAPI(): ConductorPortAPI | null {
  if (!conductorPort) {
    // Only warn on the first poll: the renderer often calls this
    // before the main process has finished wiring up the MessagePort
    // (postMessage from did-finish-load is async). Logging on every
    // call floods the console and buries real signal.
    if (!conductorPortReady) {
      conductorPortReady = true;
      console.warn('[preload] getConductorPortAPI: conductorPort is null (waiting for main to send the port)');
    }
    return null;
  }
  conductorPortReady = true;

  const registerHandler = (type: string, handler: (data: unknown) => void): () => void => {
    let handlers = conductorPortHandlers.get(type);
    if (!handlers) {
      handlers = new Set();
      conductorPortHandlers.set(type, handlers);
    }
    const wrapped = (payload: unknown) => {
      handler(payload);
    };
    handlers.add(wrapped);
    return () => {
      handlers?.delete(wrapped);
    };
  };

  return {
    onStatePatch: (callback: (data: Record<string, unknown>) => void) => {
      return registerHandler('conductor:state:patch', (data) => callback(data as Record<string, unknown>));
    },
    onCanvasChanged: (callback) => {
      return registerHandler('conductor:canvas:changed', (data) => callback(data as {
        operation: 'create' | 'switch' | 'rename';
        sessionId?: string;
        canvas: Record<string, unknown>;
        currentCanvasId?: string;
      }));
    },
    onCaptureRequest: (callback: (data: { requestId: string; canvasId: string; scope: string; elementId?: string; region?: { x: number; y: number; w: number; h: number } }) => void) => {
      return registerHandler('conductor:capture:request', (data) => callback(data as { requestId: string; canvasId: string; scope: string; elementId?: string; region?: { x: number; y: number; w: number; h: number } }));
    },
    sendCaptureResponse: (data: { requestId: string; result?: unknown; error?: string }) => {
      ipcRenderer.invoke('conductor:capture:response', data);
    },
  };
}

const electronAPI: ElectronAPI = {
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    platform: process.platform,
  },
  dialog: {
    openFolder: (options) => ipcRenderer.invoke('dialog:open-folder', options),
    openOfficeFiles: (options) => ipcRenderer.invoke('dialog:open-office-files', options),
    selectDownloadFolder: (options) => ipcRenderer.invoke('dialog:select-download-folder', options),
  },
  shell: {
    openPath: (folderPath) => ipcRenderer.invoke('shell:open-path', folderPath),
    showItemInFolder: (filePath) => ipcRenderer.invoke('shell:show-item-in-folder', filePath),
    openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  },
  notification: {
    show: (options) => ipcRenderer.invoke('notification:show', options),
  },
  onNotificationClicked: (callback: (data: { sessionId?: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { sessionId?: string }) => callback(data);
    ipcRenderer.on('notification:clicked', handler);
    return () => {
      ipcRenderer.removeListener('notification:clicked', handler);
    };
  },
  onNotificationAction: (callback: (data: {
    sessionId?: string
    type: 'message' | 'permission'
    permissionId?: string
    toolName?: string
    actionId: string
    reply?: string
  }) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: {
        sessionId?: string
        type: 'message' | 'permission'
        permissionId?: string
        toolName?: string
        actionId: string
        reply?: string
      },
    ) => callback(data);
    ipcRenderer.on('notification:action', handler);
    return () => {
      ipcRenderer.removeListener('notification:action', handler);
    };
  },
  onBackgroundTaskReady: (callback: (data: { sessionId: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { sessionId: string }) => callback(data);
    ipcRenderer.on('chat:background_task_ready', handler);
    return () => {
      ipcRenderer.removeListener('chat:background_task_ready', handler);
    };
  },
  onBashTaskUpdate: (
    callback: (data: { sessionId: string; tasks: BashBackgroundTaskSnapshot[] }) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { sessionId: string; tasks: BashBackgroundTaskSnapshot[] },
    ) => callback(data);
    ipcRenderer.on('bash_task:update', handler);
    return () => {
      ipcRenderer.removeListener('bash_task:update', handler);
    };
  },
  app: {
    getVersion: () => ipcRenderer.invoke('app:get-version'),
    quit: () => ipcRenderer.invoke('app:quit'),
    getDefaultWorkspace: () => ipcRenderer.invoke('app:get-default-workspace'),
    createProjectFolder: (projectName: string) => ipcRenderer.invoke('app:create-project-folder', projectName),
  },
  system: {
    getLocation: () => ipcRenderer.invoke('system:get-location'),
  },
  agent: {
    streamChat: (prompt, options) => ipcRenderer.invoke('agent:stream', { prompt, options }),
    interrupt: () => ipcRenderer.invoke('agent:interrupt'),
    reinitProvider: () => ipcRenderer.invoke('agent:reinit-provider'),
  },
  projects: {
    getRecentFolders: () => ipcRenderer.invoke('projects:get-recent-folders'),
    addRecentFolder: (folderPath) => ipcRenderer.invoke('projects:add-recent-folder', folderPath),
  },
  sync: {
    notifyThreadsChanged: () => {
      ipcRenderer.send('sync:threads-changed')
    },
    onThreadsChanged: (callback: () => void) => {
      syncCallbacks.add(callback)
      return () => {
        syncCallbacks.delete(callback)
      }
    },
  },
  settings: {
    setAutoStart: (enabled) => ipcRenderer.invoke('settings:set-auto-start', enabled),
    getAutoStartStatus: () => ipcRenderer.invoke('settings:get-auto-start-status'),
    getMcpServers: async () => {
      try {
        const data = await ipcRenderer.invoke('db:setting:getJson', 'mcpServers', []);
        return {
          success: true,
          data: Array.isArray(data) ? data : [],
        };
      } catch (error) {
        return {
          success: false,
          data: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    setMcpServers: async (servers) => {
      try {
        await ipcRenderer.invoke('db:setting:setJson', 'mcpServers', servers);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  },
  mcpInventory: {
    snapshot: () => ipcRenderer.invoke('mcp:inventory:snapshot'),
    tools: (serverId: string) => ipcRenderer.invoke('mcp:inventory:tools', { serverId }),
  },
  // Functions to get port APIs (called dynamically)
  getConfigPort: getConfigPortAPI,
  getConductorPort: getConductorPortAPI,
  // Agent Server port for SSE client (Phase 7.1 - plan 53)
  getAgentServerPort: () => ipcRenderer.invoke('agent-server:get-port'),
  // Session port API for per-session MessagePort communication
  getSessionPort: (sessionId: string) => {
    const info = sessionPorts.get(sessionId)
    if (!info) return null
    return {
      send: (type: string, payload?: unknown) => {
        info.port.postMessage({ type, sessionId, payload })
      },
      onMessage: (handler: (data: unknown) => void) => {
        const onMsg = (e: MessageEvent) => handler(e.data)
        info.port.onmessage = onMsg
        return () => {
          info.port.onmessage = null
        }
      },
      close: () => {
        info.port.close()
        sessionPorts.delete(sessionId)
      },
    }
  },
  // Close all session ports
  closeAllSessionPorts: () => {
    for (const [sessionId, info] of sessionPorts) {
      info.port.close()
    }
    sessionPorts.clear()
  },
  // Database IPC APIs
  conductor: {
    listCanvases: () => ipcRenderer.invoke('conductor:canvas:list'),
    getCanvasByProjectPath: (projectPath: string) => ipcRenderer.invoke('conductor:canvas:getByProjectPath', projectPath),
    createCanvas: (data: { name: string; description?: string; projectPath?: string | null }) => ipcRenderer.invoke('conductor:canvas:create', data),
    updateCanvas: (
      id: string,
      data: { name?: string; description?: string | null; layoutConfig?: Record<string, unknown>; sortOrder?: number }
    ) => ipcRenderer.invoke('conductor:canvas:update', id, data),
    deleteCanvas: (id: string) => ipcRenderer.invoke('conductor:canvas:delete', id),
    snapshot: (canvasId: string) => ipcRenderer.invoke('conductor:snapshot', canvasId),
    action: (request: Record<string, unknown>) => ipcRenderer.invoke('conductor:action', request),
    undo: (canvasId: string) => ipcRenderer.invoke('conductor:undo', canvasId),
    redo: (canvasId: string) => ipcRenderer.invoke('conductor:redo', canvasId),
    uploadAsset: (payload: { canvasId: string; buffer: ArrayBuffer; fileName: string; mimeType?: string }) =>
      ipcRenderer.invoke('conductor:asset:upload', payload),
    captureLinkSnapshot: (payload: {
      canvasId: string;
      elementId: string;
      url: string;
      mode: 'desktop-head' | 'desktop-full' | 'mobile-head' | 'mobile-full';
    }) => ipcRenderer.invoke('conductor:link:captureSnapshot', payload),
  },
  projectDatabase: {
    invoke: (request: ProjectDatabaseRequest) => ipcRenderer.invoke('project-database:invoke', request),
    onChanged: (callback: (event: ProjectDatabaseChangeEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: ProjectDatabaseChangeEvent) => callback(data)
      ipcRenderer.on('project-database:changed', handler)
      return () => ipcRenderer.removeListener('project-database:changed', handler)
    },
  },
  thread: {
    list: () => ipcRenderer.invoke('db:session:list'),
    get: (id: string) => ipcRenderer.invoke('db:session:get', id),
    create: (data: Record<string, unknown>) => ipcRenderer.invoke('db:session:create', data),
    update: (id: string, data: Record<string, unknown>) => ipcRenderer.invoke('db:session:update', id, data),
    delete: (id: string) => ipcRenderer.invoke('db:session:delete', id),
    listByParentId: (parentId: string) => ipcRenderer.invoke('db:session:listByParentId', parentId),
    getTasks: (sessionId: string) => ipcRenderer.invoke('db:task:getBySession', sessionId),
    createTask: (data: Record<string, unknown>) => ipcRenderer.invoke('db:task:create', data),
    updateTask: (id: string, data: Record<string, unknown>) => ipcRenderer.invoke('db:task:update', id, data),
    deleteTask: (id: string) => ipcRenderer.invoke('db:task:delete', id),
  },
  session: {
    saveDraft: (sessionId: string, draft: string) => ipcRenderer.invoke('db:session:saveDraft', sessionId, draft),
    getDraft: (sessionId: string) => ipcRenderer.invoke('db:session:getDraft', sessionId),
    setConductorMode: (sessionId: string, enabled: boolean, canvasId?: string | null) =>
      ipcRenderer.invoke('db:session:set_conductor_mode', { sessionId, enabled, canvasId }),
  },
  message: {
    add: (data: Record<string, unknown>) => ipcRenderer.invoke('db:message:add', data),
    getBySession: (sessionId: string) => ipcRenderer.invoke('db:message:getBySession', sessionId),
    replace: (sessionId: string, messages: unknown[], generation: number) =>
      ipcRenderer.invoke('db:message:replace', sessionId, messages, generation),
    truncateAfter: (sessionId: string, messageId: string) =>
      ipcRenderer.invoke('db:message:truncateAfter', sessionId, messageId),
    truncateFromInclusive: (sessionId: string, messageId: string) =>
      ipcRenderer.invoke('db:message:truncateFromInclusive', sessionId, messageId),
  },
  settingsDb: {
    get: (key: string) => ipcRenderer.invoke('db:setting:get', key),
    set: (key: string, value: string) => ipcRenderer.invoke('db:setting:set', key, value),
    getAll: () => ipcRenderer.invoke('db:setting:getAll'),
    getJson: <T>(key: string, defaultValue: T) => ipcRenderer.invoke('db:setting:getJson', key, defaultValue),
    setJson: <T>(key: string, value: T) => ipcRenderer.invoke('db:setting:setJson', key, value),
  },
  migration: {
    checkNeeded: (newDbPath: string) => ipcRenderer.invoke('db:migration:checkNeeded', newDbPath),
    migrate: (sourcePath: string, targetPath: string) => ipcRenderer.invoke('db:migration:migrate', sourcePath, targetPath),
    getDefaultPath: () => ipcRenderer.invoke('db:migration:getDefaultPath'),
    databaseExists: (dbPath: string) => ipcRenderer.invoke('db:migration:databaseExists', dbPath),
    getDatabaseSize: (dbPath: string) => ipcRenderer.invoke('db:migration:getDatabaseSize', dbPath),
    updateBootAndRestart: (newDbPath: string) => ipcRenderer.invoke('db:migration:updateBootAndRestart', newDbPath),
  },
  provider: {
    list: () => ipcRenderer.invoke('config:provider:getAll'),
    get: (id: string) => ipcRenderer.invoke('config:provider:get', id),
    getActive: () => ipcRenderer.invoke('config:provider:getActive'),
    upsert: (data: Record<string, unknown>) => ipcRenderer.invoke('config:provider:upsert', data),
    update: (id: string, data: Record<string, unknown>) => ipcRenderer.invoke('config:provider:update', id, data),
    delete: (id: string) => ipcRenderer.invoke('config:provider:delete', id),
    activate: (id: string) => ipcRenderer.invoke('config:provider:activate', id),
    // Get full provider config with unmasked API key for agent initialization
    getActiveProviderConfig: () => ipcRenderer.invoke('config:provider:getActiveProviderConfig'),
    // Get unmasked provider config by ID for title generation model resolution
    getConfig: (providerId: string, model: string) => ipcRenderer.invoke('config:provider:getConfig', providerId, model),
    // Phase 2: LlmProvider-aware channels (masked).
    listLlm: () => ipcRenderer.invoke('provider:listLlm'),
    getLlm: (id: string) => ipcRenderer.invoke('provider:getLlm', id),
    upsertLlm: (data: Record<string, unknown>) => ipcRenderer.invoke('provider:upsertLlm', data),
    deleteLlm: (id: string) => ipcRenderer.invoke('provider:deleteLlm', id),
    setDefaultLlm: (payload: { id: string | null }) =>
      ipcRenderer.invoke('provider:setDefaultLlm', payload),
    getDefault: () => ipcRenderer.invoke('provider:getDefault'),
    setMemory: (payload: { id: string | null }) =>
      ipcRenderer.invoke('provider:setMemory', payload),
    getMemory: () => ipcRenderer.invoke('provider:getMemory'),
    test: (payload: { providerId: string; presetKey?: string }) =>
      ipcRenderer.invoke('provider:test', payload),
    testModel: (payload: { providerId: string; modelId: string }) =>
      ipcRenderer.invoke('provider:testModel', payload),
    syncModels: (payload: { providerId: string; presetKey?: string }) =>
      ipcRenderer.invoke('provider:syncModels', payload),
    upsertModelCapability: (capability: Record<string, unknown>) =>
      ipcRenderer.invoke('provider:upsertModelCapability', capability),
    listModelCapabilities: (payload: { providerId: string }) =>
      ipcRenderer.invoke('provider:listModelCapabilities', payload),
    getModelCapability: (payload: { providerId: string; modelId: string }) =>
      ipcRenderer.invoke('provider:getModelCapability', payload),
    deleteModelCapability: (payload: { providerId: string; modelId: string }) =>
      ipcRenderer.invoke('provider:deleteModelCapability', payload),
  },
  outputStyle: {
    list: () => ipcRenderer.invoke('config:style:getAll'),
    get: (id: string) => ipcRenderer.invoke('config:style:get', id),
    upsert: (data: Record<string, unknown>) => ipcRenderer.invoke('config:style:upsert', data),
    delete: (id: string) => ipcRenderer.invoke('config:style:delete', id),
  },
  vision: {
    get: () => ipcRenderer.invoke('config:vision:get'),
    set: (config: { provider?: string; model?: string; baseUrl?: string; apiKey?: string; enabled?: boolean }) =>
      ipcRenderer.invoke('config:vision:set', config),
  },
  memory: {
    list: () => ipcRenderer.invoke('memory:list'),
  },
  permission: {
    create: (data: Record<string, unknown>) => ipcRenderer.invoke('db:permission:create', data),
    get: (id: string) => ipcRenderer.invoke('db:permission:get', id),
    resolve: (id: string, status: string, extra?: Record<string, unknown>) =>
      ipcRenderer.invoke('db:permission:resolve', id, status, extra),
  },
  project: {
    getGroups: () => ipcRenderer.invoke('db:project:getGroups'),
  },
  lock: {
    acquire: (sessionId: string, lockId: string, owner: string, ttlSec?: number) =>
      ipcRenderer.invoke('db:lock:acquire', sessionId, lockId, owner, ttlSec),
    release: (sessionId: string, lockId: string) => ipcRenderer.invoke('db:lock:release', sessionId, lockId),
    isLocked: (sessionId: string) => ipcRenderer.invoke('db:lock:isLocked', sessionId),
  },
  net: {
    testProvider: (body) => ipcRenderer.invoke('net:provider:test', body),
    getProviderUsage: (body) => ipcRenderer.invoke('net:provider:usage', body),
    getOllamaModels: (baseUrl: string) => ipcRenderer.invoke('net:ollama:models', baseUrl),
    getProviderModels: (body) => ipcRenderer.invoke('net:provider:models', body),
    testBridgeChannel: (channel) => ipcRenderer.invoke('net:bridge:test', channel),
    weixinQrStart: () => ipcRenderer.invoke('net:weixin:qr:start'),
    weixinQrPoll: (sessionId: string) => ipcRenderer.invoke('net:weixin:qr:poll', sessionId),
    weixinQrCancel: (sessionId: string) => ipcRenderer.invoke('net:weixin:qr:cancel', sessionId),
  },
  gateway: {
    start: () => ipcRenderer.invoke('gateway:start'),
    stop: () => ipcRenderer.invoke('gateway:stop'),
    reload: () => ipcRenderer.invoke('gateway:reload'),
    getStatus: () => ipcRenderer.invoke('gateway:getStatus'),
    testChannel: (channel) => ipcRenderer.invoke('gateway:testChannel', channel),
    getProxyStatus: () => ipcRenderer.invoke('gateway:getProxyStatus'),
    listSessions: () => ipcRenderer.invoke('gateway:listSessions'),
    getSession: (sessionId: string) => ipcRenderer.invoke('gateway:getSession', sessionId),
    pairingList: async () => {
      return await ipcRenderer.invoke('gateway:pairing:list');
    },
    pairingApprove: (platform: string, code: string) => ipcRenderer.invoke('gateway:pairing:approve', platform, code),
    pairingRevoke: (platform: string, platformUserId: string) => ipcRenderer.invoke('gateway:pairing:revoke', platform, platformUserId),
    feishuQrBegin: () => ipcRenderer.invoke('gateway:feishu:qr:begin'),
    feishuQrPoll: (begin: { device_code: string; interval: number; expire_in: number }) =>
      ipcRenderer.invoke('gateway:feishu:qr:poll', begin),
  },
  automation: {
    listCrons: () => ipcRenderer.invoke('automation:cron:list'),
    createCron: (data: Record<string, unknown>) => ipcRenderer.invoke('automation:cron:create', data),
    updateCron: (id: string, patch: Record<string, unknown>) => ipcRenderer.invoke('automation:cron:update', id, patch),
    deleteCron: (id: string) => ipcRenderer.invoke('automation:cron:delete', id),
    runCron: (id: string) => ipcRenderer.invoke('automation:cron:run', id),
    listCronRuns: (input: { cronId: string; limit?: number; offset?: number }) =>
      ipcRenderer.invoke('automation:cron:runs', input),
    listTemplates: () => ipcRenderer.invoke('automation:template:list'),
  },
  safeMode: {
    getStatus: () => ipcRenderer.invoke('db:safeModeStatus'),
    relocateDatabase: (newDir: string) => ipcRenderer.invoke('db:relocateDatabase', newDir),
    resetToDefaultPath: () => ipcRenderer.invoke('db:resetToDefaultPath'),
    getStats: () => ipcRenderer.invoke('db:stats'),
  },
  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
    getEnabledOverrides: () => ipcRenderer.invoke('skills:getEnabledOverrides'),
    setEnabled: (skillName: string, enabled: boolean) => ipcRenderer.invoke('skills:setEnabled', skillName, enabled),
    getSecurityBypass: () => ipcRenderer.invoke('skills:getSecurityBypass'),
    setSecurityBypass: (skillName: string, bypass: boolean) => ipcRenderer.invoke('skills:setSecurityBypass', skillName, bypass),
    uploadSkill: (filePath: string) => ipcRenderer.invoke('skills:uploadSkill', filePath),
  },
  files: {
    browse: (dirPath: string, maxDepth?: number) => ipcRenderer.invoke('files:browse', dirPath, maxDepth),
    preview: (targetPath: string, rootPath: string) => ipcRenderer.invoke('files:preview', targetPath, rootPath),
    delete: (targetPath: string) => ipcRenderer.invoke('files:delete', targetPath),
    rename: (targetPath: string, newName: string) => ipcRenderer.invoke('files:rename', targetPath, newName),
  },
  git: {
    status: (cwd: string) => ipcRenderer.invoke('git:status', cwd),
    review: (cwd: string) => ipcRenderer.invoke('git:review', cwd),
    reviewDiff: (cwd: string, filePath: string) => ipcRenderer.invoke('git:review-diff', cwd, filePath),
    reviewFullDiff: (cwd: string) => ipcRenderer.invoke('git:review-full-diff', cwd),
    reviewLatestTurn: (sessionId: string, cwd: string) => ipcRenderer.invoke('git:review-latest-turn', sessionId, cwd),
  },
  references: {
    list: (workingDirectory: string) => ipcRenderer.invoke('references:list', workingDirectory),
    pickFiles: (options?: { title?: string; defaultPath?: string }) =>
      ipcRenderer.invoke('references:pick-files', options),
    add: (workingDirectory: string, filePaths: string[]) =>
      ipcRenderer.invoke('references:add', workingDirectory, filePaths),
    delete: (workingDirectory: string, relativePath: string) =>
      ipcRenderer.invoke('references:delete', workingDirectory, relativePath),
    open: (workingDirectory: string, relativePath: string) =>
      ipcRenderer.invoke('references:open', workingDirectory, relativePath),
  },
  weixin: {
    getAccounts: () => ipcRenderer.invoke('db:weixin:getAccounts'),
    upsertAccount: (data: Record<string, unknown>) => ipcRenderer.invoke('db:weixin:upsertAccount', data),
    updateAccount: (accountId: string, data: Record<string, unknown>) => ipcRenderer.invoke('db:weixin:updateAccount', accountId, data),
    deleteAccount: (accountId: string) => ipcRenderer.invoke('db:weixin:deleteAccount', accountId),
    getContextToken: (accountId: string, peerUserId: string) => ipcRenderer.invoke('db:weixin:getContextToken', accountId, peerUserId),
    setContextToken: (accountId: string, peerUserId: string, contextToken: string) => ipcRenderer.invoke('db:weixin:setContextToken', accountId, peerUserId, contextToken),
  },
  browserExtension: {
    getStatus: () => ipcRenderer.invoke('browser-extension:get-status'),
    getExtensionPath: () => ipcRenderer.invoke('browser-extension:get-path'),
    approvePending: () => ipcRenderer.invoke('browser-extension:approve-pending'),
    denyPending: () => ipcRenderer.invoke('browser-extension:deny-pending'),
  },
  browserWebview: {
    registerWebview: (sessionId: string, webContentsId: number) =>
      ipcRenderer.invoke('browser:register-webview', { sessionId, webContentsId }),
    unregisterWebview: (sessionId: string) =>
      ipcRenderer.invoke('browser:unregister-webview', { sessionId }),
    closeAgentBrowser: (sessionId: string) =>
      ipcRenderer.invoke('browser:close-agent-browser', { sessionId }),
    onOpenAgentTab: (callback: (sessionId: string, focus: boolean) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: { sessionId: string; focus?: boolean }) => {
        callback(payload.sessionId, payload.focus !== false);
      };
      ipcRenderer.on('browser:open-agent-tab', handler);
      return () => ipcRenderer.removeListener('browser:open-agent-tab', handler);
    },
    onCloseAgentTab: (callback: (sessionId: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: { sessionId: string }) => callback(payload.sessionId);
      ipcRenderer.on('browser:close-agent-tab', handler);
      return () => ipcRenderer.removeListener('browser:close-agent-tab', handler);
    },
    onActivateAgentTab: (callback: (sessionId: string, focus: boolean) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: { sessionId: string; focus?: boolean }) => callback(payload.sessionId, payload.focus !== false);
      ipcRenderer.on('browser:activate-agent-tab', handler);
      return () => ipcRenderer.removeListener('browser:activate-agent-tab', handler);
    },
  },
  browserCookie: {
    importCookies: (browser: 'chrome' | 'edge', profile?: string) =>
      ipcRenderer.invoke('browser:import-cookies', browser, profile),
    clearData: () =>
      ipcRenderer.invoke('browser:clear-browser-data'),
  },
  browserBackend: {
    updateMode: (mode: 'auto' | 'extension' | 'built-in' | 'human-like') =>
      ipcRenderer.invoke('browser:update-backend-mode', mode),
  },
  parser: {
    parse: (filePath, options) => ipcRenderer.invoke('parser:parse', filePath, options),
    getCapabilities: () => ipcRenderer.invoke('parser:getCapabilities'),
    isReady: () => ipcRenderer.invoke('parser:isReady'),
  },
  literature: {
    ingestParsedDocument: (input) => ipcRenderer.invoke('literature:ingestParsedDocument', input),
    listSources: () => ipcRenderer.invoke('literature:listSources'),
    getSource: (sourceId: string) => ipcRenderer.invoke('literature:getSource', sourceId),
    listChunks: (sourceId: string, limit?: number) => ipcRenderer.invoke('literature:listChunks', sourceId, limit),
    getPaperCard: (sourceId: string) => ipcRenderer.invoke('literature:getPaperCard', sourceId),
    listEvidence: (sourceId: string) => ipcRenderer.invoke('literature:listEvidence', sourceId),
    saveEvidence: (input) => ipcRenderer.invoke('literature:saveEvidence', input),
    getCitation: (sourceId: string, style: LiteratureCitationStyle) => ipcRenderer.invoke('literature:getCitation', sourceId, style),
  },
  agentProfile: {
    list: () => ipcRenderer.invoke('db:agentProfile:list'),
    get: (id: string) => ipcRenderer.invoke('db:agentProfile:get', id),
    create: (data: Record<string, unknown>) => ipcRenderer.invoke('db:agentProfile:create', data),
    update: (id: string, data: Record<string, unknown>) => ipcRenderer.invoke('db:agentProfile:update', id, data),
    delete: (id: string) => ipcRenderer.invoke('db:agentProfile:delete', id),
  },
  recap: {
    request: (sessionId: string) => ipcRenderer.invoke('recap:request', sessionId),
    setActiveSession: (sessionId: string) => ipcRenderer.invoke('recap:setActiveSession', sessionId),
    getSettings: () => ipcRenderer.invoke('recap:getSettings'),
    setSettings: (settings) => ipcRenderer.invoke('recap:setSettings', settings),
    onRecapResult: (callback: (data: { sessionId: string; recap: string; timestamp: number }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { sessionId: string; recap: string; timestamp: number }) => callback(data);
      ipcRenderer.on('recap:result', handler);
      return () => {
        ipcRenderer.removeListener('recap:result', handler);
      };
    },
  },
  // Mailbox API (Plan 202 — PR1)
  mailbox: {
    send: (params) => {
      const id = crypto.randomUUID();
      return ipcRenderer.invoke('mailbox:send', { id, ...params });
    },
    edit: (id, patch) => ipcRenderer.invoke('mailbox:edit', { id, ...patch }),
    guide: (id) => ipcRenderer.invoke('mailbox:guide', { id }),
    promoteQueued: (id) => ipcRenderer.invoke('mailbox:promoteQueued', { id }),
    cancel: (id, reason) => ipcRenderer.invoke('mailbox:cancel', { id, reason }),
    list: (sessionId, opts) => ipcRenderer.invoke('mailbox:list', { sessionId, ...opts }),
    listForSession: (sessionId) => ipcRenderer.invoke('mailbox:listForSession', { sessionId }),
    onEvent: (handler: (event: unknown) => void) => {
      const wrappedHandler = (_event: Electron.IpcRendererEvent, data: unknown) => handler(data);
      ipcRenderer.on('mailbox:event', wrappedHandler);
      return () => {
        ipcRenderer.removeListener('mailbox:event', wrappedHandler);
      };
    },
  },
  // Agent Server API
  agentServer: {
    getPort: () => ipcRenderer.invoke('agent-server:getPort'),
    getUrl: () => ipcRenderer.invoke('agent-server:getUrl'),
  },
  // Logger API for checking if ports are ready
  portStatus: {
    isConfigPortReady: () => isConfigPortReadyFlag,
  },
  // Logger API
  logger: {
    export: () => ipcRenderer.invoke('logger:export'),
    exportToFile: (targetPath: string) => ipcRenderer.invoke('logger:export-to-file', targetPath),
    getPath: () => ipcRenderer.invoke('logger:get-path'),
    clear: () => ipcRenderer.invoke('logger:clear'),
  },
  // Updater API
  updater: {
    check: () => ipcRenderer.invoke('updater:check'),
    download: () => ipcRenderer.invoke('updater:download'),
    install: () => ipcRenderer.invoke('updater:install'),
    getState: () => ipcRenderer.invoke('updater:get-state'),
    onChecking: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('update:checking', handler)
      return () => ipcRenderer.removeListener('update:checking', handler)
    },
    onAvailable: (callback: (e: unknown, info: unknown) => void) => {
      const handler = (_e: unknown, info: unknown) => callback(_e, info)
      ipcRenderer.on('update:available', handler)
      return () => ipcRenderer.removeListener('update:available', handler)
    },
    onNotAvailable: (callback: (e: unknown, info: unknown) => void) => {
      const handler = (_e: unknown, info: unknown) => callback(_e, info)
      ipcRenderer.on('update:not-available', handler)
      return () => ipcRenderer.removeListener('update:not-available', handler)
    },
    onDownloading: (callback: (data: { version: string }) => void) => {
      const handler = (_e: unknown, data: { version: string }) => callback(data)
      ipcRenderer.on('update:downloading', handler)
      return () => ipcRenderer.removeListener('update:downloading', handler)
    },
    onProgress: (callback: (data: { percent: number; transferred: number; total: number }) => void) => {
      const handler = (_e: unknown, data: { percent: number; transferred: number; total: number }) => callback(data)
      ipcRenderer.on('update:progress', handler)
      return () => ipcRenderer.removeListener('update:progress', handler)
    },
    onReady: (callback: (data: { version: string; releaseNotes?: string }) => void) => {
      const handler = (_e: unknown, data: { version: string; releaseNotes?: string }) => callback(data)
      ipcRenderer.on('update:ready', handler)
      return () => ipcRenderer.removeListener('update:ready', handler)
    },
    onDownloaded: (callback: (e: unknown, info: unknown) => void) => {
      const handler = (_e: unknown, info: unknown) => callback(_e, info)
      ipcRenderer.on('update:downloaded', handler)
      return () => ipcRenderer.removeListener('update:downloaded', handler)
    },
    onError: (callback: (e: unknown, msg: string) => void) => {
      const handler = (_e: unknown, msg: string) => callback(_e, msg)
      ipcRenderer.on('update:error', handler)
      return () => ipcRenderer.removeListener('update:error', handler)
    },
  },
  // Session management
  getInterruptedSessions: () => ipcRenderer.invoke('session:getInterruptedSessions'),
  // Plugin API
  plugin: {
    catalog: {
      list: (filters?: { search?: string; category?: string; source?: string; installed?: boolean }) =>
        ipcRenderer.invoke('plugin:catalog:list', filters),
    },
    registry: {
      list: () => ipcRenderer.invoke('plugin:registry:list'),
    },
    detail: {
      get: (pluginId: string) => ipcRenderer.invoke('plugin:detail:get', pluginId),
    },
    health: {
      list: () => ipcRenderer.invoke('plugin:health:list'),
    },
    install: (payload: { pluginId: string }) => ipcRenderer.invoke('plugin:install', payload),
    installLocal: (payload: { pluginPath: string; scope?: string; autoUpdate?: boolean }) => ipcRenderer.invoke('plugin:install-local', payload),
    enable: (pluginId: string) => ipcRenderer.invoke('plugin:enable', pluginId),
    disable: (pluginId: string) => ipcRenderer.invoke('plugin:disable', pluginId),
    remove: (payload: { pluginId: string; deleteData?: boolean }) => ipcRenderer.invoke('plugin:remove', payload),
    doctor: (pluginId?: string) => ipcRenderer.invoke('plugin:doctor', pluginId),
    capabilityIndex: () => ipcRenderer.invoke('plugin:capability-index'),
    cacheStats: () => ipcRenderer.invoke('plugin:cache:stats'),
    cacheCleanup: (payload: { marketplace: string; pluginId: string; keepLatest?: number }) => ipcRenderer.invoke('plugin:cache:cleanup', payload),
    workflowGet: (payload: { pluginId: string; workflowId: string }) => ipcRenderer.invoke('plugin:workflow:get', payload),
  },
  // App Connection — Plan 312. Only status DTOs cross IPC; tokens stay
  // in the main process.
  appConnection: {
    list: () => ipcRenderer.invoke('appConnection:list'),
    providers: () => ipcRenderer.invoke('appConnection:providers'),
    status: (connectionId: string) => ipcRenderer.invoke('appConnection:status', connectionId),
    connect: (payload: { provider: string; scopes?: string[] }) => ipcRenderer.invoke('appConnection:connect', payload),
    configureProvider: (payload: { provider: string; clientId: string; clientSecret?: string }) =>
      ipcRenderer.invoke('appConnection:configureProvider', payload),
    disconnect: (connectionId: string) => ipcRenderer.invoke('appConnection:disconnect', connectionId),
  },
  marketplace: {
    list: () => ipcRenderer.invoke('marketplace:list'),
    add: (payload) => ipcRenderer.invoke('marketplace:add', payload),
    update: (payload) => ipcRenderer.invoke('marketplace:update', payload),
    remove: (payload) => ipcRenderer.invoke('marketplace:remove', payload),
    reset: () => ipcRenderer.invoke('marketplace:reset'),
    checkName: (name: string) => ipcRenderer.invoke('marketplace:check-name', name),
  },
  terminal: {
    spawn: (params) => ipcRenderer.invoke('terminal:spawn', params),
    list: () => ipcRenderer.invoke('terminal:list'),
    snapshot: (id) => ipcRenderer.invoke('terminal:snapshot', { id }),
    write: (id, data) => ipcRenderer.invoke('terminal:write', { id, data }),
    resize: (id, cols, rows) => ipcRenderer.invoke('terminal:resize', { id, cols, rows }),
    kill: (id) => ipcRenderer.invoke('terminal:kill', { id }),
    suggest: (prefix, shell, cwd, limit) =>
      ipcRenderer.invoke('terminal:suggest', { prefix, shell, cwd, limit }),
    record: (command, shell, cwd, source = 'user') =>
      ipcRenderer.invoke('terminal:record', { command, shell, cwd, source }),
  },
  onTerminalOutput: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { id: string; data: string }) => {
      callback(data)
    }
    ipcRenderer.on('terminal:output', handler)
    return () => {
      ipcRenderer.removeListener('terminal:output', handler)
    }
  },
  onTerminalExit: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { id: string; code: number | null }) => {
      callback(data)
    }
    ipcRenderer.on('terminal:exit', handler)
    return () => {
      ipcRenderer.removeListener('terminal:exit', handler)
    }
  },
  import: {
    detect: () => ipcRenderer.invoke('import:detect'),
    scan: (params: { source: string; projectPath?: string }) => ipcRenderer.invoke('import:scan', params),
    apply: (params: unknown) => ipcRenderer.invoke('import:apply', params),
    rollback: (params: { batchId: string }) => ipcRenderer.invoke('import:rollback', params),
    history: () => ipcRenderer.invoke('import:history'),
  },
  capabilityManagement: {
    snapshot: () => ipcRenderer.invoke('capability-management:snapshot'),
  },
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI);

// Expose webUtils.getPathForFile so the renderer can resolve real filesystem
// paths for dropped/pasted files (Electron ≥ 32 removed File.path). On older
// versions this stays null and the renderer falls back to file.path.
contextBridge.exposeInMainWorld('electronWebUtils', {
  getPathForFile: (file: File): string => {
    if (webUtilsGetPathForFile) {
      try {
        return webUtilsGetPathForFile(file);
      } catch {
        return '';
      }
    }
    return '';
  },
});

// Agent Server port accessor for SSE client
export function getAgentServerPort(): Promise<number | null> {
  return ipcRenderer.invoke('agent-server:get-port');
}
