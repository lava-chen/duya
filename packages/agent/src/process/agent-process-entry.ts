/**
 * agent-process-entry.ts - Agent Process Entry Point
 *
 * Runs as a standalone Node.js child process (not Worker Thread).
 * This replaces daemon-worker.ts as the Agent runtime.
 *
 * Architecture:
 * - Main Process ↔ Agent Process via stdin/stdout JSON-RPC
 * - Each Agent Process handles one session
 * - Sub-agents run sequentially within the same process
 *
 * Message Flow:
 * 1. Receive 'init' - Initialize agent with config
 * 2. Receive 'chat:start' - Start streaming chat
 * 3. Emit events back to Main via stdout JSON lines (sendEvent)
 * 4. Receive 'ping' - Respond with 'pong'
 */

import { randomUUID } from 'crypto';
import { readFile } from 'node:fs/promises';
import { appendFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendMessages, storeParsedDocumentAttachment } from '../session/db.js';
import { COMPACTION_CHECKPOINT_ID_SUFFIX } from '../message/index.js';

import type { MessageRow, AttachmentRow, ParsedDocumentAttachment } from '../session/db.js';
import { getAttachmentsForSession, rehydrateContentWithAttachments } from '../session/db.js';
import type { Message, MessageContent, MCPServerConfig, Tool, TokenUsage, UsageCall } from '../types.js';
import type { ProviderRuntimeConfig } from '@duya/ai';
import { logger } from '../utils/logger.js';
import { parseUsageCall } from './call-usage.js';
import { seedTokenUsageFromHistory, parsePersistedTokenUsage } from './seed-token-usage.js';
import {
  messageDb,
  pluginDb,
  settingDb,
  sessionDb,
  toolApprovalDb,
  turnReviewDb,
  goalDb,
} from '../ipc/db-client.js';
import { createSurfaceAwarePermissionHandler } from './tool-approval-card.js';
// Plan 426 Phase 4: lazy-loaded — only needed when permissionSurface='bot'.

// Note: sendMemoryWakeup is intentionally NOT statically imported here.
// It pulls the entire memory-rollout + memory-state module graph
// (writer, extractor, projectionContent, system_log, etc.) into the
// worker bundle, adding ~1.5 MB of minified code that is only used in
// fire-and-forget right after `ready`. We lazy-load it inside the init
// callback instead so cold-start pays nothing for it.
import {
  enqueue,
  dequeue,
  hasCommandsInQueue,
  clearCommandQueue,
  getCommandQueueLength,
} from '../queue/index.js';
import type { QueuedCommand } from '../queue/index.js';
import { generateSessionTitle } from '../session/title-generator.js';
import { getSteeringConfig } from '../hooks/config.js';
import { classifyError, APIErrorType, computeContextComposition, normalizePromptTokens, type ContextEstimateSource } from '@duya/ai';
import type { PromptProfile } from '../prompts/modes/types.js';
import { isBotAgentProfile } from '../prompts/index.js';
// Plan 312: type-only import for the App Connection tool descriptor.
import type { AppConnectionToolDescriptor } from '../tool/AppConnectionTool/index.js';
// Plan 426 Phase 4: lazy-loaded — only needed when @plugins are @-mentioned or
// an app-connection tool triggers a permission ask. Module is cached after
// first import so repeated calls across a session reuse the same instance.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _appConnectionModule: any = null;
// Plan 426 Phase 4: lazy-loaded to avoid pulling sandbox module graph into every
// cold-start worker when sandboxEnabled is false (default for most sessions).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { duyaAgent } from '../agent/DuyaAgent.js';
import { Journal } from '../journal/Journal.js';
import { loadSkills, getSkillRegistry, getAgentSkillDirectory } from '../skills/index.js';
import { browserTool } from '../tool/builtin.js';
import { modeModifierRegistry } from '../modes/index.js';
import { verifyRunManifestBinding, manifestRejectionProtocolCode, type WorkerCapabilitySet } from './run-manifest-verification.js';
import { type RunManifest } from '@duya/agent-protocol';
import { getBashTaskRegistry } from '../session/bash-task-registry.js';
import { hookTaskRegistry } from '../hooks/task-registry.js';
import { backgroundAgentLifecycle } from '../lifecycle/BackgroundAgentLifecycle.js';
import { sendEvent, parseStdin, type WorkerCommand, buildWorkflowRunEvent, buildMessageFinalizedEvent, type WorkflowRunCommand } from './worker-protocol.js';
import { convertSSEToAgentMessage } from './sse-frame-codec.js';
import { launchSavedWorkflow } from './workflow-runner.js';
import { runWorkflowRuntimeChild } from './workflow-runtime-child.js';
import { MemoryArtifactStore } from '../modes/workflow/gui-artifacts.js';
import { resolveChatStartAgentMode } from './permission-profile-bridge.js';
// Plan 600 S2: the run execution engine and its port contracts. The engine OWNS
// the turn loop; this file supplies mechanisms and forwards events, which is the
// whole of the worker's job under `04-runtime-owns-execution.md` section 2 item 3.
//
// It NO LONGER RUNS ONE. The `RunEngineImpl` construction and the
// `buildEnginePorts` bundle that went with it were removed with the phantom run
// (see the `chat:start` handler), because a run whose model port yields nothing
// cannot be completed by wiring it better -- and leaving it live meant every
// `chat:start` also minted a failed terminal for a run that never spoke.
// `ModelContentBlock` is still needed for `toEngineContent`; the rest of the
// engine's types moved out with their last use.
import type { ModelContentBlock } from '@duya/agent-runtime';
// Plan 600 S2: the per-run publisher each turn's pipeline is published into, so
// a `ToolPort` can reach the live turn once the cutover binds one. Nothing
// publishes into it today -- `DuyaAgent.streamChat` still builds and drains the
// pipeline itself -- so it is retained as the seam, not as a live mechanism.
import { TurnPipelinePublisher } from '../tool/turn-pipeline-publisher.js';
import { applyMCPConfiguration, type MCPApplyResult } from '../mcp/apply.js';
import { storePendingAnswer, takePendingAnswer } from '../tool/AskUserQuestionTool/AskUserQuestionTool.js';
import { isCDNImageUrl } from '../utils/urlSafety.js';
import { isModelLikelyMultimodal } from '../utils/multimodal-detection.js';
import { detectModelCapability } from '../utils/model-capability-cache.js';
import { loadAttachmentImages } from '../utils/attachment-images.js';
import { buildImageAttachmentContext } from '../utils/image-attachment-context.js';
import type { ProbeConfig } from '../utils/model-capability-cache.js';
import type { ToolExecutor } from '../tool/registry.js';
import { estimateMessagesTokens } from '../compact/tokenBudget.js';
import type { ApiFormat, ModelCompat } from '@duya/ai';

// Polyfill globalThis.crypto for Node.js
if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.randomUUID) {
  (globalThis as { crypto: { randomUUID: () => string } }).crypto = {
    randomUUID: () => randomUUID(),
  };
}

// Type definitions
interface VisionConfig {
  provider: string;
  model: string;
  baseURL: string;
  apiKey: string;
  enabled: boolean;
}

interface InitMessage {
  type: 'init';
  sessionId: string;
  providerConfig: {
    apiKey: string;
    baseURL?: string;
    model: string;
    provider: 'anthropic' | 'openai' | 'ollama';
    authStyle?: 'api_key' | 'auth_token';
    visionConfig?: VisionConfig;
    compactModelConfig?: VisionConfig;
    /**
     * Phase 2: optional ProviderRuntimeConfig. When present, the agent
     * prefers the apiFormat and headers from this object over the legacy
     * `provider` discriminator. New code should treat this as the
     * authoritative runtime config.
     */
    runtimeConfig?: ProviderRuntimeConfig;
  };
  workingDirectory?: string;
  /**
   * Plan 536 L1: project ID resolved from `workingDirectory` by the
   * agent server's `projects:resolveProject` IPC. Threaded into the
   * subprocess as part of session bootstrap so it lands in every
   * `ctx.options.currentProjectId` the subprocess builds. Null when
   * the cwd is outside any registered project.
   */
  currentProjectId?: string | null;
  /**
   * Plan 525 / 408 follow-up: project-entity home directory
   * (`~/.duya/projects/<projectId>/`). Resolved by the agent server's
   * `projects:resolveProject` IPC from `workingDirectory`; threaded into
   * the subprocess so `promptSystem.buildContext` →
   * `preBuildHook` → `initializeAgentsMd` can read
   * `<projectHome>/AGENTS.md` as a `'Project entity'` source.
   * Undefined when the cwd is outside any registered duya project.
   */
  projectHome?: string;
  defaultWorkspaceDirectory?: string;
  systemPrompt?: string;
  skillPaths?: string[];
  communicationPlatform?: string;
  blockedDomains?: string[];
  browserBackendMode?: 'auto' | 'extension' | 'built-in' | 'human-like';
  language?: string;
  sandboxEnabled?: boolean;
  securityScanEnabled?: boolean;
  /** Optional user-defined permission rules. Mirrors `AgentOptions.permissionRules`. */
  permissionRules?: import('../types.js').AgentOptions['permissionRules'];
  /** Authoritative locale/timezone from the user's machine (sent by main). */
  systemLocation?: {
    locale: string;
    localeCountryCode: string | null;
    timezone: string;
  };
}

interface FileAttachment {
  id: string;
  name: string;
  type: string;
  url: string;
  size: number;
  path?: string;
  text?: string;
  extractMethod?: 'text' | 'vision' | 'hybrid';
  imageChunks?: Array<{ base64: string; mediaType: string }>;
  base64?: string;
}

interface ChatStartMessage {
  type: 'chat:start';
  sessionId: string;
  /**
   * The TURN id. Plan 587 R2.1: this is explicitly NOT the run id — it is
   * threaded as `ChatOptions.turnId` for journal emits, `message_index.turn_id`
   * and turn review. The run id is `runId` below.
   */
  id: string;
  /**
   * Plan 587 R2.1: the canonical run id, minted by the Control Plane's start
   * entry (the agent-server's `RunOrchestrator.openRun`) and put on this command
   * by the execution channel. When present it IS this turn's run identity, used
   * verbatim — the same string, not an alias.
   *
   * Optional only because the non-Desktop producers have not migrated; see
   * `resolveTurnRunId` for the fallback and its removal condition.
   */
  runId?: string;
  /**
   * Plan 587 R2.1: reference to the frozen manifest (its sha256 fingerprint), so
   * the executor can tell WHICH run configuration it was given.
   *
   * R2.2: the hash is now CHECKED, not just carried — see
   * `verifyRunManifestBinding` and the call in `handleChatStart`. A digest the
   * receiver can recompute over the manifest it received is a check; a digest
   * nobody compares was a comment with hex in it.
   */
  manifestHash?: string;
  /**
   * Plan 587 R2.1: digest of this turn's prompt and options, pinned before the
   * dispatch.
   *
   * R2.2: also checked, against the prompt and options that actually arrived.
   * This is the check that makes the removal of the old dual input source
   * falsifiable — if a side channel ever delivers a prompt beside the resolved
   * one again, the two disagree and the turn is refused.
   */
  inputRevision?: string;
  /**
   * Plan 587 R2.2: the frozen manifest itself, so the hash above can be
   * recomputed over what this process received rather than trusted.
   *
   * The PUBLIC manifest: it carries an `env` REFERENCE and no credential
   * (drift test #12 walks every field for one). The provider credential for
   * this turn still reaches the worker through the separate, controlled
   * `init` command's `providerConfig` — a real constraint of the current
   * design, not a guarantee this field provides. There is no secret broker.
   */
  manifest?: RunManifest;
  prompt: string;
  options?: {
    messages?: Array<{ role: string; content: string }>;
    systemPrompt?: string;
    language?: string;
    permissionModeOverride?: 'default' | 'auto' | 'bypassPermissions';
    files?: FileAttachment[];
    agentProfileId?: string | null;
    outputStyleConfig?: { name: string; prompt: string; keepCodingInstructions?: boolean };
    displayContent?: string;
    /**
     * Plan 453 Task G: wakeless chat path. When true:
     *   - sessionId should start with `wakeless-` (callers generate
     *     a fresh UUID per wake);
     *   - the journal ref is cleared on the agent for this turn so
     *     messages never reach the rollout file;
     *   - the orb IPC owns the response stream (see
     *     `electron/services/orb-wakeless-chat.ts`).
     */
    wakeless?: boolean;
    mode?: string;
    /** Plan 450: @-mentioned providers for this run. */
    mentionedProviders?: string[];
    /** Plan 450 Phase H: `/skill-name` mentioned this run. */
    mentionedSkills?: string[];
    /** Plugins @-mentioned this run — structured capability summaries (see ChatOptions). */
    mentionedPlugins?: Array<{
      pluginId: string;
      name: string;
      description?: string;
      appConnections: string[];
      mcpServers: string[];
      skillNames: string[];
    }>;
    titleGenerationModel?: string;
    titleGenerationModelConfig?: {
      provider: string;
      apiKey: string;
      baseURL: string;
      model: string;
      apiFormat?: string;
      modelCompat?: ModelCompat;
    };
    effort?: string;
    /**
     * Maximum agentic turns for this run. Absent → fall back to the
     * configured `agent.max_turns`, then the built-in default (100).
     */
    maxTurns?: number;
    /**
     * Allowlist of tool names permitted for this chat turn. When set, only
     * tools whose name is in this list are exposed to the LLM. Used by
     * interagent `minimal` mode to restrict the target agent to Read/Grep/Glob.
     */
    allowedTools?: string[];
    /**
     * Plan 498: permission ask surface. 'bot' (bot/wake sessions) pauses the
     * turn on ask — the request is persisted as a durable approval card and
     * the turn ends with a neutral tool result. Absent → interactive wait.
     */
    permissionSurface?: 'bot' | 'default';
    /** Conductor mode — inject canvas tools + prompt overlay for this turn. */
    conductorMode?: boolean;
    /** Conductor canvas ID bound to the session (required when conductorMode is true). */
    conductorCanvasId?: string;
    /** Internal continuation for a completed background sub-agent. */
    backgroundTaskResume?: boolean;
    /**
     * Wall-clock timeout (ms) for a single LLM request within this chat turn.
     * When set, each streamChat LLM call is aborted after this duration even
     * if the stream is still producing data (e.g. a MiniMax thinking stream
     * that never converges), so a hung call fails the run fast instead of
     * burning the whole run budget. Optional; absent = no per-request cap.
     */
    llmRequestTimeoutMs?: number;
    /**
     * Plan 497: wake runs (cron / background notification / agent DM) persist
     * their prompt user row with source 'system' — model context, never
     * bot-direct chat (the dispatcher's agent_dm marker is the visible row).
     */
    wakeRun?: boolean;
    /** Renderer-minted id of this user send; worker persists the user row
     *  with this id so the renderer can dedupe the optimistic bubble by id. */
    clientMsgId?: string;
  };
}

interface PongMessage {
  type: 'pong';
  timestamp: number;
}

// Global state
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let agent: any = null;
let sessionId: string | null = null;
let initializing = false;
let chatInProgress = false;
let currentSecurityScanEnabled = true;
let lastInterruptTime = 0;
const DOUBLE_INTERRUPT_WINDOW_MS = 3000;

/**
 * What THIS build can do, for manifest verification (plan 587 R2.2).
 *
 * Read from the real registries rather than a hardcoded list, because a list
 * written here would drift the moment a mode is registered and would then be
 * a LIE in the worst direction: it would report a capability this process does
 * not have, and the check that exists to prevent a run executing under a
 * configuration it was not given would be asserting the opposite.
 *
 * Two kinds of entry, and the difference matters:
 *
 *  - `streaming` is a real, named capability this build implements: this
 *    process streams a chat turn over the parent pipe, and the Desktop chat
 *    path requires it. It is listed because the Control Plane names it, and a
 *    non-streaming executor must refuse the run rather than answer it wrongly.
 *  - The mode ids come from `modeModifierRegistry.list()` — the same registry
 *    `applyModes` resolves against, so a mode this process cannot apply is
 *    reported as unavailable.
 *
 * What is NOT claimed: tool names, profile ids, and any `replay` / `pause`
 * capability. The tool set is assembled per turn from MCP servers, skills and
 * plugins, so there is no single static list to be honest about here, and
 * claiming tool availability from a static list is the same drift problem one
 * level down. A tool named in the manifest that this build lacks therefore
 * lands in `unsatisfiedOptional` — recorded, not fatal — which is the honest
 * degrade.
 *
 * The revision is the PACKAGE version, not an invented counter: it is a real,
 * versioned fact about this build, which is all a "did the catalog move under
 * this run" record needs. Inventing a string here would be the self-certified
 * fact the manifest exists to prevent.
 */
const AGENT_CATALOG_REVISION = '0.1.0';

function workerCapabilitySet(): WorkerCapabilitySet {
  const modeIds = modeModifierRegistry.list().map((mode) => mode.id);
  return {
    available: ['streaming', ...modeIds],
    catalogRevision: `agent@${AGENT_CATALOG_REVISION}`,
    manifestVersion: 1,
  };
}

let sessionSystemPrompt: string | undefined = undefined;
let existingMessageCount = 0;
// Plan 508: pending compact command captured during init. The router may
// dispatch a 'compact' message before init finishes (e.g. bot session whose
// worker was lazy-spawned by the same POST). Stash it here and replay after
// the worker reports ready so the user does not see a misleading 'Agent not
// initialized' error. Cleared once consumed (success or failure).
let pendingCompactCommand: unknown = null;

// Live context-usage emission (plan 443, pi parity). The context size is
// computed STATELESSLY on every emit via computeContextEstimate(@duya/ai):
// latest valid assistant usage anchor + estimated trailing messages. No
// incremental base / boundary bookkeeping — the previous tracker state
// machine (liveBaseContext / liveBaseMessageCount / hasLiveBase /
// liveBoundaryPending) was the source of ring sawtooth and is gone.
// Set when compaction (manual `/compact` or proactive mid-turn) shrank the
// timeline: retained usage anchors describe the PRE-compaction prompt, so
// emissions stay "unanchored" (ring shows ?) until this turn's first `result`
// provides a post-compaction anchor. Reset on `init`.
let compactedPending = false;
// Session-cumulative usage across every `result` this worker has seen for
// this session (reset on `init`). The ring's ↑/↓/R/W/$ footer is cumulative
// (pi-style), so the worker accumulates rather than broadcasting only the
// last result's deltas — otherwise the stats line would freeze during
// streaming and only update after the turn-end DB persist.
let liveTotalInput = 0;        // normalized input (cache-convention aware)
let liveTotalInputRaw = 0;     // raw input_tokens (for cost on the uncached portion)
let liveTotalOutput = 0;
let liveTotalCacheHit = 0;
let liveTotalCacheCreation = 0;
// Plan 577 §3: the per-call Observation values (latest input, its output
// bridge, peak high-water mark) and the shrink provenance are OWNED by the
// ContextLedger (hosted by CompactionManager) — emitLiveUsage reads them
// from the ledger snapshot below. The old module-level live* copies are
// gone: two sources of truth for the same numbers is exactly what Phase 2
// exists to eliminate, and the ledger's epoch reset (compaction / clear)
// clears them with the same atomicity as the accounting state.
// Plan 445 Bug #7: dedupe emitLiveUsage so a tool-heavy turn's N
// consecutive tool_result events don't spam the renderer with the
// same snapshot. Key = (usedTokens, anchored, totalInput,
// totalCacheHit, totalCacheCreation, totalOutput, model, providerId).
// Cleared on session switch so the first emit of the new session
// always wins.
let lastEmittedUsageKey: string | null = null;

/** Single-request usage sub-block persisted inside the turn-cumulative
 *  `token_usage` JSON. The cumulative block sums EVERY LLM call of the turn,
 *  so restoring a context base from it inflates the ring ~N× on tool-heavy
 *  turns; `last_call` carries the final request's real prompt size. */
interface LastCallUsageBlock {
  input_tokens?: number;
  output_tokens?: number;
  cache_hit_tokens?: number;
  cache_creation_tokens?: number;
}

// Ring diagnostic trace — pi-style dedicated debug file written directly
// with appendFileSync (see tui-main-screen logRedraw). Deliberately bypasses
// the stderr -> prefix-classification -> level-filter pipeline, which drops
// INFO lines at the main process's default WARN level. Remove once ring
// behavior is verified.
const RING_TRACE_FILE = (() => {
  const dir = process.env.DUYA_WORKER_LOG_DIR
    ?? process.env.DUYA_CLI_USER_DATA_DIR
    ?? process.env.TMPDIR
    ?? process.env.TEMP
    ?? process.env.TMP
    ?? '/tmp';
  return path.join(dir, 'context-ring.log');
})();
const ringTrace = (line: string): void => {
  if (!RING_TRACE_FILE) return;
  try {
    mkdirSync(path.dirname(RING_TRACE_FILE), { recursive: true });
    appendFileSync(RING_TRACE_FILE, `${new Date().toISOString()} ${line}
`);
  } catch {
    // Diagnostics must never break streaming.
  }
};

