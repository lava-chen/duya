/**
 * Stage 1 extractor orchestration (Plan 304 Phase E, design v3 D2/D8/D9).
 *
 * Lifecycle: lease → compact → LLM → validate → write projection → complete
 * → persist Stage 1 output. Heartbeats every TTL/6 for the duration of
 * the LLM call. Validation enforces the D8 promotion constraints BEFORE
 * any stage1_outputs row is written.
 *
 * Shadow mode: no production caller until Plan 305 wires the worker.
 */

import type { Database } from 'better-sqlite3';
import type { LLMClient } from '../llm/index.js';
import type { Message } from '../types.js';
import {
  acquireLease,
  heartbeat,
  complete,
  fail,
  HEARTBEAT_DIVISOR,
  DEFAULT_LEASE_TTL_MS,
} from '../memory-state/lease.js';
import { compactMessages, type MessageEvent } from './compactMessages.js';
import { STAGE1_SYSTEM_PROMPT, STAGE1_USER_PROMPT_TEMPLATE } from './prompt.js';
import {
  writeRolloutProjection,
  redactCredentials,
  MAX_SUMMARY_CHARS,
} from './writer.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LLM_TIMEOUT_MS = 120_000;
const LLM_MAX_TOKENS = 4_096;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ExtractInput {
  rolloutId: string;
  claimedBy: string;
  leaseTtlMs?: number;
  /**
   * Existing canonical_keys from `memory_entries`, injected into the user
   * prompt so the LLM can reuse semantically equivalent keys instead of
   * inventing new ones. When undefined, the extractor queries the memory
   * DB itself; when explicitly null, the keys section is omitted.
   */
  existingKeys?: string[] | null;
}

export interface ExtractResult {
  status: 'committed' | 'succeeded_no_output' | 'noop_skipped' | 'stale_source' | 'failed';
  contentOutcome: 'success' | 'partial' | 'fail' | 'uncertain' | null;
  projectionPath: string | null;
  stage1RowId: string;
  durationMs: number;
  errorMessage?: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_JOB_STATUS = new Set(['succeeded', 'succeeded_no_output']);
const VALID_CONTENT_OUTCOME = new Set(['success', 'partial', 'fail', 'uncertain']);
const VALID_CLAIM_TYPE = new Set(['preference', 'fact', 'reference', 'procedure', 'person', 'area']);
const VALID_SOURCE_TYPE = new Set([
  'user_message',
  'local_tool_output',
  'browser_page',
  'mcp_response',
  'subagent_report',
  'assistant_only',
]);
const VALID_VERIFICATION = new Set(['none', 'inferred', 'observed', 'verified_code', 'verified_user']);
const EXTERNAL_SOURCE_TYPES = new Set(['browser_page', 'mcp_response']);

export interface ParsedExtraction {
  job_status: 'succeeded' | 'succeeded_no_output';
  content_outcome: 'success' | 'partial' | 'fail' | 'uncertain' | null;
  rollout_summary: string;
  rollout_slug: string;
  raw_memory: {
    items: Array<{
      claim: string;
      claim_type: string;
      scope: 'global';
      evidence: Array<{
        source_type: string;
        source_id: string;
        verification?: string;
      }>;
      canonical_key: string;
    }>;
  };
}

export type ValidationResult = { valid: true; result: ParsedExtraction } | { valid: false; error: string };

function validateSlug(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (!/^[a-z0-9-]{3,80}$/.test(value)) return null;
  return value;
}

/**
 * Parse and validate the LLM response against the Stage 1 schema (D8).
 * Rejects:
 *   - invalid JSON → 'invalid-json'
 *   - bad job_status → 'bad-job-status'
 *   - external source item with claim_type preference/procedure → 'invalid-promotion'
 *   - missing/duplicate required fields → 'schema-violation'
 */
export function parseAndValidate(response: string): ValidationResult {
  // Strip markdown fences if present.
  let text = response.trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { valid: false, error: 'invalid-json' };
  }

  if (typeof data !== 'object' || data === null) {
    return { valid: false, error: 'invalid-json' };
  }

  const obj = data as Record<string, unknown>;
  const jobStatus = obj.job_status;
  if (typeof jobStatus !== 'string' || !VALID_JOB_STATUS.has(jobStatus)) {
    return { valid: false, error: 'bad-job-status' };
  }

  // succeeded_no_output: content fields are empty by contract.
  if (jobStatus === 'succeeded_no_output') {
    return {
      valid: true,
      result: {
        job_status: 'succeeded_no_output',
        content_outcome: null,
        rollout_summary: '',
        rollout_slug: validateSlug(obj.rollout_slug) ?? 'no-output',
        raw_memory: { items: [] },
      },
    };
  }

