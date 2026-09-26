/**
 * workflow-runner.ts — worker-side saved-workflow executor (ZCode parity).
 *
 * This is the production swap-in for the plan 552 §14 synthetic SSE bridge:
 * a `.dwf.ts` saved workflow (frontmatter + TS script) is resolved from the
 * project/global scopes, a real run row is created in core-db (via the
 * worker db bridge), and the script body is compiled + executed inside the
 * dwf vm sandbox (modes/workflow/dwf/runtime). Every journal record rides
 * the same worker→router→SSE channel (`chat:workflow_run`) as before —
 * `emit` stays the stable port.
 *
 * Production DwfHostPorts binding:
 *   - runTool   → a fresh builtin ToolRegistry (`createBuiltinRegistry`).
 *                 Workflow v1 has no MCP surface — scripts call builtin
 *                 tools only.
 *   - runAgent  → the SubagentTool executor (`task`) behind a synthetic
 *                 ToolUseContext built from the worker's init config. Going
 *                 through SubagentTool buys sub-session creation (plan 504
 *                 lineage), renderer progress events, and session status
 *                 bookkeeping for free.
 *   - requestApproval → the worker's interactive `chat:permission`
 *                 pipeline (the same one tool asks ride). That pipeline has
 *                 a hard 5-minute deny timeout, so approval waits are
 *                 capped there in v1; a timeout surfaces to the script as
 *                 'deny' → DwfApprovalDeniedError('denied') regardless of
 *                 the declared onTimeout mode.
 *   - runBrowser → ExtensionCDPClient over the browser daemon (plan 564);
 *                 the daemon is localhost HTTP so the worker dials it
 *                 directly, no worker→main RPC hop.
 *
 * Resume IS wired (plan 565 Phase A): `req.resumeFromRunId` names a prior
 * run whose journal seeds this run's replay cache before the script starts —
 * a re-run / amended re-run replays every unchanged call from cache (§6.4)
 * and only re-executes new or changed nodes.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';

import {
  buildWorkflowRunEvent,
  type RunArtifactNameView,
  type RunStepNodeKind,
  type RunStepStatus,
  type RunStepView,
  type WorkflowRunEventKind,
  type WorkflowRunSse,
} from './worker-protocol.js';
import { SavedWorkflowStore } from '../modes/workflow/dwf/store.js';
import { runDwfScript, compileDwfScript, DwfCompileError, type DwfHostPorts } from '../modes/workflow/dwf/runtime.js';
import { Journal, type JournalRecord, type JournalSink } from '../modes/workflow/journal.js';
import {
  runGuiNode,
  type GuiNodeOutcome,
  type GuiRunPorts,
} from '../modes/workflow/gui-runner.js';
import {
  MemoryArtifactStore,
  FsArtifactStore,
  type ArtifactStore,
} from '../modes/workflow/gui-artifacts.js';
import { BudgetLedger, type WorkflowHost } from '../modes/workflow/host.js';
import { openRunLog, type RunLog } from '../modes/workflow/run-log.js';
import type { SavedWorkflowArgDeclaration } from '../modes/workflow/dwf/contracts.js';
import { workflowRunDb } from '../ipc/db-client.js';
import { createBuiltinRegistry } from '../tool/builtin.js';
import { SUBAGENT_TOOL_NAME } from '../tool/SubagentTool/constants.js';
import { getAgentDefinitions } from '../tool/SubagentTool/index.js';
import type { ToolUseContext } from '../types.js';
import { createIpcGuiBackend, type ComputerUseRequest } from './gui-backend.js';
import { runBrowserWithExtensionBackend } from './browser-backend.js';

// ─── deps (built by agent-process-entry where the worker closures live) ───

export interface WorkflowRunnerLlmConfig {
  apiKey: string;
  baseURL?: string;
  provider: 'anthropic' | 'openai' | 'ollama';
  model: string;
  authStyle?: 'api_key' | 'auth_token';
}

// ─── transport: where the run row lives and where progress goes (plan 560 D3) ───

export interface WorkflowRunCreateRequest {
  id: string;
  workflowName: string;
  status?: string;
  triggerKind?: string | null;
  params?: Record<string, unknown>;
  /** Plan 560 run anchoring. */
  origin?: 'library' | 'session' | 'agent' | 'cron';
  scope?: 'project' | 'global' | null;
  projectDir?: string | null;
  parentSessionId?: string | null;
}

