import { contextBridge, ipcRenderer } from 'electron'

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

// AgentControlPort API for chat communication via MessagePort
export interface AgentControlPortAPI {
  // Send messages to Agent
  startChat: (sessionId: string, prompt: string, options?: Record<string, unknown>) => void
  interruptChat: (sessionId: string) => void
  resolvePermission: (id: string, decision: string, extra?: Record<string, unknown>) => void
  compactContext: (sessionId: string) => void
  // Event handlers for Agent → Renderer messages
  onText: (callback: (content: string, sessionId?: string) => void) => () => void
  onThinking: (callback: (content: string, sessionId?: string) => void) => () => void
  onToolUse: (callback: (data: { id: string; name: string; input: unknown }, sessionId?: string) => void) => () => void
  onToolResult: (callback: (data: { id: string; result: unknown; error?: string }, sessionId?: string) => void) => () => void
  onToolProgress: (callback: (data: { toolUseId: string; percent: number; stage: string }, sessionId?: string) => void) => () => void
  onToolOutput: (callback: (data: { toolUseId: string; stream: 'stdout' | 'stderr'; data: string }, sessionId?: string) => void) => () => void
  onAgentProgress: (callback: (data: {
      agentEventType: string;
      data?: string;
      toolName?: string;
      toolInput?: Record<string, unknown>;
      toolResult?: string;
      duration?: number;
      agentId?: string;
      agentType?: string;
      agentName?: string;
      agentDescription?: string;
      agentSessionId?: string;
    }, sessionId?: string) => void) => () => void
  onPermission: (callback: (request: { id: string; toolName: string; toolInput: Record<string, unknown> }, sessionId?: string) => void) => () => void
  onContextUsage: (callback: (data: { usedTokens: number; contextWindow: number; percentFull: number }, sessionId?: string) => void) => () => void
  onDone: (callback: (sessionId?: string) => void) => () => void
  onError: (callback: (message: string, sessionId?: string) => void) => () => void
  onStatus: (callback: (message: string, sessionId?: string) => void) => () => void
  onDbPersisted: (callback: (data: { success: boolean; sessionId: string; messageCount: number; reason?: string }, sessionId?: string) => void) => () => void
  onTokenUsage: (callback: (data: { inputTokens: number; outputTokens: number }, sessionId?: string) => void) => () => void
  onRetry: (callback: (data: { attempt: number; maxAttempts: number; delayMs: number; message: string }, sessionId?: string) => void) => () => void
  onSkillReviewStarted: (callback: (sessionId?: string) => void) => () => void
  onSkillReviewCompleted: (callback: (data: { passed: boolean; score: number; feedback: string; skillName?: string; error?: string }, sessionId?: string) => void) => () => void
  onTitleGenerated: (callback: (data: { title: string }, sessionId?: string) => void) => () => void
  onCompactDone: (callback: (sessionId?: string) => void) => () => void
  onCompactError: (callback: (message: string, sessionId?: string) => void) => () => void
}

export interface ConductorPortAPI {
  startAgent: (data: { content: string; snapshot: unknown; canvasId?: string; model?: string }) => void
  interruptAgent: () => void
  onStatePatch: (callback: (data: Record<string, unknown>) => void) => () => void
  onText: (callback: (data: { content: string; sessionId?: string }) => void) => () => void
  onThinking: (callback: (data: { content: string; sessionId?: string }) => void) => () => void
  onToolUse: (callback: (data: { id: string; name: string; input: unknown; sessionId?: string }) => void) => () => void
  onToolResult: (callback: (data: { id: string; result: unknown; error?: boolean; sessionId?: string }) => void) => () => void
  onStatus: (callback: (data: { status: string; sessionId?: string }) => void) => () => void
  onError: (callback: (data: { message: string; sessionId?: string }) => void) => () => void
  onDone: (callback: (data: { sessionId?: string }) => void) => () => void
  onPermission: (callback: (data: { request: { id: string; toolName: string; toolInput: Record<string, unknown> }; sessionId?: string }) => void) => () => void
  onDisconnected: (callback: (data: { sessionId?: string }) => void) => () => void
}