  // succeeded: validate full structure.
  const contentOutcome = obj.content_outcome;
  if (typeof contentOutcome !== 'string' || !VALID_CONTENT_OUTCOME.has(contentOutcome)) {
    return { valid: false, error: 'schema-violation' };
  }

  const rolloutSummary = obj.rollout_summary;
  if (typeof rolloutSummary !== 'string') {
    return { valid: false, error: 'schema-violation' };
  }

  const rolloutSlug = validateSlug(obj.rollout_slug);
  if (!rolloutSlug) {
    return { valid: false, error: 'schema-violation' };
  }

  const rawMemory = obj.raw_memory;
  if (typeof rawMemory !== 'object' || rawMemory === null) {
    return { valid: false, error: 'schema-violation' };
  }

  const items = (rawMemory as Record<string, unknown>).items;
  if (!Array.isArray(items)) {
    return { valid: false, error: 'schema-violation' };
  }

  const seenKeys = new Set<string>();
  const validatedItems: ParsedExtraction['raw_memory']['items'] = [];

  if (items.length > 5) {
    return { valid: false, error: 'schema-violation' };
  }

  for (const item of items) {
    if (typeof item !== 'object' || item === null) {
      return { valid: false, error: 'schema-violation' };
    }

    const itemObj = item as Record<string, unknown>;
    const claim = itemObj.claim;
    if (typeof claim !== 'string' || claim.length === 0) {
      return { valid: false, error: 'schema-violation' };
    }

    const claimType = itemObj.claim_type;
    if (typeof claimType !== 'string' || !VALID_CLAIM_TYPE.has(claimType)) {
      return { valid: false, error: 'schema-violation' };
    }

    const scope = itemObj.scope;
    if (scope !== 'global') {
      return { valid: false, error: 'schema-violation' };
    }

    const canonicalKey = itemObj.canonical_key;
    if (typeof canonicalKey !== 'string' || canonicalKey.length === 0) {
      return { valid: false, error: 'schema-violation' };
    }
    if (seenKeys.has(canonicalKey)) {
      return { valid: false, error: 'schema-violation' };
    }
    seenKeys.add(canonicalKey);

    // Enforce canonical_key prefix for person/area claim types.
    if (claimType === 'person' && !canonicalKey.startsWith('person:')) {
      return { valid: false, error: 'invalid-promotion' };
    }
    if (claimType === 'area' && !canonicalKey.startsWith('area:')) {
      return { valid: false, error: 'invalid-promotion' };
    }
    const expectedPrefix = `${claimType}:`;
    if (!canonicalKey.startsWith(expectedPrefix)) {
      return { valid: false, error: 'invalid-promotion' };
    }

    const evidence = itemObj.evidence;
    if (!Array.isArray(evidence) || evidence.length === 0) {
      return { valid: false, error: 'schema-violation' };
    }

    let externalSourceCount = 0;
    let unverifiedAssistantCount = 0;

    for (const ev of evidence) {
      if (typeof ev !== 'object' || ev === null) {
        return { valid: false, error: 'schema-violation' };
      }
      const evObj = ev as Record<string, unknown>;
      const sourceType = evObj.source_type;
      if (typeof sourceType !== 'string' || !VALID_SOURCE_TYPE.has(sourceType)) {
        return { valid: false, error: 'schema-violation' };
      }
      const sourceId = evObj.source_id;
      if (typeof sourceId !== 'string' || sourceId.length === 0) {
        return { valid: false, error: 'schema-violation' };
      }
      const verification = evObj.verification;
      if (
        verification !== undefined &&
        (typeof verification !== 'string' || !VALID_VERIFICATION.has(verification))
      ) {
        return { valid: false, error: 'schema-violation' };
      }
      if (EXTERNAL_SOURCE_TYPES.has(sourceType)) {
        externalSourceCount += 1;
      }
      if (sourceType === 'assistant_only' && (verification === 'none' || verification === undefined)) {
        unverifiedAssistantCount += 1;
      }
    }

    // D8: external-only evidence cannot become preference or procedure.
    if (
      externalSourceCount === evidence.length &&
      (claimType === 'preference' || claimType === 'procedure')
    ) {
      return { valid: false, error: 'invalid-promotion' };
    }

    // D8: unverified assistant-only claims cannot become preference.
    if (unverifiedAssistantCount === evidence.length && claimType === 'preference') {
      return { valid: false, error: 'invalid-promotion' };
    }

    validatedItems.push({
      claim,
      claim_type: claimType,
      scope,
      evidence: evidence as ParsedExtraction['raw_memory']['items'][0]['evidence'],
      canonical_key: canonicalKey,
    });
  }