/** Frozen definition the run started from (audit trail + future resume). */
export interface WorkflowDefinitionSnapshot {
  runId: string;
  definition: unknown;
  nodeStack?: Array<{ nodeId: string; status: string; output?: unknown }>;
}

/** One published artifact as the runner reports it upward. */
export interface WorkflowArtifactDescriptor {
  id: string;
  name: string;
  contentType: string;
  bytes: number;
  /** Path relative to the run's artifact root. */
  relPath: string;
}

/** Terminal outcome of a run (plan 560 §5.3 `workflow:finished`). */
export interface WorkflowRunTerminal {
  status: string;
  /** Failure / cancellation detail (also lands in `pause_message`). */
  message?: string;
  summary?: string | null;
  artifacts?: WorkflowArtifactDescriptor[];
  spentTokens?: number | null;
}

/**
 * Everything the runner needs from its host *besides* the dwf ports.
 *
 * Two implementations, one executor:
 *   - **session-anchored** (`legacyTransport`, the default): the worker db
 *     bridge plus `chat:workflow_run` frames on the anchored session — the
 *     pre-560 behaviour, unchanged.
 *   - **run-anchored** (plan 560, `role === 'workflow-runtime'`): main creates
 *     the row and the snapshot *before* the process spawns, so `createRun` /
 *     `saveSnapshot` / `emit` are no-ops and the real work rides
 *     `appendJournal` / `finishRun` as IPC frames. main stays the only writer
 *     (D3), which is why the child needs no database at all.
 *
 * `finishRun` is deliberately separate from `emit`: the run-anchored path
 * emits no session frames, so a terminal state that only travelled on the
 * progress channel would be lost.
 */
export interface WorkflowRunnerTransport {
  /** Persist the run row. No-op on the run-anchored path. */
  createRun(input: WorkflowRunCreateRequest): Promise<void>;
  /** Freeze the definition. On the run-anchored path this rides `workflow:ready`. */
  saveSnapshot(snapshot: WorkflowDefinitionSnapshot): Promise<void>;
  /** Durable append of one journal record. */
  appendJournal(runId: string, record: JournalRecord): void;
  /** Terminal write — always delivered, even where `emit` is a no-op. */
  finishRun(runId: string, outcome: WorkflowRunTerminal): Promise<void>;
  /** Session-anchored progress frame; a no-op on the run-anchored path. */
  emit(event: WorkflowRunEventKind, run: WorkflowRunSse): void;
}

export interface WorkflowRunnerDeps {
  sessionId: string;
  /** Sends one raw worker stdout JSON frame (threads into sendToMain). */
  emit: (msg: unknown) => void;
  /**
   * The worker's interactive permission handler (chat:permission pipeline).
   * The same closure the chat turn uses — approvals render as a normal ask
   * card in the anchored session and resolve via permission:resolve.
   */
  requestPermission: (request: {
    id: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    expiresAt: number;
  }) => Promise<'allow' | 'deny'>;
  /**
   * Plan 565 Phase D: one-shot read of the answers stored by
   * `permission:resolve` for an AskUserQuestion-shaped request. Bound only on
   * paths whose worker owns the pendingAnswers map (agent-process-entry); the
   * run-anchored child may omit it — `wf.ask` then reports the miss honestly.
   */
  takePendingAnswer?: (permissionId: string) => Record<string, string> | undefined;
  /** LLM config captured from the worker's init (agent calls inherit it). */
  llm: WorkflowRunnerLlmConfig;
  /** Default execution cwd — overridden per-run by `req.projectDir`. */
  workingDirectory: string;
  /**
   * Persistence + progress port. Absent → the legacy worker-db bridge, so
   * every pre-560 caller keeps working untouched.
   */
  transport?: WorkflowRunnerTransport;
  /**
   * Artifact sink (plan 560 D6). Absent → `wf.publish` only writes a journal
   * record, which is the pre-560 behaviour. The run-anchored path binds this
   * to the per-run artifact directory so the bytes land on disk and the
   * returned descriptor reaches the run card.
   */
  publishArtifact?: (
    name: string,
    content: unknown,
    contentType: string,
  ) => WorkflowArtifactDescriptor | undefined | Promise<WorkflowArtifactDescriptor | undefined>;
  /**
   * Worker→main computer-use RPC (plan 556 Phase 4). Present → `wf.gui`
   * executes through the real DesktopBackend dispatcher; absent → wf.gui
   * keeps failing loudly instead of silently doing nothing.
   */
  computerUseRequest?: ComputerUseRequest;
  /**
   * Sink for gui capture screenshots. Absent → an in-memory store, which
   * keeps journal refs resolvable for the lifetime of the run only. The
   * run-anchored path binds the FsArtifactStore rooted at the run
   * artifacts directory so captures survive the process.
   */
  guiArtifactStore?: ArtifactStore;
}

