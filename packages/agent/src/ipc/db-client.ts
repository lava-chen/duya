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
      try {
        process.send!(request);
      } catch (err) {
        // H4: process.send can throw if the IPC channel is closed
        if (pendingRequests.has(id)) {
          pendingRequests.delete(id);
          reject(new Error(`Failed to send DB request: ${err instanceof Error ? err.message : String(err)}`));
        }
      }
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
    // Not an error: this module is loaded (and its message listener registered)
    // in every process that imports anything from it — including the
    // agent-server, which pulls in messageDb via the memory-rollout extractor.
    // Every process observes every db:response flowing through it, but only the
    // one that issued the request holds a matching pending entry; the rest see
    // responses destined for a sibling process (e.g. a worker being routed via
    // the agent-server). Log at DEBUG level (via env gate) so a genuinely lost
    // response in the issuing process is still diagnosable without warning on
    // every cross-process response.
    if (process.env.DUYA_DEBUG_DB_CLIENT === '1') {
      console.warn('[DB-Client] Received response for unknown request:', response.id);
    }
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

  search: (query: string, opts?: { limit?: number }) =>
    sendDbRequest('session:search', { query, opts }),
};

// Plan 504 — session spawn (grok CloudAgent parity). The worker asks MAIN to
// create a real project-scoped child session and run it asynchronously. MAIN
// returns the child session id immediately; completion/failure wakes the parent.
// Phase 2 adds continuous management scoped to sessions the caller spawned.
export const sessionSpawnDb = {
  spawn: (data: {
    parentSessionId: string;
    workingDirectory: string;
    prompt: string;
    model?: string;
  }) => sendDbRequest('session:spawn', data),

  list: (parentSessionId: string) => sendDbRequest('session:spawnList', { parentSessionId }),

  get: (sessionId: string, callerSessionId: string) =>
    sendDbRequest('session:spawnGet', { sessionId, callerSessionId }),

  reply: (data: { sessionId: string; callerSessionId: string; prompt: string; model?: string }) =>
    sendDbRequest('session:spawnReply', data),

  cancel: (sessionId: string, callerSessionId: string) =>
    sendDbRequest('session:spawnCancel', { sessionId, callerSessionId }),

  rename: (sessionId: string, callerSessionId: string, title: string) =>
    sendDbRequest('session:spawnRename', { sessionId, callerSessionId, title }),
};

// ==================== Message Operations ====================

