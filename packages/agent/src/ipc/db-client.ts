/**
 * db-client.ts - IPC-based database client for Agent Package
 *
 * This module replaces direct database access in the Agent Package.
 * All database operations go through IPC to the Main Process.
 */

import { ChildProcess } from 'child_process';

// IPC message types
interface DbRequest {
  type: 'db:request';
  id: string;
  action: string;
  payload: unknown;
}

interface DbResponse {
  type: 'db:response';
  id: string;
  success: boolean;
  result?: unknown;
  error?: string;
}

// Pending requests registry
const pendingRequests = new Map<string, {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}>();

// Generate unique request ID
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

// Send DB request and wait for response
async function sendDbRequest(action: string, payload: unknown): Promise<unknown> {
  // Check if we're in agent mode (forked child process)
  if (!process.send) {
    throw new Error('DB Client: Not in agent mode - process.send is not available');
  }

  const id = generateId();

  // Create the request object first
  const request: DbRequest = {
    type: 'db:request',
    id,
    action,
    payload,
  };

  // Use Promise with setTimeout to ensure registration happens in next tick
  return new Promise((resolve, reject) => {
    // Register pending request
    pendingRequests.set(id, { resolve, reject });

    // Send request after registration is complete (next tick)
    process.nextTick(() => {
      process.send!(request);
    });

    // Timeout after 30 seconds
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error(`DB request timeout: ${action}`));
      }
    }, 30000);
  });
}

// Handle DB response from Main Process
function handleDbResponse(response: DbResponse): void {
  const pending = pendingRequests.get(response.id);
  if (!pending) {
    console.warn('[DB-Client] Received response for unknown request:', response.id);
    return;
  }

  pendingRequests.delete(response.id);

  if (response.success) {
    pending.resolve(response.result);
  } else {
    pending.reject(new Error(response.error || 'Unknown error'));
  }
}

// Initialize IPC listeners
export function initDbClient(): void {
  if (typeof process !== 'undefined' && process.on) {
    process.on('message', (msg: DbResponse) => {
      if (msg.type === 'db:response') {
        handleDbResponse(msg);
      }
    });
  }
}

// ==================== Session Operations ====================

export const sessionDb = {
  create: (data: {
    id: string;
    title?: string;
    model?: string;
    system_prompt?: string;
    working_directory?: string;
    project_name?: string;
    status?: string;
    mode?: string;
    provider_id?: string;
    generation?: number;
    parent_id?: string | null;
    parent_session_id?: string | null;
    agent_profile_id?: string | null;
    agent_type?: string;
    agent_name?: string;
  }) => sendDbRequest('session:create', data),

  get: (id: string) => sendDbRequest('session:get', { id }),

  update: (id: string, data: Record<string, unknown>) => sendDbRequest('session:update', { id, ...data }),

  delete: (id: string) => sendDbRequest('session:delete', { id }),

  list: () => sendDbRequest('session:list', {}),

  listByWorkingDirectory: (workingDirectory: string) =>
    sendDbRequest('session:listByWorkingDirectory', { workingDirectory }),
};

// ==================== Message Operations ====================

export const messageDb = {
  add: (data: {
    id: string;
    session_id: string;
    role: string;
    content: string;
    name?: string;
    tool_call_id?: string;
    token_usage?: string;
    msg_type?: string;
    thinking?: string;
    tool_name?: string;
    tool_input?: string;
    parent_tool_call_id?: string;
    viz_spec?: string;
    status?: string;
    seq_index?: number;
    duration_ms?: number;
    sub_agent_id?: string;
  }) => sendDbRequest('message:add', data),

  getBySession: (sessionId: string) => sendDbRequest('message:getBySession', { sessionId }),

  getCount: (sessionId: string) => sendDbRequest('message:getCount', { sessionId }),

  deleteBySession: (sessionId: string) => sendDbRequest('message:deleteBySession', { sessionId }),

  replace: (sessionId: string, messages: unknown[], generation: number) =>
    sendDbRequest('message:replace', { sessionId, messages, generation }),
};

// ==================== Lock Operations ====================