// Broadcast the live context-usage snapshot for a session over the worker
// channel. Module scope so the compaction paths (manual `compact` command,
// proactive mid-turn compaction) can push a fresh snapshot too, not just the
// streamChat event loop. Stateless: recomputed from the current message
// timeline on every call.
const emitLiveUsage = (
  targetSessionId: string | null,
  systemFallbackTokens?: number,
): void => {
  if (!targetSessionId) return;
  const msgs: Message[] = agent?.getMessages?.() ?? [];
  // Plan 577 §3: the enriched snapshot is produced by CompactionManager,
  // combining ledger-owned observations with the timeline projection shared
  // by compaction probes. Keep the ledger-only getter as a compatibility
  // fallback for older workers.
  const contextSnapshot =
    typeof agent?.getContextSnapshot === 'function'
      ? agent.getContextSnapshot(msgs)
      : null;
  const ledgerSnapshot = contextSnapshot ??
    (typeof agent?.getContextLedgerSnapshot === 'function'
      ? agent.getContextLedgerSnapshot()
      : null);
  const observedLatest = ledgerSnapshot?.observation?.inputTokens ?? 0;
  const observedOutput = ledgerSnapshot?.observation?.outputTokens ?? 0;
  const observedPeak = ledgerSnapshot?.accounting?.peakInputTokens ?? 0;
  // Estimated tokens of the system prompt (excluding tool definitions) —
  // added ONLY on the unanchored fallback path inside computeContextEstimate.
  // Plan 577 §4: the tool-definition surface travels as its own option so
  // the unanchored estimate and the composition buckets can price it
  // separately (agents without the split getters keep the combined value).
  const agentSystemTokens =
    typeof agent?.getSystemTokensEstimate === 'function'
      ? agent.getSystemTokensEstimate()
      : agent?.getSystemContextTokensEstimate?.() ?? 0;
  const agentToolsTokens =
    typeof agent?.getToolsTokensEstimate === 'function' ? agent.getToolsTokensEstimate() : 0;
  const systemPrefix = agentSystemTokens || systemFallbackTokens || 0;
  const { estimate, composition } = computeContextComposition(msgs, {
    systemPrefixTokens: systemPrefix,
    toolDefinitionsTokens: agentToolsTokens,
    // Plan 579: transient <skill> mention-injection bodies ride the
    // projection rail, outside the message timeline — same treatment as
    // memory-recall payloads.
    skillParts:
      typeof agent?.getInjectedSkillParts === 'function'
        ? agent.getInjectedSkillParts()
        : [],
  });
  const usedForRing =
    contextSnapshot?.accounting?.projectedNextInputTokens ?? estimate.usedTokens ?? 0;
  const estimateSource: ContextEstimateSource | 'unknown' =
    contextSnapshot?.estimateSource ??
    (estimate.anchored ? 'anchor_projection' : estimate.usedTokens ? 'heuristic' : 'unknown');
  const anchored = contextSnapshot
    ? estimateSource !== 'heuristic' && estimateSource !== 'unknown' && !compactedPending
    : estimate.anchored && !compactedPending;
  const anchorTokensForRing = estimate.anchorTokens;
  const trailingForRing = estimate.trailingTokens;

  // Composition parts remain useful during a live correction, but the
  // timeline can temporarily describe an older projection. Reconcile the
  // estimated categories to the exact shared ContextSnapshot headline. If a
  // correction shrinks the headline, scale the category shares rather than
  // discarding every label and making the full total look unattributed.
  const compositionBuckets = [
    composition.system,
    composition.conversation,
    composition.injectedContext,
    composition.skills,
    composition.toolDefinitions,
    composition.toolResults,
    composition.attachments,
    composition.memory,
    composition.providerOverhead ?? [],
  ];
  const sumCompositionParts = (): number =>
    compositionBuckets.reduce(
      (sum, parts) => sum + parts.reduce((partSum, part) => partSum + part.tokens, 0),
      0,
    );
  const compositionParts = sumCompositionParts();
  if (compositionParts > usedForRing && compositionParts > 0) {
    const scale = Math.max(0, usedForRing) / compositionParts;
    for (const parts of compositionBuckets) {
      const scaledParts = parts.map((part) => ({
        ...part,
        tokens: Math.floor(part.tokens * scale),
      }));
      parts.splice(0, parts.length, ...scaledParts);
    }
  }
  composition.unattributedObservedTokens = Math.max(0, usedForRing - sumCompositionParts());
  // Token-trace: emit a structured INFO line so the operator can correlate
  // input / cache / trailing growth over time. The anchor's raw usage block
  // is included so an off-by-one (under-report or cache-misaccount) is easy
  // to spot in a log diff.
  logger.tokenTrace('emitLiveUsage', {
    sessionId: targetSessionId,
    anchor: estimate.anchorIndex,
    anchorMsgId: estimate.anchorIndex !== null ? msgs[estimate.anchorIndex]?.id : null,
    anchored,
    systemPrefix,
    msgs: msgs.length,
    // Plan 577 §2: three-value accounting telemetry (latest / peak /
    // projected) + where the number came from.
    latestInput: observedLatest > 0 ? observedLatest : null,
    peakInput: observedPeak > 0 ? observedPeak : null,
    projectedNext: usedForRing,
    estimateSource,
    result: {
      used: estimate.usedTokens,
      anchorTokens: estimate.anchorTokens,
      trailing: estimate.trailingTokens,
    },
    cumulative: {
      input: liveTotalInput,
      output: liveTotalOutput,
      cacheRead: liveTotalCacheHit,
      cacheCreate: liveTotalCacheCreation,
    },
  });
  // Multiple workers share one trace file — prefix every line so interleaved
  // sessions stay attributable.
  ringTrace(
    `[${targetSessionId.slice(0, 8)}] emit msgs=${msgs.length} anchored=${anchored} anchorIdx=${estimate.anchorIndex} anchor=${anchorTokensForRing} trailing=${trailingForRing} used=${usedForRing} systemPrefix=${systemPrefix} totalsIn=${liveTotalInput} cacheHit=${liveTotalCacheHit}`,
  );
  // Plan 577 §4: the composition buckets ride the same trace ("first logs,
  // then UI") — one line that names every bucket so a context-size surprise
  // (MCP load, giant tool result, memory recall) is attributable in seconds.
  const bucketLine = (
    [
      ['unattributed', composition.unattributedObservedTokens],
      ['conversation', composition.conversation],
      ['toolResults', composition.toolResults],
      ['toolDefs', composition.toolDefinitions],
      ['injected', composition.injectedContext],
      ['skills', composition.skills],
      ['system', composition.system],
      ['memory', composition.memory],
      ['attachments', composition.attachments],
    ] as const
  )
    .map(([label, parts]) =>
      typeof parts === 'number'
        ? `${label}=${parts}`
        : `${label}=${parts.reduce((s, p) => s + p.tokens, 0)}`,
    )
    .join(' ');
  ringTrace(
    `[${targetSessionId.slice(0, 8)}] composition: ${bucketLine} (anchored=${anchored ? 1 : 0})`,
  );
  // Last-request per-call fields for the stats line: read off the anchor
  // message itself (`usage` in-memory from DuyaAgent, `tokenUsage` persisted).
  const anchorMsg =
    estimate.anchorIndex !== null
      ? (msgs[estimate.anchorIndex] as
          | { usage?: LastCallUsageBlock; tokenUsage?: LastCallUsageBlock }
          | undefined)
      : undefined;
  const anchorUsage = anchorMsg?.usage ?? anchorMsg?.tokenUsage;
  const { prompt: lastInput, output: lastOutput } = normalizePromptTokens(anchorUsage);
  // Plan 445 Bug #7: skip the SSE frame if nothing material changed.
  // The frame is the source of truth for the live ring; re-emitting
  // the same payload every tool_result event would cause redundant
  // zustand sets and React re-renders. Diff over the fields the
  // ring + stats line actually read.
  // Plan 546: include `liveTotalInputRaw` so the cost line (which the
  // ring renders from this field) does not appear to flicker when only
  // the raw counter advances between two normalized-equal events.
  // Plan 577 §2: include the three-value accounting + source so a
  // peak/latest/source change re-emits even when the projection is equal.
  // Plan 577 §3: the ledger epoch is part of the key — a beginEpoch()
  // must force a re-emit even when every number happens to match.
  const windowInfo = contextSnapshot?.contextWindow
    ? { contextWindow: contextSnapshot.contextWindow, windowSource: contextSnapshot.windowSource }
    : agent?.getContextWindowResolved?.() ?? null;
  const emitKey = `${usedForRing}|${anchored ? 1 : 0}|${liveTotalInput}|${liveTotalInputRaw}|${liveTotalCacheHit}|${liveTotalCacheCreation}|${liveTotalOutput}|${observedLatest}|${observedPeak}|${estimateSource}|${agent?.model ?? mainModelName}|${currentProviderId}|${ledgerSnapshot?.epoch ?? -1}|${ledgerSnapshot?.observedAt ?? 0}|${windowInfo?.windowSource ?? '?'}`;
  if (emitKey === lastEmittedUsageKey) {
    ringTrace(`[${targetSessionId.slice(0, 8)}] emit-skip (no change) used=${usedForRing}`);
    return;
  }
  lastEmittedUsageKey = emitKey;
  sendToMain({
    type: 'chat:token_usage',
    sessionId: targetSessionId,
    // False → renderer shows "?" instead of a number (no data yet, or
    // post-compaction without a fresh response).
    anchored,
    usedTokens: usedForRing,
    // Plan 577 §2: three-value accounting. The renderer consumes
    // `currentEstimatedInputTokens` — the worker-computed projection — and
    // must never re-derive the formula itself.
    latestInputTokens: observedLatest > 0 ? observedLatest : undefined,
    peakInputTokens: observedPeak > 0 ? observedPeak : undefined,
    projectedNextInputTokens: usedForRing,
    currentEstimatedInputTokens: usedForRing,
    contextSnapshot: contextSnapshot ?? undefined,
    estimateSource,
    // Plan 577 §3/§4: lineage + window source. The renderer marks the
    // ring when the window fell back to the 200K default and can show the
    // confidence tier without re-deriving anything.
    epoch: ledgerSnapshot?.epoch,
    confidence: ledgerSnapshot?.confidence,
    observedAt: ledgerSnapshot?.observedAt,
    contextWindow: windowInfo?.contextWindow,
    windowSource: windowInfo?.windowSource,
    inputTokens: observedLatest || lastInput,
    outputTokens: observedOutput || lastOutput,
    cacheHitTokens: anchorUsage?.cache_hit_tokens,
    cacheCreationTokens: anchorUsage?.cache_creation_tokens,
    // Estimated tokens of the system prompt (pi-style prefix), kept
    // in the frame for diagnostics.
    systemTokens: systemPrefix,
    toolDefinitionsTokens: agentToolsTokens || undefined,
    // Plan 577 §4: composition buckets for the diagnostics surfaces.
    composition: {
      unattributedObservedTokens: composition.unattributedObservedTokens,
      system: composition.system,
      conversation: composition.conversation,
      injectedContext: composition.injectedContext,
      skills: composition.skills,
      toolDefinitions: composition.toolDefinitions,
      toolResults: composition.toolResults,
      attachments: composition.attachments,
      memory: composition.memory,
      providerOverhead: composition.providerOverhead ?? [],
    },
    // Session-cumulative totals so the ring's ↑/↓/R/W/$ line moves live.
    totalInput: liveTotalInput,
    totalInputRaw: liveTotalInputRaw,
    totalOutput: liveTotalOutput,
    totalCacheHit: liveTotalCacheHit,
    totalCacheCreation: liveTotalCacheCreation,
    // Model/provider snapshot (current runtime state) so the live ring can
    // price and window against the model actually in use (token-accounting).
    model: agent?.model ?? mainModelName,
    providerId: currentProviderId,
    // Token-calc breakdown for the renderer's debug surface. Lets a developer
    // see exactly which inputs fed `usedTokens`: anchor index, anchor tokens,
    // trailing estimate, system prefix. Combined with the cumulative totals
    // above this is enough to reproduce the estimate off-line.
    debugBreakdown: {
      anchorIndex: estimate.anchorIndex,
      anchorMsgId: estimate.anchorIndex !== null ? msgs[estimate.anchorIndex]?.id : null,
      anchorTokens: anchorTokensForRing,
      trailingTokens: trailingForRing,
      observedLatest,
      observedPeak,
      estimateSource,
      msgs: msgs.length,
      compactedPending,
    },
  });
};
// Track the main model name for multimodal detection
let mainModelName = '';
// Current provider id (settings row id) — snapshot from initAgent's runtime
// config. Read at result-event time to stamp each UsageCall; provider hot-swap
// mid-run is not a supported flow (unlike model), so a static snapshot suffices.
let currentProviderId = '';
let probeConfig: ProbeConfig | null = null;
let visionTool: any = null;
// Track title generation per session (Map<sessionId, lastGeneratedTitle>)
const titleGeneratedBySession = new Map<string, string>();
// Title generation model config (from settings)
let titleGenerationModelConfig: {
  provider: string;
  apiKey: string;
  baseURL: string;
  model: string;
  apiFormat?: string;
  modelCompat?: ModelCompat;
} | null = null;
const DEBUG_IPC = process.env.DUYA_DEBUG_IPC === 'true';
// Heartbeat tracking for long-running operations
let lastPongTime = Date.now();
const HEARTBEAT_INTERVAL = 5000; // Send pong every 5 seconds during streaming

// Independent heartbeat timer to keep process alive during long operations
let chatHeartbeatTimer: NodeJS.Timeout | null = null;
const CHAT_HEARTBEAT_INTERVAL = 8000; // Send pong every 8 seconds while chat is active

// ----------------------------------------------------------------------------
// Bash background task list — push snapshot to renderer on any change.
// Throttled so rapid progress events coalesce into a single update per tick.
// ----------------------------------------------------------------------------
const BASH_TASK_PUSH_THROTTLE_MS = 300;
let bashTaskPushScheduled = false;

function pushBashTaskSnapshot(): void {
  const activeSessionId = sessionId;
  if (!activeSessionId) return;
  const tasks = getBashTaskRegistry().listTasks();
  sendToMain({ type: 'bash_task:update', sessionId: activeSessionId, tasks });
}

function scheduleBashTaskPush(): void {
  if (bashTaskPushScheduled) return;
  bashTaskPushScheduled = true;
  setTimeout(() => {
    bashTaskPushScheduled = false;
    pushBashTaskSnapshot();
  }, BASH_TASK_PUSH_THROTTLE_MS);
}

getBashTaskRegistry().onAnyChange(scheduleBashTaskPush);

// ----------------------------------------------------------------------------
// Background hook tasks — push snapshot to renderer on any change.
// ----------------------------------------------------------------------------
const HOOK_TASK_PUSH_THROTTLE_MS = 300;
let hookTaskPushScheduled = false;

function pushHookTaskSnapshot(): void {
  const activeSessionId = sessionId;
  if (!activeSessionId) return;
  const tasks = hookTaskRegistry.listTasks();
  sendToMain({ type: 'hook_task:update', sessionId: activeSessionId, tasks });
}

function scheduleHookTaskPush(): void {
  if (hookTaskPushScheduled) return;
  hookTaskPushScheduled = true;
  setTimeout(() => {
    hookTaskPushScheduled = false;
    pushHookTaskSnapshot();
  }, HOOK_TASK_PUSH_THROTTLE_MS);
}

hookTaskRegistry.onAnyChange(scheduleHookTaskPush);

// ----------------------------------------------------------------------------
// Background sub-agent in-flight reporting — keep the parent worker alive.
// ----------------------------------------------------------------------------
// Background sub-agents execute inside this worker process. The Agent Server
// reaps idle workers (idle TTL) and replaces the worker when a new chat starts,
// so it must know when background sub-agents are still running here. IPC-only
// (process.send) — the stdout SSE path must not see a control-plane message.
backgroundAgentLifecycle.onInFlightChange = (inFlight: number) => {
  const activeSessionId = sessionId;
  if (!activeSessionId) return;
  try {
    process.send?.({
      type: 'background_tasks:update',
      sessionId: activeSessionId,
      inFlight,
    });
  } catch (err) {
    // Best effort — the server keeps its own TTL fallback if IPC is dead.
    warn('background_tasks:update send failed', err);
  }
};

function startChatHeartbeat(): void {
  if (chatHeartbeatTimer) {
    clearInterval(chatHeartbeatTimer);
  }
  chatHeartbeatTimer = setInterval(() => {
    lastPongTime = Date.now();
    sendToMain({ type: 'pong', timestamp: lastPongTime });
    debugLog('Sent independent heartbeat pong');
  }, CHAT_HEARTBEAT_INTERVAL);
}

function stopChatHeartbeat(): void {
  if (chatHeartbeatTimer) {
    clearInterval(chatHeartbeatTimer);
    chatHeartbeatTimer = null;
  }
}

function debugLog(...args: unknown[]): void {
  if (DEBUG_IPC) {
    log('[Agent-Process][DEBUG]', ...args);
  }
}

// Pending permission requests registry.
// Architecture: permission requests are sent to Main -> Renderer, resolved async.
//
// Keyed by `${sessionId}::${id}` to keep sessions isolated: a sub-agent or
// fork session can never accidentally resolve a top-level session's pending
// prompt (or vice versa) just because they happen to share an id namespace
// at the LLM layer. Each entry also holds a per-request timeout handle so
// we can clear it on resolve/duplicate — otherwise the 5min timer leaks
// and can fire a stray 'deny' after the prompt is already gone.
//
// IMPORTANT: keep the key format in sync with `pendingPermissionKey` below.
type PendingPermissionEntry = {
  resolve: (decision: 'allow' | 'deny') => void;
  reject: (error: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
  /** Tool name captured at request time (Plan 449 session approval memory). */
  toolName?: string;
};

const pendingPermissions = new Map<string, PendingPermissionEntry>();

// The grant scope each session's "always allow" writes into (plan 587 R2.4).
//
// `permission:resolve` arrives long after `chat:start` and on a different code
// path, and the surface decides the scope: a bot/wake session's "always" is
// scoped to the BOT (so a new conversation with the same bot inherits it and a
// different bot does not), while an interactive session's is scoped to the
// SESSION. Guessing the scope at resolve time would write a session grant for a
// bot, or a bot grant for a session, and the mis-scoped row would then be read
// back on every later turn of the wrong owner.
//
// Recorded at `chat:start`, which is the only place that knows the surface, and
// dropped on `chat:done` so a recycled worker does not inherit a scope from a
// session it no longer serves.
const permissionScopes = new Map<string, { scopeType: 'bot' | 'session'; scopeId: string }>();

function pendingPermissionKey(sessionId: string, id: string): string {
  return `${sessionId}::${id}`;
}

// Pending IPC requests registry for conductor executor RPC
const pendingIpcRequests = new Map<string, {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeoutHandle?: ReturnType<typeof setTimeout>;
}>();

// Pending inter-agent call registry.
// Architecture: the caller worker sends `interagent:invoke` via process.send,
// the server routes it to a target worker, and forwards the target's chat:*
// events back to the caller as `interagent:event` commands. The caller
// buffers events here (keyed by invoke id) and resolves the tool promise
// on `chat:done` / `chat:error`.
export interface PendingInteragentCall {
  events: import('./worker-protocol.js').WorkerEvent[];
  resolveDone: (event: import('./worker-protocol.js').WorkerEvent) => void;
  resolveError: (event: import('./worker-protocol.js').WorkerEvent) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingInteragentCalls = new Map<string, PendingInteragentCall>();

export function registerPendingInteragentCall(id: string, call: PendingInteragentCall): void {
  pendingInteragentCalls.set(id, call);
}

export function unregisterPendingInteragentCall(id: string): void {
  pendingInteragentCalls.delete(id);
}

export function getPendingInteragentCall(id: string): PendingInteragentCall | undefined {
  return pendingInteragentCalls.get(id);
}

// Helper: IPC request for conductor executor.
//
// This function is assigned to ToolUseContext.ipcRequest, so its signature
// MUST match the ipcRequest contract: (channel, payload, options) => Promise.
// The `channel` is always 'conductor:executor:rpc' (set by ipc-request.ts),
// and `payload` is { action, payload } — the inner action + its payload.
//
// We unwrap the payload and send the RPC message with the action at the
// top level so ConductorExecutorProxy.execute() can switch on it.
function conductorIpcRequest<T = unknown>(
  channel: string,
  payload: unknown,
  options?: { timeout?: number }
): Promise<{ success: boolean; data?: T; error?: { code: string; message: string } }> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timeout = options?.timeout || 30000;

    // Unwrap { action, payload } from the ipc-request.ts helper.
    const outerPayload = payload as { action?: string; payload?: unknown; sessionId?: string } | undefined;
    const action = outerPayload?.action ?? channel;
    const innerPayload = outerPayload?.payload ?? payload;

    const timeoutHandle = setTimeout(() => {
      if (pendingIpcRequests.has(requestId)) {
        pendingIpcRequests.delete(requestId);
        resolve({ success: false, error: { code: 'TIMEOUT', message: `IPC request timeout after ${timeout}ms` } });
      }
    }, timeout);

    pendingIpcRequests.set(requestId, {
      resolve: (v) => resolve(v as { success: boolean; data?: T; error?: { code: string; message: string } }),
      reject: (e) => reject(e),
      timeoutHandle,
    });

    sendToMain({
      type: 'conductor:executor:rpc',
      requestId,
      action,
      payload: innerPayload,
      sessionId: outerPayload?.sessionId,
    });
  });
}

// Plan 312: IPC request for App Connection tool execution.
//
// Routes `appConnection:invoke` messages to the main process
// (ConnectorService). The main process resolves the connection,
// acquires a valid token, dispatches to the provider connector,
// and returns a redacted result. Tokens never enter the agent process.
function appConnectionIpcRequest<T = unknown>(
  _channel: string,
  payload: unknown,
  options?: { timeout?: number }
): Promise<{ success: boolean; data?: T; error?: { code: string; message: string } }> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timeout = options?.timeout || 30000;

    const timeoutHandle = setTimeout(() => {
      if (pendingIpcRequests.has(requestId)) {
        pendingIpcRequests.delete(requestId);
        resolve({ success: false, error: { code: 'TIMEOUT', message: `IPC request timeout after ${timeout}ms` } });
      }
    }, timeout);

    pendingIpcRequests.set(requestId, {
      resolve: (v) => resolve(v as { success: boolean; data?: T; error?: { code: string; message: string } }),
      reject: (e) => reject(e),
      timeoutHandle,
    });

    const invokePayload = payload as {
      connectionId?: string;
      action?: string;
      args?: unknown;
    } | undefined;

    sendToMain({
      type: 'appConnection:invoke',
      requestId,
      connectionId: invokePayload?.connectionId,
      action: invokePayload?.action,
      args: invokePayload?.args,
    });
  });
}

// Plan 503: IPC request for the App Connection catalog (bot-only
// connector-management tools). Returns the provider directory plus the
// current connection list as DTOs — no tokens, no client secrets.
function appConnectionCatalogIpcRequest<T = unknown>(
  _channel: string,
  _payload: unknown,
  options?: { timeout?: number }
): Promise<{ success: boolean; data?: T; error?: { code: string; message: string } }> {
  return new Promise((resolve) => {
    const requestId = crypto.randomUUID();
    const timeout = options?.timeout || 15_000;

    const timeoutHandle = setTimeout(() => {
      if (pendingIpcRequests.has(requestId)) {
        pendingIpcRequests.delete(requestId);
        resolve({ success: false, error: { code: 'TIMEOUT', message: `appConnection catalog IPC request timeout after ${timeout}ms` } });
      }
    }, timeout);

    pendingIpcRequests.set(requestId, {
      resolve: (v) => resolve(v as { success: boolean; data?: T; error?: { code: string; message: string } }),
      reject: (e) => resolve({ success: false, error: { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) } }),
      timeoutHandle,
    });

    sendToMain({ type: 'appConnection:catalog', requestId });
  });
}

// Plan 454: IPC request for Computer Use tool execution.
//
// Routes `computer-use:execute` messages to the main process
// (electron/ipc/computer-use.ts). The main process owns the
// DesktopBackend singleton and dispatches each action to it.
// Distinct from conductorIpcRequest so the main process can route
// `computer-use:execute` to the Computer Use IPC handler instead
// of the Conductor executor.
function computerUseIpcRequest<T = unknown>(
  _channel: string,
  payload: unknown,
  options?: { timeout?: number }
): Promise<{ success: boolean; data?: T; error?: { code: string; message: string } }> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timeout = options?.timeout || 30000;

    const timeoutHandle = setTimeout(() => {
      if (pendingIpcRequests.has(requestId)) {
        pendingIpcRequests.delete(requestId);
        resolve({ success: false, error: { code: 'TIMEOUT', message: `computer-use IPC request timeout after ${timeout}ms` } });
      }
    }, timeout);

    pendingIpcRequests.set(requestId, {
      resolve: (v) => resolve(v as { success: boolean; data?: T; error?: { code: string; message: string } }),
      reject: (e) => reject(e),
      timeoutHandle,
    });

    // Forward the agent's flattened { action, payload, sessionId }
    // envelope to the main process Computer Use handler.
    const outerPayload = payload as { action?: string; payload?: unknown; sessionId?: string } | undefined;
    sendToMain({
      type: 'computer-use:execute',
      requestId,
      action: outerPayload?.action,
      payload: outerPayload?.payload,
      sessionId: outerPayload?.sessionId,
    });
  });
}

// Plan 575: IPC request for the computer_cua tool (14-tool surface).
//
// Routes `computer-use:cua` messages to the Agent Server, which forwards
// them to the CUA dispatcher (electron/ipc/cua-handlers.ts owns the
// CuaService singleton). MUST be matched in toolIpcRequest BEFORE the
// conductorIpcRequest fallback — otherwise the request is re-labeled
// `conductor:executor:rpc` with action = 'computer-use:cua' (the payload
// has no `action` field) and the ConductorExecutorProxy answers
// UNKNOWN_ACTION. Mirror of computerUseIpcRequest (plan 454).
function computerCuaIpcRequest<T = unknown>(
  _channel: string,
  payload: unknown,
  options?: { timeout?: number }
): Promise<{ success: boolean; data?: T; error?: { code: string; message: string } }> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timeout = options?.timeout || 30000;

    const timeoutHandle = setTimeout(() => {
      if (pendingIpcRequests.has(requestId)) {
        pendingIpcRequests.delete(requestId);
        resolve({ success: false, error: { code: 'TIMEOUT', message: `computer-use:cua IPC request timeout after ${timeout}ms` } });
      }
    }, timeout);

    pendingIpcRequests.set(requestId, {
      resolve: (v) => resolve(v as { success: boolean; data?: T; error?: { code: string; message: string } }),
      reject: (e) => reject(e),
      timeoutHandle,
    });

    // Forward the CUA executor's flattened { tool, args, sessionId }
    // envelope to the Agent Server's computer-use:cua handler.
    const outerPayload = payload as { tool?: string; args?: Record<string, unknown>; sessionId?: string } | undefined;
    sendToMain({
      type: 'computer-use:cua',
      requestId,
      tool: outerPayload?.tool,
      args: outerPayload?.args,
      sessionId: outerPayload?.sessionId,
    });
  });
}

// Plan 481: IPC request for the memory-tier bridge (update_state tool).
//
// Routes `memory-tier:rpc` messages to the main process, where the
// memory tier writer (electron/memory-state) owns the canonical memory
// files and the memory-state.db tier index. The agent process never
// touches the memory file tree directly.
function memoryTierIpcRequest<T = unknown>(
  _channel: string,
  payload: unknown,
  options?: { timeout?: number }
): Promise<{ success: boolean; data?: T; error?: { code: string; message: string } }> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timeout = options?.timeout || 15000;

    const timeoutHandle = setTimeout(() => {
      if (pendingIpcRequests.has(requestId)) {
        pendingIpcRequests.delete(requestId);
        resolve({ success: false, error: { code: 'TIMEOUT', message: `memory-tier IPC request timeout after ${timeout}ms` } });
      }
    }, timeout);

    pendingIpcRequests.set(requestId, {
      resolve: (v) => resolve(v as { success: boolean; data?: T; error?: { code: string; message: string } }),
      reject: (e) => reject(e),
      timeoutHandle,
    });

    const outerPayload = payload as { action?: string; payload?: unknown; sessionId?: string } | undefined;
    sendToMain({
      type: 'memory-tier:rpc',
      requestId,
      action: outerPayload?.action,
      payload: outerPayload?.payload,
      sessionId: outerPayload?.sessionId,
    });
  });
}

// Plan 481 amendment: identity subactions (profile.set / avatar.*) route
// over their own channel so the main process can bind them to the session's
// bot identity (the calling bot may only edit ITS OWN profile.json).
function botIdentityIpcRequest<T = unknown>(
  _channel: string,
  payload: unknown,
  options?: { timeout?: number }
): Promise<{ success: boolean; data?: T; error?: { code: string; message: string } }> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timeout = options?.timeout || 15000;

    const timeoutHandle = setTimeout(() => {
      if (pendingIpcRequests.has(requestId)) {
        pendingIpcRequests.delete(requestId);
        resolve({ success: false, error: { code: 'TIMEOUT', message: `bot-identity IPC request timeout after ${timeout}ms` } });
      }
    }, timeout);

    pendingIpcRequests.set(requestId, {
      resolve: (v) => resolve(v as { success: boolean; data?: T; error?: { code: string; message: string } }),
      reject: (e) => reject(e),
      timeoutHandle,
    });

    const outerPayload = payload as { subaction?: string; payload?: unknown; sessionId?: string } | undefined;
    sendToMain({
      type: 'bot-identity:rpc',
      requestId,
      subaction: outerPayload?.subaction,
      payload: outerPayload?.payload,
      sessionId: outerPayload?.sessionId,
    });
  });
}

/**
 * Unified tool IPC dispatcher: routes based on the `channel` argument.
 * - `'conductor:executor:rpc'` → conductorIpcRequest (canvas tools)
 * - `'appConnection:invoke'`    → appConnectionIpcRequest (connector tools)
 * - `'computer-use:execute'`    → computerUseIpcRequest (plan 454)
 * - `'memory-tier:rpc'`         → memoryTierIpcRequest (plan 481)
 * - `'bot-identity:rpc'`        → botIdentityIpcRequest (plan 481 amendment)
 *
 * Plan 312: always injected into the ToolUseContext so App Connection
 * tools work without conductor mode being active.
 *
 * Plan 454: the computer-use channel must be matched before the
 * default `conductorIpcRequest` fallback — otherwise the agent
 * would send `conductor:executor:rpc` to the main process for a
 * `computer-use:execute` call, which the ConductorExecutorProxy
 * does not know how to handle.
 */
function toolIpcRequest<T = unknown>(
  channel: string,
  payload: unknown,
  options?: { timeout?: number }
): Promise<{ success: boolean; data?: T; error?: { code: string; message: string } }> {
  if (channel === 'appConnection:invoke') {
    return appConnectionIpcRequest<T>(channel, payload, options);
  }
  if (channel === 'appConnection:catalog') {
    return appConnectionCatalogIpcRequest<T>(channel, payload, options);
  }
  if (channel === 'computer-use:execute') {
    return computerUseIpcRequest<T>(channel, payload, options);
  }
  // Plan 575: computer_cua channel — must precede the conductor fallback
  // (see computerCuaIpcRequest above for the failure mode).
  if (channel === 'computer-use:cua') {
    return computerCuaIpcRequest<T>(channel, payload, options);
  }
  if (channel === 'memory-tier:rpc') {
    return memoryTierIpcRequest<T>(channel, payload, options);
  }
  if (channel === 'bot-identity:rpc') {
    return botIdentityIpcRequest<T>(channel, payload, options);
  }
  return conductorIpcRequest<T>(channel, payload, options);
}

// Plan 312: fetch connector tool descriptors from the main process.
//
// Sends `appConnection:listDescriptors` and awaits the response via the
// same pendingIpcRequests map used by the conductor / appConnection
// invoke channels. Descriptors contain no tokens.
function fetchAppConnectionDescriptors(): Promise<{
  success: boolean;
  descriptors?: unknown[];
  connectedConnectionIds?: string[];
  discoveryFailedConnectionIds?: string[];
  error?: { code: string; message: string };
}> {
  return new Promise((resolve) => {
    const requestId = crypto.randomUUID();
    const timeout = 10_000;

    const timeoutHandle = setTimeout(() => {
      if (pendingIpcRequests.has(requestId)) {
        pendingIpcRequests.delete(requestId);
        resolve({ success: false, error: { code: 'TIMEOUT', message: `fetch descriptors timeout after ${timeout}ms` } });
      }
    }, timeout);

    pendingIpcRequests.set(requestId, {
      resolve: (v) => resolve(v as { success: boolean; descriptors?: unknown[]; connectedConnectionIds?: string[]; discoveryFailedConnectionIds?: string[]; error?: { code: string; message: string } }),
      reject: (e) => resolve({ success: false, error: { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) } }),
      timeoutHandle,
    });

    sendToMain({ type: 'appConnection:listDescriptors', requestId });
  });
}