export interface WorkflowLaunchRequest {
  runId: string;
  workflowName: string;
  /** Script args; declared defaults are applied on top. */
  params?: Record<string, unknown>;
  /** Project scope root for saved-workflow resolution. */
  projectDir?: string;
  /**
   * Which anchor this run belongs to (plan 560 D1). Defaults to `library` —
   * the run-anchored path — because that is what a caller who says nothing
   * about sessions means. The session-anchored caller states `session`.
   */
  origin?: 'library' | 'session' | 'agent' | 'cron';
  /** Only meaningful for `agent` / `session` origins. */
  parentSessionId?: string | null;
  /**
   * Plan 565 Phase A: resume the replay cache from a prior run. The prior
   * run's journal seeds this run's cache before the script executes, so every
   * unchanged call (same call order + same payload → same nodeId + reqHash)
   * replays instantly instead of re-paying; changed/new nodes re-execute.
   * The prior run is NOT touched — this is a fresh run row that starts from
   * its predecessor's results.
   */
  resumeFromRunId?: string;
  /**
   * Plan 568: run-level agent model override — `wf.agent` calls without an
   * explicit model run on this (ZCode subagentModel parity). Absent =
   * inherit the worker's main model.
   */
  model?: string;
}

// ─── journal sink: memory + write-through to the transport ───

/**
 * The Journal cache must rebuild synchronously from the sink (constructor
 * contract), so the durable copy is write-through: every appended record is
 * handed to the transport (fire-and-forget) while the in-memory array stays
 * the read side. Fresh runs start empty; a resume run (plan 565 Phase A)
 * seeds the read side from the prior run's journal BEFORE constructing the
 * Journal — seeded records are never re-appended to the new run's event
 * stream, they only rebuild the replay cache.
 */
class TransportJournalSink implements JournalSink {
  private readonly records: JournalRecord[] = [];

  constructor(
    private readonly transport: WorkflowRunnerTransport,
    private readonly runId: string,
    seed?: JournalRecord[],
  ) {
    if (seed) this.records.push(...seed);
  }

  append(record: JournalRecord): void {
    this.records.push(record);
    try {
      this.transport.appendJournal(this.runId, record);
    } catch {
      // Evidence persistence is best-effort — a failed append must never
      // break the run itself.
    }
  }

  readAll(): JournalRecord[] {
    return [...this.records];
  }
}

/**
 * The pre-560 transport: the worker db bridge plus session-anchored
 * `chat:workflow_run` frames. It is the default, so the session-anchored
 * path's observable behaviour is exactly what it was before this refactor.
 */
export function legacyTransport(deps: WorkflowRunnerDeps): WorkflowRunnerTransport {
  return {
    async createRun(input) {
      await workflowRunDb.create({
        ...input,
        // This transport *is* the session anchor, so it stamps the origin
        // itself rather than trusting the caller (plan 560 D1). A library run
        // never reaches here — it uses the run-anchored transport.
        origin: 'session',
      });
    },

    async saveSnapshot(snapshot) {
      await workflowRunDb.saveSnapshot({
        runId: snapshot.runId,
        definition: snapshot.definition,
        nodeStack: snapshot.nodeStack ?? [],
        // The journal is not part of the blob any more (plan 560 migration 31).
        journal: [],
      });
    },

    appendJournal(runId, record) {
      void workflowRunDb.appendJournal(runId, record).catch(() => {
        // Evidence persistence is best-effort — a failed append must never
        // break the run itself.
      });
    },

    async finishRun(runId, outcome) {
      await workflowRunDb.finish(runId, {
        status: outcome.status,
        ...(outcome.summary !== undefined ? { summary: outcome.summary } : {}),
        ...(outcome.artifacts !== undefined ? { artifacts: outcome.artifacts } : {}),
        ...(outcome.spentTokens !== undefined ? { spentTokens: outcome.spentTokens } : {}),
      });
      if (outcome.message !== undefined) {
        // The failure text belongs on `pause_message`, which only updateStatus
        // writes.
        await workflowRunDb.updateStatus(runId, outcome.status, outcome.message);
      }
    },

    emit(event, run) {
      deps.emit(buildWorkflowRunEvent(deps.sessionId, event, run));
    },
  };
}

// ─── arg defaults ───

