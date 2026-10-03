/**
 * eval-legacy-loop.ts — E4.1's harness: the real executor, the real run layer,
 * real SQLite, and an offline PROVIDER.
 *
 * ## The chain, end to end
 *
 * ```
 *   RunOrchestrator.openRun          (apps/desktop, real)
 *     -> buildRunManifest            (control-plane/manifest-factory, real)
 *     -> dispatchControlPlaneAction  (control-plane/run-control-plane, real)
 *          -> RunStore               (db/core/run-store, real)
 *               -> better-sqlite3    (real, isolated temp file)
 *     -> createWorkerExecutionChannel.dispatch
 *          -> stdin JSON line        (the REAL worker process)
 *               -> handleChatStart   (agent-process-entry, real)
 *                    -> DuyaAgent.streamChat          (real)
 *                         -> @duya/ai Anthropic client (real)
 *                              -> HTTP to 127.0.0.1   (the offline provider)
 *   stdout JSON frames
 *     -> RunOrchestrator.observe     (real tee)
 *          -> RunController / RunSession (agent-runtime, real)
 *               -> same real RunStore, same real SQLite file
 * ```
 *
 * Every arrow is the production path. The only substituted participant is the
 * LLM provider, and it is substituted at the network boundary (a real HTTP
 * server on loopback speaking the real Anthropic Messages SSE protocol) rather
 * than by mocking an interface — which is why the real adapter's own request
 * building, SSE parsing, thinking/tool-call assembly and usage extraction all
 * run.
 *
 * ## What is NOT claimed
 *
 * `db-bridge.ts` is Electron-coupled, so the chat-session tables are answered
 * from narrow stand-ins (see `eval-legacy-worker.ts`). Every RUN fact in the
 * report therefore comes from the real `RunStore` on real SQLite; no run fact
 * comes from a stand-in. There is no renderer, no preload, and no packaged
 * Electron here, so nothing in this harness supports a desktop-boundary claim.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { manifestFingerprint } from '@duya/agent-protocol';
import { RunOrchestrator, createWorkerExecutionChannel, type ChatStartCommand, type RunTurnIntent } from '../agents/server/run-orchestrator';
import { normalizeAndObserve, type RouterDeps } from '../agents/server/router';
import { dispatchControlPlaneAction } from '../control-plane/run-control-plane';
import { RunStore } from '../db/core/run-store';
import { startOfflineProvider, type OfflineProvider, type OfflineProviderScript } from './eval-offline-provider';
import { startLegacyWorker, type LegacyWorker, type WorkerFrame } from './eval-legacy-worker';
import { redactSecrets } from './eval-redaction';

/** Repo root, resolved from this file. */
export const REPO_ROOT = fileURLToPath(new URL('../../../../..', import.meta.url));

/** The bundle the product forks. See `eval-legacy-worker.ts` for why. */
export const AGENT_BUNDLE = path.join(REPO_ROOT, 'packages', 'agent', 'bundle', 'agent-process-entry.js');

export interface EvalCaseInput {
  /** The user prompt. Travels through the run, never beside it. */
  readonly prompt: string;
  /** Provider turns. The provider does not decide the run's outcome. */
  readonly script: OfflineProviderScript;
  readonly permissionMode?: 'default' | 'auto' | 'bypassPermissions';
  /** Ceiling the run layer itself enforces. */
  readonly maxTurns?: number;
  /** Files written into the temp workspace before the turn. */
  readonly workspaceFiles?: Readonly<Record<string, string>>;
  readonly seed?: string;
  /** How long the whole turn may take before the harness gives up. */
  readonly timeoutMs?: number;
  /**
   * Corrupt the `manifestHash` the execution channel puts on `chat:start`,
   * AFTER the Control Plane pinned the real one on the run row.
   *
   * This is the R2.2 refusal path made reachable: the worker recomputes the
   * digest over the manifest it received and compares. When the two disagree,
   * the run must be REFUSED and named, and the model must never be called. The
   * corruption happens on the COMMAND, not in the store, so the run row still
   * holds the honest hash — which is what makes the disagreement detectable at
   * all.
   */
  readonly tamperManifestHash?: boolean;
}