/**
 * Plan 312: refresh App Connection descriptors after init, connection changes,
 * or MCP reload. This updates the next turn's tool snapshot without rebuilding
 * the worker's MCP runtime.
 *
 * Fetches the current connector tool descriptors from the main process
 * and caches them. The per-turn registry merge in DuyaAgent._resolveTools
 * reads from this cache — no IPC round-trip per turn.
 */
async function getAppConnection(): Promise<any> {
  if (!_appConnectionModule) _appConnectionModule = await import('../tool/AppConnectionTool/index.js');
  return _appConnectionModule;
}

async function reloadAppConnectionTools(): Promise<void> {
  try {
    const { setCachedAppConnectionDescriptors } = await getAppConnection();
    const response = await fetchAppConnectionDescriptors();
    if (!response.success || !response.descriptors) {
      log('[Agent-Process] App Connection: descriptor fetch failed:', response.error?.message);
      return;
    }
    // Plan 580 Phase 2C (D6): forward the authoritative connected set and
    // the discovery-failure set so setCached can distinguish all three
    // replace-set events: `connection:removed` (empty replace),
    // `discovery:succeeded` (replace), `discovery:failed` (keep last-known).
    setCachedAppConnectionDescriptors(
      response.descriptors as AppConnectionToolDescriptor[],
      response.connectedConnectionIds,
      response.discoveryFailedConnectionIds,
    );
    log(`[Agent-Process] App Connection: ${response.descriptors.length} descriptors cached`);
  } catch (err) {
    warn('[Agent-Process] App Connection: reload failed:', err);
  }
}

// ============================================================================
// Token Bucket for Tool Rate Limiting
// ============================================================================

class TokenBucket {
  private tokens: number;
  private refillTimer: NodeJS.Timeout;

  constructor(
    private capacity: number,
    private refillRate: number
  ) {
    this.tokens = capacity;
    this.refillTimer = setInterval(() => {
      this.tokens = Math.min(this.capacity, this.tokens + this.refillRate);
    }, 1000);
  }

  async consume(cost = 1): Promise<void> {
    while (this.tokens < cost) {
      // Wait and retry until tokens are available
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    this.tokens -= cost;
  }

  destroy(): void {
    if (this.refillTimer) {
      clearInterval(this.refillTimer);
    }
  }
}

// Tool-level rate limiting
const toolBucket = new TokenBucket(5, 2); // 5 capacity, 2 per second

// ============================================================================
// MessageRow -> Message Conversion
// ============================================================================

function messageRowToMessage(
  row: MessageRow,
  attachmentMap?: Map<string, AttachmentRow[]>,
  parsedDocMap?: Map<string, ParsedDocumentAttachment[]>
): Message {
  let content: string | MessageContent[];
  let toolCallId = row.tool_call_id || undefined;

  if (row.msg_type === 'thinking' && row.thinking) {
    content = [{ type: 'thinking', thinking: row.thinking }];
  } else if (row.msg_type === 'tool_use' && row.tool_name) {
    let input: Record<string, unknown> = {};
    let toolId = row.id;
    try {
      const parsed = JSON.parse(row.content);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const block = parsed[0];
        if (block.id) toolId = block.id;
        if (block.input) input = block.input;
      }
    } catch (err) {
      try {
        input = row.tool_input ? JSON.parse(row.tool_input) : {};
      } catch (parseErr) {
        input = {};
      }
    }
    content = [{ type: 'tool_use', id: toolId, name: row.tool_name, input }];
    toolCallId = toolId;
  } else {
    try {
      const parsed = JSON.parse(row.content);
      if (Array.isArray(parsed)) {
        content = parsed as MessageContent[];
      } else {
        content = row.content;
      }
    } catch {
      content = row.content;
    }
  }

  // Rehydrate CDN image URLs with locally stored base64
  if (attachmentMap && Array.isArray(content)) {
    content = rehydrateContentWithAttachments(content, attachmentMap) as MessageContent[];
  }

  let parsedAttachments: import('../types.js').FileAttachment[] | undefined;
  if (row.attachments) {
    try {
      parsedAttachments = JSON.parse(row.attachments) as import('../types.js').FileAttachment[];
    } catch {
      // ignore parse errors
    }
  }

  // Restore document attachment fields for LLM context on restart.
  // text, path, imageChunks, and extractMethod are restored so that
  // buildAttachmentContext() in the LLM client can assemble the doc context on-the-fly.
  if (parsedAttachments && parsedDocMap) {
    for (const att of parsedAttachments) {
      const docs = parsedDocMap.get(row.id);
      if (docs) {
        const doc = docs.find(d => d.filename === att.name);
        if (doc) {
          att.path = doc.filePath;
          att.text = doc.text;
          if (doc.extractMethod) att.extractMethod = doc.extractMethod as 'text' | 'vision' | 'hybrid';
          if (doc.imageChunks) {
            try {
              const parsed = JSON.parse(doc.imageChunks) as Array<{ base64: string; mediaType: string }>;
              if (parsed.length > 0) {
                att.imageChunks = parsed;
              }
            } catch {
              // ignore parse errors
            }
          }
        }
      }
    }
  }

  // parsePersistedTokenUsage preserves the plan-445 sub-blocks (`last_call`
  // + `calls[]`). Stripping them here made every reloaded turn-cumulative
  // block normalize as ONE request's prompt (cacheHit > input → input +
  // cacheHit + write ≈ N_calls × real context): measured anchor 476,536 on
  // a ~24k context (2026-09-28) → ring 238% / 200k and a spurious proactive
  // compaction of the real history until the turn's first `result` observed
  // the true 24,178 and corrected the anchor back down.
  const tokenUsage = parsePersistedTokenUsage(row.token_usage);

  // Plan 486: restore thread/fork metadata from the flat row columns so a
  // reloaded session can serve getThread and keep branched messages out of
  // the main projections.
  let threadMeta: { replyToId?: string; branched?: boolean } | undefined;
  if (row.reply_to_id != null || row.branched != null) {
    threadMeta = {
      ...(row.reply_to_id != null ? { replyToId: row.reply_to_id } : {}),
      ...(row.branched != null ? { branched: row.branched === true } : {}),
    };
  }

  return {
    id: row.id,
    role: row.role,
    content,
    displayContent: row.display_content != null
      ? row.display_content
      : undefined,
    name: row.name || undefined,
    tool_call_id: toolCallId,
    timestamp: row.created_at,
    msg_type: row.msg_type || undefined,
    thinking: row.thinking || undefined,
    tool_name: row.tool_name || undefined,
    tool_input: row.tool_input || undefined,
    parent_tool_call_id: row.parent_tool_call_id || undefined,
    viz_spec: row.viz_spec || undefined,
    status: row.status || undefined,
    seq_index: row.seq_index ?? undefined,
    duration_ms: row.duration_ms ?? undefined,
    sub_agent_id: row.sub_agent_id || undefined,
    attachments: parsedAttachments,
    tokenUsage,
    ...(threadMeta ? { metadata: { threadMeta } } : {}),
  };
}

function applyRequestDisplayContent(messages: readonly Message[], displayContent?: string): void {
  if (displayContent === undefined) {
    return;
  }
  const userMessage = messages.find((item) => item.role === 'user');
  if (userMessage && userMessage.displayContent === undefined) {
    userMessage.displayContent = displayContent;
  }
}

// ============================================================================
// Message History Validation
// ============================================================================

function getToolUseIds(message: Message): string[] {
  if (message.role !== 'assistant') return [];
  if (message.msg_type === 'tool_use' && message.tool_call_id) {
    return [message.tool_call_id];
  }
  if (!Array.isArray(message.content)) return [];
  return message.content.flatMap((block) => (
    block.type === 'tool_use' && 'id' in block && typeof block.id === 'string' && block.id
      ? [block.id]
      : []
  ));
}

function getToolResultIds(message: Message): string[] {
  if (message.role === 'tool' && message.tool_call_id) {
    return [message.tool_call_id];
  }
  if (!Array.isArray(message.content)) return [];
  return message.content.flatMap((block) => (
    block.type === 'tool_result' && 'tool_use_id' in block && typeof block.tool_use_id === 'string' && block.tool_use_id
      ? [block.tool_use_id]
      : []
  ));
}

function assistantContentBlocks(message: Message): MessageContent[] {
  if (Array.isArray(message.content)) return message.content;

  if (message.msg_type === 'tool_use' && message.tool_call_id) {
    let input: Record<string, unknown> = {};
    if (message.tool_input) {
      try {
        const parsed = JSON.parse(message.tool_input);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          input = parsed as Record<string, unknown>;
        }
      } catch {
        // Preserve the call with an empty input rather than dropping its result pair.
      }
    }
    return [{
      type: 'tool_use',
      id: message.tool_call_id,
      name: message.tool_name || 'unknown_tool',
      input,
    }];
  }

  return message.content ? [{ type: 'text', text: message.content }] : [];
}

function mergeAssistantToolRound(messages: readonly Message[]): Message {
  if (messages.length === 1) return messages[0];

  const first = messages[0];
  return {
    ...first,
    content: messages.flatMap(assistantContentBlocks),
    msg_type: undefined,
    tool_call_id: undefined,
    tool_name: undefined,
    tool_input: undefined,
  };
}

/**
 * Canonicalize complete tool rounds before a restored session is reused.
 *
 * Some Anthropic-compatible providers require all tool results to be the next
 * user turn after their assistant tool call. A queued notification may have
 * been persisted between the two; this is recoverable by moving the
 * notification after the completed tool round.
 */
function reorderCompleteToolRounds(messages: Message[]): Message[] {
  const reordered: Message[] = [];
  let repairedRounds = 0;

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    const pendingToolUseIds = getToolUseIds(message);
    const pendingIds = new Set(pendingToolUseIds);
    if (pendingIds.size === 0) {
      reordered.push(message);
      continue;
    }

    // A model can correct a bad tool name before the executor flushes the
    // first failure. Persisted as two assistant messages, that sequence is
    // invalid for strict Anthropic-compatible providers. Group consecutive
    // tool-bearing assistant messages into one canonical tool round.
    const assistantRound = [message];
    let firstNonAssistantIndex = index + 1;
    while (firstNonAssistantIndex < messages.length) {
      const candidate = messages[firstNonAssistantIndex];
      const candidateIds = getToolUseIds(candidate);
      if (candidateIds.length === 0) break;
      assistantRound.push(candidate);
      pendingToolUseIds.push(...candidateIds);
      candidateIds.forEach((id) => pendingIds.add(id));
      firstNonAssistantIndex++;
    }

    const unresolvedIds = new Set(pendingIds);
    const resultMessages: Array<{ message: Message; order: number }> = [];
    const deferredMessages: Message[] = [];
    let resultEndIndex = -1;

    for (let cursor = firstNonAssistantIndex; cursor < messages.length && unresolvedIds.size > 0; cursor++) {
      const candidate = messages[cursor];
      if (candidate.role === 'assistant') break;

      const matchingIds = getToolResultIds(candidate).filter((id) => unresolvedIds.has(id));
      if (matchingIds.length > 0) {
        matchingIds.forEach((id) => unresolvedIds.delete(id));
        resultMessages.push({
          message: candidate,
          order: Math.min(...matchingIds.map((id) => pendingToolUseIds.indexOf(id))),
        });
        resultEndIndex = cursor;
      } else {
        deferredMessages.push(candidate);
      }
    }

    if (unresolvedIds.size > 0 || resultEndIndex === -1) {
      // Filter out unmatched tool_use blocks to avoid API 400 error
      // (tool_use blocks without corresponding tool_result blocks)
      const filteredAssistantRound = assistantRound
        .map((msg) => {
          if (msg.msg_type === 'tool_use' && msg.tool_call_id && unresolvedIds.has(msg.tool_call_id)) {
            return null;
          }
          if (Array.isArray(msg.content)) {
            const filteredContent = msg.content.filter((block) => {
              if (block.type === 'tool_use' && 'id' in block && typeof block.id === 'string' && unresolvedIds.has(block.id)) {
                return false;
              }
              return true;
            });
            if (filteredContent.length === 0) return null;
            if (filteredContent.length === msg.content.length) return msg;
            return { ...msg, content: filteredContent };
          }
          return msg;
        })
        .filter((msg): msg is Message => msg !== null);
      if (filteredAssistantRound.length > 0) {
        reordered.push(...filteredAssistantRound);
      }
      index = firstNonAssistantIndex - 1;
      continue;
    }

    const alreadyOrdered = assistantRound.length === 1 && resultEndIndex === index + 1 && deferredMessages.length === 0;
    reordered.push(alreadyOrdered ? message : mergeAssistantToolRound(assistantRound));
    if (alreadyOrdered) {
      reordered.push(messages[resultEndIndex]);
    } else {
      resultMessages.sort((left, right) => left.order - right.order);
      reordered.push(...resultMessages.map(({ message: resultMessage }) => resultMessage), ...deferredMessages);
      repairedRounds++;
    }
    index = resultEndIndex;
  }

  if (repairedRounds > 0) {
    log(`[Agent-Process] Reordered ${repairedRounds} persisted tool round(s) to restore tool_use -> tool_result ordering`);
  }

  return repairedRounds > 0 ? reordered : messages;
}

/**
 * Validates and cleans up message history to ensure tool_use/tool_result pairs are complete.
 * 
 * When a stream fails mid-execution (e.g., API error, network issue), the database
 * may contain tool_use messages without corresponding tool_result messages. The
 * Anthropic API rejects requests where tool results don't properly follow tool calls.
 * 
 * This function:
 * 1. Identifies all tool_use message IDs
 * 2. Identifies all tool_result message IDs
 * 3. Removes any tool_use that has no matching tool_result
 * 4. Removes any orphan tool_result that has no matching tool_use
 * 5. Removes trailing incomplete tool_use from the last assistant message
 */
function validateMessageHistory(messages: Message[]): Message[] {
  if (messages.length === 0) return messages;

  // Collect all tool_use IDs from messages
  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();

  for (const msg of messages) {
    if (msg.msg_type === 'tool_use' && msg.tool_call_id) {
      toolUseIds.add(msg.tool_call_id);
    } else if (msg.role === 'tool' && msg.tool_call_id) {
      toolResultIds.add(msg.tool_call_id);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_use' && 'id' in block && typeof block.id === 'string') {
          toolUseIds.add(block.id);
        } else if (block.type === 'tool_result' && 'tool_use_id' in block && typeof block.tool_use_id === 'string') {
          toolResultIds.add(block.tool_use_id);
        }
      }
    }
  }

  // Find tool_uses without matching results
  const unmatchedToolUseIds = new Set<string>();
  for (const id of toolUseIds) {
    if (!toolResultIds.has(id)) {
      unmatchedToolUseIds.add(id);
    }
  }

  // Find tool_results without matching tool_uses — symmetric with
  // toAnthropicMessages' bidirectional cleanup. Previously this
  // function returned early when there were no unmatched tool_uses,
  // leaving truly orphan tool_results in place to be handled (or
  // missed) downstream. We now drop them in this pass too, so the
  // load-from-DB path keeps the message history in a state that the
  // Anthropic converter can handle without surprises.
  const orphanToolResultIds = new Set<string>();
  for (const id of toolResultIds) {
    if (!toolUseIds.has(id)) {
      orphanToolResultIds.add(id);
    }
  }

  // Detect tool_result messages with empty/undefined tool_call_id.
  // These come from providers (MiniMax-M3) returning empty tool_use.id;
  // they can never be paired and would trigger Anthropic 2013.
  let unpairedToolResultCount = 0;
  for (const msg of messages) {
    if (msg.role === 'tool' && !msg.tool_call_id) {
      unpairedToolResultCount++;
    }
  }

  if (unmatchedToolUseIds.size === 0 && orphanToolResultIds.size === 0 && unpairedToolResultCount === 0) {
    return reorderCompleteToolRounds(messages);
  }

  log(`[Agent-Process] Cleaning history: ${unmatchedToolUseIds.size} unmatched tool_use(s), ${orphanToolResultIds.size} orphan tool_result(s), ${unpairedToolResultCount} unpaired tool_result(s) with empty tool_call_id`);

  // Filter out messages with unmatched tool_uses or orphan tool_results
  const cleanedMessages: Message[] = [];
  for (const msg of messages) {
    // Drop any tool_result message whose tool_call_id is empty/undefined.
    // These originate from providers (notably MiniMax-M3) that occasionally
    // return an empty `tool_use.id`; the empty string collapses to NULL in
    // the DB (appendMessages uses `msg.tool_call_id || null`), and
    // messageRowToMessage converts NULL back to undefined. Such a
    // tool_result can never be paired with a tool_use — the API rejects
    // it with 400 "tool call id is invalid (2013)". The `msg.tool_call_id`
    // guard in the orphan check below would otherwise skip these, so we
    // catch them explicitly here.
    if (msg.role === 'tool' && !msg.tool_call_id) {
      log(`[Agent-Process] Removing unpaired tool_result with empty tool_call_id (tool_name=${msg.tool_name || 'unknown'})`);
      continue;
    }

    // Drop truly orphan tool_result messages (tool_call_id has no
    // matching tool_use anywhere in the history).
    if (msg.role === 'tool' && msg.tool_call_id && orphanToolResultIds.has(msg.tool_call_id)) {
      log(`[Agent-Process] Removing orphan tool_result: ${msg.tool_call_id}`);
      continue;
    }

    // Skip tool_use messages that don't have a matching result
    if (msg.msg_type === 'tool_use' && msg.tool_call_id && unmatchedToolUseIds.has(msg.tool_call_id)) {
      log(`[Agent-Process] Removing incomplete tool_use: ${msg.tool_call_id} (${msg.tool_name})`);
      continue;
    }

    // For assistant messages with mixed content, drop unmatched
    // tool_use blocks (incomplete calls) AND orphan tool_result
    // blocks (their tool_use is gone). Keep the rest of the message
    // intact — same convention used by toAnthropicMessages: a text
    // block is preserved even when its sibling tool blocks are
    // stripped.
    if (Array.isArray(msg.content)) {
      const filteredContent = msg.content.filter((block) => {
        if (block.type === 'tool_use' && 'id' in block && typeof block.id === 'string') {
          if (unmatchedToolUseIds.has(block.id)) {
            log(`[Agent-Process] Removing tool_use block from assistant message: ${block.id}`);
            return false;
          }
        }
        if (block.type === 'tool_result' && 'tool_use_id' in block && typeof block.tool_use_id === 'string') {
          if (orphanToolResultIds.has(block.tool_use_id)) {
            log(`[Agent-Process] Removing orphan tool_result block from assistant message: ${block.tool_use_id}`);
            return false;
          }
        }
        return true;
      });

      // If all blocks were removed, keep the message with empty content
      // If some blocks remain, use filtered content
      cleanedMessages.push({
        ...msg,
        content: filteredContent.length > 0 ? filteredContent : '',
      });
    } else {
      cleanedMessages.push(msg);
    }
  }

  const orderedMessages = reorderCompleteToolRounds(cleanedMessages);
  log(`[Agent-Process] Cleaned message history: ${messages.length} -> ${orderedMessages.length} messages`);
  return orderedMessages;
}

function extractFinalAssistantText(messages: Message[]): string {
  const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant');
  if (!lastAssistant) {
    return '';
  }

  if (typeof lastAssistant.content === 'string') {
    return lastAssistant.content.trim();
  }

  return lastAssistant.content
    .filter((block) => block.type === 'text')
    .map((block) => (block as { type: 'text'; text: string }).text)
    .join('\n')
    .trim();
}