/** Declared defaults fill absent params (§ run options contract). */
export function applyArgDefaults(
  declared: Record<string, SavedWorkflowArgDeclaration> | undefined,
  params: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(params ?? {}) };
  for (const [name, decl] of Object.entries(declared ?? {})) {
    if (out[name] === undefined && decl.default !== undefined) {
      out[name] = decl.default;
    }
  }
  return out;
}

/** Missing required args are a launch failure, not a mid-run one. */
export function findMissingRequiredArgs(
  declared: Record<string, SavedWorkflowArgDeclaration> | undefined,
  args: Record<string, unknown>,
): string[] {
  const missing: string[] = [];
  for (const [name, decl] of Object.entries(declared ?? {})) {
    if (decl.required === true && args[name] === undefined) missing.push(name);
  }
  return missing;
}

/**
 * The publishable name of an `artifact` journal record. `wf.publish` writes
 * `inputSummary: name` and `result: { name, contentType, content }` — prefer
 * the summary, fall back to the payload, and never guess.
 */
function readArtifactName(result: unknown): string | undefined {
  if (result && typeof result === 'object' && typeof (result as Record<string, unknown>).name === 'string') {
    const name = (result as Record<string, unknown>).name as string;
    return name.length > 0 ? name : undefined;
  }
  return undefined;
}

// ─── production host ports ───

function buildToolUseContext(
  deps: WorkflowRunnerDeps,
  registry: ReturnType<typeof createBuiltinRegistry>,
  cwd: string,
): ToolUseContext {
  const definitions = getAgentDefinitions();
  let appState: Record<string, unknown> = {};
  return {
    toolUseId: randomUUID(),
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: (updater) => {
      appState = updater(appState) as Record<string, unknown>;
    },
    options: {
      recentImageAttachments: [],
      tools: registry.getAllTools(),
      commands: [],
      mainLoopModel: deps.llm.model,
      mcpClients: [],
      apiKey: deps.llm.apiKey,
      baseURL: deps.llm.baseURL,
      authStyle: deps.llm.authStyle,
      provider: deps.llm.provider,
      sessionId: deps.sessionId,
      agentProfileId: null,
      // The launch dialog's directory, not the worker's default (plan 560
      // §7.5) — `wf.agent` sub-agents inherit it as their working directory.
      workingDirectory: cwd,
      agentDefinitions: {
        activeAgents: definitions,
        allAgents: definitions,
      },
    },
  };
}

/**
 * Workflow ask (plan 565 Phase D): route a free-text question through the
 * EXISTING interactive permission pipeline as an AskUserQuestion-shaped
 * request — the renderer already renders that card with options plus a free
 * text field, and the answer returns via permission:resolve's
 * updatedInput.answers → storePendingAnswer. No new protocol frame. The
 * stored answer is one-shot (takePendingAnswer), exactly like the tool's own
 * Phase-2 retry. Deny / 5-minute pipeline timeout → no answer (null); the
 * caller (wf.ask / the on_stuck ladders) decides what a silent session means.
 */
async function runWorkflowAsk(
  deps: WorkflowRunnerDeps,
  question: string,
): Promise<{ answer: string | null }> {
  const id = randomUUID();
  const decision = await deps.requestPermission({
    id,
    toolName: 'AskUserQuestion',
    toolInput: {
      questions: [
        {
          question,
          header: 'Workflow',
          multiSelect: false,
          options: [
            { label: 'Retry', description: 'Re-run the failed step / node once' },
            { label: 'Skip', description: 'Skip it and continue the run' },
          ],
        },
      ],
    },
    expiresAt: Date.now() + 600_000,
  });
  if (decision !== 'allow') return { answer: null };
  const answers = deps.takePendingAnswer?.(id);
  const answer = answers
    ? Object.values(answers)
        .filter((v) => typeof v === 'string' && v.trim().length > 0)
        .join(' ')
        .trim()
    : '';
  return { answer: answer.length > 0 ? answer : null };
}