export interface ThreadAPI {
  list: () => Promise<unknown[]>
  get: (id: string) => Promise<unknown>
  create: (data: Record<string, unknown>) => Promise<unknown>
  update: (id: string, data: Record<string, unknown>) => Promise<unknown>
  delete: (id: string) => Promise<boolean>
  listByParentId: (parentId: string) => Promise<unknown[]>
  getTasks: (sessionId: string) => Promise<unknown[]>
  updateTask: (id: string, data: Record<string, unknown>) => Promise<unknown>
}

export interface MessageAPI {
  add: (data: Record<string, unknown>) => Promise<unknown>
  getBySession: (sessionId: string) => Promise<unknown[]>
  replace: (sessionId: string, messages: unknown[], generation: number) => Promise<unknown>
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
  getSecurityBypass: () => Promise<{ success: boolean; skills: string[]; error?: string }>
  setSecurityBypass: (skillName: string, bypass: boolean) => Promise<{ success: boolean; skills: string[]; error?: string }>
}

export interface ProviderAPI {
  list: () => Promise<unknown[]>
  get: (id: string) => Promise<unknown>
  getActive: () => Promise<unknown>
  upsert: (data: Record<string, unknown>) => Promise<unknown>
  update: (id: string, data: Record<string, unknown>) => Promise<unknown>
  delete: (id: string) => Promise<boolean>
  activate: (id: string) => Promise<unknown>
}

export interface OutputStyleAPI {
  list: () => Promise<unknown[]>
  get: (id: string) => Promise<unknown>
  upsert: (data: Record<string, unknown>) => Promise<unknown>
  delete: (id: string) => Promise<boolean>
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
  getOllamaModels: (baseUrl: string) => Promise<{
    success: boolean
    models?: Array<{ id: string; name: string; size?: number; modified_at?: string }>
    error?: string
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
}

export interface AutomationAPI {
  listCrons: () => Promise<unknown[]>
  createCron: (data: Record<string, unknown>) => Promise<unknown>
  updateCron: (id: string, patch: Record<string, unknown>) => Promise<unknown>
  deleteCron: (id: string) => Promise<{ success: boolean }>
  runCron: (id: string) => Promise<unknown>
  listCronRuns: (input: { cronId: string; limit?: number; offset?: number }) => Promise<unknown[]>
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
  delete: (targetPath: string) => Promise<{ success: boolean; error?: string }>
  rename: (targetPath: string, newName: string) => Promise<{ success: boolean; error?: string; newPath?: string }>
}

export interface PortStatusAPI {
  isAgentPortReady: () => boolean
  isConfigPortReady: () => boolean
  waitForAgentPort: (timeout?: number) => Promise<boolean>
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
  pendingCommands: number;
  port: number;
}

export interface BrowserExtensionAPI {
  getStatus: () => Promise<{ success: boolean; status?: BrowserExtensionStatus; error?: string }>
  getExtensionPath: () => Promise<string>
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
  }
  shell: {
    openPath: (folderPath: string) => Promise<string>
  }
  notification: {
    show: (options: { title: string; body: string }) => Promise<boolean>
  }
  app: {
    getVersion: () => Promise<string>
    quit: () => Promise<void>
    getDefaultWorkspace: () => Promise<string>
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
  }
  // Functions to get port APIs (called dynamically, not getters)
  getConfigPort: () => ConfigPortAPI | null
  getAgentPort: () => AgentControlPortAPI | null
  getConductorPort: () => ConductorPortAPI | null
  // Port status API for checking if ports are ready
  portStatus: PortStatusAPI
  // Session port API for per-session MessagePort communication
  getSessionPort: (sessionId: string) => SessionPortAPI | null
  closeAllSessionPorts: () => void
  // Database IPC APIs
  conductor: {
    listCanvases: () => Promise<unknown[]>
    createCanvas: (data: { name: string; description?: string }) => Promise<unknown>
    updateCanvas: (
      id: string,
      data: { name?: string; description?: string | null; layoutConfig?: Record<string, unknown>; sortOrder?: number }
    ) => Promise<unknown>
    deleteCanvas: (id: string) => Promise<boolean>
    snapshot: (canvasId: string) => Promise<unknown>
    action: (request: Record<string, unknown>) => Promise<unknown>
    undo: (canvasId: string) => Promise<unknown>
    redo: (canvasId: string) => Promise<unknown>
  }
  thread: ThreadAPI
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
  weixin: WeixinAccountAPI
  browserExtension: BrowserExtensionAPI
  agentProfile: AgentProfileAPI
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

// Agent control port handlers
// Use a container object to ensure the reference is shared
const agentPortState = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  agentPort: null as any,
  isAgentPortReadyFlag: false,
  isConfigPortReadyFlag: false,
}
const agentPortHandlers: Map<string, Set<(data: unknown) => void>> = new Map()