function summarizeConversation(messages: Message[], maxMessages = 12): string {
  return messages
    .slice(-maxMessages)
    .map((message) => {
      const role = message.role.toUpperCase();
      if (typeof message.content === 'string') {
        return `[${role}] ${message.content.slice(0, 1000)}`;
      }

      const text = message.content
        .filter((block) => block.type === 'text')
        .map((block) => (block as { type: 'text'; text: string }).text)
        .join('\n')
        .trim();

      return text ? `[${role}] ${text.slice(0, 1000)}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

// ============================================================================
// Agent Initialization
// ============================================================================

async function initAgent(
  config: InitMessage['providerConfig'] | null | undefined,
  workDir?: string,
  defaultWorkspaceDir?: string,
  sysPrompt?: string,
  blockedDomains?: string[],
  language?: string,
  sandboxEnabled?: boolean,
  communicationPlatform?: string,
  browserBackendMode?: 'auto' | 'extension' | 'built-in' | 'human-like',
  permissionRules?: InitMessage['permissionRules'],
  // Plan 536 L1: project ID resolved by the agent server from the
  // session's workingDirectory. Forwarded into the agent as
  // `currentProjectId` so it lands in every ctx.options.currentProjectId.
  currentProjectId?: string | null,
  // Plan 525 / 408 follow-up: project-entity home directory
  // (`~/.duya/projects/<projectId>/`). Forwarded into the agent as
  // `projectHome` so the agentsmd loader can read
  // `<projectHome>/AGENTS.md` as a `'Project entity'` source. Undefined
  // when no project is bound.
  projectHome?: string,
): Promise<void> {
  // Store system prompt for use in chat
  sessionSystemPrompt = sysPrompt;

  // Guard: providerConfig can be null when no provider is configured.
  // Without this, accessing config.model throws and crashes the worker,
  // which surfaces as a misleading "initialization timeout" after 30s.
  if (!config) {
    throw new Error('No provider config available. Please configure an API provider in Settings.');
  }

  // Store model name for multimodal detection
  mainModelName = config.model;
  // Provider id snapshot for per-call usage attribution (token-accounting).
  currentProviderId = config.runtimeConfig?.providerId ?? '';
  if (config.runtimeConfig) {
    // Phase 2: log that the new runtime config has been delivered.
    // The actual wiring into the LLM client is staged for a later
    // iteration; this confirms the new path is end-to-end reachable.
    log('[Agent-Process] runtimeConfig present (Phase 2)', {
      providerId: config.runtimeConfig.providerId,
      apiFormat: config.runtimeConfig.apiFormat,
      baseUrl: config.runtimeConfig.baseUrl,
      model: config.runtimeConfig.model,
      headerKeys: Object.keys(config.runtimeConfig.headers ?? {}),
      // CRITICAL: never log the apiKey / accessToken here.
    });
  }
  probeConfig = {
    model: config.model,
    provider: (config.provider || 'openai') as ProbeConfig['provider'],
    apiKey: config.apiKey || '',
    baseURL: config.baseURL || '',
    authStyle: config.authStyle as ProbeConfig['authStyle'],
  };

  agent = new duyaAgent({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    model: config.model,
    authStyle: config.authStyle,
    provider: config.provider,
    sessionId: sessionId!,
    communicationPlatform: (communicationPlatform as 'cli' | 'duya-app' | 'weixin' | 'feishu' | 'telegram' | 'web' | 'api') ?? 'duya-app',
    workingDirectory: workDir,
    // Plan 536 L1: project ID resolved by the agent server.
    currentProjectId: currentProjectId ?? null,
    // Plan 525 / 408 follow-up: project-entity home directory
    // resolved by the agent server. Undefined when no project is bound
    // to the session's workingDirectory.
    projectHome,
    visionConfig: config.visionConfig,
    compactModelConfig: config.compactModelConfig,
    blockedDomains,
    browserBackendMode,
    language,
    defaultWorkspaceDirectory: defaultWorkspaceDir,
    permissionRules,
    // Phase 3: thread the runtime config into the agent. The
    // constructor will prefer `apiFormat` over `provider` when
    // present. Legacy fields stay authoritative for everything else
    // (vision, sub-model resolution, etc.).
    runtimeConfig: config.runtimeConfig,
  });

  // Plan 441: wire the per-event journal. Built after the agent so we have
  // sessionId and can attach it via the new `agent.journal` field. Subagent
  // instances also pass through `duyaAgent` constructor and inherit the
  // journal wiring when their own handleChatStart setup runs — the journal
  // is set in this same function for every DuyaAgent constructed in this
  // file (subagent construction in runAgent.ts reuses the same pattern).
  agent.journal = new Journal({
    sessionId: sessionId!,
    onError: (kind, err) => {
      log(`[Agent-Process] journal ${kind} persist failed:`, err instanceof Error ? err.message : String(err));
    },
  });

  // Wire the compaction callback so proactive compaction inside
  // streamChat emits a `rebase` event rather than re-appending the full
  // compacted message list. The old turn-end batch semantics were
  // appendMessages-of-all-messages which only worked because INSERT OR
  // IGNORE deduped — under the journal model we use appendRebase so
  // the rollout file is strictly append-only (Phase 4 replaces the
  // remaining rewriteSession callers with the same pattern).
  agent.onMessagesCompacted = (newMessageCount: number): void => {
    log(`[Agent-Process] Messages compacted, new count=${newMessageCount}`);
    if (!agent.journal) return;
    const currentMessages = agent.getMessages();
    // Plan 441: append-only rebase. A null supersededUpToSeq supersedes ALL
    // raw messages preceding the rebase in the trace — survivors are kept
    // by id matching against the compacted message list. The subprocess has
    // no reliable view of DB-assigned seqs, so a numeric bound would be
    // wrong for resumed sessions.
    agent.journal.appendRebase(
      `compact:${Date.now()}:${currentMessages.length}`,
      null,
      currentMessages,
    );
    log(`[Agent-Process] Compaction rebase emitted, newMessages=${currentMessages.length}`);
    // Proactive mid-turn compaction rewrote the timeline: retained anchors
    // describe the pre-compaction prompt, so mark pending and broadcast an
    // unanchored frame (ring shows "?") until the next `result` lands.
    compactedPending = true;
    // Plan 577 §3: epoch boundary — compaction succeeded inside
    // CompactionManager.compact(), whose ledger already began the
    // 'compaction' epoch, so the Observation layer (latest/peak/shrink) is
    // cleared atomically there. Nothing to reset here anymore.
    emitLiveUsage(sessionId);
  };

  if (sandboxEnabled !== false) {
    const { buildSandboxImage, setSandboxEnabled } = await import('../sandbox/index.js');
    if (setSandboxEnabled) setSandboxEnabled(true);
    buildSandboxImage((msg: string) => log(msg)).catch(() => {});
  }

  log('[Agent-Process] Agent core initialized');
}

async function loadAgentSkills(workDir?: string, skillPaths?: string[], securityScanEnabled?: boolean): Promise<void> {
  try {
    // Bundled skills are now installed on-demand via the plugin marketplace;
    // do not auto-sync the entire bundled set at agent startup.
    const loadOptions: { additionalPaths?: string[]; agentSkillsDir?: string; syncBundled?: boolean; securityBypassSkills?: string[]; skipSecurityScan?: boolean } = {
      syncBundled: false,
    };

    // Bot-scoped skills: persistent bot sessions are `bot:<botId>`, so load
    // that bot's own skills dir (source 'agent') and let them shadow global
    // user/project skills of the same name.
    if (sessionId?.startsWith('bot:')) {
      const botId = sessionId.slice('bot:'.length);
      if (botId) loadOptions.agentSkillsDir = getAgentSkillDirectory(botId);
    }

    // Discover plugin skill directories dynamically
    const pluginSkillPaths = await discoverPluginSkillPaths();
    const allSkillPaths = [...(skillPaths || []), ...pluginSkillPaths];

    if (allSkillPaths.length > 0) {
      loadOptions.additionalPaths = allSkillPaths;
    }
    // Read security bypass list from environment variable
    const bypassSkillsEnv = process.env.DUYA_SECURITY_BYPASS_SKILLS;
    if (bypassSkillsEnv) {
      loadOptions.securityBypassSkills = bypassSkillsEnv.split(',').map(s => s.trim()).filter(Boolean);
    }
    // Honor the securityScanEnabled setting from the UI
    if (securityScanEnabled === false) {
      loadOptions.skipSecurityScan = true;
    }
    // Use workDir if provided, otherwise use process.cwd()
    const skillsCwd = workDir || process.cwd();
    await loadSkills(skillsCwd, loadOptions);
    const registry = getSkillRegistry();

    // Apply user overrides from settings (disabled skills are fully removed from runtime registry)
    try {
      const overridesRaw = await settingDb.getJson<Record<string, boolean>>('skillEnabledOverrides', {});
      const overrides = (overridesRaw && typeof overridesRaw === 'object')
        ? overridesRaw as Record<string, boolean>
        : {};
      const disabledNames = new Set<string>(
        Object.entries(overrides)
          .filter(([, enabled]) => enabled === false)
          .map(([name]) => name)
      );
      if (disabledNames.size > 0) {
        for (const skill of registry.list()) {
          // System-level skills are always enabled; user overrides must not
          // disable them.
          if (disabledNames.has(skill.name) && skill.source !== 'system') {
            registry.unregister(skill.name);
          }
        }
        log(`[Agent-Process] Disabled ${disabledNames.size} skill(s) via user overrides`);
      }
    } catch (overrideErr) {
      warn('[Agent-Process] Failed to apply skill enabled overrides:', overrideErr);
    }

    const skills = registry.list();
    log(`[Agent-Process] Loaded ${skills.length} skills after filtering (${pluginSkillPaths.length} plugin skill paths)`);
    if (skills.length === 0) {
      sendToMain({
        type: 'skills:status',
        synced: false,
        added: [],
        updated: [],
        skipped: [],
        removed: [],
        error: 'No skills loaded. Check bundled skills directory or user skills directory.',
      });
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    warn('[Agent-Process] Failed to load skills:', err);
    sendToMain({
      type: 'skills:status',
      synced: false,
      added: [],
      updated: [],
      skipped: [],
      removed: [],
      error: errMsg,
    });
  }
}

// ============================================================================
// Message Handling
// ============================================================================

// Send events via stdout JSON lines (worker-protocol.ts)
// Events go to BOTH channels:
//   - process.send() (IPC) for DB requests, permissions, RPC
//   - sendEvent() (stdout) for the SSE stream handler in router.ts
function sendToMain(msg: Record<string, unknown>): void {
  process.send?.(msg);
  sendEvent(msg);
}

async function persistTurnReview(
  currentSessionId: string,
  turnId: string,
  baseline: unknown,
): Promise<void> {
  if (!baseline) return;
  const { completeTurnReview } = await import('../session/turn-review.js');
  const review = completeTurnReview(baseline as Parameters<typeof completeTurnReview>[0]);
  if (!review) return;
  try {
    await turnReviewDb.save({
      id: randomUUID(),
      sessionId: currentSessionId,
      turnId,
      workingDirectory: review.workingDirectory,
      files: review.files,
      patch: review.patch,
      additions: review.additions,
      removals: review.removals,
      truncated: review.truncated,
      binary: review.binary,
      capturedAt: Date.now(),
    });
  } catch (error) {
    warn('[Agent-Process] Failed to persist turn review:', error instanceof Error ? error.message : String(error));
  }
}

// The SSE-to-frame mapping moved to ./sse-frame-codec.ts under plan 587 H8.1.
// It used to live here, which meant the headless run host would have had to
// copy it to speak the same frame vocabulary as the worker process. One codec,
// two callers: see that module for why that matters.
// Create permission handler for streaming
function createPermissionHandler(sessId: string): (request: { id: string; toolName: string; toolInput: Record<string, unknown>; mode?: string; expiresAt: number; metadata?: { toolParamsDisplay?: Array<{ name: string; label: string; value: string }> } }) => Promise<'allow' | 'deny'> {
  return async (request) => {
    const descriptor = (await getAppConnection()).getCachedAppConnectionDescriptors().find((d: any) => d.name === request.toolName);
    return new Promise<'allow' | 'deny'>((resolve, reject) => {
      const key = pendingPermissionKey(sessId, request.id);

      // Duplicate request: the renderer (or main) is replaying the same id
      // (SSE reconnect, sub-agent fork, race with the 5min timer, etc.).
      // We must NOT overwrite the existing pending entry — doing so would
      // orphan the first promise and create a stuck prompt. The 5min
      // timeout is still armed on the original entry; leave it alone.
      if (pendingPermissions.has(key)) {
        warn('[Agent-Process] Duplicate permission request, ignoring:', { sessionId: sessId, id: request.id });
        return;
      }

      const timeoutHandle = setTimeout(() => {
        const entry = pendingPermissions.get(key);
        if (entry) {
          pendingPermissions.delete(key);
          entry.resolve('deny');
        }
      }, 300000);
      // Don't keep the agent process alive solely for this timer — if the
      // process is otherwise idle (e.g. permission prompt is the only thing
      // outstanding), let it exit gracefully.
      if (typeof (timeoutHandle as { unref?: () => void }).unref === 'function') {
        (timeoutHandle as { unref: () => void }).unref();
      }

      pendingPermissions.set(key, { resolve, reject, timeoutHandle, toolName: request.toolName });

      sendToMain({
        type: 'chat:permission',
        sessionId: sessId,
        request: {
          id: request.id,
          toolName: request.toolName,
          toolInput: request.toolInput,
          mode: request.mode,
          expiresAt: request.expiresAt,
          ...(descriptor
            ? {
                connector: {
                  provider: descriptor.provider,
                  riskTier: descriptor.riskTier,
                  preApproved: descriptor.preApproved === true,
                },
              }
            : {}),
          ...(request.metadata
            ? { metadata: { toolParamsDisplay: request.metadata.toolParamsDisplay } }
            : {}),
        },
      });
    });
  };
}

// ============================================================================
// The run engine (plan 600 S2)
// ============================================================================

/**
 * Narrow a legacy prompt into the engine's `ModelContentBlock` shape.
 *
 * A legacy `MessageContent[]` carries blocks this port has no vocabulary for
 * (images, documents), and `ModelContentBlock` is deliberately closed so a host
 * cannot smuggle a UI payload through the model boundary. Rather than widen the
 * runtime's type to fit the legacy one, the text is extracted and anything else
 * is dropped — stated here because a silent drop is the failure mode, and the
 * attachment content the model needs is injected by `ContextPort.assemble`,
 * which is the host's job and where the full block set still lives.
 */
function toEngineContent(content: string | MessageContent[]): string | ModelContentBlock[] {
  if (typeof content === 'string') return content;
  const blocks: ModelContentBlock[] = [];
  for (const block of content) {
    if (block.type === 'text' && typeof (block as { text?: unknown }).text === 'string') {
      blocks.push({ type: 'text', text: (block as { text: string }).text });
    }
  }
  return blocks;
}

// ============================================================================
// Chat Handler
// ============================================================================

async function handleChatStart(msg: ChatStartMessage): Promise<void> {
  if (!agent) {
    sendToMain({ type: 'chat:error', message: 'Agent not initialized', sessionId: msg.sessionId });
    return;
  }

  // Plan 453 Task G: wakeless path. When `options.wakeless === true`,
  // the session is ephemeral — closing the orb discards everything
  // and we never write a rollout file. We strip the journal ref on
  // the agent so subsequent `_pushDurable` calls (which already
  // check `this.journal`) are no-ops.
  if (msg.options?.wakeless === true) {
    if (!msg.sessionId.startsWith('wakeless-')) {
      log(
        `[Agent-Process] WARN: wakeless=true but sessionId=${msg.sessionId} lacks 'wakeless-' prefix`,
      );
    }
    log(
      `[Agent-Process] wakeless=true; journal + timeline-persist disabled for sessionId=${msg.sessionId}`,
    );
    agent.journal = undefined;
  }

  // Plan 314: wait for the long-lived ToolCatalog to have MCP tools
  // registered before resolving tools for this turn. The gate is
  // released once after applyMCPConfiguration completes (init), or
  // after a 3s timeout — whichever is first. Subsequent turns
  // resolve immediately since the promise stays settled.
  await agent.waitForMcpReady(3000);

  const workingDirectory = typeof agent.workingDirectory === 'string' ? agent.workingDirectory : '';
  const { captureTurnReviewBaseline } = await import('../session/turn-review.js');
  const turnReviewBaseline = captureTurnReviewBaseline(workingDirectory);

  // Update title generation model config from chat options
  const titleModelOption = msg.options?.titleGenerationModel;
  const titleModelConfigOption = msg.options?.titleGenerationModelConfig;

  if (titleModelConfigOption) {
    titleGenerationModelConfig = {
      provider: titleModelConfigOption.provider,
      apiKey: titleModelConfigOption.apiKey,
      baseURL: titleModelConfigOption.baseURL,
      model: titleModelConfigOption.model,
      apiFormat: titleModelConfigOption.apiFormat,
      modelCompat: titleModelConfigOption.modelCompat,
    };
    log('[Agent-Process] Title generation model configured from options:', titleGenerationModelConfig.model);
  } else if (titleModelOption) {
    const parts = titleModelOption.split(':');
    if (parts.length >= 2) {
      const model = parts.slice(1).join(':');
      titleGenerationModelConfig = {
        provider: agent.provider || 'openai',
        apiKey: agent.apiKey || '',
        baseURL: agent.baseURL || '',
        model: model,
      };
      log('[Agent-Process] Title generation model configured from agent config:', titleGenerationModelConfig.model);
    }
  } else {
    titleGenerationModelConfig = null;
  }

  if (msg.options?.language && agent) {
    agent.setLanguage(msg.options.language);
  }

  log('[Agent-Process] handleChatStart:', {
    sessionId: msg.sessionId,
    promptLength: msg.prompt.length,
    agentProfileId: msg.options?.agentProfileId || '(none)',
    conductorMode: msg.options?.conductorMode ?? false,
    hasConductorCanvasId: !!msg.options?.conductorCanvasId,
  });
  if (agent) {
    log('[Agent-Process] Agent LLM config:', {
      model: agent.model,
      provider: agent.provider,
      baseURL: agent.baseURL,
    });
  }
  debugLog('chat:start received', {
    sessionId: msg.sessionId,
    agentProfileId: msg.options?.agentProfileId || '(none)',
    hasOptionsMessages: Array.isArray(msg.options?.messages),
    optionsMessageCount: Array.isArray(msg.options?.messages) ? msg.options?.messages.length : 0,
    hasFiles: Array.isArray(msg.options?.files) && msg.options.files.length > 0,
    filesKeys: msg.options?.files?.[0] ? Object.keys(msg.options.files[0]) : [],
    firstFileHasText: msg.options?.files?.[0] ? 'text' in msg.options.files[0] : false,
    firstFileTextLength: msg.options?.files?.[0]?.text?.length ?? 'N/A',
    firstFileRaw: msg.options?.files?.[0] ? JSON.stringify(msg.options.files[0]).substring(0, 200) : 'N/A',
  });

  // Plan 587 R2.2: verify the binding BEFORE any execution. This sits above
  // every side effect in this function on purpose — the whole point of a
  // refused run is that nothing happened, and a check placed after the
  // heartbeat, the permission seeds or the tool-approval ledger read would
  // already have touched state.
  //
  // Producers that have not migrated (automation, the workflow runtime, the
  // sub-agent tool) send no manifest at all, and they are registered for H8.
  // They are NOT failed here: there is nothing to verify against, and refusing
  // them would break working paths to satisfy a check they cannot yet meet.
  // A turn that ARRIVES with a manifest is held to it.
  if (msg.manifest !== undefined && msg.manifestHash !== undefined) {
    const verdict = verifyRunManifestBinding({
      manifest: msg.manifest,
      manifestHash: msg.manifestHash,
      inputRevision: msg.inputRevision ?? '',
      received: {
        sessionId: msg.sessionId,
        prompt: msg.prompt,
        options: (msg.options ?? {}) as Record<string, unknown>,
      },
      worker: workerCapabilitySet(),
    });
    if (!verdict.ok) {
      // Refused, and NAMED. `chat:error` is the frame the router already turns
      // into a run terminal, so the refusal is recorded rather than being a
      // worker that silently never answers.
      log(
        `[chat:start] refused ${verdict.code}: ${verdict.detail} (runId=${msg.runId ?? 'none'}, session=${msg.sessionId})`,
      );
      // `message`, not `error`. This frame used to carry `error`, and it was
      // the ONLY `chat:error` in this file that did — every other send site,
      // and the `AgentErrorEvent` contract in `worker-protocol.ts`, use
      // `message`. The consequence was silent: `normalizeWorkerEvent` reads
      // `event.message || 'Unknown error'`, so a manifest refusal arrived at
      // the run layer as `code: 'internal', message: 'unknown error'` and the
      // verdict code this branch exists to report never left the worker.
      //
      // Found by plan 587 E4.1, which drives this file as a real process; no
      // seam test could see it, because every one of them constructed the
      // frame rather than receiving it.
      //
      // `code` is the PROTOCOL code from `ERROR_CODES`, not the verdict string.
      // The run layer classifies on this field (`classifyErrorCode`), and an
      // unrecognised string falls through to `internal` — which is how a named
      // refusal was still landing as an unnamed one. The verdict string stays
      // in the message, where a reader can act on it, and the mapping is a
      // total function over the five verdicts `verifyRunManifestBinding` can
      // return, so a sixth verdict cannot silently arrive uncoded.
      sendToMain({
        type: 'chat:error',
        sessionId: msg.sessionId,
        message: `run refused (${verdict.code}): ${verdict.detail}`,
        code: manifestRejectionProtocolCode(verdict.code),
      } as never);
      return;
    }
    if (verdict.unsatisfiedOptional.length > 0) {
      // Version skew: recorded, and NOT fatal. See the module header for why
      // this degrades where a required capability refuses.
      log(
        `[chat:start] catalog skew: ${verdict.unsatisfiedOptional.length} optional capabilit(ies) unavailable ` +
          `(${verdict.unsatisfiedOptional.join(', ')}); continuing against the frozen manifest`,
      );
    }
    // R2.2 item 4: the catalog revision this process is running is RECORDED for
    // every verified turn, not only when something is missing. A run frozen
    // against catalog X that executes on catalog Y is a fact someone will want
    // later, and it is only cheap to capture while the turn is in hand.
    // `adopted` is always false: the run keeps the snapshot it was frozen with,
    // and this line is the evidence that it did.
    log(
      `[chat:start] manifest verified (runId=${msg.manifest.runId}, hash=${msg.manifestHash.slice(0, 12)}…, ` +
        `catalog=${verdict.catalogRevision.worker}, adopted=${String(verdict.catalogRevision.adopted)})`,
    );
  }

  // Plan 600 S2, step 1: where this run's turns publish their tool pipeline.
  //
  // Declared OUTSIDE the try so the `finally` can close it, and PER RUN rather
  // than at module scope because the worker serves sessions concurrently — a
  // module-level "current pipeline" would let one session's engine dispatch into
  // another session's turn. The same instance is handed to `streamChat` (which
  // publishes each turn's freshly built pipeline) and to the engine's
  // `queueTool` (which dispatches through whatever turn is live), which is the
  // whole of the mechanism: a per-turn pipeline, reachable from outside the
  // generator, never hoisted.
  const turnPipelines = new TurnPipelinePublisher();

  try {
    startChatHeartbeat();
    // Plan 498: surface-aware permission handling. Bot/wake sessions pause
    // the turn on ask (durable approval card + continuation replay);
    // interactive sessions keep the in-worker wait, plus a persisted card
    // as a crash fallback. AskUserQuestion-style two-phase prompts never
    // pause — they are inherently interactive.
    const permissionSurface = msg.options?.permissionSurface === 'bot' ? 'bot' : 'default';
    const botAgentId = msg.options?.agentProfileId || null;
    // Plan 587 R2.4: `permission:resolve` needs to know which durable scope an
    // "always allow" belongs to, and this is the only place that knows. A
    // missing entry falls back to the session scope, which is the narrower of
    // the two: a wrongly-scoped bot grant would leak across conversations, a
    // wrongly-scoped session grant only asks again.
    const grantScope = {
      scopeType: (permissionSurface === 'bot' ? 'bot' : 'session') as 'bot' | 'session',
      scopeId: (permissionSurface === 'bot' ? botAgentId : msg.sessionId) || msg.sessionId,
    };
    permissionScopes.set(msg.sessionId, grantScope);
    const requestPermission = createSurfaceAwarePermissionHandler(
      createPermissionHandler(msg.sessionId),
      { sessionId: msg.sessionId, surface: permissionSurface, botAgentId },
    );
    // Plan 498: "Always allow this tool" grants from persisted approval
    // cards, scoped to this session's bot (bot surface) or the session itself.
    // Plan 587 R2.4: this durable read is now also the SOURCE of the in-process
    // approval cache, so the two cannot disagree. Previously the cache was
    // written only by this worker's own `allow_for_session` clicks, which made
    // it a process grant wearing a session label — and a recycled worker
    // started with an empty cache while the durable table still held the grant.
    let approvedAlwaysAllowTools: string[] = [];
    try {
      approvedAlwaysAllowTools = (await toolApprovalDb.listRules(grantScope)) as string[];
    } catch {
      // Best-effort: a failed rules read just skips the always-allow seeds.
    }
    if (approvedAlwaysAllowTools.length > 0) {
      try {
        const { rememberSessionApproval } = await import('../tool/AppConnectionTool/approvals.js');
        for (const tool of approvedAlwaysAllowTools) rememberSessionApproval(tool);
      } catch {
        // The durable set is still on `approvedAlwaysAllowTools`, which the
        // permission gate consults first. The cache is only a fast path.
      }
    }
    const consumeApprovedEffect = async (
      toolName: string,
      toolInput?: Record<string, unknown>,
    ): Promise<boolean> => {
      try {
        return Boolean(
          await toolApprovalDb.consumeApproved({
            sessionId: msg.sessionId,
            toolName,
            toolInput,
          }),
        );
      } catch {
        // Fail closed: a broken ledger read must never pre-approve a call.
        return false;
      }
    };
    const sendStatus = (message: string): void => {
      sendToMain({ type: 'chat:status', sessionId: msg.sessionId, message });
    };
    const sendI18nStatus = (key: string, params?: Record<string, string | number>): void => {
      const encodedParams = params
        ? Object.entries(params)
          .map(([k, v]) => `|${k}=${encodeURIComponent(String(v))}`)
          .join('')
        : '';
      sendStatus(`@i18n:${key}${encodedParams}`);
    };
    // Emit an immediate "preparing" status so the client shows activity right
    // away (before the MCP gate, image processing, capability probe, and first
    // LLM round-trip run). This is what makes the start feel responsive
    // instead of a silent blank wait after the user hits send.
    sendI18nStatus('streaming.preparing');
    // Use session system prompt if available, fallback to options.systemPrompt
    const effectiveSystemPrompt = sessionSystemPrompt || msg.options?.systemPrompt;
    // Rough token estimate of the system prompt alone (AGENTS.md, skills,
    // base instructions). Tool definitions are added by the agent once it
    // builds the request; before that, this is the only prefix we can price.
    // Used as a floor for the live ring's no-usage fallback.
    const systemPromptTokensEstimate = effectiveSystemPrompt
      ? estimateMessagesTokens([{ role: 'assistant', content: effectiveSystemPrompt }])
      : 0;
    // Resolve permission mode from session row, with explicit override allowed.
    // Plan 583 / ISS-09: the old `options.permissionMode` field is gone from
    // the wire protocol, so a stale sender that still includes it simply has
    // it dropped here — structurally impossible to honour, rather than read
    // and then deliberately ignored.
    let rowProfile: string | null = null;
    try {
      const sessionRow = sessionDb.get(msg.sessionId);
      rowProfile = (sessionRow as { permission_profile?: string | null } | null)?.permission_profile ?? null;
    } catch {
      // 静默降级, 走 default
    }
    const resolved = resolveChatStartAgentMode({
      rowProfile,
      optionOverride: msg.options?.permissionModeOverride,
    });
    log('[chat:start] agentMode:', resolved.agentMode, 'fromRow:', resolved.fromRow, 'override:', resolved.override);
    agent.setPermissionMode(resolved.agentMode);

    // Build document context from inline file attachments.
    // Document files (pdf, docx, etc.) carry their parsed text and imageChunks
    // directly on the FileAttachment objects (path, text, extractMethod, imageChunks).
    const files = msg.options?.files;

    const docFiles = (files || []).filter(f => f.path || f.text);
    const imageFiles = (files || []).filter(f => f.type.startsWith('image/') || f.type.startsWith('img/'));

    // Pre-analyze user-attached images with the configured vision model.
    // Mirrors hermes-agent design: a dedicated vision model analyzes images
    // and the text description is passed to the main LLM as context.
    //
    // Image content blocks are only included for natively multimodal-capable
    // models (e.g. Claude, GPT-4V). For text-only models, pre-analysis text
    // is the sole image context.
    // Model capability detection — checks regex heuristics, DB cache, then API probe
    const modelIsMultimodal = probeConfig
      ? await detectModelCapability(probeConfig)
      : isModelLikelyMultimodal(mainModelName);
    log(`[Image-Processing] Model multimodal detection: ${mainModelName} → ${modelIsMultimodal} (${probeConfig ? 'probed' : 'regex-only fallback'})`);

    // Phase 1: Read and compress all image files once.
    // Cache base64 data to avoid double-read (vision analysis + content block).
    const imageDataCache = await loadAttachmentImages(imageFiles);
    const readFailedFiles = new Set<string>();
    const cdnSkippedFiles = new Set<string>();
    const visionFailedFiles = new Set<string>();
    const markVisionFailed = (name: string) => { if (name) visionFailedFiles.add(name); };
    for (const file of imageFiles) {
      if (imageDataCache.has(file)) continue;
      if (isCDNImageUrl(file.url)) cdnSkippedFiles.add(file.name);
      else readFailedFiles.add(file.name);
    }

    // Phase 2: Vision pre-analysis using the configured vision model.
    // Only run this for text-only main models. When the main model can
    // consume image blocks natively, sending both the original image and a
    // synthetic vision summary duplicates context and adds avoidable latency.
    let preAnalysisText = '';
    let visionAnalysisFailed = false;
    let visionAnalysisError: string | null = null;
    // Names of images whose pre-analysis text was successfully appended to
    // preAnalysisText. Used by the fallback prompt so a partially-failed
    // vision pass doesn't double-count "analyzed" images as failures.
    const analyzedImageNames = new Set<string>();
    // Failed-vision tracking now lives in visionFailedFiles (Phase 1) so the
    // fallback prompt can attribute each skip reason precisely.
    const hasVisionAnalyzer = agent && typeof (agent as Record<string, unknown>).analyzeImage === 'function';
    const shouldUseVisionPreAnalysis = imageFiles.length > 0 && hasVisionAnalyzer && !modelIsMultimodal;
    if (imageFiles.length > 0 && hasVisionAnalyzer && modelIsMultimodal) {
      log('[Image-Processing] Skipping vision pre-analysis because main model accepts image input directly');
    }
    if (shouldUseVisionPreAnalysis) {
      sendI18nStatus('streaming.visionAnalyzingStart');
    }
    if (shouldUseVisionPreAnalysis) {
      let analyzedCount = 0;
      for (const file of imageFiles) {
        const cached = imageDataCache.get(file);
        if (!cached) continue;

        try {
          analyzedCount += 1;
          sendI18nStatus('streaming.visionAnalyzingProgress', {
            current: analyzedCount,
            total: imageFiles.length,
          });
          const quickVisionPrompt = msg.prompt?.trim()
            ? `Briefly analyze this image for the user's request: ${msg.prompt.trim()}. `
              + 'Return concise key points only, include critical text/OCR if relevant.'
            : 'Provide a concise image summary with key objects and critical text only.';
          const result = await (agent as unknown as { analyzeImage: (b64: string, mt: string, prompt?: string) => Promise<string> }).analyzeImage(
            cached.base64,
            cached.mediaType,
            quickVisionPrompt,
          );
          preAnalysisText += `\n\n[Image: "${file.name}"]\n${result}`;
          analyzedImageNames.add(file.name);
          log(`[Agent-Process] Vision analysis: "${file.name}" — ${result.length} chars`);
        } catch (err) {
          visionAnalysisFailed = true;
          visionAnalysisError = err instanceof Error ? err.message : String(err);
          markVisionFailed(file.name);
          logger.warn(
            'Vision pre-analysis failed',
            {
              phase: 'image-pre-analysis',
              fileName: file.name,
              reason: visionAnalysisError,
            },
            'ImageProcessing',
          );
          warn(`[Agent-Process] Vision analysis failed for "${file.name}": ${visionAnalysisError}`);
        }
      }
    }

    let effectivePrompt = msg.prompt;
    if (preAnalysisText) {
      effectivePrompt = msg.prompt
        ? `${msg.prompt}\n\n--- Image Analysis (auto-generated) ---${preAnalysisText}`
        : `The user sent an image. Here is a detailed description generated by an AI vision model:\n${preAnalysisText}\n\nPlease help the user based on the image description above.`;
    }

    // Fallback: if direct pre-analysis failed for non-multimodal models,
    // run a controlled vision_analyze tool pass and append its output.
    if (
      imageFiles.length > 0 &&
      !modelIsMultimodal &&
      (!preAnalysisText || visionAnalysisFailed)
    ) {
      sendI18nStatus('streaming.visionFallback');
      const toolPassResults: string[] = [];
      for (const file of imageFiles) {
        const cached = imageDataCache.get(file);
        const imagePath = (file.path || file.url || '').trim();

        // Skip CDN URLs (no local data available)
        if (isCDNImageUrl(imagePath)) {
          continue;
        }

        try {
          let toolResult: { error?: boolean; result?: unknown };

          if (cached) {
            // Skip immediate re-try if this file already failed in phase 2.
            if (visionFailedFiles.has(file.name)) {
              continue;
            }
            // For data: URLs and already-read files, use analyzeImage directly
            // with the cached base64 to avoid double-read
            const analyzeImage = (agent as unknown as { analyzeImage?: (b64: string, mt: string, prompt?: string) => Promise<string> })?.analyzeImage?.bind(agent);
            if (!analyzeImage) {
              continue;
            }
            const question = msg.prompt?.trim()
              ? `Analyze this image for the user's request: ${msg.prompt.trim()}`
              : 'Describe this image in detail.';
            const analysis = await analyzeImage(cached.base64, cached.mediaType, question);
            toolResult = { result: analysis };
          } else if (imagePath && !imagePath.startsWith('data:')) {
            visionTool ??= new (await import('../tool/VisionTool/VisionTool.js')).VisionTool();
            toolResult = await visionTool.execute(
              {
                image_path: imagePath,
                question: msg.prompt?.trim()
                  ? `Analyze this image for the user's request: ${msg.prompt.trim()}`
                  : 'Describe this image in detail.',
              },
              undefined,
              {
                options: {
                  analyzeImage: (agent as unknown as { analyzeImage?: (b64: string, mt: string, prompt?: string) => Promise<string> })?.analyzeImage?.bind(agent),
                },
              } as unknown as import('../types.js').ToolUseContext,
            );
          } else {
            continue;
          }

          if (!toolResult.error && typeof toolResult.result === 'string' && toolResult.result.trim()) {
            const normalized = toolResult.result.replace(/\r\n/g, '\n');
            const marker = '\n\n';
            const body = normalized.includes(marker)
              ? normalized.slice(normalized.indexOf(marker) + marker.length).trim()
              : normalized.trim();
            if (body) {
              toolPassResults.push(`[Image: "${file.name}"]\n${body}`);
              analyzedImageNames.add(file.name);
            }
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          markVisionFailed(file.name);
          visionAnalysisFailed = true;
          if (!visionAnalysisError) visionAnalysisError = errMsg;
          logger.warn(
            'Vision tool fallback failed',
            {
              phase: 'vision-tool-fallback',
              fileName: file.name,
              reason: errMsg,
            },
            'ImageProcessing',
          );
          warn(`[Agent-Process] vision_analyze fallback failed for "${file.name}":`, err);
        }
      }
      if (toolPassResults.length > 0) {
        const fallbackText = toolPassResults.join('\n\n');
        effectivePrompt = effectivePrompt
          ? `${effectivePrompt}\n\n--- Image Analysis (vision_analyze fallback) ---\n${fallbackText}`
          : `The user sent image(s). Here is a detailed analysis generated by vision_analyze:\n\n${fallbackText}`;
        preAnalysisText = fallbackText;
        visionAnalysisFailed = false;
      }
    }

    // Single source of truth for the [System: ...] block that explains to
    // the main model which images it received, which it could see, and why
    // any images are unavailable. Replaces three formerly-separate fallback
    // branches that conflated CDN-skip with read-failure and missed partial
    // vision success (see buildImageAttachmentContext for the buckets).
    if (imageFiles.length > 0) {
      const ctx = buildImageAttachmentContext({
        imageFiles,
        analyzedFileNames: analyzedImageNames,
        cdnSkipped: cdnSkippedFiles,
        readFailed: readFailedFiles,
        visionFailed: visionFailedFiles,
        modelIsMultimodal,
        hasVisionAnalyzer,
        visionAnalysisError,
      });
      if (ctx.appendText) {
        effectivePrompt = effectivePrompt
          ? `${effectivePrompt}${ctx.appendText}`
          : ctx.appendText.trimStart();
      }
    }

    // When files are attached but no text prompt, provide a default instruction
    // so the agent knows to analyze the attachments instead of guessing the user's intent.
    if (!effectivePrompt.trim() && files && files.length > 0) {
      effectivePrompt = 'The user has attached file(s). Please analyze the attached files and provide a helpful response based on their contents.';
    }

    if (shouldUseVisionPreAnalysis) {
      sendI18nStatus('streaming.visionPreprocessDone');
    }

    let messageContent: string | MessageContent[] = effectivePrompt;

    if (files && files.length > 0) {
      const contentBlocks: MessageContent[] = [];
      const imageBlocks: MessageContent[] = [];

      // First add text block if there's actual text
      if (effectivePrompt && effectivePrompt.trim()) {
        contentBlocks.push({ type: 'text', text: effectivePrompt });
      }

      // Phase 3: Build image content blocks using cached data.
      // Only send image blocks to multimodal-capable models.
      for (const file of files) {
        if (file.type.startsWith('image/') || file.type.startsWith('img/')) {
          const cached = imageDataCache.get(file);

          if (cached) {
            if (modelIsMultimodal) {
              imageBlocks.push({
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: cached.mediaType,
                  data: cached.base64,
                },
              });
              log(`[Agent-Process] Added image block: "${file.name}"`);
            } else {
              log(`[Agent-Process] Skipping image block, model not multimodal: "${file.name}"`);
            }
          } else if (isCDNImageUrl(file.url)) {
            warn('[Agent-Process] Skipping CDN image URL:', file.name);
          } else {
            warn('[Agent-Process] Image file has no cached base64 data:', file.name);
          }
        }
      }

      // Also add document-extracted images (e.g. scanned PDF with embedded images)
      // Only for multimodal-capable models
      if (modelIsMultimodal) {
        for (const doc of docFiles) {
          if (doc.imageChunks) {
            for (const img of doc.imageChunks) {
              imageBlocks.push({
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: img.mediaType,
                  data: img.base64,
                },
              });
            }
          }
        }
      }

      // Assemble: text first, then images
      messageContent = [...contentBlocks, ...imageBlocks];
    } else if (docFiles.some(d => d.imageChunks?.length)) {
      // No direct file attachments, but parsed documents contain extracted images
      const contentBlocks: MessageContent[] = [];
      const imageBlocks: MessageContent[] = [];

      // Text first (filter empty)
      if (effectivePrompt && effectivePrompt.trim()) {
        contentBlocks.push({ type: 'text', text: effectivePrompt });
      }

      for (const doc of docFiles) {
        if (doc.imageChunks && modelIsMultimodal) {
          for (const img of doc.imageChunks) {
            imageBlocks.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: img.mediaType,
                data: img.base64,
              },
            });
          }
        }
      }
      messageContent = [...contentBlocks, ...imageBlocks];
    }

    // Images that could not be auto-inlined (CDN URLs, local file read
    // failures, or missing base64 data) are silently skipped. The LLM won't
    // see these images as content blocks. The attachment text context is
    // separately injected as a durable runtime_context message by
    // DuyaAgent._injectRuntimeContext via adaptAttachmentContext, so the
    // user message content no longer embeds it (avoids duplicate injection).
    //
    // For non-multimodal models, image content blocks are intentionally
    // omitted — pre-analysis text from the vision model (if configured)
    // is the sole image context.
    // Pre-analysis text from the vision model (if configured) is still
    // prepended to the prompt so the LLM has a text description.
    //
    // vision_analyze tool remains registered so the LLM can request
    // re-analysis of previously analyzed or newly referenced images.

    // Defensive sync: ensure agent's in-memory messages match the DB state.
    // During long-running sessions, the agent accumulates messages in memory.
    // If an out-of-band modification occurs (e.g., concurrent process, crash
    // recovery with partial persist), the agent's view can become stale.
    // Reload from DB when the count diverges to guarantee consistency.
    const agentMsgCountBeforeSync = agent.getMessages().length;
    log(`[Agent-Process] Before sync: agent has ${agentMsgCountBeforeSync} messages, existingMessageCount=${existingMessageCount}`);
    
    if (existingMessageCount > 0) {
      try {
        const dbCount = await messageDb.getCount(msg.sessionId) as number;
        log(`[Agent-Process] DB message count: ${dbCount}`);
        if (dbCount > existingMessageCount) {
          log(`[Agent-Process] DB has ${dbCount} messages but agent has ${existingMessageCount}, syncing...`);
          const loaded = await messageDb.loadMessages(msg.sessionId) as { messages: MessageRow[] };
          const allRows = loaded.messages;
          if (allRows.length > existingMessageCount) {
            const attachmentMap = getAttachmentsForSession(msg.sessionId);
            const allMsgs = allRows.map(row => messageRowToMessage(row, attachmentMap));
            const validated = validateMessageHistory(allMsgs);
            agent.setMessages(validated);
            existingMessageCount = validated.length;
            log(`[Agent-Process] Synced ${validated.length} messages from DB`);
          }
        }
      } catch (syncErr) {
        log('[Agent-Process] Message resync failed (non-critical):', syncErr);
      }
    } else if (agentMsgCountBeforeSync === 0) {
      // If existingMessageCount is 0 but agent also has no messages, try loading from DB
      try {
        const dbCount = await messageDb.getCount(msg.sessionId) as number;
        if (dbCount > 0) {
          log(`[Agent-Process] Agent has no messages but DB has ${dbCount}, loading...`);
          const loaded = await messageDb.loadMessages(msg.sessionId) as { messages: MessageRow[] };
          const allRows = loaded.messages;
          const attachmentMap = getAttachmentsForSession(msg.sessionId);
          const allMsgs = allRows.map(row => messageRowToMessage(row, attachmentMap));
          const validated = validateMessageHistory(allMsgs);
          agent.setMessages(validated);
          existingMessageCount = validated.length;
          log(`[Agent-Process] Loaded ${validated.length} messages from DB`);
        }
      } catch (loadErr) {
        log('[Agent-Process] Message load failed (non-critical):', loadErr);
      }
    }

    // Seed the session-cumulative live totals (and the authoritative context
    // base) from the history the agent now holds. The router sends `init` on
    // EVERY turn, which zeroes the live counters — without re-seeding, the
    // ring's ↑/↓/R/$ would reset to 0 at the start of each new turn instead
    // of continuing from the real cumulative numbers. Re-seeding from
    // messages also survives a full worker restart (messages are reloaded
    // from the DB above), so the stats stay correct regardless of process
    // lifetime. `result` events during this turn then accumulate on top.
    {
      // Plan 546: walk PER-CALL fields (plan 445 calls[] ledger, then
      // last_call, then legacy single-call block) instead of summing
      // top-level input_tokens / cache_hit_tokens directly. The top-
      // level fields are now turn-cumulative (sum of every LLM call in
      // the turn), and the `result` handler ALSO accumulates per-call
      // rawInput on top — so the old seed summed each turn twice, and
      // over N turns the gap grew ~N× (1720M / 1.0M screenshots).
      // See packages/agent/src/process/seed-token-usage.ts.
      const seeded = seedTokenUsageFromHistory(agent.getMessages());
      liveTotalInput = seeded.totalInput;
      liveTotalInputRaw = seeded.totalInputRaw;
      liveTotalOutput = seeded.totalOutput;
      liveTotalCacheHit = seeded.totalCacheHit;
      liveTotalCacheCreation = seeded.totalCacheCreation;
      // Plan 577 §3: the Observation layer is ledger-owned — no module-level
      // reset needed here (a fresh agent starts at epoch 0 with no
      // observation by construction).
      // Plan 445 Bug #7: dedupe cache must reset on init so the first
      // frame of the session always emits even if the numbers happen
      // to match a previous session.
      lastEmittedUsageKey = null;
      // Plan 443: no context-base restore here. The pure estimator anchors on
      // the persisted usage blocks directly (preferring `last_call`) — same
      // numbers, zero bookkeeping. Post-compaction staleness is handled by
      // `compactedPending` + boundary markers instead of skipping the seed.
    }

    // Plan 426 Phase 4: steering config from [steering] in ~/.duya/config.toml.
    // Fresh read per streamChat — hot reload semantics (hooks/config.ts).
    const steering = getSteeringConfig();

    // Plan 450 Phase G: descriptor-cache freshness for @-mention turns.
    // The cache is a boot/reload-time snapshot; a mentioned provider with
    // zero cached descriptors used to make the activation reminder claim the
    // app was "not connected" even though the UI showed it as connected.
    // Before the run starts, refetch once when any mentioned provider is
    // missing from the cache. Best-effort: a failed refetch keeps the stale
    // cache and the agent's reminder wording stays neutral about it.
    const mentionedProviders = msg.options?.mentionedProviders?.filter(
      (p: unknown): p is string => typeof p === 'string' && p.length > 0,
    );
    if (mentionedProviders && mentionedProviders.length > 0) {
      const cachedProviders = new Set(
        (await import('../tool/AppConnectionTool/index.js')).getCachedAppConnectionDescriptors().map((d) => d.provider),
      );
      if (mentionedProviders.some((p: string) => !cachedProviders.has(p))) {
        log('[Agent-Process] App Connection: mentioned provider missing from descriptor cache — refetching');
        await reloadAppConnectionTools();
      }
    }

    // Plan 445: turn-cumulative tokenUsage lives in agent-process-entry's
    // scope (this is where every `result` event lands). The agent loop's
    // done handler READS it through `cumulativeTokenUsageRef` BEFORE
    // journal.assistantMsgFinalized fires, so the persisted DB row gets
    // the cumulative sum + `last_call` sub-block instead of the single-
    // call usageBlock.
    let tokenUsage: TokenUsage | null = null;
    let lastCallUsage: LastCallUsageBlock & { output_tokens: number } | null = null;
    let lastCallModel = '';
    let lastCallProviderId = '';
    // Mutable reference passed to streamChat options. Agent loop reads
    // `.current` synchronously when building the final assistant message;
    // the result handler below mutates it as each `result` event lands.
    const cumulativeTokenUsageRef: { current: TokenUsage | null } = {
      current: null,
    };

    // ── Plan 600 S2: where the turn is driven, and why it is still HERE ─────
    //
    // This used to construct and run a `RunEngineImpl` on every `chat:start`,
    // with `openModelStream: () => emptyModelStream()`. That was a PHANTOM run,
    // and it is gone as of this commit. It was removed rather than completed,
    // because a run the engine cannot serve is not a neutral placeholder.
    //
    // MEASURED consequences of that phantom run, observed rather than reasoned
    // (see `__tests__/live-turn-single-driver.test.ts`):
    //
    //  - It asked the provider ZERO times and dispatched ZERO tools, then ended
    //    `failed` on `sawFrame === false` (`run-engine.ts:584`) and proposed that
    //    failure as the run's terminal. `RunSession.settle` is the single writer
    //    of a real terminal, so the proposal was logged and discarded: a second
    //    account of a run that had not happened, minted once per `chat:start`.
    //  - NONE of the decisions the removed comment claimed for it were reachable.
    //    `buildEnginePorts` attaches no `budget`, no `attempt` and no `subtasks`
    //    (`run-engine-ports.ts:280`), so `#budgetExhausted` was constantly false,
    //    the fence was always null, and `#reclaimSubtasks` always returned 0. The
    //    old claim that "the stop decision, the turn ceiling, the budget verdict
    //    and the subtask sweep are therefore the engine's" was false in all four
    //    parts, and is not restated here as if it were true.
    //
    // The turn is driven HERE, by `DuyaAgent.streamChat`, and by nothing else.
    //
    // Why a PUBLISHED LEG cannot be what the engine's model port reads --
    // measured before it was made unconstructible, and the reason the port was
    // deleted rather than kept. The port that pulled one,
    // `createTurnLegModelPort`, ignored the `ModelRequest` the engine assembles
    // and streamed the leg instead -- and the leg's `open()` IS
    // `runTurnStream(params.deps)` (`model-leg.ts:258`), the same call this
    // generator makes at its own `:2461`. Binding it therefore did not lend the
    // engine one turn of the running loop; it handed it the WHOLE cycle
    // (`run-engine.ts:354` is a self-contained `for`: assemble, `#streamModel`
    // at `:439`, drain at `:449`, decide, repeat) while this generator kept
    // running that same cycle. Two callers, two provider requests, one set of
    // per-attempt accumulators -- a transport death under either attempt called
    // `onRetryReset` -> `executor.discard()` underneath the other. Measured as
    // `entered === 2`; `__tests__/engine-model-port.test.ts` now measures the
    // engine's own share as 1 and re-points the two-driver case at the
    // request-owned port.
    //
    // The engine's model port is `createClientModelPort`: it opens the request
    // the engine assembled and threads the engine's own scoped signal into the
    // provider call, so cancellation no longer has to be AIMED at a controller
    // this generator owns. The leg itself is now a publication with no reader --
    // `DuyaAgent.streamChat` still publishes per turn (`DuyaAgent.ts:2453`) and
    // nothing consumes it, because no live caller passes `modelLegs`. The
    // publish site stays only because it sits inside the turn body this comment
    // says must become port calls; removing it belongs to that rewrite.
    //
    // So the model port, the tool drain, `TurnOutputPort` and the `chat:*`
    // projection all become correct in the SAME change that stops this generator
    // from driving the turn -- and this generator is what owns the durable
    // transcript write, the tool-result frames and the `PostToolUseFailure` hook
    // (the eleven rows `__tests__/engine-drain-carryover.test.ts` enumerates).
    // They land together or the turn loses them. That change is a REFACTOR of
    // `DuyaAgent.streamChat` -- its body has to become port calls, because
    // `packages/agent-runtime` may not import `packages/agent` -- and it is the
    // whole of the remaining cutover.
    const eventGen = agent.streamChat(messageContent, {
      systemPrompt: effectiveSystemPrompt,
      requestPermission,
      // Plan 498: one-shot approval ledger + persisted always-allow grants.
      consumeApprovedEffect,
      approvedAlwaysAllowTools,
      agentProfileId: msg.options?.agentProfileId,
      outputStyleConfig: msg.options?.outputStyleConfig,
      mode: msg.options?.mode,
      // Plan 450: @-mentioned providers for this run (exposure promotion +
      // connector-activation reminder). See mentions/index.ts.
      mentionedProviders: msg.options?.mentionedProviders,
      // Plan 450 Phase H: /skill-name mentioned this run (skill fragment
      // injection). See mentions/index.ts collectSkillInjection.
      mentionedSkills: msg.options?.mentionedSkills,
      // Plugins @-mentioned this run (the @ popover lists installed plugins).
      // Structured capability summaries; agent injects <plugin-activation>.
      mentionedPlugins: msg.options?.mentionedPlugins,
      attachments: files,
      imageInputSupported: modelIsMultimodal,
      displayContent: msg.options?.displayContent,
      // Plan 441: thread the chat:start message id through as the turn id
      // so every journal emit and rebase event for this turn carries the
      // same id. The renderer uses it for turn-scoped queries via the
      // `message_index.turn_id` column.
      turnId: msg.id,
      // Plan 587 R2.1: the Control Plane's run id, when it sent one. Passed
      // through UNCHANGED — the point is that the value the mailbox attributes
      // a claim to is the value the Control Plane recorded a terminal under, not
      // a second id minted here. See `run-identity.ts` for the fallback used by
      // producers that have not migrated.
      runId: msg.runId,
      effort: msg.options?.effort,
      maxTurns: msg.options?.maxTurns,
      allowedTools: msg.options?.allowedTools,
      conductorMode: msg.options?.conductorMode ? true : undefined,
      conductorCanvasId: msg.options?.conductorCanvasId,
      // Plan 312: always inject ipcRequest so App Connection tools work
      // without conductor mode. The unified dispatcher routes by channel.
      conductorIpc: { sendToMain, ipcRequest: toolIpcRequest },
      backgroundTaskResume: msg.options?.backgroundTaskResume,
      llmRequestTimeoutMs: msg.options?.llmRequestTimeoutMs,
      // Plan 497: wake runs (cron/background notification/agent DM) persist
      // their prompt user row source 'system' — model context, not chat.
      wakeRun: msg.options?.wakeRun === true,
      clientMsgId: msg.options?.clientMsgId,
      todoGate: { enabled: steering.todoGateEnabled },
      antiDeadLoop: { ...steering.antiDeadLoop },
      disabledLoopHooks: steering.disabledLoopHooks,
      // Plan 445: agent loop reads this mutable reference at the `done`
      // boundary to know the turn-cumulative tokenUsage (with `last_call`
      // sub-block) it should attach to the final assistant message before
      // journal.assistantMsgFinalized fires. Without this, journal would
      // persist only the single-call usageBlock (roundResultUsage),
      // losing the per-turn sum and last_call forever.
      cumulativeTokenUsageRef,
      // Plan 600 S2, step 1: each turn publishes its freshly built pipeline here,
      // which is what gives the engine's `queueTool` above a handle that is
      // correct for the live turn and correct again on the next one.
      turnPipelines,
    });

    log('[Agent-Process] streamChat started, agentProfileId:', msg.options?.agentProfileId || '(none)', 'iterating events...');
    // Terminal `done` reason from the agent loop (completed / max_turns /
    // repeated_tool_calls / aborted). Captured from the deferred chat:done
    // and attached to the final chat:done so the renderer can surface why
    // the run stopped.
    let turnEndReason: string | undefined;
    /** True once the agent loop yielded `done` and we held it back for the
     *  post-flush persistence barrier below. */
    let deferredDone = false;
    let eventCount = 0;
    // Stable-boundary persistence baseline: capture the message count at turn
    // start so the single end-of-turn append can persist exactly the messages
    // this turn produced (user/assistant/tool_use/tool_result), in order,
    // without an incremental counter.
    const turnStartMessageCount = agent.getMessages().length;

    // Live context-usage emission — stateless pure function at module scope
    // (computeContextEstimate / emitLiveUsage, plan 443). Local wrapper binds
    // the session id and this turn's system-prompt fallback estimate.
    const emitTokenUsage = (): void =>
      emitLiveUsage(msg.sessionId, systemPromptTokensEstimate);

    // Kick off the ring before the first LLM `result` lands.
    emitTokenUsage();

    for await (const event of eventGen) {
      eventCount++;
      if (eventCount <= 5) {
        log(`[Agent-Process] Event ${eventCount}:`, event.type, event.data ? String((event as {data?: unknown}).data).substring(0, 100) : '');
      }
        if (DEBUG_IPC && (
        event.type === 'tool_use'
        || event.type === 'tool_result'
        || event.type === 'agent_progress'
        || event.type === 'error'
        || event.type === 'done'
      )) {
        debugLog('stream event', {
          sessionId: msg.sessionId,
          eventCount,
          type: event.type,
          hasData: event.data !== undefined,
        });
      }

      // Heartbeat: send pong periodically during long streaming to prevent being killed
      if (eventCount % 10 === 0 && Date.now() - lastPongTime > HEARTBEAT_INTERVAL) {
        lastPongTime = Date.now();
        sendToMain({ type: 'pong', timestamp: lastPongTime });
        debugLog('Sent heartbeat pong during streaming');
      }

      if (event.type === 'result' && event.data) {
        // Parse the single LLM API call's usage. One `result` fires per API
        // call, so a tool-heavy turn emits many — each becomes one UsageCall
        // in the turn ledger (token-accounting), keeping per-model attribution
        // exact when the model hot-swaps mid-turn.
        const call = parseUsageCall(event.data as Record<string, unknown>);
        if (call) {
          // Snapshot the exact model/provider that produced THIS call.
          // `agent.model` is the hot-swap surface (ModelRuntime), so reading
          // it here attributes each call to the model actually in use.
          call.model = agent?.model ?? mainModelName;
          call.provider_id = currentProviderId;
          const rawInput = call.input_tokens;
          const outputTokens = call.output_tokens;
          const cacheHitTokens = call.cache_hit_tokens ?? 0;
          const cacheCreationTokens = call.cache_creation_tokens ?? 0;
          // Cache-convention guard: Anthropic's input_tokens already includes
          // cached tokens, but some OpenAI-compatible gateways report
          // prompt_tokens EXCLUDING cache. When cache hits exceed the reported
          // input, the input clearly omits cache — add the hits back (pi does
          // the same: input + cacheRead + cacheWrite). The cacheWrite clause
          // covers the first request of a session where cacheRead is still 0
          // but the full prefix (system + tools) is written to cache.
          const normalizedInput =
            cacheHitTokens > rawInput || cacheCreationTokens > rawInput
              ? rawInput + cacheHitTokens + cacheCreationTokens
              : rawInput;
          // ONLY-NEW session-total volume: the uncached delta + newly-written
          // cache. cache_hit is a RE-READ of an already-counted prefix and
          // must NOT accumulate into the session "t" total (MiniMax re-reports
          // the whole cached prefix every call → N×/quadratic inflation). The
          // RESIDENT volume (normalizedInput above) still drives the RING via
          // liveLatestObserved so the anchor shows real resident context.
          const onlyNewInput =
            cacheHitTokens > rawInput || cacheCreationTokens > rawInput
              ? rawInput + cacheCreationTokens
              : rawInput;
          // Accumulate across ALL result events in this turn — one fires per
          // LLM API call, so a tool-heavy turn emits many. Keeping only the
          // last event (the old behavior) lost every earlier round's tokens,
          // and input grows each round, so the loss was large. Raw fields are
          // summed; per-provider conventions (input includes cache,
          // total_tokens = input + output) survive summation.
          const callTotal = call.total_tokens ?? rawInput + outputTokens;
          if (!tokenUsage) {
            tokenUsage = {
              input_tokens: rawInput,
              output_tokens: outputTokens,
              total_tokens: callTotal,
              cache_hit_tokens: cacheHitTokens,
              cache_creation_tokens: cacheCreationTokens,
              calls: [],
            };
          } else {
            tokenUsage.input_tokens += rawInput;
            tokenUsage.output_tokens += outputTokens;
            tokenUsage.total_tokens = (tokenUsage.total_tokens ?? 0) + callTotal;
            tokenUsage.cache_hit_tokens = (tokenUsage.cache_hit_tokens ?? 0) + cacheHitTokens;
            tokenUsage.cache_creation_tokens = (tokenUsage.cache_creation_tokens ?? 0) + cacheCreationTokens;
          }
          // Push the per-call ledger entry (carries model/provider snapshot).
          if (!tokenUsage.calls) tokenUsage.calls = [];
          tokenUsage.calls.push(call);
          // Plan 445: keep the agent loop's done handler in sync with
          // the cumulative block we're building here. Include
          // `last_call` so the persisted anchor (normalizePromptTokens
          // prefers it on reload) reflects the largest-prompt call of
          // the turn instead of the cumulative N-call sum. We update
          // the ref AFTER every result, so by the time the agent loop
          // yields `done` and reads `.current`, it sees the final turn
          // state.
          cumulativeTokenUsageRef.current = lastCallUsage
            ? { ...tokenUsage, last_call: lastCallUsage }
            : { ...tokenUsage };
          // last_call feeds the persisted anchor (normalizePromptTokens
          // prefers it on reload) and the footer's per-request line. Keep the
          // LARGEST-prompt call of the turn, not the latest: GLM-style
          // gateways report a near-fresh prefix (input=0, tiny hit) on some
          // rounds, and a collapsed last_call would permanently shrink the
          // ring after an app restart. Context only grows within a turn.
          const anchorVolume = (
            u: { input_tokens?: number; output_tokens?: number; cache_hit_tokens?: number; cache_creation_tokens?: number },
          ): number => {
            const input = u.input_tokens ?? 0;
            const hit = u.cache_hit_tokens ?? 0;
            const write = u.cache_creation_tokens ?? 0;
            return (hit > input || write > input ? input + hit + write : input) + (u.output_tokens ?? 0);
          };
          // Recompute last_call from the calls ledger each time, so the
          // anchor block can never diverge from the per-call records.
          let maxCall: UsageCall | null = null;
          for (const c of tokenUsage.calls) {
            if (!maxCall || anchorVolume(c) >= anchorVolume(maxCall)) maxCall = c;
          }
          lastCallUsage = maxCall
            ? {
                input_tokens: maxCall.input_tokens,
                output_tokens: maxCall.output_tokens,
                cache_hit_tokens: maxCall.cache_hit_tokens,
                cache_creation_tokens: maxCall.cache_creation_tokens,
              }
            : null;
          // Track the LAST call's model/provider for the assistant-message
          // attribution at stream end (the final answer is produced by the
          // turn's last LLM call).
          lastCallModel = call.model ?? '';
          lastCallProviderId = call.provider_id ?? '';
          ringTrace(`[${(msg.sessionId ?? sessionId ?? '?').slice(0, 8)}] result call: input=${rawInput}, output=${outputTokens}, cacheHit=${cacheHitTokens}, cacheWrite=${cacheCreationTokens}, normalizedInput=${normalizedInput}, model=${call.model ?? '?'}`);
          // A real request just landed — its usage rides on the assistant
          // message DuyaAgent pushes right after `done` (plan 443), so the
          // pure estimator anchors on it directly. Clear the post-compaction
          // pending flag here too.
          compactedPending = false;
          // Plan 577 §3: the Observation layer is seeded by DuyaAgent itself
          // (setObservedUsage on its `result` handler, BEFORE this event is
          // yielded) into the ContextLedger — the single entry point. The
          // ledger holds latest input, the output bridge and the peak
          // high-water mark; emitLiveUsage reads them from the snapshot and
          // merges into the timeline scan via applyLiveAnchorCorrection.
          // Accumulate session-cumulative totals for the ring's stats line.
          liveTotalInput += onlyNewInput;
          liveTotalInputRaw += rawInput;
          liveTotalOutput += outputTokens;
          liveTotalCacheHit += cacheHitTokens;
          liveTotalCacheCreation += cacheCreationTokens;
          emitTokenUsage();
        } else {
          warn('[Agent-Process] Received all-zero usage, ignoring to avoid empty context ring');
        }
      } else if (event.type === 'tool_result' && event.data) {
        // Tool results are appended to the in-memory history and will be sent
        // to the model on the next request. Recompute statelessly from the
        // full timeline so trailing tool-result volume is included.
        emitTokenUsage();
      } else if (event.type === 'done') {
        // The assistant message carrying this round's usage is pushed BEFORE
        // `done` yields downstream, so emitting here re-anchors the frame on
        // the fresh per-call usage immediately. Without this, a thinking /
        // text-only round emits nothing after its `result` (which fires pre-
        // push) and the ring freezes until the next tool_result or turn end.
        emitTokenUsage();
      }

      const agentMsg = convertSSEToAgentMessage(event);
      if (agentMsg) {
        // Plan 441 follow-up: hold `chat:done` instead of forwarding it
        // inline. The renderer's terminal handoff (App.tsx) only swaps the
        // live stream view for durable rows when a SUCCESSFUL `db_persisted`
        // ack precedes `done`; forwarding done here raced ahead of the
        // journal flush, the ack could never precede it, and the message
        // list went blank at turn end. The held event is re-emitted after
        // the flush + bookkeeping block below.
        if (agentMsg.type === 'chat:done') {
          turnEndReason = (agentMsg as { reason?: string }).reason;
          deferredDone = true;
          continue;
        }
        if (DEBUG_IPC && (
          agentMsg.type === 'chat:tool_use'
          || agentMsg.type === 'chat:tool_result'
          || agentMsg.type === 'chat:agent_progress'
          || agentMsg.type === 'chat:error'
          || agentMsg.type === 'chat:done'
        )) {
          debugLog('forward event->main', {
            sessionId: msg.sessionId,
            from: event.type,
            to: agentMsg.type,
          });
        }
        sendToMain({ ...agentMsg, sessionId: msg.sessionId });
      } else if (DEBUG_IPC) {
        debugLog('event dropped by converter', {
          sessionId: msg.sessionId,
          type: event.type,
        });
      }
    }

    let agentMessages = agent.getMessages();

    // Plan 437: persist hook invocation rows. The ConfigHooksRunner buffers
    // one `msg_type: 'hook_invocation'` Message per dispatch in
    // agent.pendingHookMessages; without this drain the rows never reach
    // the DB and hook cards vanish after reload. Best-effort: a failed
    // append must not break the turn (rows are lost, chat:done still flows).
    try {
      const hookMessages = agent.drainPendingHookMessages();
      if (hookMessages.length > 0) {
        const hookRes = await appendMessages(msg.sessionId, hookMessages);
        existingMessageCount += hookRes.count;
        log(`[Agent-Process] Persisted ${hookRes.count}/${hookMessages.length} hook invocation message(s)`);
      }
    } catch (hookErr) {
      warn('[Agent-Process] Failed to persist hook messages:', hookErr instanceof Error ? hookErr : new Error(String(hookErr)));
    }

    // The turn's authoritative assistant message, captured here at the one
    // point this function already looks for it. Held (not scoped to the
    // `tokenUsage` branch below) because the done boundary further down reads
    // it again to build `chat:message_finalized` — a second lookup would be
    // the same query written twice, and the two could disagree if the message
    // list grew between them.
    let lastAssistant: (typeof agentMessages)[number] | undefined;

    log(`[Agent-Process] Stream ended, tokenUsage present=${!!tokenUsage}, agentMessages=${agentMessages.length}, existingMessageCount=${existingMessageCount}`);
    if (agentMessages.length > 0) {
      if (tokenUsage) {
        lastAssistant = [...agentMessages].reverse().find(m => m.role === 'assistant');
        if (lastAssistant) {
          // Plan 445: the cumulative tokenUsage + last_call are already
          // attached to `pushed.tokenUsage` BEFORE _pushDurable runs
          // (see cumulativeTokenUsageRef in streamChat options), so
          // journal persists the correct shape. The legacy write here
          // only mutated the in-memory message after journal had
          // already fired — INSERT OR IGNORE dropped the re-emit on the
          // next replay. Removing it eliminates the dead assignment.
          //
          // Attribute the final assistant message to the model/provider
          // that produced the turn's last LLM call (per-message model
          // accounting). The journal already has `pushed.providerId` /
          // `pushed.model` from when DuyaAgent built it, but the agent
          // loop's roundResultUsage is updated on EVERY result while
          // lastCallModel / lastCallProviderId reflect the FINAL call.
          // Overwrite here so the persisted row carries the final
          // call's attribution rather than whichever call happened to
          // produce the largest prompt.
          if (lastCallModel) {
            (lastAssistant as Record<string, unknown>).model = lastCallModel;
          }
          if (lastCallProviderId) {
            (lastAssistant as Record<string, unknown>).providerId = lastCallProviderId;
          }
          log(`[Agent-Process] Attached token_usage to last assistant message: id=${lastAssistant.id}, lastCallInput=${lastCallUsage?.input_tokens ?? 'n/a'}, model=${lastCallModel || 'n/a'}`);
        } else {
          warn('[Agent-Process] No assistant message found to attach token_usage');
        }
      } else {
        warn('[Agent-Process] No tokenUsage received during stream');
      }

      // Plan 441: post-stream bookkeeping that is NOT message persistence:
      //   - token-budget delta (goal mirror)
      //   - parsed document attachments (per-message)
      //   - turn-review baseline flush
      //   - update existingMessageCount for the next turn's defensive resync
      //
      // These used to be wrapped inside the same try/catch as the turn-end
      // `appendMessages` call. Now that the journal handles persistence
      // synchronously per boundary, only the bookkeeping remains — and it
      // is best-effort (errors are logged, not propagated to chat:done).

      // Plan 331 Phase 2.3: persist token-budget delta after each turn.
      try {
        if (tokenUsage) {
          const turnTokens = tokenUsage.total_tokens ?? (tokenUsage.input_tokens + tokenUsage.output_tokens);
          if (turnTokens > 0) {
            await goalDb.updateBudget(msg.sessionId, { tokensUsedDelta: turnTokens });
            log(`[Agent-Process] Persisted token budget delta: +${turnTokens} for session ${msg.sessionId}`);
          }
        }
        const stats = agent.getContextStats();
        if (stats.totalTokens >= stats.maxTokens) {
          await goalDb.setStatus(msg.sessionId, 'usage_limited');
          log(`[Agent-Process] Session ${msg.sessionId} marked usage_limited (context exhausted: ${stats.totalTokens}/${stats.maxTokens})`);
        } else {
          await goalDb.setStatus(msg.sessionId, 'active');
        }
      } catch (err) {
        warn('[Agent-Process] Failed to persist token budget delta:', err);
      }

      // Store parsed document content to DB for rehydration on restart.
      // The journal already persisted the user message itself; this side
      // channel stores the attachment text separately so the user-message
      // payload stays small.
      for (const msgItem of agentMessages) {
        if (msgItem.role === 'user' && msgItem.attachments && msgItem.attachments.length > 0) {
          if (!msgItem.id) {
            warn('[Agent-Process] storeParsedDocumentAttachment: user message has no id, skipping');
            continue;
          }
          const userMsgId = msgItem.id;
          for (const att of msgItem.attachments as FileAttachment[]) {
            if (att.text && (att.path || att.url)) {
              try {
                storeParsedDocumentAttachment(userMsgId, msg.sessionId, {
                  filename: att.name,
                  filePath: att.path || att.url || '',
                  charCount: att.text.length,
                  text: att.text,
                  extractMethod: att.extractMethod,
                  imageChunks: att.imageChunks,
                });
              } catch (storeErr) {
                warn('[Agent-Process] Failed to store parsed document:', storeErr);
              }
            }
          }
        }
      }

      await persistTurnReview(msg.sessionId, msg.id, turnReviewBaseline);

      // Update existingMessageCount baseline for the next turn's defensive
      // resync. The journal already wrote each message; this is just our
      // local view of "where we left off".
      existingMessageCount = agentMessages.length;
      log(`[Agent-Process] Updated existingMessageCount to ${existingMessageCount}`);
    } else {
      warn(`[Agent-Process] No messages to save for session ${msg.sessionId}`);
      await persistTurnReview(msg.sessionId, msg.id, turnReviewBaseline);
    }

    // Turn-end persistence barrier: wait for every fire-and-forget journal
    // emit to settle, acknowledge durability to the renderer, then release
    // the deferred chat:done. Order matters — App.tsx's terminal handoff only
    // swaps the live stream view for durable rows when dbPersisted.success
    // arrives before done; without this ack the message list went blank at
    // turn end until the user re-entered the session.
    await agent.journal?.flush();
    sendToMain({
      type: 'chat:db_persisted',
      sessionId: msg.sessionId,
      success: true,
      messageCount: agentMessages.length,
    });
    if (deferredDone) {
      // AHEAD of `chat:done`, deliberately. `assistant.message_finalized` is the
      // point where the message stopped changing, and the run terminal is a
      // later fact; the ledger has to record them in that order for a consumer
      // rebuilding a transcript to read the message before the run ends. The
      // frame is emitted only when there IS an assistant message — a turn that
      // produced none is a real state, and its honest wire is the absence of
      // this frame rather than one with an empty `content`.
      const finalized = buildMessageFinalizedEvent(msg.sessionId, lastAssistant, turnEndReason);
      if (finalized !== null) {
        sendToMain(finalized as unknown as Record<string, unknown>);
      }
      sendToMain({
        type: 'chat:done',
        sessionId: msg.sessionId,
        reason: turnEndReason,
      });
    }

    // Background title generation: only in first 3 rounds, never regenerate after
    const hasGeneratedTitle = titleGeneratedBySession.has(msg.sessionId);
    // Count user messages to determine conversation rounds (not total messages)
    const userMessageCount = agentMessages.filter((m: Message) => m.role === 'user').length;
    const assistantMessageCount = agentMessages.filter((m: Message) => m.role === 'assistant').length;
    // Only generate if: (1) never generated before, AND (2) in first 3 rounds, AND (3) at least 1 complete round
    // After round 3, title is locked and never updated
    // Bot-pipeline agents never surface a session title in the UI (bot
    // persistent sessions are `bot:<agentId>`, gateway channels reply inline),
    // so the LLM title call would be pure token burn. Skip entirely.
    const isBotPipeline = msg.sessionId.startsWith('bot:')
      || isBotAgentProfile(agent.getLastAppliedAgentProfile());
    const shouldGenerate = !isBotPipeline
      && !hasGeneratedTitle
      && userMessageCount >= 1
      && userMessageCount <= 3
      && assistantMessageCount >= 1;

    log(`[Agent-Process] Title generation check: hasGenerated=${hasGeneratedTitle}, userMsg=${userMessageCount}, assistantMsg=${assistantMessageCount}, shouldGenerate=${shouldGenerate}`);
    log(`[Agent-Process] Title generation config: ${titleGenerationModelConfig ? JSON.stringify({provider: titleGenerationModelConfig.provider, model: titleGenerationModelConfig.model}) : 'null'}`);
    log(`[Agent-Process] Agent LLM client available: ${!!agent.llmClient}`);
    if (agent.llmClient) {
      log(`[Agent-Process] Agent LLM config: provider=${agent.provider}, model=${agent.model}, baseURL=${agent.baseURL}`);
    }

    log(`[Agent-Process] Title generation model config: ${
      titleGenerationModelConfig
        ? JSON.stringify({
            provider: titleGenerationModelConfig.provider,
            baseURL: titleGenerationModelConfig.baseURL,
            model: titleGenerationModelConfig.model,
            hasApiKey: Boolean(titleGenerationModelConfig.apiKey),
          })
        : 'null'
    }`);

    if (shouldGenerate) {
      void (async () => {
        try {
          // For MiniMax endpoints, always use agent's own LLM client
          // because MiniMax requires X-Api-Key header which agent already has configured correctly
          let titleLLMClient = agent.llmClient;
          if (titleGenerationModelConfig) {
            // Check if baseURL is a MiniMax endpoint (includes minimax in domain)
            const isMiniMaxEndpoint = titleGenerationModelConfig.baseURL?.includes('minimax');
            if (isMiniMaxEndpoint) {
              // MiniMax requires X-Api-Key auth - agent LLM client is already configured correctly
              log(`[Agent-Process] Title model is MiniMax endpoint, using agent LLM client (has correct X-Api-Key auth)`);
              titleLLMClient = agent.llmClient;
            } else {
              try {
                const { createAIClient } = await import('@duya/ai');
                const { findModelCompat } = await import('@duya/ai');

                // Resolve apiFormat: use provided value, or infer from the
                // legacy provider discriminator. This matches the inference
                // already done inside createLLMClient, but we materialize it
                // here so findModelCompat can be called with a concrete value.
                const titleApiFormat = (titleGenerationModelConfig.apiFormat
                  ?? (titleGenerationModelConfig.provider === 'anthropic' ? 'anthropic' : 'openai-chat')) as
                  ApiFormat;

                // Resolve modelCompat: use provided value, or look up from
                // @duya/ai presets so reasoning models (DeepSeek, Qwen, GLM,
                // Kimi, etc.) parse reasoning content correctly.
                const titleModelCompat = titleGenerationModelConfig.modelCompat
                  ?? findModelCompat(titleApiFormat, titleGenerationModelConfig.model);

                titleLLMClient = createAIClient({
                    apiKey: titleGenerationModelConfig.apiKey,
                    baseURL: titleGenerationModelConfig.baseURL,
                    model: titleGenerationModelConfig.model,
                    apiFormat: titleApiFormat,
                    providerId: titleGenerationModelConfig.provider,
                    modelCapabilities: titleModelCompat,
                  }
                );
                log(`[Agent-Process] Using custom title model: ${titleGenerationModelConfig.model}`);
              } catch (createErr) {
                warn('[Agent-Process] Failed to create title model client, falling back to agent LLM:', createErr);
                titleLLMClient = agent.llmClient;
              }
            }
          }

          log(`[Agent-Process] Title LLM client ready: provider=${titleLLMClient ? 'yes' : 'no'}`);
          log('[Agent-Process] Calling generateSessionTitle...');
          log(`[Agent-Process] Messages to pass: count=${agentMessages.length}, firstRole=${agentMessages[0]?.role}, firstContentType=${typeof agentMessages[0]?.content}`);
          const result = await generateSessionTitle(
            agentMessages,
            titleLLMClient,
            undefined,
            msg.sessionId
          );

          log(`[Agent-Process] generateSessionTitle returned: title="${result.title}"`);

          if (result.title) {
            titleGeneratedBySession.set(msg.sessionId, result.title);
            // Persist to DB immediately so the title survives renderer crashes
            try {
              await sessionDb.update(msg.sessionId, { title: result.title });
            } catch (dbErr) {
              warn('[Agent-Process] Failed to persist title to DB:', dbErr instanceof Error ? dbErr.message : String(dbErr));
            }
            sendToMain({ type: 'chat:title_generated', sessionId: msg.sessionId, title: result.title });
            log(`[Agent-Process] Title generated and sent: "${result.title}"`);
          } else {
            log('[Agent-Process] Title generation returned null, not sending');
          }
        } catch (titleErr) {
          // Log title generation errors for debugging
          log('[Agent-Process] Title generation error:', titleErr);
        }
      })();
    }

    // Note: 'chat:done' is sent AFTER persistence completes above.
    // It is intentionally deferred from the for-await loop to ensure
    // messages are saved to DB before the SSE stream closes.

  } catch (err) {
    log('[Agent-Process] Chat error:', err);
    const errMsg = err instanceof Error ? err.message : String(err);
    const errType = classifyError(err);
    let code: string | undefined;
    if (errType === APIErrorType.RATE_LIMIT) {
      code = 'rate_limit_error';
    } else if (errType === APIErrorType.USAGE_LIMIT) {
      code = 'usage_limit_exceeded';
    } else if (errType === APIErrorType.PROVIDER_SAFETY_FILTER) {
      code = 'provider_safety_filter';
    }
    sendToMain({
      type: 'chat:error',
      sessionId: msg.sessionId,
      message: errMsg,
      code,
    });
    // Persist any buffered hook rows even on a failed/aborted turn so the
    // cards survive reload — hooks that ran before the failure still count.
    try {
      const hookMessages = agent.drainPendingHookMessages();
      if (hookMessages.length > 0) {
        await appendMessages(msg.sessionId, hookMessages);
        log(`[Agent-Process] Persisted ${hookMessages.length} hook message(s) on error path`);
      }
    } catch (hookErr) {
      warn('[Agent-Process] Failed to persist hook messages on error path:', hookErr instanceof Error ? hookErr : new Error(String(hookErr)));
    }
    // Ensure the SSE stream closes even on error
    await persistTurnReview(msg.sessionId, msg.id, turnReviewBaseline);
    sendToMain({ type: 'chat:done', sessionId: msg.sessionId });
  } finally {
    stopChatHeartbeat();
    // Plan 587 R2.4: the grant SCOPE is per session, so it must not outlive
    // the session that established it. A worker that kept serving a new
    // session would otherwise write a new session's "always allow" into the
    // previous session's row -- a grant that follows the process instead of
    // the conversation, which is the exact failure §E forbids.
    permissionScopes.delete(msg.sessionId);
    // Plan 600 S2, step 1: the run is over, so no turn holds a pipeline. Closed
    // on BOTH paths — a dispatch that arrives after this now throws rather than
    // reaching a pipeline whose turn finished long ago. Publishing after a
    // close is refused too, so a late turn cannot resurrect it.
    turnPipelines.close();
  }
}