export interface ProtocolTraceEntry {
  readonly seq: number;
  /** Which channel the frame arrived on. */
  readonly channel: 'worker_stdout' | 'run_event';
  readonly type: string;
  /** Redacted. Never the raw frame. */
  readonly detail: unknown;
}

export interface ToolAttempt {
  readonly id: unknown;
  readonly name: unknown;
  readonly input: unknown;
  readonly outcome: 'succeeded' | 'failed' | 'absent';
  readonly resultExcerpt: string;
  readonly error: boolean;
}

export interface EvalArtifacts {
  readonly manifest: unknown;
  readonly manifestHash: string;
  readonly inputRevision: string;
  /** The binding the real execution channel put on `chat:start`. */
  readonly dispatchedChatStart: unknown;
  readonly protocolTrace: readonly ProtocolTraceEntry[];
  readonly transcript: readonly unknown[];
  readonly permissionAudit: readonly unknown[];
  readonly toolAttempts: readonly ToolAttempt[];
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly frames: number };
  readonly terminal: unknown;
  readonly runEvents: readonly unknown[];
  readonly providerRequests: readonly unknown[];
  readonly workerDbCalls: readonly string[];
  /** `run:*` actions the real worker issued, in order. Empty pre-R2. */
  readonly runControlCalls: readonly string[];
  readonly metadata: EvalMetadata;
}

export interface EvalMetadata {
  readonly head: string;
  readonly agentBundle: { readonly path: string; readonly bytes: number; readonly sha256: string };
  readonly versions: Record<string, string>;
  readonly environment: { readonly platform: string; readonly node: string; readonly abi: number };
  readonly seed: string;
  readonly configuration: {
    readonly case: string;
    readonly permissionMode: string;
    readonly maxTurns: number;
    readonly provider: 'offline-anthropic-sse';
    readonly providerBaseUrlIsLoopback: boolean;
    readonly providerTurns: number;
    readonly isolatedNamespace: string;
    readonly sqlitePathIsTemp: boolean;
  };
  readonly boundary: {
    readonly realExecutorProcess: true;
    readonly realManifestFactory: true;
    readonly realControlPlane: true;
    readonly realRunStore: true;
    readonly realSqlite: true;
    readonly realExecutionChannel: true;
    readonly substituted: readonly string[];
    readonly notCovered: readonly string[];
  };
}

export interface EvalRunResult {
  readonly artifacts: EvalArtifacts;
  /** Raw `RunTerminalState` as the real store recorded it. */
  readonly terminalStatus: string | null;
  readonly dbPath: string;
  readonly workspace: string;
  readonly diagnostics: readonly string[];
  dispose(): Promise<void>;
}

/** Apply the redaction policy to any value before it enters an artifact. */
function redact(value: unknown): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = /^(api[_-]?key|authorization|auth[_-]?token|access[_-]?token|password|secret)$/i.test(k)
        ? '[REDACTED]'
        : redact(v);
    }
    return out;
  }
  return value;
}

function sha256File(file: string): string {
  // node:crypto is fine HERE: this is a test-tree file. The protocol package
  // is the place that forbids it, and this file is not in that package.
  return require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync(file)).digest('hex');
}

let runCounter = 0;

/**
 * Flip one hex digit of a sha256, leaving the shape valid.
 *
 * A shape-valid digest matters: the worker's check compares the string it
 * recomputes against the string it was given, and a malformed value would fail
 * the same comparison for a different reason (a parse error rather than a
 * mismatch), which would make the refusal evidence ambiguous.
 */
function corruptDigest(digest: string | undefined): string {
  if (digest === undefined || digest.length === 0) return 'f'.repeat(64);
  const first = digest[0] === '0' ? '1' : '0';
  return first + digest.slice(1);
}

/**
 * Drive one real turn and return the artifacts it produced.
 *
 * `caseName` only appears in metadata, so two runs of the same case can be
 * told apart in a report without any assertion depending on the label.
 */