export const lockDb = {
  acquire: (sessionId: string, lockId: string, owner: string, ttlSec = 300) =>
    sendDbRequest('lock:acquire', { sessionId, lockId, owner, ttlSec }),

  renew: (sessionId: string, lockId: string, ttlSec = 300) =>
    sendDbRequest('lock:renew', { sessionId, lockId, ttlSec }),

  release: (sessionId: string, lockId: string) =>
    sendDbRequest('lock:release', { sessionId, lockId }),

  isLocked: (sessionId: string) => sendDbRequest('lock:isLocked', { sessionId }),
};

// ==================== Task Operations ====================

export const taskDb = {
  create: (data: {
    id: string;
    session_id: string;
    subject: string;
    description: string;
    active_form?: string;
    owner?: string;
  }) => sendDbRequest('task:create', data),

  get: (id: string) => sendDbRequest('task:get', { id }),

  getBySession: (sessionId: string) => sendDbRequest('task:getBySession', { sessionId }),

  update: (id: string, data: Record<string, unknown>) => sendDbRequest('task:update', { id, ...data }),

  delete: (id: string) => sendDbRequest('task:delete', { id }),

  deleteBySession: (sessionId: string) => sendDbRequest('task:deleteBySession', { sessionId }),

  claim: (id: string, owner: string) => sendDbRequest('task:claim', { id, owner }),

  block: (fromId: string, toId: string) => sendDbRequest('task:block', { fromId, toId }),

  unassignTeammate: (sessionId: string, owner: string) => sendDbRequest('task:unassignTeammate', { sessionId, owner }),

  getByOwner: (sessionId: string, owner: string) => sendDbRequest('task:getByOwner', { sessionId, owner }),
};

// ==================== Settings Operations ====================

export const settingDb = {
  get: (key: string) => sendDbRequest('setting:get', { key }),

  set: (key: string, value: string) => sendDbRequest('setting:set', { key, value }),

  getAll: () => sendDbRequest('setting:getAll', {}),

  getJson: <T>(key: string, defaultValue: T) =>
    sendDbRequest('setting:getJson', { key, defaultValue }),

  setJson: <T>(key: string, value: T) =>
    sendDbRequest('setting:setJson', { key, value }),
};

// ==================== Provider Operations ====================

export const providerDb = {
  getAll: () => sendDbRequest('provider:getAll', {}),

  get: (id: string) => sendDbRequest('provider:get', { id }),

  getActive: () => sendDbRequest('provider:getActive', {}),

  upsert: (data: {
    id: string;
    name: string;
    providerType?: string;
    baseUrl?: string;
    apiKey?: string;
    isActive?: boolean;
  }) => sendDbRequest('provider:upsert', data),

  update: (id: string, data: Record<string, unknown>) =>
    sendDbRequest('provider:update', { id, ...data }),

  delete: (id: string) => sendDbRequest('provider:delete', { id }),

  activate: (id: string) => sendDbRequest('provider:activate', { id }),
};

// ==================== Permission Operations ====================

export const permissionDb = {
  create: (data: {
    id: string;
    sessionId?: string;
    toolName: string;
    toolInput?: Record<string, unknown>;
  }) => sendDbRequest('permission:create', data),

  get: (id: string) => sendDbRequest('permission:get', { id }),

  resolve: (
    id: string,
    status: 'allow' | 'deny' | 'timeout' | 'aborted',
    extra?: {
      message?: string;
      updatedPermissions?: unknown[];
      updatedInput?: Record<string, unknown>;
    }
  ) => sendDbRequest('permission:resolve', { id, status, extra }),
};

// ==================== Search Operations ====================

export const searchDb = {
  sessions: (query: string, limit = 10) =>
    sendDbRequest('search:sessions', { query, limit }),
};

// ==================== Channel Operations ====================

export const channelDb = {
  getBindings: (channelType?: string) =>
    sendDbRequest('channel:getBindings', { channelType }),

  getBinding: (channelType: string, chatId: string) =>
    sendDbRequest('channel:getBinding', { channelType, chatId }),

  upsertBinding: (data: {
    id: string;
    channel_type: string;
    chat_id: string;
    duya_session_id: string;
    sdk_session_id?: string;
    working_directory?: string;
    model?: string;
    mode?: string;
  }) => sendDbRequest('channel:upsertBinding', data),

  getOffset: (channelType: string, offsetKey: string) =>
    sendDbRequest('channel:getOffset', { channelType, offsetKey }),

  setOffset: (
    channelType: string,
    offsetKey: string,
    offsetValue: string,
    offsetType = 'long_polling'
  ) => sendDbRequest('channel:setOffset', { channelType, offsetKey, offsetValue, offsetType }),
};

