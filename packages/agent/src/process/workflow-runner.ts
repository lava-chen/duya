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
 *
 * Resume is NOT wired in this cut: every launch is a fresh run. The journal
 * is persisted record-by-record (workflowRun:appendJournal) for console
 * evidence and for a future cache-hit resume — the §6.4 economics need an
 * async journal load which the sync JournalSink cannot express yet.
 */

import { randomUUID } from 'node:crypto';

import {
  buildWorkflowRunEvent,
  type RunStepStatus,
  type RunStepView,
  type WorkflowRunEventKind,
  type WorkflowRunSse,
} from './worker-protocol.js';
import { SavedWorkflowStore } from '../modes/workflow/dwf/store.js';
import { runDwfScript, type DwfHostPorts } from '../modes/workflow/dwf/runtime.js';
import { Journal, type JournalRecord, type JournalSink } from '../modes/workflow/journal.js';
import type { GuiNodeOutcome } from '../modes/workflow/gui-runner.js';
import type { SavedWorkflowArgDeclaration } from '../modes/workflow/dwf/contracts.js';
import { workflowRunDb } from '../ipc/db-client.js';
import { createBuiltinRegistry } from '../tool/builtin.js';
import { SUBAGENT_TOOL_NAME } from '../tool/SubagentTool/constants.js';
import { getAgentDefinitions } from '../tool/SubagentTool/index.js';
import type { ToolUseContext } from '../types.js';

// ─── deps (built by agent-process-entry where the worker closures live) ───

export interface WorkflowRunnerLlmConfig {
  apiKey: string;
  baseURL?: string;
  provider: 'anthropic' | 'openai' | 'ollama';
  model: string;
  authStyle?: 'api_key' | 'auth_token';
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
  /** LLM config captured from the worker's init (agent calls inherit it). */
  llm: WorkflowRunnerLlmConfig;
  /** Default execution cwd — overridden per-run by `req.projectDir`. */
  workingDirectory: string;
}

export interface WorkflowLaunchRequest {
  runId: string;
  workflowName: string;
  /** Script args; declared defaults are applied on top. */
  params?: Record<string, unknown>;
  /** Project scope root for saved-workflow resolution. */
  projectDir?: string;
}

// ─── journal sink: memory + write-through to core-db ───

/**
 * The Journal cache must rebuild synchronously from the sink (constructor
 * contract), so the durable copy is write-through: every appended record is
 * pushed to core-db via the worker db bridge (fire-and-forget) while the
 * in-memory array stays the read side. Fresh runs start empty; a future
 * resume flow seeds a sink from `workflowRunDb.loadJournal` before
 * constructing the Journal.
 */
class DbWriteThroughJournalSink implements JournalSink {
  private readonly records: JournalRecord[] = [];

  constructor(private readonly runId: string) {}

  append(record: JournalRecord): void {
    this.records.push(record);
    void workflowRunDb.appendJournal(this.runId, record).catch(() => {
      // Evidence persistence is best-effort — a failed append must never
      // break the run itself.
    });
  }

  readAll(): JournalRecord[] {
    return [...this.records];
  }
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

// ─── production host ports ───

function buildToolUseContext(deps: WorkflowRunnerDeps, registry: ReturnType<typeof createBuiltinRegistry>): ToolUseContext {
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
      workingDirectory: deps.workingDirectory,
      agentDefinitions: {
        activeAgents: definitions,
        allAgents: definitions,
      },
    },
  };
}