async function drainQueuedChatStart(): Promise<void> {
  // Atomic check-and-set: if a chat is already in progress, bail
  // out immediately. The finally block of the active chat will
  // re-invoke this via setImmediate, so we don't need a while loop.
  if (chatInProgress) return;

  const next = dequeue<ChatStartMessage>(
    (cmd: QueuedCommand<ChatStartMessage>) => cmd.agentId === undefined && cmd.mode === 'prompt'
  );
  if (!next) return;

  log('[Agent-Process] Draining queued chat:start from priority queue');
  chatInProgress = true;
  try {
    await handleChatStart(next.rawMessage);
  } finally {
    chatInProgress = false;
    // Use setImmediate to avoid stack overflow on rapid drain cycles
    // and to ensure the current microtask queue clears first.
    if (hasCommandsInQueue()) {
      setImmediate(() => { void drainQueuedChatStart(); });
    }
  }
}

// stderr wrapper to prevent stdout pollution of JSON-RPC protocol
// Use console.error/console.warn directly since log/warn aren't defined yet
const log = (...args: unknown[]): void => { console.error('[Agent-Process]', ...args); };
const warn = (...args: unknown[]): void => { console.warn('[Agent-Process]', ...args); };

// ============================================================================
// Plugin Skill Discovery
// ============================================================================