export const messageDb = {
  add: (data: {
    id: string;
    session_id: string;
    role: string;
    content: unknown;
    display_content?: string | null;
    displayContent?: unknown;
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

  append: (sessionId: string, messages: unknown[], turnId?: string | null) =>
    sendDbRequest('message:append', { sessionId, messages, turnId }),

  /**
   * Plan 441: emit a typed RolloutEvent (rebase, hook_invoked, etc.) into the
   * session's rollout JSONL. Routes to `journal:emit` on the db-bridge; the
   * adapter preserves the event's `type` discriminator so MessageLog stores it
   * as a RolloutEvent row rather than a MessageEntry.
   */
  emit: (sessionId: string, event: unknown, turnId?: string | null) =>
    sendDbRequest('journal:emit', { sessionId, event, turnId }),

  loadMessages: (sessionId: string) =>
    sendDbRequest('session:loadMessages', { sessionId }),
};

// ==================== Tool Approval State (plan 498) ====================

export const toolApprovalDb = {
  create: (data: {
    id: string;
    messageId: string;
    sessionId: string;
    scopeType: 'bot' | 'session';
    scopeId: string;
    toolName: string;
    toolInput?: Record<string, unknown>;
  }) => sendDbRequest('toolApproval:create', data),

  /** One-shot ledger consume: CAS approved → consumed on tool+input-hash match. */
  consumeApproved: (data: {
    sessionId: string;
    toolName: string;
    toolInput?: Record<string, unknown>;
  }) => sendDbRequest('toolApproval:consumeApproved', data),

  listRules: (data: { scopeType: 'bot' | 'session'; scopeId: string }) =>
    sendDbRequest('toolApproval:listRules', data),
};



// ==================== SendMessage side-state Operations ====================
// Plan 489 P0.2: persist interaction state for card-shaped SendMessage (widget /
// cursor-agent / secret-request) in the three legacy-main-DB side tables.
// `messageId` is the id returned by messageDb.append. All helpers are best-effort:
// a write failure resolves to { success: false } rather than rejecting, so the
// tool's main send path is never blocked by state persistence.

export const sendMessageStateDb = {
  createWidgetPending: (data: {
    id: string;
    messageId: string;
    sessionId: string;
    botAgentId: string;
    prompt: string;
    widgetJson: string;
    createdAt: number;
  }) => sendDbRequest('sendMessageState:createWidgetPending', data),

  updateWidgetResponse: (data: {
    messageId: string;
    status: 'pending' | 'answered' | 'dismissed';
    customAnswer?: string | null;
    answeredAt?: number | null;
  }) => sendDbRequest('sendMessageState:updateWidgetResponse', data),

  upsertCursorAgentRun: (data: {
    id: string;
    messageId: string;
    sessionId: string;
    bcId: string;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'aborted';
    createdAt: number;
    updatedAt: number;
  }) => sendDbRequest('sendMessageState:upsertCursorAgentRun', data),

  updateCursorAgentRun: (data: {
    messageId: string;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'aborted';
    updatedAt: number;
  }) => sendDbRequest('sendMessageState:updateCursorAgentRun', data),

  createSecretPending: (data: {
    id: string;
    messageId: string;
    sessionId: string;
    label: string;
    connector: string;
    field: string;
    createdAt: number;
  }) => sendDbRequest('sendMessageState:createSecretPending', data),

  markSecretProvided: (data: {
    messageId: string;
    status: 'provided' | 'dismissed';
    providedAt?: number | null;
  }) => sendDbRequest('sendMessageState:markSecretProvided', data),
};

export const turnReviewDb = {
  save: (data: {
    id: string;
    sessionId: string;
    turnId: string;
    workingDirectory: string;
    files: unknown[];
    patch: string;
    additions: number;
    removals: number;
    truncated: boolean;
    binary: boolean;
    capturedAt: number;
  }) => sendDbRequest('turn-review:save', data),
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

// ==================== Goal Operations ====================
// Plan 331 Phase 2: per-session goal + token budget mirror. The agent
// reports token/time deltas after each turn; on session resume the
// persisted counters are read back into the in-memory TokenBudgetManager.

export const goalDb = {
  get: (sessionId: string) => sendDbRequest('goal:get', { sessionId }),

  create: (data: {
    id: string;
    session_id: string;
    goal_text?: string | null;
    token_budget?: number | null;
  }) => sendDbRequest('goal:create', data),

  updateBudget: (sessionId: string, delta: {
    tokensUsedDelta?: number;
    timeUsedDelta?: number;
  }) => sendDbRequest('goal:updateBudget', { sessionId, ...delta }),

  setStatus: (sessionId: string, status: 'active' | 'paused' | 'usage_limited' | 'complete') =>
    sendDbRequest('goal:setStatus', { sessionId, status }),

  listByStatus: (status: 'active' | 'paused' | 'usage_limited' | 'complete') =>
    sendDbRequest('goal:listByStatus', { status }),
};

// ==================== Mode State Operations ====================
// Plan 413c: per (session, mode) ModeTracker snapshot. The agent persists a
// snapshot after a tracker state transition and restores it on session resume
// (see modes/engine/persistence.ts). `snapshotJson` carries the full
// `ModeStateSnapshot` payload; `status`/`reminderCount` mirror query columns.

/** Row shape of the core-db `mode_state_snapshots` table (IPC view). */
export interface ModeStateRow {
  sessionId: string;
  mode: string;
  status: string;
  reminderCount: number;
  snapshotJson: string;
  updatedAt: number;
}

export const modeStateDb = {
  get: (sessionId: string, mode: string): Promise<ModeStateRow | null> =>
    sendDbRequest('modeState:get', { sessionId, mode }) as Promise<ModeStateRow | null>,

  upsert: (input: {
    sessionId: string;
    mode: string;
    status: string;
    snapshotJson: string;
    reminderCount?: number;
  }): Promise<void> => sendDbRequest('modeState:upsert', input) as Promise<void>,

  setStatus: (input: { sessionId: string; mode: string; status: string }): Promise<void> =>
    sendDbRequest('modeState:setStatus', input) as Promise<void>,

  listBySession: (sessionId: string): Promise<ModeStateRow[]> =>
    sendDbRequest('modeState:listBySession', { sessionId }) as Promise<ModeStateRow[]>,
};

// ==================== Task Operations ====================

export const taskDb = {
  create: (data: {
    id: string;
    session_id: string;
    subject: string;
    description: string;
    status?: string;
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

  /**
   * Plan 488 P2.1: deliver a SendMessage payload to an external channel via the
   * registered ChannelTransport (Discord, Slack, etc.).
   *
   * Used by SendMessageTool when the bot invocation includes a "channel" address
   * token (e.g. "slack:C12345"). The agent subprocess never imports the electron
   * channel-delivery module directly — it goes through db-bridge IPC which calls
   * ChannelBackgroundWakes.deliverToChannel (handles failure wake queue).
   *
   * Returns { success: true } on success or { success: false, reason } on failure.
   */
  deliver: (input: {
    sessionId: string;
    channelAddress: string;
    outbound: { content: string; url?: string; caption?: string };
  }) => sendDbRequest('channel:deliver', input) as Promise<{ success: boolean; reason?: string }>,
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

  /**
   * Plan 536 L4: lightweight cwd -> projectId reverse-lookup. Returns
   * `{ projectId, paths }` when the cwd belongs to a registered duya
   * project, or `{ projectId: null, paths: null }` when it doesn't (or
   * cwd is unparseable / memory-state DB unavailable).
   *
   * Distinct from `projects:resolveAdditionalRoots` which also returns
   * the writable-root fan-out. This is the canonical answer for the
   * L1 session bootstrap injection and any CLI/runtime caller that
   * only needs to know "which project is this cwd in?".
   *
   * Plan 525 / 408 follow-up: the response now also carries
   * `projectHome` (the project's entity home directory
   * `~/.duya/projects/<projectId>/`). The agent subprocess consumes it
   * to feed the agentsmd loader's `'Project entity'` source. Same
   * null-on-miss semantics as the rest of the payload.
   */
  resolveProject: (workingDirectory: string): Promise<{
    projectId: string | null;
    paths: string[] | null;
    /**
     * Project-entity home directory (`~/.duya/projects/<projectId>/`).
     * Null when no project is bound to the cwd. When set, the agent
     * subprocess uses this string to feed the agentsmd loader via
     * `promptSystem.buildContext({ projectHome })` →
     * `preBuildHook` → `initializeAgentsMd`.
     */
    projectHome: string | null;
  }> =>
    sendDbRequest('projects:resolveProject', { workingDirectory }) as Promise<{
      projectId: string | null;
      paths: string[] | null;
      projectHome: string | null;
    }>,
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

  /**
   * Fetch all plugin setup values as a `{ [pluginId]: { [setupKey]: value } }`
   * map. Used by the MCP loader to expand `${setup.X}` references in
   * plugin manifests. Returns an empty object when the setup table is
   * absent (e.g. before the setup-storage migration has run).
   */
  setupListAll: () => sendDbRequest('plugin:setup:list-all', {}),
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

  guide: (id: string) =>
    sendDbRequest('mailbox:guide', { id }),

  cancel: (id: string, reason?: string) =>
    sendDbRequest('mailbox:cancel', { id, reason }),

  list: (sessionId: string, opts?: { status?: string[]; limit?: number }) =>
    sendDbRequest('mailbox:list', { sessionId, ...opts }),

  listForSession: (sessionId: string) =>
    sendDbRequest('mailbox:listForSession', { sessionId }),

  claimBatch: (input: {
    sessionId: string;
    runId: string;
    checkpoint: string;
    limit?: number;
    leaseMs?: number;
    coalesceWindowMs?: number;
    maxClaimAttempts?: number;
  }) => sendDbRequest('mailbox:claimBatch', input),

  apply: (input: {
    id: string;
    claimToken: string;
    mode: string;
    checkpoint: string;
    summary?: string;
    resultingUserMsgId?: string;
  }) => sendDbRequest('mailbox:apply', input),

  cancelByAgent: (input: { id: string; claimToken: string; reason: string }) =>
    sendDbRequest('mailbox:cancelByAgent', input),
};

// ==================== Automation Operations ====================

export const automationDb = {
  listCrons: () => sendDbRequest('automation:cron:list', {}),

  createCron: (data: {
    name: string;
    prompt: string;
    /** Optional: event-only routines omit schedule (matches CreateAutomationCronInput). */
    schedule?: { kind: 'once' | 'every' | 'cron'; every?: string; at?: string; expr?: string; tz?: string | null; endAt?: string | null };
    workingDirectory?: string;
    model?: string;
    concurrencyPolicy?: 'skip' | 'parallel' | 'replace';
    maxRetries?: number;
    enabled?: boolean;
    /** Plan 476 P2.3b — bot binding; ManageRoutineTool always sets it to the CALLING bot. */
    agent?: string;
    /** Plan 476 P2.3d — event listeners (github/slack specs). */
    eventTriggers?: Array<Record<string, unknown>>;
  }) => sendDbRequest('automation:cron:create', data) as Promise<{ id: string; name: string }>,

  updateCron: (
    id: string,
    patch: {
      name?: string;
      prompt?: string;
      schedule?: { kind: 'once' | 'every' | 'cron'; every?: string; at?: string; expr?: string; tz?: string | null; endAt?: string | null };
      workingDirectory?: string;
      model?: string;
      concurrencyPolicy?: 'skip' | 'parallel' | 'replace';
      maxRetries?: number;
      enabled?: boolean;
      /** Set to null to clear an existing bot binding. */
      agent?: string | null;
      /** Plan 476 P2.3d — replace the event listener set. */
      eventTriggers?: Array<Record<string, unknown>>;
    }
  ) => sendDbRequest('automation:cron:update', { id, patch }) as Promise<{ id: string; name: string }>,

  deleteCron: (id: string) => sendDbRequest('automation:cron:delete', { id }),

  runCron: (id: string) => sendDbRequest('automation:cron:run', { id }),

  // A cron's run history is its ordinary sessions (id prefix `cron:<jobId>:`).
  listCronSessions: (input: { cronId: string; limit?: number; offset?: number }) =>
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

  /**
   * Plan 492 P4.2: agent-side CreateAgent/UpdateAgent tool persistence.
   * Routes to the db-bridge config:agents:create / config:agents:update
   * cases, which own the config.toml `[agents.<id>]` write in the main
   * process (the agent subprocess never mutates the config store).
   * create returns the ACTUAL id — the requested name is slugified and
   * allocateBotId may suffix it on collision.
   */
  agentCreate: (data: { name: string; description?: string; avatarEmoji?: string }) =>
    sendDbRequest('config:agents:create', data) as Promise<{ id: string; name: string }>,

  agentUpdate: (data: { agentId: string; name?: string; description?: string; avatarEmoji?: string }) =>
    sendDbRequest('config:agents:update', data) as Promise<{ id: string; name: string }>,
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
