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
let dbClientInitialized = false;
export function initDbClient(): void {
  if (dbClientInitialized) return;
  dbClientInitialized = true;
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
    attachments?: unknown[];
  }) => sendDbRequest('message:add', data),

  getBySession: (sessionId: string) => sendDbRequest('message:getBySession', { sessionId }),

  getCount: (sessionId: string) => sendDbRequest('message:getCount', { sessionId }),

  deleteBySession: (sessionId: string) => sendDbRequest('message:deleteBySession', { sessionId }),

  replace: (sessionId: string, messages: unknown[], generation: number) =>
    sendDbRequest('message:replace', { sessionId, messages, generation }),

  append: (sessionId: string, messages: unknown[]) =>
    sendDbRequest('message:append', { sessionId, messages }),

  loadMessages: (sessionId: string) =>
    sendDbRequest('session:loadMessages', { sessionId }),
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

// ==================== Attachment Operations (parsed_document) ====================

export const attachmentDb = {
  storeParsedDocument: (
    messageId: string,
    sessionId: string,
    data: {
      filename: string;
      filePath: string;
      charCount: number;
      text: string;
      extractMethod?: string;
      imageChunks?: Array<{ base64: string; mediaType: string }>;
    }
  ) => sendDbRequest('attachment:store', { messageId, sessionId, ...data }),

  getParsedDocumentsForSession: (sessionId: string) =>
    sendDbRequest('attachment:getForSession', { sessionId }),

  getParsedDocumentsForMessage: (messageId: string) =>
    sendDbRequest('attachment:getForMessage', { messageId }),
};

// ==================== Project Operations ====================

export const projectDb = {
  getGroups: () => sendDbRequest('project:getGroups', {}),
};

// ==================== Research Session Operations ====================

export const researchSessionDb = {
  create: (data: {
    id: string;
    session_id: string;
    original_query: string;
    clarification?: string;
    context_json: string;
    status?: 'active' | 'completed' | 'aborted';
    title?: string;
    run_status?: string;
  }) => sendDbRequest('researchSession:create', data),

  get: (id: string) => sendDbRequest('researchSession:get', { id }),

  getBySessionId: (sessionId: string) =>
    sendDbRequest('researchSession:getBySessionId', { sessionId }),

  update: (id: string, data: {
    clarification?: string;
    context_json?: string;
    status?: 'active' | 'completed' | 'aborted';
    current_phase?: string;
    iterations?: number;
    coverage?: number;
    title?: string;
    run_status?: string;
    plan_version?: number;
    active_step_id?: string | null;
    progress_summary?: string | null;
    completed_at?: number | null;
    error_json?: string | null;
  }) => sendDbRequest('researchSession:update', { id, ...data }),

  delete: (id: string) => sendDbRequest('researchSession:delete', { id }),

  list: (limit?: number) => sendDbRequest('researchSession:list', { limit }),

  listByStatus: (status: 'active' | 'completed' | 'aborted') =>
    sendDbRequest('researchSession:listByStatus', { status }),

  getActiveRun: (sessionId: string) =>
    sendDbRequest('researchSession:getActiveRun', { sessionId }),

  listActiveRuns: () =>
    sendDbRequest('researchSession:listActiveRuns', {}),
};

// ==================== Research Plan Step Operations ====================

export const researchPlanStepDb = {
  createSteps: (runId: string, steps: Array<{
    id: string;
    order_num: number;
    user_facing_label: string;
    internal_question_ids: string[];
  }>) => sendDbRequest('researchPlanStep:createSteps', { runId, steps }),

  getByRunId: (runId: string) =>
    sendDbRequest('researchPlanStep:getByRunId', { runId }),

  update: (stepId: string, data: {
    status?: 'pending' | 'active' | 'completed' | 'skipped' | 'failed';
    started_at?: number | null;
    completed_at?: number | null;
  }) => sendDbRequest('researchPlanStep:update', { stepId, ...data }),

  deleteByRunId: (runId: string) =>
    sendDbRequest('researchPlanStep:deleteByRunId', { runId }),
};