async function discoverPluginSkillPaths(): Promise<string[]> {
  const paths: string[] = [];
  try {
    const installed = await pluginDb.registryList() as Array<{ id?: unknown; enabled?: unknown; installPath?: unknown }>;
    const enabledPlugins = installed.filter(
      (item) => item.enabled === true && typeof item.id === 'string' && typeof item.installPath === 'string'
    );
    for (const plugin of enabledPlugins) {
      const installPath = plugin.installPath as string;
      const skillsDir = path.join(installPath, 'skills');
      if (existsSync(skillsDir)) {
        paths.push(skillsDir);
      }
    }
    if (paths.length > 0) {
      log(`[Agent-Process] Discovered ${paths.length} plugin skill directories`);
    }
  } catch (err) {
    warn('[Agent-Process] Failed to discover plugin skill paths:', err);
  }
  return paths;
}

async function reloadSkills(): Promise<void> {
  try {
    // Plan 445: no explicit cache handling needed here. loadSkillsFromDirectory
    // resolves each child directory through the per-skill snapshot cache, so
    // this full reload only re-parses SKILL.md files whose subtree changed;
    // unchanged skills reuse their previous PromptSkill objects.
    const registry = getSkillRegistry();
    // Clear existing non-bundled skills (system-level skills are
    // re-registered idempotently by loadSkills; keeping them out of the
    // unregister pass avoids a transient window with no system skills).
    const allSkills = registry.list();
    for (const skill of allSkills) {
      if (skill.source !== 'bundled' && skill.source !== 'system') {
        registry.unregister(skill.name);
      }
    }
    // Reload with plugin discovery
    await loadAgentSkills(agent?.workingDirectory, [], currentSecurityScanEnabled);
    sendToMain({ type: 'skills:reloaded', count: registry.list().length });
  } catch (err) {
    warn('[Agent-Process] Failed to reload skills:', err);
    sendToMain({ type: 'skills:reload:error', error: err instanceof Error ? err.message : String(err) });
  }
}

// ============================================================================
// Phase 2A diagnostic chain helpers
// ============================================================================
//
// The worker owns the post-apply snapshot (apply.ts PHASE C). Main /
// settings UI consumes the diagnostic chain through two events:
//   - `mcp:reloaded`      — emitted after every successful apply
//                           (init or reload). Carries the post-apply
//                           action summary + active server/tool
//                           keys + issue counts. Lightweight; safe
//                           to fire on every apply.
//   - `mcp:status:snapshot` — emitted only in response to a
//                           `mcp:status:get` command from main. The
//                           full inventory + issues + alias map
//                           summary, so the UI can render the
//                           settings page without a separate
//                           worker round-trip.
// Failure events:
//   - `mcp:reload:error`  — apply threw; old runtime preserved.
// Both are routed through `sendToMain`, which fans out to
// `process.send` (consumed by router's `child.on('message')`) and
// `sendEvent` (consumed by the SSE parser).

/**
 * Build the lightweight post-apply diagnostic event. The shape
 * is intentionally flat (no nested arrays of long strings) so the
 * router can serialize it without size concerns on every reload.
 */
function buildMcpReloadedEvent(result: MCPApplyResult): Record<string, unknown> {
  // The action summary comes from MCPApplyResult. The active
  // server keys are the same `scopedServerName`s in the
  // post-filter `resolvedConfigs`. The active tool keys are
  // the internalKeys installed by the apply. We surface them
  // so the UI can render the post-reload state without
  // needing a follow-up `mcp:status:get`.
  return {
    type: 'mcp:reloaded',
    reason: result.reason,
    committedAt: result.committedAt,
    clientsConnected: result.action.clientsConnected,
    toolsAdded: result.action.toolsAdded,
    toolsRemoved: result.action.toolsRemoved,
    inventoryRows: result.loadResult.inventory.length,
    issueCount: result.loadResult.issues.length,
    activeServerKeys: result.loadResult.resolvedConfigs.map((c) => c.scopedServerName),
  };
}

/**
 * Build the full diagnostic snapshot. The output mirrors the
 * shape consumed by the settings page: every inventory row, the
 * active server / tool keys, the full issues list, and the
 * apply reason + committedAt. Heavier than `mcp:reloaded`; only
 * emitted on explicit `mcp:status:get` requests.
 *
 * Phase 3 enrichment: also surface a per-server `mcpStatus` block
 * (connectionStatus + tool list + annotations) keyed by
 * `scopedServerName`. The main-process capability-management
 * aggregator consumes this so the settings UI / popovers can
 * show live "connected / disconnected" dots and the actual tool
 * list without a second IPC. The data is sourced from the
 * agent's live `MCPManager.getAllClients()` — nothing stale.
 */
function buildMcpStatusSnapshot(): Record<string, unknown> {
  if (!agent) {
    return {
      type: 'mcp:status:snapshot',
      hasAgent: false,
      inventory: [],
      activeServerKeys: [],
      activeToolKeys: [],
      issues: [],
      reason: null,
      committedAt: null,
      mcpStatus: {},
    };
  }
  const snapshot = agent.activeMCPRuntimeSnapshot;
  if (!snapshot) {
    return {
      type: 'mcp:status:snapshot',
      hasAgent: true,
      inventory: [],
      activeServerKeys: [],
      activeToolKeys: [],
      issues: [],
      reason: null,
      committedAt: null,
      mcpStatus: collectMcpStatusByServer(agent.getActiveMCPManager()),
    };
  }

  return {
    type: 'mcp:status:snapshot',
    hasAgent: true,
    reason: snapshot.reason,
    committedAt: snapshot.committedAt,
    inventory: snapshot.loadResult.inventory,
    activeServerKeys: snapshot.activeServerKeys,
    activeToolKeys: snapshot.activeToolKeys,
    issues: snapshot.loadResult.issues,
    connectionIssues: snapshot.connectionIssues,
    registrationIssues: snapshot.registrationIssues,
    mcpStatus: collectMcpStatusByServer(agent.getActiveMCPManager()),
  };
}

/**
 * Walk the live MCPManager and produce a per-server status map.
 * Empty when no runtime is active (initial boot before PHASE B2
 * commits).
 */