  return {
    valid: true,
    result: {
      job_status: 'succeeded',
      content_outcome: contentOutcome as ParsedExtraction['content_outcome'],
      rollout_summary: rolloutSummary,
      rollout_slug: rolloutSlug,
      raw_memory: { items: validatedItems },
    },
  };
}

// ---------------------------------------------------------------------------
// Lease snapshot row
// ---------------------------------------------------------------------------

interface LeaseSnapshotRow {
  source_updated_at: number;
  source_content_hash: string;
  attempt_count: number;
  last_error: string | null;
}

interface CatalogMappingRow {
  project_id: string | null;
  working_directory: string | null;
}

// ---------------------------------------------------------------------------
// Extractor
// ---------------------------------------------------------------------------

/**
 * Stage 1 extractor. Holds injected DB handles + LLM client so the extract
 * method stays focused on orchestration. Plan 305 wires a concrete
 * Stage1Extractor instance in the Electron main process worker.
 *
 * Uses streamChat() instead of chat() to avoid Anthropic's "Streaming is
 * required for operations that may take longer than 10 minutes" error on
 * large payloads (long conversation histories).
 */
export class Stage1Extractor {
  private readonly streamChat: LLMClient['streamChat'];

  constructor(
    private readonly memoryDb: Database,
    private readonly mainDb: Database,
    private readonly llmClient: LLMClient,
    private readonly opts?: { rootDir?: string },
  ) {
    if (typeof llmClient.streamChat !== 'function') {
      throw new Error('LLMClient.streamChat is required for Stage1Extractor');
    }
    // Bind streamChat to the LLMClient instance. LazyLLMClientProxy.streamChat
    // calls `this.getClient()` internally — without binding, `this` would be
    // undefined when invoked via `this.streamChat(...)`.
    this.streamChat = llmClient.streamChat.bind(llmClient);
  }

  async extract(input: ExtractInput): Promise<ExtractResult> {
    const startTime = Date.now();
    const ttlMs = input.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    const { rolloutId, claimedBy } = input;

    const elapsed = (): number => Date.now() - startTime;

    // 1. Catalog lookup.
    const catalog = this.memoryDb
      .prepare('SELECT project_id, working_directory FROM rollout_catalog WHERE rollout_id = ?')
      .get(rolloutId) as CatalogMappingRow | undefined;
    if (!catalog) {
      return { status: 'noop_skipped', contentOutcome: null, projectionPath: null, stage1RowId: rolloutId, durationMs: elapsed() };
    }

    // 2. Acquire lease.
    const acquireResult = acquireLease(this.memoryDb, { rolloutId, claimedBy, ttlMs });
    if (acquireResult.status === 'busy') {
      return { status: 'noop_skipped', contentOutcome: null, projectionPath: null, stage1RowId: rolloutId, durationMs: elapsed() };
    }
    const token = acquireResult.token;

    // Read the lease snapshot for source version + retry context.
    const leaseRow = this.memoryDb
      .prepare('SELECT source_updated_at, source_content_hash, attempt_count, last_error FROM rollout_leases WHERE rollout_id = ?')
      .get(rolloutId) as LeaseSnapshotRow | undefined;
    if (!leaseRow) {
      // acquireLease succeeded but the row vanished before we could read
      // it (e.g. a concurrent retire). Release the lease via fail() so it
      // doesn't dangle as 'running' until TTL expiry.
      fail(this.memoryDb, { rolloutId, token, error: 'lease-snapshot-miss-after-acquire' });
      return { status: 'noop_skipped', contentOutcome: null, projectionPath: null, stage1RowId: rolloutId, durationMs: elapsed() };
    }

    if (leaseRow.attempt_count > 1 && leaseRow.last_error) {
      console.warn(
        `[Stage1Extractor] Retry attempt ${leaseRow.attempt_count} for ${rolloutId}, last error: ${leaseRow.last_error}`,
      );
    }

    // 3. Heartbeat every TTL/6.
    const heartbeatMs = Math.max(1, Math.floor(ttlMs / HEARTBEAT_DIVISOR));
    const heartbeatInterval = setInterval(() => {
      heartbeat(this.memoryDb, { rolloutId, token, ttlMs });
    }, heartbeatMs);

    try {
      return await this.runExtraction(
        rolloutId,
        token,
        leaseRow,
        catalog,
        ttlMs,
        startTime,
        input.existingKeys,
      );
    } finally {
      clearInterval(heartbeatInterval);
    }
  }