// ==================== Research Activity Operations ====================

export const researchActivityDb = {
  create: (data: {
    id: string;
    run_id: string;
    sequence: number;
    kind: string;
    title: string;
    detail?: string;
    visibility?: 'user' | 'debug';
  }) => sendDbRequest('researchActivity:create', data),

  getByRunId: (runId: string, options?: {
    visibility?: 'user' | 'debug';
    limit?: number;
    afterSequence?: number;
  }) => sendDbRequest('researchActivity:getByRunId', { runId, ...options }),

  getMaxSequence: (runId: string) =>
    sendDbRequest('researchActivity:getMaxSequence', { runId }),

  deleteByRunId: (runId: string) =>
    sendDbRequest('researchActivity:deleteByRunId', { runId }),
};

// ==================== Research Artifact Operations ====================

export const researchEventDb = {
  create: (data: {
    id: string;
    run_id: string;
    sequence: number;
    event_type: string;
    payload_json: string;
    visibility?: 'user' | 'debug';
  }) => sendDbRequest('researchEvent:create', data),

  getByRunId: (runId: string, options?: {
    visibility?: 'user' | 'debug';
    limit?: number;
    afterSequence?: number;
  }) => sendDbRequest('researchEvent:getByRunId', { runId, ...options }),

  getMaxSequence: (runId: string) =>
    sendDbRequest('researchEvent:getMaxSequence', { runId }),
};

export const researchSourceDb = {
  upsert: (data: {
    id: string;
    run_id: string;
    title: string;
    url?: string | null;
    canonical_url?: string | null;
    source_type?: string;
    allowed_by_policy?: boolean;
    reliability_json?: string | null;
    dedupe_key?: string | null;
    rejected_reason?: string | null;
    metadata_json?: string | null;
  }) => sendDbRequest('researchSource:upsert', data),

  getByRunId: (runId: string) =>
    sendDbRequest('researchSource:getByRunId', { runId }),
};

export const researchCitationDb = {
  create: (data: {
    id: string;
    run_id: string;
    report_id?: string | null;
    source_id: string;
    finding_id?: string | null;
    claim: string;
    locator_json?: string | null;
    quoted_evidence?: string | null;
  }) => sendDbRequest('researchCitation:create', data),

  getByRunId: (runId: string, reportId?: string) =>
    sendDbRequest('researchCitation:getByRunId', { runId, reportId }),
};

export const researchReportDb = {
  upsert: (data: {
    id: string;
    run_id: string;
    title?: string | null;
    markdown: string;
    outline_json?: string | null;
    source_ids_json?: string;
    citation_ids_json?: string;
    activity_summary_json?: string | null;
    export_metadata_json?: string | null;
  }) => sendDbRequest('researchReport:upsert', data),

  getLatest: (runId: string) =>
    sendDbRequest('researchReport:getLatest', { runId }),
};

// ==================== Literature Plugin Operations ====================

export const literatureDb = {
  sourceCreate: (data: {
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
    citationKey?: string
    bibtex?: string
    projectIds?: string[]
    tags?: string[]
  }) => sendDbRequest('literature:source:create', data),

  sourceGet: (id: string) => sendDbRequest('literature:source:get', { id }),

  sourceList: (options?: {
    kind?: string
    projectId?: string
    tags?: string[]
    yearFrom?: number
    yearTo?: number
    search?: string
    limit?: number
  }) => sendDbRequest('literature:source:list', options || {}),

  sourceUpdate: (id: string, data: Record<string, unknown>) =>
    sendDbRequest('literature:source:update', { id, ...data }),

  sourceDelete: (id: string) => sendDbRequest('literature:source:delete', { id }),

  evidenceCreateMany: (spans: Array<{
    id: string
    sourceId: string
    page?: number
    section?: string
    text: string
    quote?: string
    bbox?: { page: number; x: number; y: number; width: number; height: number }
  }>) => sendDbRequest('literature:evidence:createMany', { spans }),

  evidenceSearch: (query: string, options?: {
    sourceId?: string
    page?: number
    section?: string
  }) => sendDbRequest('literature:evidence:search', { query, ...options }),

  evidenceDeleteBySource: (sourceId: string) =>
    sendDbRequest('literature:evidence:deleteBySource', { sourceId }),

  paperCardUpsert: (data: {
    id: string
    sourceId: string
    card: Record<string, unknown>
    evidenceSpanIds: string[]
  }) => sendDbRequest('literature:paperCard:upsert', data),

  paperCardGet: (sourceId: string) =>
    sendDbRequest('literature:paperCard:get', { sourceId }),

  paperCardDelete: (sourceId: string) =>
    sendDbRequest('literature:paperCard:delete', { sourceId }),
}