export async function runLegacyLoop(
  caseName: string,
  input: EvalCaseInput,
): Promise<EvalRunResult> {
  const timeoutMs = input.timeoutMs ?? 120_000;
  const namespace = `e41-${caseName}-${process.pid.toString(36)}-${(runCounter++).toString(36)}`;
  const root = mkdtempSync(path.join(tmpdir(), `duya-e41-${namespace}-`));
  const workspace = path.join(root, 'workspace');
  const dbPath = path.join(root, 'duya-core.db');
  mkdirSync(workspace, { recursive: true });
  for (const [name, content] of Object.entries(input.workspaceFiles ?? {})) {
    writeFileSync(path.join(workspace, name), content, 'utf8');
  }

  // Real SQLite with the REAL RunStore migrations, taken from the store
  // itself rather than re-declared — a test that re-listed them would pass
  // while the real list drifted. Same file for the Control Plane and for the
  // assertions, so what the test reads is the bytes the production write path
  // left.
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  const runStore = new RunStore(sqlite as never);
  for (const migration of RunStore.migrations) {
    migration.up(sqlite as never);
  }
  // The Control Plane reaches storage through `getCoreStores()`, a boot-time
  // singleton. Injecting the real store into it is the ONE substitution on
  // this side, and it substitutes a process boundary, not a behaviour.
  await import('../db/core-connection').then((mod) => {
    mod._setCoreStoresForTesting({ runs: runStore } as never);
  });

  const provider: OfflineProvider = await startOfflineProvider(input.script);

  const protocolTrace: ProtocolTraceEntry[] = [];
  const runEvents: unknown[] = [];
  let seq = 0;
  const record = (channel: ProtocolTraceEntry['channel'], type: string, detail: unknown): void => {
    protocolTrace.push({ seq: seq++, channel, type, detail: redact(detail) });
  };

  const sessionId = `e41-${namespace}-session`;
  const runId = `e41-${namespace}-run`;

  let worker: LegacyWorker | null = null;
  const sentCommands: ChatStartCommand[] = [];

  // The real execution channel, with the REAL worker's stdin behind dispatch.
  // This is the same adapter the product uses; only the transport under it
  // is a test-spawned child.
  //
  // `tamperManifestHash` is applied HERE, on the outbound command, and nowhere
  // else — so the run row keeps the honest hash the Control Plane pinned, and
  // the worker's recomputation is what notices the disagreement. Tampering the
  // store instead would make the two agree and the check would never fire.
  const orchestrator = new RunOrchestrator({
    dbRequest: (action, payload) =>
      dispatchControlPlaneAction(action, payload as Record<string, unknown>) as Promise<unknown>,
    channel: createWorkerExecutionChannel({
      dispatch: (command) => {
        sentCommands.push(command);
        const outbound: ChatStartCommand = input.tamperManifestHash === true
          ? { ...command, manifestHash: corruptDigest(command.manifestHash) }
          : command;
        worker?.send(outbound);
        return true;
      },
      interrupt: () => null,
    }),
  });

  worker = await startLegacyWorker({
    workerPath: AGENT_BUNDLE,
    repoRoot: REPO_ROOT,
    workspace,
    dbPath,
    namespace,
    sessionId,
    controlPlane: (action, payload) =>
      dispatchControlPlaneAction(action, payload) as Promise<unknown>,
  });

  // The run layer, as the router sees it: the REAL orchestrator, wrapped only
  // to record the `late` verdict.
  //
  // `normalizeAndObserve` calls `observe` and discards the return value, and
  // `observe` reports `late: true` for a frame that arrived after the run had
  // already ended. That verdict is the run layer saying "I had already decided
  // this run" — a real behavioural fact, and the one the pre-R2 comparison
  // needs. It is read by DELEGATING to the real orchestrator and reading what
  // it returns; no verdict is inferred, recomputed or re-decided here.
  const runLayerView = {
    observe: (session: string, frame: Record<string, unknown>) => {
      const observed = orchestrator.observe(session, frame);
      if (observed.late) {
        record('run_event', 'late_frame', { type: frame['type'] ?? null });
      }
      return observed;
    },
  } as unknown as RunOrchestrator;

  // The tee: real worker stdout into the run layer, through the REAL router's
  // `normalizeAndObserve` — the same call production makes per frame. This is
  // the harness standing in for the HTTP+SSE hop and nothing else; the run
  // layer's own translation, seq assignment, durability and terminal decision
  // are all below this line.
  //
  // `normalizeAndObserve` rather than a bare `orchestrator.observe` is NOT a
  // convenience. The router normalises a worker frame FIRST (e.g. `chat:error`
  // carries `message` + `code`, while the worker's own field is `error`) and
  // hands the NORMALISED object to the run layer. Feeding the raw frame
  // instead makes the translator read a field that is not there — which
  // presented as a real run terminal of `code: 'internal', message:
  // 'unknown error'` for a manifest refusal the worker had named correctly.
  // The wrong terminal was the harness's bug, not the run layer's.
  worker.onFrame((frame: WorkerFrame) => {
    record('worker_stdout', frame.type, frame);
    normalizeAndObserve(sessionId, frame, {
      runOrchestrator: runLayerView,
    } as RouterDeps);
  });

  // init → ready, over the real stdin channel.
  worker.send({
    type: 'init',
    sessionId,
    providerConfig: {
      apiKey: 'sk-eval-offline-REDACT-ME',
      baseURL: provider.baseUrl,
      model: input.script.turns[0] ? 'eval-offline-model' : 'eval-offline-model',
      provider: 'anthropic',
    },
    workingDirectory: workspace,
    language: 'en',
    sandboxEnabled: false,
    securityScanEnabled: false,
  });

  const ready = await worker.waitForReady(60_000);
  if (!ready) {
    await worker.stop();
    await provider.close();
    sqlite.close();
    throw new Error(
      `real worker never reported ready. stdout diagnostics:\n${worker.diagnostics.join('').slice(-4000)}`,
    );
  }
  // The `ready` frame itself was already recorded by the onFrame subscriber
  // above. Recording it again here would put a second entry in the trace for
  // one real frame, and the baseline comparison compares frame LISTS — so a
  // double-counted frame reads as a behavioural difference that does not exist.

  // The Control Plane's own view of what this case asks for. NOT the manifest
  // that runs: `openRun` freezes its own (R2.1's single run entry), and
  // building a manifest here to report would report one no run executed under.
  // What this object IS for is the intent comparison below.
  const intent: RunTurnIntent = {
    workingDirectory: workspace,
    model: 'eval-offline-model',
    providerId: 'eval-offline',
    apiFormat: 'anthropic',
    prompt: input.prompt,
    // A chat turn IS a streaming turn — this is what the real router names at
    // `router.ts` (`requiredCapabilities: ['streaming']`), and the harness
    // passes it through `openRun` for the same reason: a worker that cannot
    // stream must be refused, not silently degraded. Reading it off the
    // router's source rather than hardcoding it here keeps the two in step.
    requiredCapabilities: ['streaming'],
    maxTurns: input.maxTurns ?? 4,
    permissionMode: input.permissionMode ?? 'bypassPermissions',
    hostSwitch: 'always',
    runOrigin: 'user',
    options: {
      maxTurns: input.maxTurns ?? 4,
      permissionModeOverride: input.permissionMode ?? 'bypassPermissions',
    },
  };

  const start = await orchestrator.openRun(sessionId, intent);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (worker.frames.some((f) => f.type === 'chat:done' || f.type === 'chat:error')) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  // Let the run layer's settle path finish its durable writes.
  await new Promise((resolve) => setTimeout(resolve, 1_500));

  const handleResult = start.accepted
    ? await orchestrator.resultFor(sessionId).catch((error: unknown) => ({
        status: 'error',
        error: { message: error instanceof Error ? error.message : String(error) },
      }))
    : { status: 'not_accepted', reason: start.reason };

  // The manifest that actually ran is the one `openRun` froze, not the one
  // built above: `openRun` is the single run entry (R2.1) and it mints the run
  // id and the manifest itself. Building a second one here and reporting it
  // would report a manifest no run was ever executed under, so the built
  // manifest below is used ONLY to show what the factory produces, and every
  // run fact is read back for `startedRunId`.
  const startedRunId = start.accepted ? String(start.runId) : runId;

  const storedRun = (await dispatchControlPlaneAction('run:get', { runId: startedRunId })) as Record<string, unknown> | null;
  const storedEvents = (await dispatchControlPlaneAction('run:events', { runId: startedRunId, afterSeq: 0 })) as unknown[];
  // The run layer's own view of the same run, read through the handle rather
  // than the store, so the two can be compared instead of assumed equal.
  const runResult = handleResult as Record<string, unknown> | null;
  for (const event of runResult?.transcript ?? []) {
    runEvents.push(redact(event));
  }

  // Read the run row back from the table by hand, not through the store's own
  // accessor: the manifest that ran is the bytes on disk, not the object this
  // process built. If they ever diverge, the row is the truth and the
  // divergence is a finding.
  const rawRunRow = sqlite
    .prepare('SELECT id, status, terminal, manifest_hash, manifest_json, started_at, finished_at FROM runs WHERE id = ?')
    .get(startedRunId) as Record<string, unknown> | undefined;
  let storedManifest: unknown = null;
  try {
    storedManifest = rawRunRow?.manifest_json ? JSON.parse(String(rawRunRow.manifest_json)) : null;
  } catch {
    storedManifest = null;
  }

  const toolAttempts = collectToolAttempts(worker.frames);
  const usageFrames = worker.frames.filter((f) => f.type === 'chat:token_usage');
  const lastUsage = usageFrames[usageFrames.length - 1] as Record<string, unknown> | undefined;

  const metadata = buildMetadata({
    caseName,
    namespace,
    dbPath,
    root,
    seed: input.seed ?? input.script.seed,
    permissionMode: input.permissionMode ?? 'bypassPermissions',
    maxTurns: input.maxTurns ?? 4,
    providerTurns: input.script.turns.length,
    providerBaseUrl: provider.baseUrl,
  });

  const artifacts: EvalArtifacts = {
    // The manifest as PERSISTED and read back off disk — not the object this
    // process handed over. When they are the same, the Control Plane's write
    // path agreed with its own input; when they are not, the difference is a
    // real finding rather than a passing assertion.
    manifest: redact(storedManifest),
    manifestHash: String(rawRunRow?.manifest_hash ?? ''),
    inputRevision: sentCommands[0]?.inputRevision ?? '',
    // The `chat:start` the real execution channel dispatched, minus the
    // prompt. This is the binding the WORKER verified, so it is the artifact
    // that answers "what was this run actually given".
    dispatchedChatStart: redact({
      runId: sentCommands[0]?.runId ?? null,
      manifestHash: sentCommands[0]?.manifestHash ?? null,
      inputRevision: sentCommands[0]?.inputRevision ?? null,
      maxTurns: sentCommands[0]?.maxTurns ?? null,
    }),
    protocolTrace,
    transcript: (worker.frames
      .filter((f) => f.type === 'chat:text' || f.type === 'chat:thinking' || f.type === 'chat:tool_use')
      .map((f) => redact(f))),
    permissionAudit: (worker.frames
      .filter((f) => f.type === 'chat:permission' || f.type === 'permission:request' || f.type === 'permission:resolved')
      .map((f) => redact(f))),
    toolAttempts,
    usage: {
      inputTokens: Number(lastUsage?.inputTokens ?? 0),
      outputTokens: Number(lastUsage?.outputTokens ?? 0),
      frames: usageFrames.length,
    },
    terminal: redact({
      status: rawRunRow?.status ?? storedRun?.status ?? null,
      terminal: rawRunRow?.terminal ?? null,
      startedAt: rawRunRow?.started_at ?? null,
      finishedAt: rawRunRow?.finished_at ?? null,
      handleResult: runResult,
    }),
    runEvents: storedEvents.map((e) => redact(e)),
    providerRequests: provider.requests.map((r) => ({ ...r })),
    workerDbCalls: [...new Set(worker.dbCalls.map((c) => c.action))],
    // The run-control actions the REAL worker asked the Control Plane for, in
    // order. Pre-R2 this list is empty — the worker had no run to open — so it
    // is the sharpest single piece of evidence that the run layer is now in
    // the executor's path. Recorded from the IPC channel, not inferred.
    runControlCalls: worker.dbCalls
      .filter((c) => c.action.startsWith('run:'))
      .map((c) => c.action),
    metadata,
  };

  const diagnostics = [...worker.diagnostics];

  return {
    artifacts,
    terminalStatus: typeof rawRunRow?.status === 'string' ? rawRunRow.status : null,
    dbPath,
    workspace,
    diagnostics,
    dispose: async () => {
      await worker?.stop();
      await provider.close();
      sqlite.close();
    },
  };
}