function collectMcpStatusByServer(
  manager: ReturnType<NonNullable<typeof agent>['getActiveMCPManager']>,
): Record<
  string,
  {
    connectionStatus: 'connected' | 'disconnected' | 'connecting' | 'error' | 'degraded';
    toolCount: number;
    tools: Array<{
      name: string;
      description: string;
      annotations: Record<string, unknown> | undefined;
    }>;
    /** Plan 580 Phase 5: per-server inventory ledger snapshot (optional; absent on older clients). */
    ledger?: {
      discoveryStatus: 'complete' | 'refreshing' | 'failed' | 'stale';
      pagesFetched: number;
      discoveredTotal: number;
      inventoryRevision: number;
      layers: { discovered: number; descriptors: number; aliases: number; registered: number; discoverable: number };
      fetchedAt: number;
    };
  }
> {
  if (!manager) return {};
  const out: Record<
    string,
    {
      connectionStatus: 'connected' | 'disconnected' | 'connecting' | 'error' | 'degraded';
      toolCount: number;
      tools: Array<{
        name: string;
        description: string;
        annotations: Record<string, unknown> | undefined;
      }>;
      ledger?: {
        discoveryStatus: 'complete' | 'refreshing' | 'failed' | 'stale';
        pagesFetched: number;
        discoveredTotal: number;
        inventoryRevision: number;
        layers: { discovered: number; descriptors: number; aliases: number; registered: number; discoverable: number };
        fetchedAt: number;
      };
    }
  > = {};
  for (const client of manager.getAllClients()) {
    const status = client.getStatus();
    const tools = client.getTools();
    out[client.getName()] = {
      connectionStatus: status,
      toolCount: tools.length,
      tools: tools.map((t: { name: string; description: string; annotations?: Record<string, unknown> }) => ({
        name: t.name,
        description: t.description,
        annotations: t.annotations,
      })),
      // Plan 580 Phase 5: attach the ledger snapshot when the client
      // provides one (new-field-optional contract; older UI ignores it).
      ledger: client.getLedgerSnapshot(),
    };
  }
  return out;
}

async function reloadMCP(): Promise<void> {
  // Phase 2A worker closure: reload now goes through the same
  // applyMCPConfiguration state machine as init. PHASE A computes
  // the next typed state without touching the active runtime;
  // PHASE B1 prepares the new manager + tool registration plan;
  // PHASE B2 atomically swaps the registry entries and the
  // active manager; PHASE C commits the snapshot. In-flight
  // calls against the old client fail deterministically after
  // PHASE B2 (this is the documented known limit; a future
  // tool-call drain is out of scope for this round).
  if (!agent) return;
  try {
    const result = await applyMCPConfiguration({
      agent,
      reason: 'manual',
      agentProfileId: agent.getActiveAgentProfileId(),
    });
    log(
      `[Agent-Process] Reloaded MCP: ${result.action.clientsConnected} connected, ` +
      `${result.action.toolsAdded} tools added, ${result.action.toolsRemoved} removed ` +
      `(${result.loadResult.inventory.length} inventory rows, ${result.loadResult.issues.length} issues)`,
    );
    for (const issue of result.loadResult.issues) {
      log(
        `[Agent-Process] MCP issue [${issue.phase}] ${issue.serverName ?? '(unknown)'}: ${issue.humanMessage}` +
        (issue.suggestedAction ? ` (action: ${issue.suggestedAction})` : ''),
      );
    }
    // Phase 2A diagnostic chain: emit a richer `mcp:reloaded`
    // event so main / settings UI can surface the active server
    // keys + tool keys + issue counts without polling. The full
    // `MCPHealthReport`-shaped payload arrives on demand via
    // `mcp:status:get` (handled in the worker protocol switch
    // below).
    sendToMain(buildMcpReloadedEvent(result));
    // Keep App Connection descriptors synchronized after a genuine MCP
    // reload too. Connect/disconnect uses its dedicated worker command.
    await reloadAppConnectionTools();
  } catch (err) {
    warn('[Agent-Process] Failed to reload MCP:', err);
    sendToMain({ type: 'mcp:reload:error', error: err instanceof Error ? err.message : String(err) });
  }
}

// ============================================================================
// Main Message Loop (stdin/stdout JSON-RPC)
// ============================================================================

async function handleCommand(msg: WorkerCommand): Promise<void> {
  const msgType = msg.type as string;
  if (msgType !== 'db:response') {
    log('[Agent-Process] Received command:', msgType, 'sessionId:', (msg as Record<string, unknown>).sessionId);
  }

  switch (msgType) {
    case 'init': {
          const initMsg = msg as unknown as InitMessage;
          log('[Agent-Process] Received init for session:', initMsg.sessionId);
          // Guard: reject re-init while chat is in progress to prevent mid-flight agent destruction
          if (chatInProgress) {
            log('[Agent-Process] Rejecting init: chat in progress, cannot reinit now');
            sendToMain({ type: 'ready', sessionId: initMsg.sessionId, status: 'deferred', reason: 'chat_in_progress' });
            break;
          }
          const previousSessionId = sessionId;
          sessionId = initMsg.sessionId;
          existingMessageCount = 0;
          // Fresh session served by this worker process: clear the live
          // context-usage tracker carried over from the previous session.
          // A re-init for the SAME session (main re-sends init between
          // turns) must keep it — wiping here dropped the authoritative base
          // every turn, so the ring fell back to the capped local estimate
          // until the first `result` of the next turn rebased it.
          if (previousSessionId !== sessionId) {
            compactedPending = false;
            liveTotalInput = 0;
            liveTotalInputRaw = 0;
            liveTotalOutput = 0;
            liveTotalCacheHit = 0;
            liveTotalCacheCreation = 0;
            // Plan 577 §3: new session = fresh agent instance = a fresh
            // ContextLedger (its own epoch counter starts at 0 with an empty
            // Observation layer) — no module-level observation reset needed.
            // Plan 445 Bug #7: dedupe cache must reset on session switch.
            lastEmittedUsageKey = null;
          }
          if (agent) {
            log('[Agent-Process] Re-init: destroying existing agent and creating new one');
            try {
              agent.destroy?.();
            } catch (err) {
              warn('[Agent-Process] Error destroying old agent:', err);
            }
            agent = null;
          }
          if (initializing) {
            log('[Agent-Process] Init in progress, waiting...');
            const INIT_POLL_TIMEOUT_MS = 30_000;
            const initPollStartTime = Date.now();
            const waitForInit = setInterval(() => {
              if (!initializing) {
                clearInterval(waitForInit);
                sendToMain({ type: 'ready', sessionId });
              } else if (Date.now() - initPollStartTime >= INIT_POLL_TIMEOUT_MS) {
                clearInterval(waitForInit);
                initializing = false;
                warn(`[Agent-Process] Init poll timed out after ${INIT_POLL_TIMEOUT_MS}ms, forcing ready`);
                sendToMain({ type: 'ready', sessionId, status: 'error', reason: 'init_timeout' });
              }
            }, 50);
            break;
          }
          initializing = true;
          log('[Agent-Process] Received init message:', {
            sessionId: initMsg.sessionId,
            workingDirectory: initMsg.workingDirectory,
            systemPrompt: initMsg.systemPrompt ? 'present' : 'not present',
            providerConfig: initMsg.providerConfig ? {
              provider: initMsg.providerConfig.provider,
              model: initMsg.providerConfig.model,
              baseURL: initMsg.providerConfig.baseURL,
              hasApiKey: !!initMsg.providerConfig.apiKey,
            } : 'MISSING!',
          });
          let initError: string | null = null;
          try {
            await initAgent(
              initMsg.providerConfig,
              initMsg.workingDirectory,
              initMsg.defaultWorkspaceDirectory,
              initMsg.systemPrompt,
              initMsg.blockedDomains,
              initMsg.language,
              initMsg.sandboxEnabled,
              initMsg.communicationPlatform,
              initMsg.browserBackendMode,
              initMsg.permissionRules,
              // Plan 536 L1: thread resolved projectId into the agent.
              initMsg.currentProjectId,
              // Plan 525 / 408 follow-up: thread the project-entity home
              // into the agent so the agentsmd loader can read
              // `<projectHome>/AGENTS.md` as a `'Project entity'` source.
              initMsg.projectHome,
            );

            try {
              // Parallel: initToolCatalog (only depends on agent instance),
              // skills loading (disk I/O), and DB message loading (IPC).
              // Skills errors are handled inside loadAgentSkills; DB errors caught below.
              currentSecurityScanEnabled = initMsg.securityScanEnabled !== false;
              const [_, __, loadedData] = await Promise.all([
                // Plan 314: initToolCatalog only depends on the agent instance, no dependency on skills/messages, run in parallel
                agent ? agent.initToolCatalog() : Promise.resolve(),
                loadAgentSkills(initMsg.workingDirectory, initMsg.skillPaths, initMsg.securityScanEnabled),
                messageDb.loadMessages(sessionId!) as Promise<{ messages: MessageRow[]; parsedDocuments: ParsedDocumentAttachment[] }>,
              ]);
              const existingRows = loadedData.messages;
              debugLog('loaded history rows', { sessionId, rows: existingRows.length });
              if (existingRows.length > 0) {
                // Load attachments for CDN URL rehydration
                let attachmentMap: Map<string, AttachmentRow[]> | undefined;
                try {
                  attachmentMap = getAttachmentsForSession(sessionId!);
                } catch {
                  // attachmentMap stays undefined, messages load without rehydration
                }
                // Build parsed doc map from combined IPC response (saves 1 round trip)
                let parsedDocMap: Map<string, ParsedDocumentAttachment[]> | undefined;
                if (loadedData.parsedDocuments?.length) {
                  parsedDocMap = new Map<string, ParsedDocumentAttachment[]>();
                  for (const doc of loadedData.parsedDocuments) {
                    const existing = parsedDocMap.get(doc.message_id) || [];
                    existing.push(doc);
                    parsedDocMap.set(doc.message_id, existing);
                  }
                }
                let existingMessages = existingRows.map(row => messageRowToMessage(row, attachmentMap, parsedDocMap));

                // Validate and repair incomplete or out-of-order tool rounds
                // before the history is ever sent back to a provider. Persist
                // successful repairs so a legacy bad row cannot poison this
                // session again after the worker restarts.
                const validatedMessages = validateMessageHistory(existingMessages);
                if (validatedMessages !== existingMessages) {
                  // Projection-synthesized compaction checkpoint markers (id
                  // `<entryId>:checkpoint`) are already carried inline by their
                  // rebase event. Re-persisting one lands as a NEW un-indexed
                  // row (INSERT OR IGNORE cannot dedupe the bare id against the
                  // rebase event), and on the next load the projection then
                  // yields the checkpoint twice — "Duplicate agent message id"
                  // breaks hydration. The in-memory list keeps the marker (the
                  // timeline needs it); only the replace payload drops it.
                  const persistableMessages = validatedMessages.filter(
                    (m) => !(m.id ?? '').endsWith(COMPACTION_CHECKPOINT_ID_SUFFIX),
                  );
                  const repairResult = await messageDb.replace(sessionId!, persistableMessages, 0) as {
                    success?: boolean;
                    reason?: string;
                  };
                  if (repairResult.success) {
                    log(`[Agent-Process] Repaired persisted message history for session ${sessionId}`);
                  } else {
                    warn(`[Agent-Process] Could not persist repaired message history for session ${sessionId}: ${repairResult.reason ?? 'unknown error'}`);
                  }
                }
                existingMessages = validatedMessages;

                agent.setMessages(existingMessages);
                existingMessageCount = existingMessages.length;
                log(`[Agent-Process] Loaded ${existingMessages.length} messages from DB for session ${sessionId}`);
                debugLog('loaded message roles', existingMessages.map(m => ({ role: m.role, type: m.msg_type || (Array.isArray(m.content) ? m.content.map((c: { type: string }) => c.type).join(',') : 'string') })));

                // Plan 331 Phase 2.4: restore (or create) the session_goals row
                // so token-budget deltas persist across restarts. The in-memory
                // TokenBudgetManager is rebuilt from the message history above
                // (updateContextTokens is called lazily on first
                // shouldCompact / getContextStats), so we only need to ensure
                // the DB row exists — the accumulators (tokens_used,
                // time_used_seconds) are read back on the next turn report.
                // Both branches below converge on get-then-create so a re-init
                // (row exists, message history empty) never trips the
                // UNIQUE(session_id) constraint.
                try {
                  const existingGoal = await goalDb.get(sessionId!) as Record<string, unknown> | undefined;
                  if (!existingGoal) {
                    const { randomUUID } = await import('node:crypto');
                    await goalDb.create({
                      id: randomUUID(),
                      session_id: sessionId!,
                    });
                    log(`[Agent-Process] Created new session_goals row for ${sessionId}`);
                  } else {
                    log(`[Agent-Process] Restored session_goals for ${sessionId}: tokens_used=${existingGoal.tokens_used}, status=${existingGoal.status}`);
                  }
                } catch (err) {
                  warn('[Agent-Process] Failed to restore/create session goal:', err);
                }
              } else {
                log(`[Agent-Process] No existing messages found in DB for session ${sessionId}`);
                // Plan 331 Phase 2.4: even for a brand-new session, create
                // the session_goals row so the first turn report has a row
                // to increment. Get-then-create keeps this idempotent — a
                // leftover goal row from an earlier run of the same session
                // is restored instead of rejected by the UNIQUE constraint.
                try {
                  const existingGoal = await goalDb.get(sessionId!) as Record<string, unknown> | undefined;
                  if (existingGoal) {
                    log(`[Agent-Process] Restored session_goals for ${sessionId}: tokens_used=${existingGoal.tokens_used}, status=${existingGoal.status}`);
                  } else {
                    const { randomUUID } = await import('node:crypto');
                    await goalDb.create({
                      id: randomUUID(),
                      session_id: sessionId!,
                    });
                    log(`[Agent-Process] Created new session_goals row for ${sessionId} (new session)`);
                  }
                } catch (err) {
                  warn('[Agent-Process] Failed to restore/create session goal:', err);
                }
              }
            } catch (err) {
              warn('[Agent-Process] Failed to load messages from DB:', err);
            }
          } catch (err) {
            initError = err instanceof Error ? err.message : String(err);
            warn('[Agent-Process] Agent initialization failed:', err);
          } finally {
            initializing = false;
            await drainQueuedChatStart();
          }

          sendToMain({
            type: 'ready',
            sessionId,
            ...(initError ? { status: 'error', error: initError } : {}),
          });

          // Plan 508: drain any compact command that arrived while init was
          // still running. If init failed, send a clearer error than the
          // previous 'Agent not initialized' so the renderer can recover.
          if (pendingCompactCommand) {
            const pending = pendingCompactCommand;
            pendingCompactCommand = null;
            if (initError) {
              sendToMain({
                type: 'compact:error',
                sessionId,
                message: `Worker initialization failed: ${initError}; please retry the chat session to recover.`,
                reason: 'init-failed',
              });
            } else {
              log('[Agent-Process] Replaying pending compact after init');
              handleCompactMessage(pending).catch((err) => {
                warn('[Agent-Process] Deferred compact failed:', err);
              });
            }
          }

          // Plan 312: fire-and-forget App Connection descriptor fetch.
          // Caches the descriptor list so DuyaAgent._resolveTools can
          // merge connector tools into the per-turn registry.
          if (!initError) {
            void reloadAppConnectionTools();
          }

          // Plan 305 Phase B: fire-and-forget memory wakeup. The
          // main-process router intercepts the `memory:wakeup` worker
          // event and triggers `MemoryWorker.forceSweep()` so Stage 1
          // extraction runs immediately after init (no 60s wait).
          // Gated by DUYA_MEMORY_ENABLED; failures are swallowed.
          if (!initError) {
            // Lazy-load: the memory rollout pipeline is heavy and not
            // needed until after the worker reports ready. Importing it
            // here (instead of at module top) trims ~1.5 MB off the cold
            // worker parse. The helper itself is gated by DUYA_MEMORY
            // *_ENABLED inside wakeup.ts, so failures are swallowed.
            void import('@duya/memory/wakeup').then(({ sendMemoryWakeup }) => {
              try {
                sendMemoryWakeup(
                  (event) => sendToMain(event as unknown as Record<string, unknown>),
                  {
                    sessionId: sessionId ?? undefined,
                    // Plan 610 A5: `wakeup` moved into `@duya/memory` and no
                    // longer reaches into this package's logger, so the
                    // warning is reported through a port the caller supplies.
                    onError: (err) =>
                      logger.warn('memory:wakeup send failed (shadow mode tolerates this)', {
                        error: err instanceof Error ? err.message : String(err),
                      }),
                  },
                );
              } catch (wakeupErr) {
                // Wakeup is best-effort; a failure here must not block
                // init or surface as a chat error.
                log('[Agent-Process] sendMemoryWakeup failed (ignored):', wakeupErr);
              }
            }).catch((importErr) => {
              log('[Agent-Process] Lazy memory-rollout import failed (ignored):', importErr);
            });
          }

          // Initialize MCP servers asynchronously after sending ready so that slow or hung
          // MCP servers do not block the worker from becoming ready.
          //
          // Phase 2A worker closure: both init and reload go
          // through `applyMCPConfiguration` (Phase 2A apply state
          // machine). Old Phase 1C "init typed, reload legacy"
          // transitional state is removed.
          (async () => {
            if (!agent) return;
            try {
              agent.setActiveAgentProfileId(undefined);
              log('[Agent-Process] Initializing MCP servers (applyMCPConfiguration)...');
              const result = await applyMCPConfiguration({
                agent,
                reason: 'initialization',
              });
              log(
                `[Agent-Process] Initialized MCP servers: ${result.action.clientsConnected} connected, ` +
                `${result.action.toolsAdded} tools, ${result.action.toolsRemoved} removed ` +
                `(${result.loadResult.inventory.length} inventory rows, ${result.loadResult.issues.length} issues)`,
              );
              for (const issue of result.loadResult.issues) {
                log(
                  `[Agent-Process] MCP issue [${issue.phase}] ${issue.serverName ?? '(unknown)'}: ${issue.humanMessage}` +
                  (issue.suggestedAction ? ` (action: ${issue.suggestedAction})` : ''),
                );
              }
            } catch (mcpErr) {
              warn('[Agent-Process] Failed to initialize MCP servers after ready:', mcpErr);
            } finally {
              // Plan 314: release the mcpReady gate regardless of outcome
              // so first chat is never permanently blocked. Success →
              // tools are in catalog; failure → degraded turn without MCP.
              agent.notifyMcpReady();
            }
          })();
          break;
        }

        case 'chat:start': {
          const chatMsg = msg as unknown as ChatStartMessage;
          log('[Agent-Process] Received chat:start for session:', chatMsg.sessionId, 'initInProgress:', initializing);
          if (initializing || chatInProgress) {
            log('[Agent-Process] Init in progress or chat in progress, queuing chat:start');
            enqueue({
              value: chatMsg.prompt,
              mode: 'prompt',
              priority: 'next',
              agentId: undefined,
              rawMessage: chatMsg,
            });
            break;
          }
          chatInProgress = true;
          handleChatStart(chatMsg).catch((err) => {
            // Defensive: any uncaught error inside handleChatStart
            // (e.g. turn-review temp-dir cleanup EBUSY on Windows)
            // must not crash the worker. Log and let the finally
            // block reset chatInProgress.
            warn('[Agent-Process] handleChatStart error:', err);
            sendToMain({
              type: 'chat:error',
              message: err instanceof Error ? err.message : String(err),
              sessionId: chatMsg.sessionId,
            });
          }).finally(() => {
            chatInProgress = false;
            setImmediate(() => {
              void drainQueuedChatStart();
            });
          });
          break;
        }

        case 'permission:set': {
          const pMode = (msg as { mode?: string }).mode;
          log('[Agent-Process] Received permission:set', { sessionId, mode: pMode });
          if (agent && pMode) {
            agent.setPermissionMode(pMode);
            log('[Agent-Process] Permission mode updated live', { sessionId, mode: pMode });
          }
          break;
        }

        case 'chat:interrupt': {
          const now = Date.now();
          log('[Agent-Process] Received chat:interrupt, chatInProgress:', chatInProgress);

          if (chatInProgress) {
            // First press: abort current chat.
            //
            // ONE path, and it is the agent's. This used to ask the run engine
            // first and the agent second, which was two mechanisms for one
            // symptom: the engine run that `activeEngineRun` pointed at was the
            // phantom run removed above, so its `stop` could only ever abort a
            // controller that no provider request was reading. Two callers, one
            // of which provably cancelled nothing.
            //
            // `agent.interrupt()` is what actually stops the in-flight turn: it
            // fires `this.abortController`, which is the signal `runTurnStream`
            // hands the client, so the provider request is aborted rather than
            // merely orphaned. That remains true after the cutover lands, and it
            // is why this line is the one the cutover's cancellation slice
            // removes -- not before, and not after a partial handover.
            if (agent && agent.interrupt) {
              agent.interrupt();
            }
            lastInterruptTime = now;
            break;
          }

          // Second press within window OR no chat running: clear queued messages
          if (hasCommandsInQueue() && (now - lastInterruptTime < DOUBLE_INTERRUPT_WINDOW_MS || !chatInProgress)) {
            log('[Agent-Process] Double interrupt: clearing command queue');
            clearCommandQueue();
            lastInterruptTime = 0;
          } else if (hasCommandsInQueue()) {
            // First press while idle with queued messages: pop the front of the
            // queue. Only user commands (agentId undefined) are interrupt-popped;
            // queue holds user prompts only now that background notifications
            // flow through the mailbox instead of the command queue.
            const popped = dequeue<ChatStartMessage>(
              (cmd: QueuedCommand<ChatStartMessage>) => cmd.agentId === undefined
            );
            if (popped) {
              log('[Agent-Process] Interrupt popped queued command from queue, remaining:', getCommandQueueLength());
            }
            lastInterruptTime = now;
          }
          break;
        }

        case 'ping': {
          lastPongTime = Date.now();
          sendToMain({ type: 'pong', timestamp: lastPongTime });
          break;
        }

        case 'compact': {
          void handleCompactMessage(msg);
          break;
        }

        case 'side:question': {
          const sideMsg = msg as unknown as import('./worker-protocol.js').SideQuestionCommand;
          log('[Agent-Process] Received side:question for session:', sideMsg.sessionId);
          if (!agent) {
            sendToMain({
              type: 'side:answer',
              sessionId: sideMsg.sessionId,
              id: sideMsg.id,
              answer: '',
              error: 'Agent not initialized',
            } satisfies import('./worker-protocol.js').SideQuestionResponse);
            break;
          }
          try {
            const answer = await agent.sideQuestion(sideMsg.question);
            sendToMain({
              type: 'side:answer',
              sessionId: sideMsg.sessionId,
              id: sideMsg.id,
              answer,
            } satisfies import('./worker-protocol.js').SideQuestionResponse);
          } catch (err) {
            warn('[Agent-Process] side:question failed:', err);
            sendToMain({
              type: 'side:answer',
              sessionId: sideMsg.sessionId,
              id: sideMsg.id,
              answer: '',
              error: err instanceof Error ? err.message : String(err),
            } satisfies import('./worker-protocol.js').SideQuestionResponse);
          }
          break;
        }

        case 'reload:skills': {
          log('[Agent-Process] Received reload:skills');
          void reloadSkills();
          break;
        }

        case 'appConnection:reload': {
          log('[Agent-Process] Received appConnection:reload');
          await reloadAppConnectionTools();
          break;
        }

        case 'reload:mcp': {
          log('[Agent-Process] Received reload:mcp');
          void reloadMCP();
          break;
        }

        case 'config:update': {
          const cfgMsg = msg as unknown as { browserBackendMode?: 'auto' | 'extension' | 'built-in' | 'human-like'; blockedDomains?: string[] };
          log('[Agent-Process] Received config:update:', cfgMsg);
          if (cfgMsg.browserBackendMode) {
            browserTool.setBrowserConfig({
              mode: cfgMsg.browserBackendMode,
              extensionProbeTimeoutMs: 500,
            });
            log('[Agent-Process] Browser backend mode updated:', cfgMsg.browserBackendMode);
          }
          break;
        }

        case 'mcp:status:get': {
          // Diagnostic chain command: main / settings UI queries
          // the active MCP runtime on demand. The full snapshot
          // (inventory + issues + active keys) goes out as a
          // single `mcp:status:snapshot` event.
          sendToMain(buildMcpStatusSnapshot());
          break;
        }

        case 'workflow:run': {
          // ZCode parity: real saved-workflow execution. Dispatched by the
          // agent server's POST /workflow/:name/trigger route targeting THIS
          // session's worker. The dwf script runs in-process via
          // launchSavedWorkflow (saved-store resolve → run row → journal →
          // vm sandbox) and every lifecycle frame flows out through the same
          // worker→router→SSE channel as goal_updated, so the renderer's
          // `workflow_run` case slots the card into this session.
          const wf = msg as unknown as WorkflowRunCommand;
          log('[Agent-Process] Received workflow:run', { sessionId, runId: wf.runId, workflowName: wf.workflowName });
          if (!agent) {
            sendToMain(
              buildWorkflowRunEvent(wf.sessionId, 'error', {
                runId: wf.runId ?? 'unstarted',
                workflowName: wf.workflowName ?? 'unknown',
                status: 'failed',
                startedAt: Date.now(),
                finishedAt: Date.now(),
                error: 'agent worker not initialized (no init command received)',
                stoppedReason: 'not_initialized',
              }) as unknown as Record<string, unknown>,
            );
            break;
          }
          void launchSavedWorkflow(
            {
              sessionId: wf.sessionId,
              emit: sendToMain as (msg: unknown) => void,
              // Same interactive ask pipeline the chat turn uses — approval
              // cards render in the anchored session and resolve via
              // permission:resolve.
              requestPermission: createPermissionHandler(wf.sessionId),
              // Plan 565 Phase D: wf.ask resolves through the same
              // permission pipeline — the answers stored by permission:resolve
              // are read back one-shot here.
              takePendingAnswer,
              llm: {
                apiKey: agent.apiKey ?? '',
                baseURL: agent.baseURL,
                provider: agent.provider ?? 'openai',
                model: agent.model ?? '',
                authStyle: agent.authStyle,
              },
              workingDirectory: wf.projectDir || agent.workingDirectory || process.cwd(),
              // Plan 556 Phase 4: wf.gui rides the same worker→main
              // computer-use bridge the computer_use tool uses. Captures
              // stay in memory on the session-anchored path — the run-
              // anchored runtime child binds the durable FsArtifactStore.
              computerUseRequest: (action, payload, options) =>
                computerUseIpcRequest(
                  'computer-use:execute',
                  { action, payload, sessionId: wf.sessionId },
                  options,
                ),
              guiArtifactStore: new MemoryArtifactStore(),
            },
            {
              runId: wf.runId,
              workflowName: wf.workflowName,
              params: wf.params,
              projectDir: wf.projectDir,
              ...(wf.resumeFromRunId !== undefined ? { resumeFromRunId: wf.resumeFromRunId } : {}),
            },
          ).catch((err) => {
            warn('[Agent-Process] workflow:run failed:', err);
            sendToMain(
              buildWorkflowRunEvent(wf.sessionId, 'error', {
                runId: wf.runId ?? 'unstarted',
                workflowName: wf.workflowName ?? 'unknown',
                status: 'failed',
                startedAt: Date.now(),
                finishedAt: Date.now(),
                error: err instanceof Error ? err.message : String(err),
                stoppedReason: 'unknown',
              }) as unknown as Record<string, unknown>,
            );
          });
          break;
        }

        case 'permission:resolve': {
          // Handle permission resolution from main — resolve the pending permission promise.
          // sessionId is required to keep sessions isolated (B4): a stray resolve
          // from a sub-agent/fork must not unlock a top-level session's prompt.
          const { id, decision, updatedInput, sessionId: resolveSessionId } = msg as {
            id: string;
            decision: string;
            updatedInput?: Record<string, unknown>;
            message?: string;
            sessionId?: string;
          };

          if (!resolveSessionId) {
            warn('[Agent-Process] permission:resolve missing sessionId, ignoring:', id);
            break;
          }

          log('[Agent-Process] Permission resolved:', resolveSessionId, id, decision, updatedInput ? 'with updatedInput' : '');

          // Store answers for AskUserQuestion tool retry
          if (updatedInput?.answers) {
            storePendingAnswer(id, updatedInput.answers as Record<string, string>);
          }

          const key = pendingPermissionKey(resolveSessionId, id);
          const pending = pendingPermissions.get(key);
          if (pending) {
            // Clear the 5min timer FIRST so a late expiry can never race
            // with this resolve and emit a stray 'deny'.
            clearTimeout(pending.timeoutHandle);
            pendingPermissions.delete(key);
            if (decision === 'allow' || decision === 'allow_once' || decision === 'allow_for_session') {
              // Plan 587 R2.4: `allow_for_session` used to record the grant in
              // this process's memory only, so it died on worker recycle even
              // though `tool_approval_rules` (read at :2541) already had a
              // durable reader waiting for it. A grant whose scope is narrower
              // than its name is a defect, so the WRITE now goes to the same
              // table the bot card path writes, keyed by the session.
              //
              // The in-process set is kept as a fast path AND is seeded from
              // the durable rules below, so the two cannot disagree: it is a
              // cache of the session's grants, not a second opinion about them.
              if (decision === 'allow_for_session' && pending.toolName) {
                const scope = permissionScopes.get(resolveSessionId) ?? {
                  scopeType: 'session' as const,
                  scopeId: resolveSessionId,
                };
                try {
                  const written = (await toolApprovalDb.upsertRule({
                    scopeType: scope.scopeType,
                    scopeId: scope.scopeId,
                    toolName: pending.toolName,
                  })) as { ok?: boolean } | undefined;
                  if (written?.ok === false) {
                    warn('[Agent-Process] session grant could not be persisted; scope stays one-shot', {
                      sessionId: resolveSessionId,
                      toolName: pending.toolName,
                    });
                  }
                } catch (err) {
                  // A grant that could not be stored must not be reported as
                  // remembered. The call itself still proceeds (the user did
                  // answer "allow"); only the DURATION is lost, and it is lost
                  // loudly rather than silently.
                  warn('[Agent-Process] session grant write failed; scope stays one-shot', {
                    sessionId: resolveSessionId,
                    toolName: pending.toolName,
                    error: err instanceof Error ? err.message : String(err),
                  });
                }
                const connectorDescriptor = (await getAppConnection()).getCachedAppConnectionDescriptors().find(
                  (d: any) => d.name === pending.toolName,
                );
                if (connectorDescriptor) {
                  (await import('../tool/AppConnectionTool/approvals.js')).rememberSessionApproval(pending.toolName);
                }
              }
              pending.resolve('allow');
            } else {
              pending.resolve('deny');
            }
          } else {
            // Common during SSE reconnect: a fresh permission event was
            // emitted after the original had already been resolved. The
            // renderer's `waitingRef` guard prevents double-send, and the
            // missing entry is the expected state — log at info, not warn,
            // to avoid noise.
            log('[Agent-Process] No pending permission for resolved id (likely already resolved or expired):', resolveSessionId, id);
          }
          break;
        }

        case 'subagent:kill': {
          // Plan 571 2.5: the sub-agent panel's stop button. A sub-agent has
          // no worker of its own — it runs in-process inside THIS worker — so
          // the kill arrives on this worker's stdin command channel and is
          // resolved against this worker's lifecycle singleton.
          //
          // Contract:
          //  - fire-and-forget, like `permission:set` and `db:response`
          //    (there is no ack convention on this channel);
          //  - `taskId` is REQUIRED. A bare sessionId is deliberately not
          //    accepted: sessionId identifies this worker, and accepting it
          //    would let one id kill whatever task happened to be in flight;
          //  - never throws. `handleCommand` is awaited by the stdin
          //    `for await` loop, so an escaping error would tear down the
          //    worker's command reader and desync every later command.
          const killMsg = msg as unknown as {
            type: 'subagent:kill';
            taskId?: string;
            sessionId?: string;
            reason?: string;
          };
          if (typeof killMsg.taskId !== 'string' || !killMsg.taskId.trim()) {
            warn('[Agent-Process] subagent:kill missing taskId, ignoring:', killMsg.sessionId);
            break;
          }
          // The wire `reason` is not trusted: the only reason a user can
          // produce is a user-initiated stop, and BackgroundAgentLifecycle
          // types the reason as a closed union.
          try {
            const outcome = backgroundAgentLifecycle.tryKill(killMsg.taskId, 'user_kill');
            log('[Agent-Process] subagent:kill', killMsg.taskId, '->', outcome);
          } catch (err) {
            warn('[Agent-Process] subagent:kill threw (ignored):', killMsg.taskId, err);
          }
          break;
        }

        case 'interagent:event': {
          const eventMsg = msg as unknown as { type: 'interagent:event'; id: string; event: import('./worker-protocol.js').WorkerEvent };
          const call = pendingInteragentCalls.get(eventMsg.id);
          if (!call) {
            // Stale event after cleanup — safe to ignore
            break;
          }
          call.events.push(eventMsg.event);
          if (eventMsg.event.type === 'chat:done') {
            call.resolveDone(eventMsg.event);
          } else if (eventMsg.event.type === 'chat:error') {
            call.resolveError(eventMsg.event);
          }
          break;
        }

        case 'db:response': {
          // Handled by db-client, just acknowledge
          break;
        }

        case 'conductor:executor:rpc:response': {
          const { requestId, success, result, error } = msg as unknown as {
            requestId: string;
            success: boolean;
            result?: unknown;
            error?: { code: string; message: string };
          };
          const pending = pendingIpcRequests.get(requestId);
          if (pending) {
            // Clear the timeout so it doesn't fire after a successful response
            if (pending.timeoutHandle) {
              clearTimeout(pending.timeoutHandle);
            }
            pendingIpcRequests.delete(requestId);
            if (success) {
              pending.resolve({ success: true, data: result });
            } else {
              pending.resolve({ success: false, error: error || { code: 'UNKNOWN', message: 'Unknown error' } });
            }
          } else {
            warn('[Agent-Process] No pending IPC request found for requestId:', requestId);
          }
          break;
        }

        // Plan 312: App Connection tool execution response.
        case 'appConnection:invoke:response': {
          const { requestId, success, data, error } = msg as unknown as {
            requestId: string;
            success: boolean;
            data?: unknown;
            error?: { code: string; message: string };
          };
          const pending = pendingIpcRequests.get(requestId);
          if (pending) {
            if (pending.timeoutHandle) {
              clearTimeout(pending.timeoutHandle);
            }
            pendingIpcRequests.delete(requestId);
            if (success) {
              pending.resolve({ success: true, data });
            } else {
              pending.resolve({ success: false, error: error || { code: 'UNKNOWN', message: 'Unknown error' } });
            }
          } else {
            warn('[Agent-Process] No pending appConnection IPC request found for requestId:', requestId);
          }
          break;
        }

        // Plan 312: App Connection descriptor list response.
        case 'appConnection:listDescriptors:response': {
          const { requestId, success, descriptors, error } = msg as unknown as {
            requestId: string;
            success: boolean;
            descriptors?: unknown[];
            error?: { code: string; message: string };
          };
          const pending = pendingIpcRequests.get(requestId);
          if (pending) {
            if (pending.timeoutHandle) {
              clearTimeout(pending.timeoutHandle);
            }
            pendingIpcRequests.delete(requestId);
            if (success) {
              pending.resolve({ success: true, descriptors });
            } else {
              pending.resolve({ success: false, error: error || { code: 'UNKNOWN', message: 'Unknown error' } });
            }
          } else {
            warn('[Agent-Process] No pending appConnection descriptor request found for requestId:', requestId);
          }
          break;
        }

        // Plan 503: App Connection catalog response (bot connector tools).
        case 'appConnection:catalog:response': {
          const { requestId, success, data, error } = msg as unknown as {
            requestId: string;
            success: boolean;
            data?: unknown;
            error?: { code: string; message: string };
          };
          const pending = pendingIpcRequests.get(requestId);
          if (pending) {
            if (pending.timeoutHandle) {
              clearTimeout(pending.timeoutHandle);
            }
            pendingIpcRequests.delete(requestId);
            if (success) {
              pending.resolve({ success: true, data });
            } else {
              pending.resolve({ success: false, error: error || { code: 'UNKNOWN', message: 'Unknown error' } });
            }
          } else {
            warn('[Agent-Process] No pending appConnection catalog request found for requestId:', requestId);
          }
          break;
        }

        // Plan 454: Computer Use tool execution response. Resolves
        // the promise created by computerUseIpcRequest so the
        // computer_use tool executor can unwrap the envelope.
        case 'computer-use:execute:response': {
          const { requestId, success, data, error } = msg as unknown as {
            requestId: string;
            success: boolean;
            data?: unknown;
            error?: { code: string; message: string };
          };
          const pending = pendingIpcRequests.get(requestId);
          if (pending) {
            if (pending.timeoutHandle) {
              clearTimeout(pending.timeoutHandle);
            }
            pendingIpcRequests.delete(requestId);
            if (success) {
              pending.resolve({ success: true, data });
            } else {
              pending.resolve({ success: false, error: error || { code: 'UNKNOWN', message: 'Unknown error' } });
            }
          } else {
            warn('[Agent-Process] No pending computer-use IPC request found for requestId:', requestId);
          }
          break;
        }
        // Plan 575: computer_cua tool response. Resolves the promise
        // created by computerCuaIpcRequest so the computer_cua tool
        // executor can unwrap the envelope.
        case 'computer-use:cua:response': {
          const { requestId, success, data, error } = msg as unknown as {
            requestId: string;
            success: boolean;
            data?: unknown;
            error?: { code: string; message: string };
          };
          const pending = pendingIpcRequests.get(requestId);
          if (pending) {
            if (pending.timeoutHandle) {
              clearTimeout(pending.timeoutHandle);
            }
            pendingIpcRequests.delete(requestId);
            if (success) {
              pending.resolve({ success: true, data });
            } else {
              pending.resolve({ success: false, error: error || { code: 'UNKNOWN', message: 'Unknown error' } });
            }
          } else {
            warn('[Agent-Process] No pending computer-use:cua IPC request found for requestId:', requestId);
          }
          break;
        }
        // Plan 481: memory-tier bridge response (update_state tool).
        case 'memory-tier:rpc:response': {
          const { requestId, success, data, error } = msg as unknown as {
            requestId: string;
            success: boolean;
            data?: unknown;
            error?: { code: string; message: string };
          };
          const pending = pendingIpcRequests.get(requestId);
          if (pending) {
            if (pending.timeoutHandle) {
              clearTimeout(pending.timeoutHandle);
            }
            pendingIpcRequests.delete(requestId);
            if (success) {
              pending.resolve({ success: true, data });
            } else {
              pending.resolve({ success: false, error: error || { code: 'UNKNOWN', message: 'Unknown error' } });
            }
          } else {
            warn('[Agent-Process] No pending memory-tier IPC request found for requestId:', requestId);
          }
          break;
        }
        // Plan 481 amendment: bot-identity bridge response (profile.set / avatar.*).
        case 'bot-identity:rpc:response': {
          const { requestId, success, data, error } = msg as unknown as {
            requestId: string;
            success: boolean;
            data?: unknown;
            error?: { code: string; message: string };
          };
          const pending = pendingIpcRequests.get(requestId);
          if (pending) {
            if (pending.timeoutHandle) {
              clearTimeout(pending.timeoutHandle);
            }
            pendingIpcRequests.delete(requestId);
            if (success) {
              pending.resolve({ success: true, data });
            } else {
              pending.resolve({ success: false, error: error || { code: 'UNKNOWN', message: 'Unknown error' } });
            }
          } else {
            warn('[Agent-Process] No pending bot-identity IPC request found for requestId:', requestId);
          }
          break;
        }
    default:
      warn('[Agent-Process] Unknown message type:', msgType);
  }
}