// ==================== Research Memory Operations ====================

export const researchMemoryDb = {
  projectCreate: (data: {
    id: string
    name: string
    description?: string
  }) => sendDbRequest('researchMemory:project:create', data),

  projectGet: (id: string) => sendDbRequest('researchMemory:project:get', { id }),

  projectList: () => sendDbRequest('researchMemory:project:list', {}),

  projectUpdate: (id: string, data: Record<string, unknown>) =>
    sendDbRequest('researchMemory:project:update', { id, ...data }),

  projectDelete: (id: string) => sendDbRequest('researchMemory:project:delete', { id }),

  projectStateGet: (projectId: string) =>
    sendDbRequest('researchMemory:projectState:get', { projectId }),

  projectStateUpsert: (projectId: string, state: Record<string, unknown>) =>
    sendDbRequest('researchMemory:projectState:upsert', { projectId, state }),

  memoryObjectCreate: (data: {
    id: string
    projectId: string
    type: string
    content: string
    summary?: string
    sourceRefs?: unknown[]
    relationRefs?: unknown[]
    validFrom?: number
    validTo?: number
    status?: string
    confidence?: number
    importance?: number
    tags?: string[]
  }) => sendDbRequest('researchMemory:object:create', data),

  memoryObjectGet: (id: string) => sendDbRequest('researchMemory:object:get', { id }),

  memoryObjectListByProject: (projectId: string, options?: {
    type?: string
    status?: string
    limit?: number
  }) => sendDbRequest('researchMemory:object:listByProject', { projectId, ...options }),

  memoryObjectSearch: (query: string, projectId?: string, options?: {
    type?: string
    status?: string
    limit?: number
  }) => sendDbRequest('researchMemory:object:search', { query, projectId, ...options }),

  memoryObjectUpdate: (id: string, data: Record<string, unknown>) =>
    sendDbRequest('researchMemory:object:update', { id, ...data }),

  memoryObjectDelete: (id: string) =>
    sendDbRequest('researchMemory:object:delete', { id }),

  hypothesisCreate: (data: {
    id: string
    projectId: string
    statement: string
    status?: string
    supportingEvidenceIds?: string[]
    contradictingEvidenceIds?: string[]
    relatedSourceIds?: string[]
  }) => sendDbRequest('researchMemory:hypothesis:create', data),

  hypothesisGet: (id: string) => sendDbRequest('researchMemory:hypothesis:get', { id }),

  hypothesisListByProject: (projectId: string) =>
    sendDbRequest('researchMemory:hypothesis:listByProject', { projectId }),

  hypothesisUpdate: (id: string, data: {
    status?: string
    supersededBy?: string
    supportingEvidenceIds?: string[]
    contradictingEvidenceIds?: string[]
    relatedSourceIds?: string[]
  }) => sendDbRequest('researchMemory:hypothesis:update', { id, ...data }),

  hypothesisDelete: (id: string) =>
    sendDbRequest('researchMemory:hypothesis:delete', { id }),

  candidateCreate: (data: {
    id: string
    projectId: string
    proposedType: string
    content: string
    rationale: string
    sourceRefs?: unknown[]
    confidence?: number
    createdBySessionId?: string
  }) => sendDbRequest('researchMemory:candidate:create', data),

  candidateListByProject: (projectId: string, status?: string) =>
    sendDbRequest('researchMemory:candidate:listByProject', { projectId, status }),

  candidateGet: (id: string) => sendDbRequest('researchMemory:candidate:get', { id }),

  candidateAccept: (id: string, options?: { embeddingJson?: string }) =>
    sendDbRequest('researchMemory:candidate:accept', { id, ...options }),

  candidateReject: (id: string) => sendDbRequest('researchMemory:candidate:reject', { id }),

  candidateDelete: (id: string) => sendDbRequest('researchMemory:candidate:delete', { id }),

  objectUpdateEmbedding: (id: string, embeddingJson: string | null) =>
    sendDbRequest('researchMemory:object:updateEmbedding', { id, embedding_json: embeddingJson }),

  objectListWithEmbeddings: (projectId?: string, limit?: number) =>
    sendDbRequest('researchMemory:object:listWithEmbeddings', { projectId, limit }),

  relationCreate: (data: {
    projectId: string
    fromMemoryId: string
    toMemoryId: string
    relationType: string
  }) => sendDbRequest('researchMemory:relation:create', data),

  relationListByMemory: (memoryId: string) =>
    sendDbRequest('researchMemory:relation:listByMemory', { memoryId }),

  relationListByProject: (projectId: string) =>
    sendDbRequest('researchMemory:relation:listByProject', { projectId }),

  relationDelete: (id: string) => sendDbRequest('researchMemory:relation:delete', { id }),
}