// ==================== Project Operations ====================

export const projectDb = {
  getGroups: () => sendDbRequest('project:getGroups', {}),
};

// ==================== Automation Operations ====================

export const automationDb = {
  listCrons: () => sendDbRequest('automation:cron:list', {}),

  createCron: (data: {
    name: string;
    description?: string | null;
    schedule: { kind: 'at' | 'every' | 'cron'; at?: string; everyMs?: number; cronExpr?: string; cronTz?: string | null };
    prompt: string;
    inputParams?: Record<string, unknown>;
    concurrencyPolicy?: 'skip' | 'parallel' | 'queue' | 'replace';
    maxRetries?: number;
    enabled?: boolean;
  }) => sendDbRequest('automation:cron:create', data),

  updateCron: (
    id: string,
    patch: {
      name?: string;
      description?: string | null;
      schedule?: { kind: 'at' | 'every' | 'cron'; at?: string; everyMs?: number; cronExpr?: string; cronTz?: string | null };
      prompt?: string;
      inputParams?: Record<string, unknown>;
      concurrencyPolicy?: 'skip' | 'parallel' | 'queue' | 'replace';
      maxRetries?: number;
      status?: 'enabled' | 'disabled' | 'error';
    }
  ) => sendDbRequest('automation:cron:update', { id, patch }),

  deleteCron: (id: string) => sendDbRequest('automation:cron:delete', { id }),

  runCron: (id: string) => sendDbRequest('automation:cron:run', { id }),

  listCronRuns: (input: { cronId: string; limit?: number; offset?: number }) =>
    sendDbRequest('automation:cron:runs', input),
};

// ==================== Config Operations (Self-Management) ====================

export const configDb = {
  appInfo: () => sendDbRequest('config:appInfo', {}),
  providerGetAll: () => sendDbRequest('config:provider:getAll', {}),
  providerGetActive: () => sendDbRequest('config:provider:getActive', {}),
  providerUpsert: (data: {
    id: string;
    name: string;
    providerType: string;
    baseUrl?: string;
    apiKey?: string;
    isActive?: boolean;
  }) => sendDbRequest('config:provider:upsert', data),
  providerDelete: (id: string) => sendDbRequest('config:provider:delete', { id }),
  providerActivate: (id: string) => sendDbRequest('config:provider:activate', { id }),
  agentGetSettings: () => sendDbRequest('config:agent:getSettings', {}),
  agentSetSettings: (patch: Record<string, unknown>) => sendDbRequest('config:agent:setSettings', patch),
  visionGet: () => sendDbRequest('config:vision:get', {}),
  visionSet: (patch: Record<string, unknown>) => sendDbRequest('config:vision:set', patch),
  outputStylesGet: () => sendDbRequest('config:outputStyles:get', {}),
  outputStylesSet: (patch: Record<string, unknown>) => sendDbRequest('config:outputStyles:set', patch),
  restart: (data: { sessionId: string; reason: string; resume: boolean }) =>
    sendDbRequest('agent:restart', data),

  healthTestProvider: (data: { providerId?: string }) =>
    sendDbRequest('health:testProvider', data),

  healthGatewayStatus: () =>
    sendDbRequest('health:gatewayStatus', {}),

  logsTail: (lines: number) =>
    sendDbRequest('logs:tail', { lines }),

  logsErrors: (lines: number) =>
    sendDbRequest('logs:errors', { lines }),
};

// Initialize client on module load
initDbClient();

/**
 * Close the DB client by rejecting all pending requests.
 * Called during agent process shutdown to prevent hanging requests.
 */
export function closeDbClient(): void {
  for (const [id, pending] of pendingRequests.entries()) {
    pending.reject(new Error('DB client closing'));
    pendingRequests.delete(id);
  }
}