function collectToolAttempts(frames: readonly WorkerFrame[]): ToolAttempt[] {
  const uses = frames.filter((f) => f.type === 'chat:tool_use');
  const results = new Map<string, WorkerFrame>();
  for (const frame of frames) {
    if (frame.type === 'chat:tool_result' && typeof frame.id === 'string') {
      results.set(frame.id, frame);
    }
  }
  return uses.map((use) => {
    const result = typeof use.id === 'string' ? results.get(use.id) : undefined;
    const raw = result === undefined ? '' : String(result.result ?? '');
    return {
      id: redact(use.id),
      name: redact(use.name),
      input: redact(use.input),
      outcome: result === undefined ? 'absent' : result.error === true ? 'failed' : 'succeeded',
      resultExcerpt: raw.slice(0, 200),
      error: result?.error === true,
    };
  });
}

function buildMetadata(args: {
  caseName: string;
  namespace: string;
  dbPath: string;
  root: string;
  seed: string;
  permissionMode: string;
  maxTurns: number;
  providerTurns: number;
  providerBaseUrl: string;
}): EvalMetadata {
  const pkg = (name: string): string => {
    try {
      return (require(path.join(REPO_ROOT, 'node_modules', name, 'package.json')) as { version: string }).version;
    } catch {
      return 'unknown';
    }
  };
  const head = (() => {
    try {
      return (require('node:child_process') as typeof import('node:child_process'))
        .execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' })
        .trim();
    } catch {
      return 'unknown';
    }
  })();
  const bundleBytes = require('node:fs').statSync(AGENT_BUNDLE).size;
  return {
    head,
    agentBundle: { path: 'packages/agent/bundle/agent-process-entry.js', bytes: bundleBytes, sha256: sha256File(AGENT_BUNDLE) },
    versions: {
      '@duya/agent': pkg('@duya/agent'),
      '@duya/agent-protocol': pkg('@duya/agent-protocol'),
      '@duya/agent-runtime': pkg('@duya/agent-runtime'),
      '@duya/ai': pkg('@duya/ai'),
      'better-sqlite3': pkg('better-sqlite3'),
    },
    environment: {
      platform: process.platform,
      node: process.versions.node,
      abi: process.versions.modules,
    },
    seed: args.seed,
    configuration: {
      case: args.caseName,
      permissionMode: args.permissionMode,
      maxTurns: args.maxTurns,
      provider: 'offline-anthropic-sse',
      providerBaseUrlIsLoopback: /^http:\/\/127\.0\.0\.1:\d+$/.test(args.providerBaseUrl),
      providerTurns: args.providerTurns,
      isolatedNamespace: args.namespace,
      sqlitePathIsTemp: args.dbPath.startsWith(args.root) && args.dbPath.startsWith(tmpdir()),
    },
    boundary: {
      realExecutorProcess: true,
      realManifestFactory: true,
      realControlPlane: true,
      realRunStore: true,
      realSqlite: true,
      realExecutionChannel: true,
      substituted: [
        'LLM provider (real HTTP server on loopback speaking Anthropic Messages SSE)',
        'chat-session db tables (narrow stand-ins; run:* goes to the real Control Plane)',
        'getCoreStores() singleton (injected real RunStore, not a boot-time Electron one)',
      ],
      notCovered: [
        'Electron renderer / preload boundary',
        'packaged agent bundle resolution and electron-builder output',
        'live provider (no key available in this environment)',
        'a Desktop chat turn arriving over the real HTTP+SSE agent-server transport',
      ],
    },
  };
}