export const pluginDb = {
  registryList: () => sendDbRequest('plugin:registry:list', {}),
}

// ==================== Model Capability Operations ====================

export const modelCapabilityDb = {
  get: (modelName: string) => sendDbRequest('modelCapability:get', { modelName }),
  set: (modelName: string, isMultimodal: boolean, method: string) =>
    sendDbRequest('modelCapability:set', { modelName, isMultimodal, method }),
  delete: (modelName: string) => sendDbRequest('modelCapability:delete', { modelName }),
};

// ==================== Mailbox Operations ====================

export const mailboxDb = {
  send: (data: {
    id: string;
    sessionId: string;
    submittedDuringRunId: string;
    content: string;
    kind: string;
    attachments?: unknown[];
    clientMsgId?: string;
    source?: string;
    constraintsJson?: string;
  }) => sendDbRequest('mailbox:send', data),

  edit: (id: string, patch: { content?: string; kind?: string }) =>
    sendDbRequest('mailbox:edit', { id, ...patch }),

  cancel: (id: string, reason?: string) =>
    sendDbRequest('mailbox:cancel', { id, reason }),

  list: (sessionId: string, opts?: { status?: string[]; limit?: number }) =>
    sendDbRequest('mailbox:list', { sessionId, ...opts }),

  listForSession: (sessionId: string) =>
    sendDbRequest('mailbox:listForSession', { sessionId }),
};

// ==================== Automation Operations ====================

export const automationDb = {
  listCrons: () => sendDbRequest('automation:cron:list', {}),

  createCron: (data: {
    name: string;
    description?: string | null;
    schedule: { kind: 'at' | 'every' | 'cron'; at?: string; everyMs?: number; cronExpr?: string; cronTz?: string | null };
    prompt: string;
    model: string;
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

  pairingListPending: () => sendDbRequest('pairing:listPending', {}),

  pairingListApproved: (platform?: string) => sendDbRequest('pairing:listApproved', { platform }),

  pairingApprove: (platform: string, code: string) =>
    sendDbRequest('pairing:approve', { platform, code }),

  pairingRevoke: (platform: string, platformUserId: string) =>
    sendDbRequest('pairing:revoke', { platform, platformUserId }),

  pairingIsApproved: (platform: string, platformUserId: string) =>
    sendDbRequest('pairing:isApproved', { platform, platformUserId }),
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