function buildHostPorts(deps: WorkflowRunnerDeps): DwfHostPorts {
  const registry = createBuiltinRegistry();
  const ctx = buildToolUseContext(deps, registry);

  return {
    async runTool(tool, input) {
      const res = await registry.execute(tool, (input ?? {}) as Record<string, unknown>, deps.workingDirectory, ctx);
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
        deps.workingDirectory,
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
        return { ok: false, error: parsed.error ?? res.result };
      }
      return {
        ok: true,
        output: parsed.content ?? '',
        childSessionId: parsed.sessionId,
      };
    },

    async runGui() {
      // RPA steps need the recorder/gui bridge which is not worker-wired in
      // v1 — wf.gui fails loudly instead of silently doing nothing.
      const outcome: GuiNodeOutcome = {
        status: 'failed',
        error: 'gui runtime is not wired into the worker yet',
      };
      return outcome;
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
  const { sessionId, emit } = deps;
  const startedAt = Date.now();
  const frame = (event: WorkflowRunEventKind, run: WorkflowRunSse): void => {
    emit(buildWorkflowRunEvent(sessionId, event, run));
  };

  // Accumulated per-step view, grown as journal records land and carried on
  // every later frame so a failing run still shows the steps that did run.
  const steps: RunStepView[] = [];
  const failFrame = (error: string, status: 'failed' | 'cancelled' = 'failed'): void => {
    frame('error', {
      runId: req.runId,
      workflowName: req.workflowName,
      status,
      startedAt,
      finishedAt: Date.now(),
      steps,
      error,
      stoppedReason: status === 'cancelled' ? 'cancelled' : 'run failed',
    });
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
    failFrame(detail);
    return;
  }

  // 2. Merge declared arg defaults + validate required args up front.
  const args = applyArgDefaults(resolved.meta.args, req.params);
  const missing = findMissingRequiredArgs(resolved.meta.args, args);
  if (missing.length > 0) {
    failFrame(`missing required args: ${missing.join(', ')}`);
    return;
  }

  // 3. Run row + snapshot seed (appendJournal needs a blob to exist).
  try {
    await workflowRunDb.create({
      id: req.runId,
      workflowName: req.workflowName,
      status: 'active',
      triggerKind: 'manual',
      params: args,
    });
    await workflowRunDb.saveSnapshot({
      runId: req.runId,
      definition: {
        name: resolved.name,
        path: resolved.path,
        scope: resolved.scope,
        description: resolved.meta.description,
        args: resolved.meta.args ?? {},
      },
      nodeStack: [],
      journal: [],
    });
  } catch (err) {
    failFrame(`failed to create run row: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // 4. Journal + live SSE tap. Journal.append persists via the sink BEFORE
  //    the listener fires, so durability always precedes progress.
  const journal = new Journal(new DbWriteThroughJournalSink(req.runId));
  const stats = { tokens: 0, subagents: 0 };

  // Fold each reaching step record into the shared step view: match by node id,
  // flip running→success/failed in place, else append. Honest — only materialize
  // what the journal actually observed.
  const upsertStep = (record: JournalRecord): void => {
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
    } else {
      steps.push({
        id: record.nodeId,
        label: record.action ?? record.nodeId,
        status,
        startedAt: status === 'running' ? record.atMs : undefined,
        finishedAt: status !== 'running' ? record.atMs : undefined,
      });
    }
  };

  journal.listener = (record) => {
    if (record.usage) stats.tokens += record.usage.inputTokens + record.usage.outputTokens;
    if (record.nodeKind === 'agent' && record.status === 'succeeded') stats.subagents++;
    if (record.kind === 'node_result' || record.kind === 'decision' || record.kind === 'approval') {
      upsertStep(record);
      frame('progress', {
        runId: req.runId,
        workflowName: req.workflowName,
        status: 'active',
        phase: record.action ?? record.nodeId,
        startedAt,
        steps,
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

  // 5. Execute the script in the dwf sandbox with production ports.
  const ports = buildHostPorts(deps);
  try {
    await runDwfScript(resolved.script, ports, {
      runId: req.runId,
      journal,
      args,
    });
    await workflowRunDb.updateStatus(req.runId, 'complete');
    frame('done', {
      runId: req.runId,
      workflowName: req.workflowName,
      status: 'complete',
      startedAt,
      finishedAt: Date.now(),
      steps,
      tokens: stats.tokens > 0 ? stats.tokens : undefined,
      subagents: stats.subagents > 0 ? stats.subagents : undefined,
    });
  } catch (err) {
    const cancelled = signal?.aborted === true;
    const message = err instanceof Error ? err.message : String(err);
    try {
      await workflowRunDb.updateStatus(req.runId, cancelled ? 'cancelled' : 'failed', message);
    } catch {
      // Terminal status is best-effort; the frame still goes out.
    }
    failFrame(message, cancelled ? 'cancelled' : 'failed');
  }
}