/**
 * Plan 508: extracted compact-message handler so the switch case stays a
 * thin dispatch and the same body can be replayed from the init-drain path
 * when a compact command arrived before init finished.
 */
async function handleCompactMessage(msg: unknown): Promise<void> {
  log('[Agent-Process] Received compact for session:', sessionId);
  // Plan 508: when the worker has not finished init yet, defer the
  // compact until init completes (mirror chat:start's enqueue).
  // Without this, the bot session 'compact' popover clicks hit a
  // 'Agent not initialized' error every time the worker has just been
  // lazy-spawned by the router.
  if (!agent && initializing) {
    log('[Agent-Process] Compact received during init, deferring until ready');
    pendingCompactCommand = msg;
    return;
  }
  if (!agent) {
    // Plan 508: init previously failed for this worker (e.g. bot session
    // with no provider config). Surface a clearer error so the renderer
    // can recover by triggering a new chat:start / re-init flow instead
    // of looping on the same opaque 'Agent not initialized'.
    sendToMain({
      type: 'compact:error',
      sessionId,
      message: 'Worker initialization previously failed; please retry the chat session to recover.',
      reason: 'init-failed',
    });
    return;
  }
  // Backpressure gate: compaction mutates the shared messages timeline
  // and the llmClient reference. Running it concurrently with an in-
  // flight turn would race the stream generator. Wait briefly for
  // the active turn to finish; if it takes too long, surface a busy
  // error so the renderer can retry.
  if (chatInProgress || initializing) {
    const compactBusyStart = Date.now();
    const COMPACT_BUSY_WAIT_MS = 5_000;
    log('[Agent-Process] Chat in progress, waiting before compact');
    while ((chatInProgress || initializing) && Date.now() - compactBusyStart < COMPACT_BUSY_WAIT_MS) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (chatInProgress || initializing) {
      sendToMain({
        type: 'compact:error',
        sessionId,
        message: 'Chat turn still in progress after 5s; please retry after the turn completes',
      });
      return;
    }
  }
  chatInProgress = true;
  // Plan 422: lazy-load messages if the worker has not yet seen this
  // session via chat:start. The /compact popover button is dispatched
  // independently of chat:start, so without this the worker would call
  // agent.compact() on an empty timeline and return strategy: 'none'
  // — the symptom the user hit on a 332-message session.
  try {
    if (sessionId) {
      const dbCount = await messageDb.getCount(sessionId) as number
      if (dbCount > 0 && agent.getMessages().length === 0) {
        const loaded = await messageDb.loadMessages(sessionId) as { messages: MessageRow[] }
        const attachmentMap = getAttachmentsForSession(sessionId)
        const allMsgs = loaded.messages.map(row => messageRowToMessage(row, attachmentMap))
        const validated = validateMessageHistory(allMsgs)
        agent.setMessages(validated)
        existingMessageCount = validated.length
        log('[Agent-Process] Compact: lazy-loaded ' + validated.length + ' messages from DB')
      }
    }
  } catch (loadErr) {
    log('[Agent-Process] Compact: lazy-load failed (continuing):', loadErr)
  }
  try {
    // Extract optional compact options from message
    const compactMsg = msg as unknown as {
      strategy?: string;
      maxMessagesToKeep?: number;
      customInstructions?: string;
      keepRecentTokens?: number;
    };

    const result = await agent.compact({
      strategy: compactMsg.strategy,
      maxMessagesToKeep: compactMsg.maxMessagesToKeep,
      customInstructions: compactMsg.customInstructions,
    });
    log('[Agent-Process] Compaction complete:', result);
    // Plan 475 P4.6 follow-up: persistence is owned by the
    // `onMessagesCompacted` wiring, which emits an append-only
    // `rebase` journal event (supersedes compacted-away messages,
    // carries the summary + survivors). The legacy appendMessages-
    // of-all call that used to live here is gone — it never
    // superseded anything, so a reload resurrected the full
    // pre-compaction history next to the summary (ghost history).
    existingMessageCount = agent.getMessages().length;
    log(`[Agent-Process] Compaction: rebase emitted, new count=${existingMessageCount}`);
    // Broadcast BEFORE compact:done: retained anchors describe the
    // pre-compact prompt, so mark pending and emit an unanchored
    // frame — the ring shows "?" until the next turn's first `result`
    // provides a post-compaction anchor (plan 443, pi parity).
    compactedPending = true;
    // Plan 577 §3: the successful compact() began the 'compaction' epoch in
    // the ledger — the observation lineage is cleared there atomically.
    emitLiveUsage(sessionId);
    sendToMain({ type: 'compact:done', sessionId, result });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log('[Agent-Process] Compaction failed:', errorMessage);
    sendToMain({ type: 'compact:error', sessionId, message: errorMessage });
  } finally {
    // Release the gate even on error so subsequent compactions or
    // chat:start messages can proceed. Without this, a thrown
    // error would deadlock the worker until process restart.
    chatInProgress = false;
  }
}

async function main(options: AgentProcessStartOptions = {}): Promise<void> {
  log('Process started, session:', process.env.SESSION_ID);
  log('cwd:', process.cwd());

  // Plan 560 D2: the same bundle serves two roles. `workflow-runtime` is the
  // run-anchored executor — one process, one run, no init handshake, no chat
  // session, no agent. It owns stdin/stdout itself (the command loop in
  // workflow-runtime-child.ts), so this branch must return before the chat
  // command loop below installs a second consumer on the same pipe.
  if (process.env.DUYA_AGENT_ROLE === 'workflow-runtime') {
    try {
      await runWorkflowRuntimeChild();
    } catch (err) {
      // A throw here means the child died before it could report the failure
      // on stdout. Exit non-zero so the manager settles the run as failed.
      warn('[Workflow-Runtime] child failed:', err);
      exitAfterCleanup(1);
      return;
    }
    exitAfterCleanup(0);
    return;
  }

  // Handle IPC messages from AgentProcessPool (cronjob, conductor, etc.)
  // Agent Server uses stdin/stdout, but AgentProcessPool uses IPC child.send()
  process.on('message', (msg: unknown) => {
    if (msg && typeof msg === 'object') {
      void handleCommand(msg as WorkerCommand);
    }
  });

  try {
    // The injection seam, same shape as runWorkflowRuntimeChild's `commands`:
    // production takes the `parseStdin()` branch and a test supplies its own
    // stream, so both drive THIS loop rather than a test-only variant.
    for await (const msg of options.commands ?? parseStdin()) {
      await handleCommand(msg);
    }
  } catch (err) {
    log('[Agent-Process] Fatal error in main loop:', err);
    writeAgentCrashLog(err, 'main-loop');
    exitAfterCleanup(1);
  }
}

// ============================================================================
// Graceful Shutdown Handling
// ============================================================================

let isShuttingDown = false;

async function performCleanup(): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  log('[Agent-Process] Starting cleanup...');

  // Stop chat heartbeat
  stopChatHeartbeat();

  // Destroy token bucket timer
  toolBucket.destroy();

  // Shutdown worker pool (kills all BashWorker processes)
  try {
    const { shutdownWorkerPool } = await import('../tool/WorkerPool.js');
    shutdownWorkerPool();
    log('[Agent-Process] Worker pool shut down');
  } catch (err) {
    warn('[Agent-Process] Failed to shut down worker pool:', err);
  }

  // Clear title generation state
  titleGeneratedBySession.clear();

  // Close database connection
  try {
    const { closeDbClient } = await import('../ipc/db-client.js');
    await closeDbClient();
    log('[Agent-Process] DB client closed');
  } catch (err) {
    warn('[Agent-Process] Failed to close DB client:', err);
  }

  log('[Agent-Process] Cleanup complete');
}

function exitAfterCleanup(code: number): void {
  const safetyTimeout = setTimeout(() => {
    log('[Agent-Process] Cleanup timed out, force exiting');
    process.exit(code);
  }, 5000);

  void performCleanup().then(() => {
    clearTimeout(safetyTimeout);
    process.exit(code);
  }).catch((err) => {
    log('[Agent-Process] Cleanup failed:', err);
    clearTimeout(safetyTimeout);
    process.exit(code);
  });
}

// The termination-signal, parent-disconnect and output-stream handlers used to
// sit here at module scope, which made importing this file install them. They
// are now in installProcessLifecycleHandlers() below, called by the start path.

// Persist the full error to a file so the crash is diagnosable even though
// the process pool only retains the first 5 stderr lines. Called from both
// the main-loop fatal-error catch and the uncaughtException handler.
function writeAgentCrashLog(err: unknown, origin: string): void {
  try {
    const crashDir = path.join(os.tmpdir(), 'duya-agent-crash');
    mkdirSync(crashDir, { recursive: true });
    const crashPath = path.join(crashDir, `agent-${sessionId || 'unknown'}-${origin}-${Date.now()}.log`);
    writeFileSync(
      crashPath,
      `[${new Date().toISOString()}] sessionId=${sessionId} origin=${origin}\n${err instanceof Error ? (err.stack || err.toString()) : String(err)}\n`,
      'utf-8',
    );
    log(`[Agent-Process] Crash log written to ${crashPath}`);
  } catch (writeErr) {
    warn('[Agent-Process] Failed to write crash log:', writeErr);
  }
}

// Swallow EPIPE / broken-pipe errors on our own stdout & stderr. When the
// parent tears the process down (releaseAndWait / killProcessTree) or exits
// before we finish flushing, the write pipe is broken. Node surfaces that as
// an ASYNC 'error' event on the stream (not a synchronous throw), which the
// write-queue try/catch in worker-protocol.ts cannot intercept — without a
// listener it escalates to uncaughtException and is misreported as a crash
// (exit code 1 + a spurious crash log). A genuine write failure elsewhere is
// still observable via other channels, so it is safe to swallow EPIPE only.
const swallowPipeError = (err: unknown): void => {
  const code = (err as { code?: string } | null)?.code;
  if (code === 'EPIPE' || code === 'ERR_STREAM_WRITE_AFTER_END') {
    log('[Agent-Process] Ignoring broken pipe on process output:', code);
    return;
  }
  // Any other stream error is unexpected; surface it as a crash.
  log('[Agent-Process] Fatal process output error:', err);
  writeAgentCrashLog(err, 'output-stream');
  exitAfterCleanup(1);
};

// ============================================================================
// Process Startup
// ============================================================================

/** Options for the one process start path. */
export interface AgentProcessStartOptions {
  /** Injection seam for tests — defaults to the real stdin command stream. */
  commands?: AsyncIterable<WorkerCommand>;
}

/**
 * Register the process-level lifecycle handlers: the two termination signals,
 * the parent-disconnect path, the two output-stream error handlers, and the
 * two crash reporters.
 *
 * These were module-scope statements, so merely IMPORTING this file installed
 * seven handlers as a side effect — which is what made the live chat path
 * impossible to test. They are registered here instead, by the start path,
 * synchronously before main() reaches its first await and in the same order
 * as before, so a crash during async startup still reaches exitAfterCleanup.
 */
function installProcessLifecycleHandlers(): void {
  // Handle termination signals
  // Note: On Windows, Node.js child processes do NOT receive SIGTERM/SIGINT
  // from parent.kill(). We rely primarily on 'disconnect' event.
  process.on('SIGTERM', () => {
    log('[Agent-Process] Received SIGTERM');
    exitAfterCleanup(0);
  });

  process.on('SIGINT', () => {
    log('[Agent-Process] Received SIGINT');
    exitAfterCleanup(0);
  });

  // Handle disconnect from parent (Electron main process exited)
  // This is the PRIMARY shutdown mechanism on Windows.
  process.on('disconnect', () => {
    log('[Agent-Process] Parent disconnected, shutting down...');
    exitAfterCleanup(0);
  });

  process.stdout.on('error', swallowPipeError);
  process.stderr.on('error', swallowPipeError);

  // Handle uncaught errors to avoid zombie processes
  process.on('uncaughtException', (err) => {
    log('[Agent-Process] Uncaught exception:', err);
    writeAgentCrashLog(err, 'uncaught-exception');
    exitAfterCleanup(1);
  });

  process.on('unhandledRejection', (reason) => {
    log('[Agent-Process] Unhandled rejection:', reason);
  });
}

/**
 * True only when this module IS the program Node was started with.
 *
 * Both production launchers put the bundle's own path in argv[1]:
 * `fork(workerPath, ...)` in apps/desktop/.../server/worker-manager.ts and
 * `spawn(process.execPath, [agentPath])` in
 * apps/desktop/.../process-pool/process-manager.ts. Under a test runner
 * argv[1] is the runner, so the import stays inert.
 *
 * This is an identity check, NOT an environment sniff: a packaged run that
 * happens to carry NODE_ENV=test still self-starts, because nothing here
 * reads the environment.
 */
function isProcessEntryPoint(): boolean {
  // `import.meta.url` must stay the literal expression below. esbuild's
  // `import.meta.url` define in scripts/build-agent-bundle.mjs (CJS output,
  // banner polyfill `pathToFileURL(__filename)`) only matches this exact
  // syntactic shape; the same constraint is documented on WorkerPool's
  // resolveDirname().
  const selfUrl = import.meta.url;
  const entryArg = process.argv[1];
  if (typeof selfUrl !== 'string' || selfUrl.length === 0 || !entryArg) {
    return false;
  }
  let selfPath: string;
  try {
    selfPath = fileURLToPath(selfUrl);
  } catch {
    return false;
  }
  const resolvedSelf = path.resolve(selfPath);
  const resolvedEntry = path.resolve(entryArg);
  // Windows paths compare case-insensitively: the parent's spelling of the
  // path is not guaranteed to match the child's.
  return process.platform === 'win32'
    ? resolvedSelf.toLowerCase() === resolvedEntry.toLowerCase()
    : resolvedSelf === resolvedEntry;
}

/**
 * The one process start path. Production reaches it through the
 * isProcessEntryPoint() guard at the bottom of this file; a test calls it
 * directly. Both run the same code.
 */
export async function startAgentProcess(options: AgentProcessStartOptions = {}): Promise<void> {
  installProcessLifecycleHandlers();
  await main(options);
}

// Start the main loop — only when this file is the process entry point, so
// that importing it (tests, tooling) does not boot the agent.
if (isProcessEntryPoint()) {
  void startAgentProcess();
}