// Port status tracking (exposed via contextBridge)
const agentPortReadyCallbacks = new Set<() => void>()

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
        console.error(`[preload] Session ${sessionId} port handler error:`, error)
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

// Handle incoming agent port messages
function handleAgentPortMessage(data: Record<string, unknown>): void {
  const { type, ...payload } = data
  const sessionId = payload.sessionId as string | undefined
  debugLog('agent<-main', { type, sessionId })
  const handlers = agentPortHandlers.get(type as string)
  if (handlers) {
    handlers.forEach(handler => {
      try {
        handler(payload)
      } catch (error) {
        console.error('[preload] Agent port handler error:', error)
      }
    })
  }
}

// Listen for config port from main process
ipcRenderer.on('config-port', (event) => {
  const [port] = event.ports
  if (port) {
    configPort = port
    agentPortState.isConfigPortReadyFlag = true
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

// Listen for agent control port from main process
ipcRenderer.on('agent-control-port', (event) => {
  const [port] = event.ports
  if (port) {
    agentPortState.agentPort = port
    // Set flag to indicate agentPort is ready
    agentPortState.isAgentPortReadyFlag = true
    port.onmessage = (e) => {
      handleAgentPortMessage(e.data)
    }
    port.start()
    // Notify all waiting callbacks
    agentPortReadyCallbacks.forEach(callback => {
      try {
        callback()
      } catch (error) {
        console.error('[preload] Error in agentPort ready callback:', error)
      }
    })
    agentPortReadyCallbacks.clear()
    // Dispatch event to notify renderer that agentPort is ready
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('agent-port-ready'))
    }, 0)
  } else {
    console.error('[preload] No port in agent-control-port event')
  }
})

// Listen for conductor port from main process
ipcRenderer.on('conductor-port', (event) => {
  const [port] = event.ports
  if (port) {
    conductorPort = port
    port.onmessage = (e) => {
      const { type, ...payload } = e.data
      const handlers = conductorPortHandlers.get(type as string)
      if (handlers) {
        handlers.forEach(handler => {
          try { handler(payload) } catch (error) { console.error('[preload] Conductor port handler error:', error) }
        })
      }
    }
    port.start()
  }
})

// Listen for sync events from main process
ipcRenderer.on('sync:threads-changed', () => {
  syncCallbacks.forEach(callback => {
    try {
      callback()
    } catch (error) {
      console.error('[preload] Error in sync callback:', error)
    }
  })
})