function buildHostPorts(
  deps: WorkflowRunnerDeps,
  cwd: string,
  gui: { journal: Journal; runId: string },
  onArtifact?: (descriptor: WorkflowArtifactDescriptor) => void,
): DwfHostPorts {
  const registry = createBuiltinRegistry();
  const ctx = buildToolUseContext(deps, registry, cwd);
  // One extension session tab per wf.browser call (plan 564 D2).
  let browserSeq = 0;

  return {
    async publishArtifact(name, content, contentType) {
      // No sink bound (the pre-560 session path) → `wf.publish` only writes
      // its journal record, which is exactly what it did before.
      const sink = deps.publishArtifact;
      if (!sink) return;
      const descriptor = await sink(name, content, contentType);
      if (descriptor) onArtifact?.(descriptor);
      // Plan 568: the descriptor (with its store `ref`) flows back so the dwf
      // runtime journals it — the renderer's artifact chips click through it.
      return descriptor;
    },

    async runTool(tool, input) {
      const res = await registry.execute(tool, (input ?? {}) as Record<string, unknown>, cwd, ctx);
      if (!res) {
        return { ok: false, error: `unknown tool "${tool}"` };
      }
      if (res.error) {
        return {
          ok: false,
          error: res.result,
          exitCode: typeof res.metadata?.exitCode === 'number' ? res.metadata.exitCode : null,
        };
      }
      return {
        ok: true,
        output: res.result,
        exitCode: typeof res.metadata?.exitCode === 'number' ? res.metadata.exitCode : null,
      };
    },

    async runAgent(spec) {
      // Foreground sub-agent through the SubagentTool executor: sub-session
      // creation (plan 504 lineage), renderer progress events and session
      // status bookkeeping all come along for free.
      const res = await registry.execute(
        SUBAGENT_TOOL_NAME,
        {
          prompt: spec.prompt,
          subagent_type: spec.agent,
          run_in_background: false,
          ...(spec.model !== undefined ? { model: spec.model } : {}),
        },
        cwd,
        ctx,
      );
      if (!res) {
        return { ok: false, error: `subagent tool "${SUBAGENT_TOOL_NAME}" not registered` };
      }
      let parsed: { error?: string; content?: unknown; sessionId?: string } = {};
      try {
        parsed = JSON.parse(res.result) as typeof parsed;
      } catch {
        parsed = { content: res.result };
      }
      if (res.error || parsed.error) {
        // Plan 568: a failed agent may still have created its sub-session
        // (schema mismatch, mid-run error) — carry the id so the journal's
        // failed record links the watch pane.
        return {
          ok: false,
          error: parsed.error ?? res.result,
          ...(parsed.sessionId !== undefined ? { childSessionId: parsed.sessionId } : {}),
        };
      }
      return {
        ok: true,
        output: parsed.content ?? '',
        childSessionId: parsed.sessionId,
      };
    },

    async runGui(spec, annotation) {
      // RPA steps (plan 556 Phase 4): execute through runGuiNode with the
      // real computer-use backend port. Without the RPC bridge the node
      // still fails loudly — a silent no-op would corrupt recorder
      // workflows that assume their steps happened.
      if (!deps.computerUseRequest) {
        const outcome: GuiNodeOutcome = {
          status: 'failed',
          errorClass: 'tool_missing',
          error:
            'gui runtime has no computer-use bridge in this worker — set the [computer_use] access policy / check the main-process dispatcher',
        };
        return outcome;
      }

      // Best-effort foreground of the recorded app. The dispatcher's
      // per-action access policy still applies to every step, so this
      // cannot bypass anything — it only raises the window.
      try {
        await deps.computerUseRequest(
          'focus_app',
          { processName: spec.target_app, raise: true },
          { timeout: 10_000 },
        );
      } catch {
        // Focus is advisory; the on_stuck ladder owns real failures.
      }

      const ports: GuiRunPorts = {
        backend: createIpcGuiBackend(deps.computerUseRequest),
        artifacts: deps.guiArtifactStore ?? new MemoryArtifactStore(),
        // on_stuck:'agent' escalation fallback (plan 565 Phase D) — see
        // enterLadder in gui-runner.ts.
        ...(deps.takePendingAnswer
          ? { ask: (question: string) => runWorkflowAsk(deps, question).then((r) => r.answer) }
          : {}),
      };

      // Minimal WorkflowHost for the needs_confirmation gate — approvals
      // ride the same interactive pipeline as `wf.approve`.
      const host: WorkflowHost = {
        async runAgent() {
          throw new Error('runAgent is not available on the gui node path');
        },
        async runTool() {
          throw new Error('runTool is not available on the gui node path');
        },
        async requestApproval(approvalSpec) {
          const decision = await deps.requestPermission({
            id: randomUUID(),
            toolName: 'workflow_approval',
            toolInput: { prompt: approvalSpec.prompt },
            expiresAt: Date.now() + (approvalSpec.timeoutMs ?? 300_000),
          });
          return { decision: decision === 'allow' ? 'approve' : 'deny' };
        },
      };

      return runGuiNode({
        nodeId: `gui:${spec.target_app}`,
        gui: spec,
        // dwf scripts interpolate args as plain JS (the script body closes
        // over `args`), so the ${expr} scope stays empty here.
        scope: { resolve: () => undefined },
        host,
        journal: gui.journal,
        budget: new BudgetLedger(),
        ports,
        approvalMode: 'await',
        runId: gui.runId,
        ...(annotation !== undefined ? { annotation } : {}),
      });
    },

    async runBrowser(spec) {
      // Browser-extension steps (plan 564): the daemon is a localhost HTTP
      // service, so the worker talks to it DIRECTLY — unlike computer-use,
      // no worker→main RPC type is needed. Without the extension online the
      // node fails loudly (on_stuck ladder owns skip semantics).
      return runBrowserWithExtensionBackend(`wf-${gui.runId}-${browserSeq++}`, spec, {
        runId: gui.runId,
        ...(deps.guiArtifactStore ? { artifacts: deps.guiArtifactStore } : {}),
        // on_stuck:'agent' escalation (plan 565 Phase D): the ladder asks the
        // anchored session whether to retry; absent port → fail-as-before.
        ...(deps.takePendingAnswer
          ? {
              ask: (question: string) =>
                runWorkflowAsk(deps, question).then((r) => r.answer),
            }
          : {}),
      });
    },

    async runAsk(question) {
      return runWorkflowAsk(deps, question);
    },

    async requestApproval(spec) {
      // Rides the interactive chat:permission pipeline (same as tool asks).
      // v1 cap: the pipeline's own 5-minute deny timeout applies; a timeout
      // reaches the script as 'deny' → DwfApprovalDeniedError('denied').
      const decision = await deps.requestPermission({
        id: randomUUID(),
        toolName: 'workflow_approval',
        toolInput: { prompt: spec.prompt },
        expiresAt: Date.now() + (spec.timeoutMs ?? 300_000),
      });
      return { decision: decision === 'allow' ? 'approve' : 'deny' };
    },
  };
}