  private async runExtraction(
    rolloutId: string,
    token: string,
    leaseRow: LeaseSnapshotRow,
    catalog: CatalogMappingRow,
    _ttlMs: number,
    startTime: number,
    existingKeysInput?: string[] | null,
  ): Promise<ExtractResult> {
    const elapsed = (): number => Date.now() - startTime;
    const { source_updated_at, source_content_hash } = leaseRow;

    // 4. Read + compact messages.
    const messages = this.readMessages(rolloutId);
    const compacted = compactMessages(messages, {
      sourceUpdatedAt: source_updated_at,
      sourceContentHash: source_content_hash,
    });

    // 4b. Resolve existing canonical_keys for cross-session dedup.
    // When existingKeysInput is undefined, query the memory DB; when null,
    // omit the keys section entirely. This lets the worker pre-compute
    // keys once per batch and pass them to all parallel extracts.
    let existingKeysSection = '';
    if (existingKeysInput !== null) {
      const keys = existingKeysInput ?? this.queryExistingKeys();
      if (keys.length > 0) {
        existingKeysSection = `Existing canonical keys (reuse if semantically equivalent):\n${keys.map((k) => `- ${k}`).join('\n')}\n\n`;
      }
    }

    // 5. LLM call (streaming — avoids Anthropic's 10-min non-streaming limit).
    const userContent = STAGE1_USER_PROMPT_TEMPLATE.replace(
      '{{existing_keys}}',
      existingKeysSection,
    ).replace(
      '{{compacted}}',
      compacted.lines.join('\n'),
    );
    const userMessage: Message = { role: 'user', content: userContent };

    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), LLM_TIMEOUT_MS);

    let llmResponse: string;
    try {
      const generator = this.streamChat([userMessage], {
        systemPrompt: STAGE1_SYSTEM_PROMPT,
        maxTokens: LLM_MAX_TOKENS,
        signal: abortController.signal,
      });
      const chunks: string[] = [];
      for await (const event of generator) {
        if (event.type === 'text' || event.type === 'text_delta') {
          chunks.push(event.data);
        } else if (event.type === 'error') {
          throw new Error(event.data);
        }
        // 'done' event marks completion; loop exits naturally.
      }
      llmResponse = chunks.join('');
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const failReason = abortController.signal.aborted || /abort|timeout/i.test(errorMsg)
        ? 'llm-timeout'
        : /refus|content.?policy|safety/i.test(errorMsg)
          ? 'llm-refused'
          : errorMsg.slice(0, 200);
      fail(this.memoryDb, { rolloutId, token, error: failReason });
      return { status: 'failed', contentOutcome: null, projectionPath: null, stage1RowId: rolloutId, durationMs: elapsed(), errorMessage: failReason };
    } finally {
      clearTimeout(timeoutId);
    }

    if (!llmResponse || llmResponse.trim().length === 0) {
      fail(this.memoryDb, { rolloutId, token, error: 'llm-refused' });
      return { status: 'failed', contentOutcome: null, projectionPath: null, stage1RowId: rolloutId, durationMs: elapsed(), errorMessage: 'llm-refused' };
    }

    // 6. Parse + validate.
    const parsed = parseAndValidate(llmResponse);
    if (!parsed.valid) {
      fail(this.memoryDb, { rolloutId, token, error: parsed.error });
      return { status: 'failed', contentOutcome: null, projectionPath: null, stage1RowId: rolloutId, durationMs: elapsed(), errorMessage: parsed.error };
    }

    const data = parsed.result;

    // 7. succeeded_no_output path.
    if (data.job_status === 'succeeded_no_output') {
      const status = complete(this.memoryDb, {
        rolloutId,
        token,
        sourceUpdatedAt: source_updated_at,
        sourceContentHash: source_content_hash,
        outcome: 'succeeded_no_output',
        contentOutcome: null,
        rolloutSummary: null,
        rawMemoryJson: null,
        rolloutSlug: data.rollout_slug,
        extractedThroughSeq: compacted.extractedThroughSeq,
      });

      if (status !== 'committed') {
        console.warn(`[Stage1Extractor] complete() returned ${status} for ${rolloutId}`);
        return { status: 'stale_source', contentOutcome: null, projectionPath: null, stage1RowId: rolloutId, durationMs: elapsed(), errorMessage: status };
      }

      return { status: 'succeeded_no_output', contentOutcome: null, projectionPath: null, stage1RowId: rolloutId, durationMs: elapsed() };
    }

    // 8. succeeded path — process summary (truncate + redact) so DB and
    //    file projection stay byte-identical.
    const rawSummary = data.rollout_summary;
    const truncated =
      rawSummary.length > MAX_SUMMARY_CHARS
        ? rawSummary.slice(0, MAX_SUMMARY_CHARS) + '\n... [truncated]'
        : rawSummary;
    const processedSummary = redactCredentials(truncated);
    const rawMemoryJson = redactCredentials(JSON.stringify(data.raw_memory));

    // Write projection (enqueues outbox).
    const writeResult = writeRolloutProjection(this.memoryDb, {
      rolloutId,
      cwd: catalog.working_directory ?? '',
      threadId: rolloutId,
      gitBranch: null,
      outcome: 'succeeded',
      contentOutcome: data.content_outcome!,
      summaryMarkdown: processedSummary,
      rawMemoryJson,
      rolloutSlug: data.rollout_slug,
      generatedAt: Date.now(),
      sourceUpdatedAt: source_updated_at,
      sourceContentHash: source_content_hash,
      rootDir: this.opts?.rootDir,
    });

    // Complete (CAS).
    const status = complete(this.memoryDb, {
      rolloutId,
      token,
      sourceUpdatedAt: source_updated_at,
      sourceContentHash: source_content_hash,
      outcome: 'succeeded',
      contentOutcome: data.content_outcome!,
      rolloutSummary: processedSummary,
      rawMemoryJson,
      rolloutSlug: data.rollout_slug,
      extractedThroughSeq: compacted.extractedThroughSeq,
      contentHashAtWrite: writeResult.contentHashAtWrite,
    });

    if (status !== 'committed') {
      console.warn(`[Stage1Extractor] complete() returned ${status} for ${rolloutId}`);
      return { status: 'stale_source', contentOutcome: data.content_outcome, projectionPath: writeResult.projectionPath, stage1RowId: rolloutId, durationMs: elapsed(), errorMessage: status };
    }

    return { status: 'committed', contentOutcome: data.content_outcome, projectionPath: writeResult.projectionPath, stage1RowId: rolloutId, durationMs: elapsed() };
  }

  /**
   * Read session messages from the main DB and map to MessageEvent with
   * inferred source_type (user→user_message, tool→local_tool_output,
   * assistant→assistant_only).
   */

  /**
   * Query active canonical_keys from `memory_entries` for cross-session
   * dedup. Returns an empty array when the table does not exist (e.g.
   * before migration 0005/0006). Guards against table-missing errors so
   * the extractor degrades gracefully on fresh installs.
   */
  private queryExistingKeys(): string[] {
    try {
      const rows = this.memoryDb
        .prepare("SELECT DISTINCT canonical_key FROM memory_entries WHERE status = 'active' ORDER BY canonical_key ASC")
        .all() as Array<{ canonical_key: string }>;
      return rows.map((r) => r.canonical_key);
    } catch {
      // Table missing (pre-migration) — no existing keys to reuse.
      return [];
    }
  }

  private readMessages(sessionId: string): MessageEvent[] {
    const rows = this.mainDb
      .prepare(
        `SELECT id, role, content, tool_call_id, tool_name, tool_input,
                msg_type, seq_index, created_at, status
         FROM messages
         WHERE session_id = ?
         ORDER BY seq_index ASC`,
      )
      .all(sessionId) as Array<{
        id: string;
        role: string;
        content: string;
        tool_call_id: string | null;
        tool_name: string | null;
        tool_input: string | null;
        msg_type: string | null;
        seq_index: number | null;
        created_at: number | null;
        status: string | null;
      }>;

    return rows.map((row): MessageEvent => {
      const role = row.role as MessageEvent['role'];
      let source_type: string | undefined;
      if (role === 'user') source_type = 'user_message';
      else if (role === 'tool') source_type = 'local_tool_output';
      else if (role === 'assistant') source_type = 'assistant_only';

      return {
        message_id: row.id,
        role,
        content: row.content ?? '',
        tool_call_id: row.tool_call_id ?? undefined,
        tool_name: row.tool_name ?? undefined,
        tool_input: row.tool_input ?? undefined,
        type: row.msg_type ?? undefined,
        source_type,
        seq_index: row.seq_index ?? undefined,
        created_at: row.created_at ?? undefined,
        status: row.status ?? undefined,
      };
    });
  }
}