// Listen for daemon disconnected events
ipcRenderer.on('daemon:disconnected', (_event, data: { code: number; source: string }) => {
  console.warn('[preload] Daemon disconnected:', data.source, 'code:', data.code)
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
function getConductorPortAPI(): ConductorPortAPI | null {
  if (!conductorPort) return null;

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
    startAgent: (data: { content: string; snapshot: unknown; canvasId?: string; model?: string }) => {
      const sessionId = data.canvasId ? `conductor-${data.canvasId}` : `conductor-${Date.now()}`;
      conductorPort?.postMessage({
        type: 'conductor:agent:start',
        sessionId,
        prompt: data.content,
        snapshot: data.snapshot,
        model: data.model,
      });
    },
    interruptAgent: () => {
      conductorPort?.postMessage({ type: 'conductor:interrupt' });
    },
    onStatePatch: (callback: (data: Record<string, unknown>) => void) => {
      return registerHandler('conductor:state:patch', (data) => callback(data as Record<string, unknown>));
    },
    onText: (callback: (data: { content: string; sessionId?: string }) => void) => {
      return registerHandler('conductor:text', (data) => callback(data as { content: string; sessionId?: string }));
    },
    onThinking: (callback: (data: { content: string; sessionId?: string }) => void) => {
      return registerHandler('conductor:thinking', (data) => callback(data as { content: string; sessionId?: string }));
    },
    onToolUse: (callback: (data: { id: string; name: string; input: unknown; sessionId?: string }) => void) => {
      return registerHandler('conductor:tool_use', (data) => callback(data as { id: string; name: string; input: unknown; sessionId?: string }));
    },
    onToolResult: (callback: (data: { id: string; result: unknown; error?: boolean; sessionId?: string }) => void) => {
      return registerHandler('conductor:tool_result', (data) => callback(data as { id: string; result: unknown; error?: boolean; sessionId?: string }));
    },
    onStatus: (callback: (data: { status: string; sessionId?: string }) => void) => {
      return registerHandler('conductor:status', (data) => callback(data as { status: string; sessionId?: string }));
    },
    onError: (callback: (data: { message: string; sessionId?: string }) => void) => {
      return registerHandler('conductor:error', (data) => callback(data as { message: string; sessionId?: string }));
    },
    onDone: (callback: (data: { sessionId?: string }) => void) => {
      return registerHandler('conductor:done', (data) => callback(data as { sessionId?: string }));
    },
    onPermission: (callback: (data: { request: { id: string; toolName: string; toolInput: Record<string, unknown> }; sessionId?: string }) => void) => {
      return registerHandler('conductor:permission', (data) => callback(data as { request: { id: string; toolName: string; toolInput: Record<string, unknown> }; sessionId?: string }));
    },
    onDisconnected: (callback: (data: { sessionId?: string }) => void) => {
      return registerHandler('conductor:disconnected', (data) => callback(data as { sessionId?: string }));
    },
  };
}

// Helper functions for agentPort API
function getAgentPortAPI(): AgentControlPortAPI | null {
  if (!agentPortState.agentPort) {
    return null;
  }
  return {
    startChat: (sessionId: string, prompt: string, options?: Record<string, unknown>) => {
      debugLog('renderer->main chat:start', { sessionId, promptLength: prompt.length })
      agentPortState.agentPort?.postMessage({ type: 'chat:start', sessionId, prompt, options })
    },
    interruptChat: (sessionId: string) => {
      agentPortState.agentPort?.postMessage({ type: 'chat:interrupt', sessionId })
    },
    resolvePermission: (id: string, decision: string, extra?: Record<string, unknown>) => {
      agentPortState.agentPort?.postMessage({ type: 'permission:resolve', id, decision, ...extra })
    },
    compactContext: (sessionId: string) => {
      agentPortState.agentPort?.postMessage({ type: 'compact', sessionId })
    },
    onText: (callback: (content: string, sessionId?: string) => void) => {
      return registerAgentPortHandler('chat:text', (data) => callback((data as { content: string }).content, (data as { sessionId?: string }).sessionId))
    },
    onThinking: (callback: (content: string, sessionId?: string) => void) => {
      return registerAgentPortHandler('chat:thinking', (data) => callback((data as { content: string }).content, (data as { sessionId?: string }).sessionId))
    },
    onToolUse: (callback: (data: { id: string; name: string; input: unknown }, sessionId?: string) => void) => {
      return registerAgentPortHandler('chat:tool_use', (data) => callback(data as { id: string; name: string; input: unknown }, (data as { sessionId?: string }).sessionId))
    },
    onToolResult: (callback: (data: { id: string; result: unknown; error?: string }, sessionId?: string) => void) => {
      return registerAgentPortHandler('chat:tool_result', (data) => callback(data as { id: string; result: unknown; error?: string }, (data as { sessionId?: string }).sessionId))
    },
    onToolProgress: (callback: (data: { toolUseId: string; percent: number; stage: string }, sessionId?: string) => void) => {
      return registerAgentPortHandler('chat:tool_progress', (data) => callback(data as { toolUseId: string; percent: number; stage: string }, (data as { sessionId?: string }).sessionId))
    },
    onToolOutput: (callback: (data: { toolUseId: string; stream: 'stdout' | 'stderr'; data: string }, sessionId?: string) => void) => {
      return registerAgentPortHandler('chat:tool_output', (data) => callback(data as { toolUseId: string; stream: 'stdout' | 'stderr'; data: string }, (data as { sessionId?: string }).sessionId))
    },
    onAgentProgress: (callback: (data: {
      agentEventType: string;
      data?: string;
      toolName?: string;
      toolInput?: Record<string, unknown>;
      toolResult?: string;
      duration?: number;
      agentId?: string;
      agentType?: string;
      agentName?: string;
      agentDescription?: string;
      agentSessionId?: string;
    }, sessionId?: string) => void) => {
      return registerAgentPortHandler('chat:agent_progress', (data) => callback(data as {
        agentEventType: string;
        data?: string;
        toolName?: string;
        toolInput?: Record<string, unknown>;
        toolResult?: string;
        duration?: number;
        agentId?: string;
        agentType?: string;
        agentName?: string;
        agentDescription?: string;
        agentSessionId?: string;
      }, (data as { sessionId?: string }).sessionId))
    },
    onPermission: (callback: (request: { id: string; toolName: string; toolInput: Record<string, unknown> }, sessionId?: string) => void) => {
      return registerAgentPortHandler('chat:permission', (data) => callback((data as { request: { id: string; toolName: string; toolInput: Record<string, unknown> } }).request, (data as { sessionId?: string }).sessionId))
    },
    onContextUsage: (callback: (data: { usedTokens: number; contextWindow: number; percentFull: number }, sessionId?: string) => void) => {
      return registerAgentPortHandler('chat:context_usage', (data) => callback(data as { usedTokens: number; contextWindow: number; percentFull: number }, (data as { sessionId?: string }).sessionId))
    },
    onDone: (callback: (sessionId?: string) => void) => {
      return registerAgentPortHandler('chat:done', (data) => callback((data as { sessionId?: string }).sessionId))
    },
    onError: (callback: (message: string, sessionId?: string) => void) => {
      return registerAgentPortHandler('chat:error', (data) => callback((data as { message: string }).message, (data as { sessionId?: string }).sessionId))
    },
    onStatus: (callback: (message: string, sessionId?: string) => void) => {
      return registerAgentPortHandler('chat:status', (data) => callback((data as { message: string }).message, (data as { sessionId?: string }).sessionId))
    },
    onDbPersisted: (callback: (data: { success: boolean; sessionId: string; messageCount: number; reason?: string }, sessionId?: string) => void) => {
      return registerAgentPortHandler('chat:db_persisted', (data) => callback(data as { success: boolean; sessionId: string; messageCount: number; reason?: string }, (data as { sessionId?: string }).sessionId))
    },
    onTokenUsage: (callback: (data: { inputTokens: number; outputTokens: number }, sessionId?: string) => void) => {
      return registerAgentPortHandler('chat:token_usage', (data) => callback(data as { inputTokens: number; outputTokens: number }, (data as { sessionId?: string }).sessionId))
    },
    onRetry: (callback: (data: { attempt: number; maxAttempts: number; delayMs: number; message: string }, sessionId?: string) => void) => {
      return registerAgentPortHandler('chat:retry', (data) => callback(data as { attempt: number; maxAttempts: number; delayMs: number; message: string }, (data as { sessionId?: string }).sessionId))
    },
    onSkillReviewStarted: (callback: (sessionId?: string) => void) => {
      return registerAgentPortHandler('chat:skill_review_started', (data) => callback((data as { sessionId?: string }).sessionId))
    },
    onSkillReviewCompleted: (callback: (data: { passed: boolean; score: number; feedback: string; skillName?: string; error?: string }, sessionId?: string) => void) => {
      return registerAgentPortHandler('chat:skill_review_completed', (data) => callback((data as { data?: { passed: boolean; score: number; feedback: string; skillName?: string; error?: string } }).data ?? data as { passed: boolean; score: number; feedback: string; skillName?: string; error?: string }, (data as { sessionId?: string }).sessionId))
    },
    onTitleGenerated: (callback: (data: { title: string }, sessionId?: string) => void) => {
      return registerAgentPortHandler('chat:title_generated', (data) => callback(data as { title: string }, (data as { sessionId?: string }).sessionId))
    },
    onCompactDone: (callback: (sessionId?: string) => void) => {
      return registerAgentPortHandler('compact:done', (data) => callback((data as { sessionId?: string }).sessionId))
    },
    onCompactError: (callback: (message: string, sessionId?: string) => void) => {
      return registerAgentPortHandler('compact:error', (data) => callback((data as { message: string }).message, (data as { sessionId?: string }).sessionId))
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
  },
  shell: {
    openPath: (folderPath) => ipcRenderer.invoke('shell:open-path', folderPath),
  },
  notification: {
    show: (options) => ipcRenderer.invoke('notification:show', options),
  },
  app: {
    getVersion: () => ipcRenderer.invoke('app:get-version'),
    quit: () => ipcRenderer.invoke('app:quit'),
    getDefaultWorkspace: () => ipcRenderer.invoke('app:get-default-workspace'),
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
  },
  // Functions to get port APIs (called dynamically)
  getConfigPort: getConfigPortAPI,
  getAgentPort: getAgentPortAPI,
  getConductorPort: getConductorPortAPI,
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
    createCanvas: (data: { name: string; description?: string }) => ipcRenderer.invoke('conductor:canvas:create', data),
    updateCanvas: (
      id: string,
      data: { name?: string; description?: string | null; layoutConfig?: Record<string, unknown>; sortOrder?: number }
    ) => ipcRenderer.invoke('conductor:canvas:update', id, data),
    deleteCanvas: (id: string) => ipcRenderer.invoke('conductor:canvas:delete', id),
    snapshot: (canvasId: string) => ipcRenderer.invoke('conductor:snapshot', canvasId),
    action: (request: Record<string, unknown>) => ipcRenderer.invoke('conductor:action', request),
    undo: (canvasId: string) => ipcRenderer.invoke('conductor:undo', canvasId),
    redo: (canvasId: string) => ipcRenderer.invoke('conductor:redo', canvasId),
  },
  thread: {
    list: () => ipcRenderer.invoke('db:session:list'),
    get: (id: string) => ipcRenderer.invoke('db:session:get', id),
    create: (data: Record<string, unknown>) => ipcRenderer.invoke('db:session:create', data),
    update: (id: string, data: Record<string, unknown>) => ipcRenderer.invoke('db:session:update', id, data),
    delete: (id: string) => ipcRenderer.invoke('db:session:delete', id),
    listByParentId: (parentId: string) => ipcRenderer.invoke('db:session:listByParentId', parentId),
    getTasks: (sessionId: string) => ipcRenderer.invoke('db:task:getBySession', sessionId),
    updateTask: (id: string, data: Record<string, unknown>) => ipcRenderer.invoke('db:task:update', id, data),
  },
  message: {
    add: (data: Record<string, unknown>) => ipcRenderer.invoke('db:message:add', data),
    getBySession: (sessionId: string) => ipcRenderer.invoke('db:message:getBySession', sessionId),
    replace: (sessionId: string, messages: unknown[], generation: number) =>
      ipcRenderer.invoke('db:message:replace', sessionId, messages, generation),
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
  },
  outputStyle: {
    list: () => ipcRenderer.invoke('config:style:getAll'),
    get: (id: string) => ipcRenderer.invoke('config:style:get', id),
    upsert: (data: Record<string, unknown>) => ipcRenderer.invoke('config:style:upsert', data),
    delete: (id: string) => ipcRenderer.invoke('config:style:delete', id),
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
    getOllamaModels: (baseUrl: string) => ipcRenderer.invoke('net:ollama:models', baseUrl),
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
  },
  automation: {
    listCrons: () => ipcRenderer.invoke('automation:cron:list'),
    createCron: (data: Record<string, unknown>) => ipcRenderer.invoke('automation:cron:create', data),
    updateCron: (id: string, patch: Record<string, unknown>) => ipcRenderer.invoke('automation:cron:update', id, patch),
    deleteCron: (id: string) => ipcRenderer.invoke('automation:cron:delete', id),
    runCron: (id: string) => ipcRenderer.invoke('automation:cron:run', id),
    listCronRuns: (input: { cronId: string; limit?: number; offset?: number }) =>
      ipcRenderer.invoke('automation:cron:runs', input),
  },
  safeMode: {
    getStatus: () => ipcRenderer.invoke('db:safeModeStatus'),
    relocateDatabase: (newDir: string) => ipcRenderer.invoke('db:relocateDatabase', newDir),
    resetToDefaultPath: () => ipcRenderer.invoke('db:resetToDefaultPath'),
    getStats: () => ipcRenderer.invoke('db:stats'),
  },
  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
    getSecurityBypass: () => ipcRenderer.invoke('skills:getSecurityBypass'),
    setSecurityBypass: (skillName: string, bypass: boolean) => ipcRenderer.invoke('skills:setSecurityBypass', skillName, bypass),
  },
  files: {
    browse: (dirPath: string, maxDepth?: number) => ipcRenderer.invoke('files:browse', dirPath, maxDepth),
    delete: (targetPath: string) => ipcRenderer.invoke('files:delete', targetPath),
    rename: (targetPath: string, newName: string) => ipcRenderer.invoke('files:rename', targetPath, newName),
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
  },
  agentProfile: {
    list: () => ipcRenderer.invoke('db:agentProfile:list'),
    get: (id: string) => ipcRenderer.invoke('db:agentProfile:get', id),
    create: (data: Record<string, unknown>) => ipcRenderer.invoke('db:agentProfile:create', data),
    update: (id: string, data: Record<string, unknown>) => ipcRenderer.invoke('db:agentProfile:update', id, data),
    delete: (id: string) => ipcRenderer.invoke('db:agentProfile:delete', id),
  },
  // Logger API for checking if ports are ready
  portStatus: {
    isAgentPortReady: () => agentPortState.isAgentPortReadyFlag,
    isConfigPortReady: () => agentPortState.isConfigPortReadyFlag,
    waitForAgentPort: (timeout = 5000) => {
      return new Promise<boolean>((resolve) => {
        if (agentPortState.isAgentPortReadyFlag) {
          resolve(true)
          return
        }
        const timeoutId = setTimeout(() => {
          resolve(false)
        }, timeout)
        const callback = () => {
          clearTimeout(timeoutId)
          resolve(true)
        }
        agentPortReadyCallbacks.add(callback)
      })
    },
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
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)