// ─── launch ───

/**
 * Resolve + execute a saved dwf workflow, emitting
 * `start` → `progress`* → `done`/`error` frames. Resolves when the terminal
 * frame has been emitted. `signal` aborts between journal records and lands
 * a cancelled terminal.
 */
export async function launchSavedWorkflow(
  deps: WorkflowRunnerDeps,
  req: WorkflowLaunchRequest,
  signal?: AbortSignal,
): Promise<void> {
  const transport = deps.transport ?? legacyTransport(deps);
  const startedAt = Date.now();
  // Per-run text log (best-effort, no-op on fs failure): launch args, every
  // journal record in seq order and the terminal error land in
  // ~/.duya/workflow-logs/<workflow>-<runId>.log for post-mortem analysis.
  const runLog: RunLog = openRunLog(fs, req.runId, req.workflowName, {
    origin: req.origin ?? 'library',
    ...(req.projectDir !== undefined ? { projectDir: req.projectDir } : {}),
  });
  const frame = (event: WorkflowRunEventKind, run: WorkflowRunSse): void => {
    transport.emit(event, run);
  };

  // Accumulated per-step view, grown as journal records land and carried on
  // every later frame so a failing run still shows the steps that did run.
  // `phase` records ride the same list as nodeKind:'phase' dividers — the
  // renderer cuts stage columns at them (§6.2); `artifact` records become
  // name-only entries in `artifactsView` instead (they are not work).
  const steps: RunStepView[] = [];
  const artifactsView: RunArtifactNameView[] = [];
  const stats = { tokens: 0, subagents: 0 };
  const artifacts: WorkflowArtifactDescriptor[] = [];

  /**
   * Terminal failure. `finishRun` is the durable half and fires even where
   * `emit` is a no-op (the run-anchored path), so a launch that dies before
   * its first journal record still lands a terminal status instead of leaving
   * the row `active` forever.
   */
  const failFrame = async (error: string, status: 'failed' | 'cancelled' = 'failed'): Promise<void> => {
    runLog.line('error', `run ${status}: ${error}`);
    try {
      await transport.finishRun(req.runId, {
        status,
        message: error,
        ...(stats.tokens > 0 ? { spentTokens: stats.tokens } : {}),
      });
    } catch {
      // Terminal status is best-effort; the frame still goes out.
    }
    frame('error', {
      runId: req.runId,
      workflowName: req.workflowName,
      status,
      startedAt,
      finishedAt: Date.now(),
      steps,
      ...(artifactsView.length > 0 ? { artifacts: artifactsView } : {}),
      error,
      stoppedReason: status === 'cancelled' ? 'cancelled' : 'run failed',
    });
    runLog.close();
  };

  // 1. Resolve the saved definition (project scope shadows global).
  const store = new SavedWorkflowStore();
  const cwd = req.projectDir ?? deps.workingDirectory;
  const resolved = store.resolve(cwd, req.workflowName);
  if (!resolved.ok) {
    const detail =
      resolved.reason === 'not_found'
        ? `workflow "${req.workflowName}" not found in ${cwd} (or ~/.duya/workflows)`
        : resolved.reason === 'invalid_name'
          ? resolved.detail
          : `${resolved.reason}: ${resolved.detail}`;
    await failFrame(detail);
    return;
  }

  // 2. Merge declared arg defaults + validate required args up front.
  const args = applyArgDefaults(resolved.meta.args, req.params);
  runLog.line(
    'info',
    `launch workflow="${resolved.name}" scope=${resolved.scope} cwd=${cwd} args=${JSON.stringify(args)}`,
  );
  const missing = findMissingRequiredArgs(resolved.meta.args, args);
  if (missing.length > 0) {
    await failFrame(`missing required args: ${missing.join(', ')}`);
    return;
  }

  // 2.5 Compile gate (plan 565 Phase B): syntax/shape errors fail fast HERE,
  //     before any run row or journal record exists — the same "编不过不启动"
  //     semantics ZCode applies at CreateWorkflow. Without this, a broken
  //     script surfaced only when the runtime's own esbuild transform blew up
  //     mid-run, leaving a failed row and partial journal behind.
  try {
    await compileDwfScript(resolved.script);
  } catch (err) {
    const detail =
      err instanceof DwfCompileError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    await failFrame(`script compile failed: ${detail}`);
    return;
  }

  // 3. Run row + snapshot seed. On the run-anchored path main created the row
  //    (and will store the definition from the `ready` frame), so both calls
  //    are no-ops there.
  try {
    await transport.createRun({
      id: req.runId,
      workflowName: req.workflowName,
      status: 'active',
      triggerKind: 'manual',
      params: args,
      origin: req.origin ?? 'library',
      scope: resolved.scope,
      projectDir: cwd,
      parentSessionId: req.parentSessionId ?? null,
    });
    await transport.saveSnapshot({
      runId: req.runId,
      definition: {
        name: resolved.name,
        path: resolved.path,
        scope: resolved.scope,
        description: resolved.meta.description,
        args: resolved.meta.args ?? {},
      },
      nodeStack: [],
    });
  } catch (err) {
    await failFrame(`failed to create run row: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // 4. Journal + live progress tap. Journal.append persists via the sink BEFORE
  //    the listener fires, so durability always precedes progress. A resume run
  //    (plan 565 Phase A) loads the prior run's journal first and seeds the
  //    sink's read side so the constructor rebuilds the replay cache — the
  //    prior run's records are cache keys only, never re-persisted here.
  let resumeSeed: JournalRecord[] | undefined;
  if (req.resumeFromRunId) {
    try {
      const raw = await workflowRunDb.loadJournal(req.resumeFromRunId);
      // Shape guard: only well-formed records with a numeric seq may seed the
      // cache — a corrupt or foreign payload degrades to a cold start, never
      // to a crash or a poisoned cache.
      resumeSeed = (Array.isArray(raw) ? raw : []).filter(
        (r): r is JournalRecord =>
          !!r && typeof r === 'object' && typeof (r as JournalRecord).seq === 'number',
      );
      runLog.line(
        'info',
        `resume from ${req.resumeFromRunId}: ${resumeSeed.length} seeded journal records`,
      );
    } catch (err) {
      // Seeding is best-effort: a missing/unreadable predecessor means the
      // run simply pays full price, which is exactly a fresh launch.
      runLog.line(
        'warn',
        `resume seed unavailable (${err instanceof Error ? err.message : String(err)}) — starting cold`,
      );
    }
  }
  const journal = new Journal(new TransportJournalSink(transport, req.runId, resumeSeed));

  // Fold each reaching step record into the shared step view: match by node id,
  // flip running→success/failed in place, else append. Honest — only materialize
  // what the journal actually observed.
  const upsertStep = (record: Omit<JournalRecord, 'nodeKind'> & { nodeKind?: RunStepNodeKind }): void => {
    const status: RunStepStatus | undefined =
      record.status === 'succeeded'
        ? 'success'
        : record.status === 'failed'
          ? 'failed'
          : record.status === 'running'
            ? 'running'
            : undefined;
    if (status === undefined) return;
    const existing = steps.find((s) => s.id === record.nodeId);
    if (existing !== undefined) {
      existing.status = status;
      if (status !== 'running') existing.finishedAt = record.atMs;
      // Plan 568: the child-session link lands with whichever record carries
      // it (a failed agent's session id arrives on the failed record).
      if (record.childSessionId !== undefined) existing.childSessionId = record.childSessionId;
    } else {
      steps.push({
        id: record.nodeId,
        label: record.action ?? record.nodeId,
        status,
        ...(record.nodeKind !== undefined ? { nodeKind: record.nodeKind } : {}),
        ...(record.childSessionId !== undefined ? { childSessionId: record.childSessionId } : {}),
        startedAt: status === 'running' ? record.atMs : undefined,
        finishedAt: status !== 'running' ? record.atMs : undefined,
      });
    }
  };

  journal.listener = (record) => {
    runLog.record(record);
    if (record.usage) stats.tokens += record.usage.inputTokens + record.usage.outputTokens;
    if (record.nodeKind === 'agent' && record.status === 'succeeded') stats.subagents++;
    if (record.kind === 'artifact') {
      // wf.publish — an output, not a step: fold the name into the artifact
      // chips and let the card show it on the terminal receipt. The ref rides
      // along so the renderer can resolve the bytes to a previewable path.
      const name = record.inputSummary ?? readArtifactName(record.result);
      const ref =
        record.result && typeof record.result === 'object' && typeof (record.result as { ref?: unknown }).ref === 'string'
          ? (record.result as { ref: string }).ref
          : undefined;
      if (name && !artifactsView.some((a) => a.name === name)) {
        artifactsView.push({ name, ...(ref !== undefined ? { ref } : {}) });
      }
    }
    if (
      record.kind === 'node_result' ||
      record.kind === 'decision' ||
      record.kind === 'approval' ||
      record.kind === 'phase'
    ) {
      // The journal types a phase record as nodeKind:'noop' (it does no work);
      // on the wire the divider is its own kind so the renderer can cut stage
      // columns without re-deriving it from the nodeId string.
      upsertStep(record.kind === 'phase' ? { ...record, nodeKind: 'phase' } : record);
      frame('progress', {
        runId: req.runId,
        workflowName: req.workflowName,
        status: 'active',
        phase: record.action ?? record.nodeId,
        startedAt,
        steps,
        ...(artifactsView.length > 0 ? { artifacts: artifactsView } : {}),
        tokens: stats.tokens > 0 ? stats.tokens : undefined,
        subagents: stats.subagents > 0 ? stats.subagents : undefined,
      });
    }
  };

  frame('start', {
    runId: req.runId,
    workflowName: req.workflowName,
    status: 'active',
    phase: 'starting',
    startedAt,
  });

  // 5. Execute the script in the dwf sandbox with production ports bound to the
  //    launch directory, collecting artifacts into the terminal outcome.
  const ports = buildHostPorts(
    deps,
    cwd,
    { journal, runId: req.runId },
    (descriptor) => artifacts.push(descriptor),
  );
  try {
    await runDwfScript(resolved.script, ports, {
      runId: req.runId,
      journal,
      args,
      ...(req.model !== undefined ? { agentModel: req.model } : {}),
    });
    await transport.finishRun(req.runId, {
      status: 'complete',
      ...(artifacts.length > 0 ? { artifacts } : {}),
      ...(stats.tokens > 0 ? { spentTokens: stats.tokens } : {}),
    });
    runLog.line(
      'info',
      `run complete: steps=${steps.length} artifacts=${artifacts.length} tokens=${stats.tokens} duration=${Date.now() - startedAt}ms`,
    );
    frame('done', {
      runId: req.runId,
      workflowName: req.workflowName,
      status: 'complete',
      startedAt,
      finishedAt: Date.now(),
      steps,
      ...(artifactsView.length > 0 ? { artifacts: artifactsView } : {}),
      tokens: stats.tokens > 0 ? stats.tokens : undefined,
      subagents: stats.subagents > 0 ? stats.subagents : undefined,
    });
    runLog.close();
  } catch (err) {
    const cancelled = signal?.aborted === true;
    const message = err instanceof Error ? err.message : String(err);
    await failFrame(message, cancelled ? 'cancelled' : 'failed');
  }
}
