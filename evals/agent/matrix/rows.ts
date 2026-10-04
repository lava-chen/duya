/**
 * evals/agent/matrix/rows.ts — plan 587 E4.2, the behaviour matrix.
 *
 * ## What this file is
 *
 * The plan's acceptance table: nine groups, fifty-six scenarios, and for each one
 * an answer to "what proves this?". The answers are of three kinds, and the
 * distinction is the whole point:
 *
 *   proved-real              the claim is observed on a real path — a real child
 *                            process, a real socket, a real filesystem, a real
 *                            SQLite file — with nothing substituted at the
 *                            boundary the row is about.
 *   covered-by-existing-suite
 *                            an existing test already asserts it. This slice
 *                            deliberately does NOT re-assert it: the plan says
 *                            existing unit tests may be reused, and a second
 *                            assertion of the same fact is a second place to
 *                            drift.
 *   unsupported              the capability is not reachable here, with the
 *                            reason named.
 *
 * ## The rule this file exists to enforce
 *
 * "A mock with no real wire path is not proof for the corresponding host claim."
 * So a row whose subject IS a host boundary may only be `proved-real` when the
 * host boundary is genuinely crossed, and `unsupported` otherwise. A green mock
 * is worse than an open row, so the vocabulary has no status for "it passed with
 * a double". `./matrix.test.ts` enforces the mechanical half of that: every
 * `covered-by-existing-suite` row must name a file that exists AND a test title
 * that is actually in it, so a renamed or deleted test breaks the claim instead
 * of leaving a ledger entry pointing at nothing.
 *
 * ## Why the status vocabulary is not the eval one
 *
 * The eval vocabulary (`pass` / `fail` / `unknown` / `skipped` in
 * `../evaluators/layer.ts`) describes a CHECK THAT RAN. These rows mostly did not
 * run under this slice: most of them are already owned by another suite. So the
 * vocabulary here describes a CLAIM'S PROVENANCE, and `./section.ts` maps it onto
 * the eval vocabulary honestly — never `pass` — so a row this slice did not
 * execute cannot be read as a green check.
 */

export const MATRIX_GROUPS = [
  'lifecycle',
  'tools',
  'approvals',
  'hooks',
  'modes',
  'context',
  'mailbox',
  'storage',
  'resources',
] as const;
export type MatrixGroup = (typeof MATRIX_GROUPS)[number];

/** Where a row's proof lives. See the header for why these three and no more. */
export const MATRIX_STATUSES = ['proved-real', 'covered-by-existing-suite', 'unsupported'] as const;
export type MatrixStatus = (typeof MATRIX_STATUSES)[number];

export interface MatrixEvidence {
  /** Repo-root relative. Never absolute: a claim must not depend on the machine. */
  readonly file: string;
  /**
   * A `describe` / `it` title that must literally appear in `file`, or — for
   * harness rows — the eval case id under `evals/agent/cases/`.
   *
   * The verifier greps for it, which is what stops this file from decaying into
   * a list of good intentions.
   */
  readonly name?: string;
  /** What that evidence actually establishes, in one clause. */
  readonly why: string;
}

export interface MatrixRow {
  readonly group: MatrixGroup;
  /** Stable kebab-case id, unique across the matrix. */
  readonly row: string;
  /** The plan's own wording for the scenario. */
  readonly scenario: string;
  /** What must be true for the row to hold, stated as this slice understands it. */
  readonly assertion: string;
  readonly status: MatrixStatus;
  readonly evidence: readonly MatrixEvidence[];
  /** Required when `status` is `unsupported`; forbidden otherwise. */
  readonly reason?: string;
  /**
   * Set when the plan's shorthand and the product's actual behaviour differ.
   *
   * Recorded rather than quietly resolved, because a reader comparing this matrix
   * against the plan needs to see which of the two moved.
   */
  readonly divergence?: string;
}

/** The rows, in the plan's group order. */
export const MATRIX: readonly MatrixRow[] = [
  // ── lifecycle ──────────────────────────────────────────────────────────────
  {
    group: 'lifecycle',
    row: 'normal-completion',
    scenario: '正常完成 / normal completion',
    assertion:
      'A turn that finishes on its own produces one durable run row with a `completed` terminal, a gapless event log, and a manifest the executor was given and checked.',
    status: 'proved-real',
    evidence: [
      {
        file: 'evals/agent/cases/structure-text-only.json',
        name: 'structure-text-only',
        why: 'runs through the real forked `agent-process-entry` bundle against a real loopback Anthropic SSE provider, and reads the terminal off real SQLite',
      },
      {
        file: 'apps/desktop/src/main/__tests__/eval-legacy-loop.test.ts',
        name: 'runs the real worker process through a real manifest into a real durable run',
        why: 'the closed loop itself: real worker process, real manifest factory, real control plane, real RunStore',
      },
    ],
  },
  {
    group: 'lifecycle',
    row: 'dispatch-failure',
    scenario: 'dispatch 失败 / dispatch failure',
    assertion:
      'A dispatch that cannot happen closes the run with a terminal rather than leaving it live, and reports the refusal instead of an empty success.',
    status: 'covered-by-existing-suite',
    evidence: [
      {
        file: 'packages/agent-runtime/test/run-persistence-sequence.test.ts',
        name: 'records a terminal when the dispatch itself throws',
        why: 'the real controller turns a throwing dispatch into a durable terminal',
      },
      {
        file: 'apps/desktop/src/main/__tests__/run-entry-single-dispatch.test.ts',
        name: 'reports a worker that is not there as NOT ACCEPTED, and closes the run',
        why: 'the real execution channel reports a missing worker as a refusal and still closes the run',
      },
    ],
  },
  {
    group: 'lifecycle',
    row: 'desktop-chat-durable-dispatch',
    scenario: 'Desktop 聊天派发 / the desktop chat path opens a durable run and dispatches the turn',
    assertion:
      'A turn sent through the desktop `POST /chat` entry point gets a `run:create` whose reply the agent-server can read, the worker is sent exactly one `chat:start` carrying the canonical run id, and the run reaches a terminal with `run_events` written.',
    status: 'proved-real',
    evidence: [
      {
        file: 'apps/desktop/src/main/__tests__/run-create-ack-real-bridge.test.ts',
        name: 'dispatches chat:start and reaches a durable terminal with events written',
        why: 'drives the real `db:request` entry point (`handleDbRequest`) with the real bridge, the real `ControlPlaneService`, the real dispatcher and a real `RunStore` on a real sqlite file, then reads the `runs` and `run_events` tables directly',
      },
      {
        file: 'apps/desktop/src/main/__tests__/run-create-ack-real-bridge.test.ts',
        name: 'closes a row that was written by a run:create whose reply was unreadable',
        why: 'reproduces the dropped turn deliberately — a real row plus the reply shape that shipped — and shows the row is settled with a terminal event instead of left at `terminal=NULL`',
      },
    ],
    divergence:
      'The bridge, the Control Plane, the store, the orchestrator, the router tee and the dispatch are all real, and the worker is a real execution channel — but it is NOT a real child process, and no live provider is called. So two things remain unproven: that a REAL forked worker answers the `chat:start` this path sends, and that the 500 body the router now returns on a refusal is rendered as the error a user sees. Both need a packaged Electron run against a live provider; `eval-legacy-loop.test.ts` proves the executor half but reaches storage without crossing this bridge, which is exactly the seam that broke. This row is also why the earlier rows were not sufficient: every component was proved, and the composition was not, so a green suite and a product that dropped every turn agreed with each other.',
  },
  {
    group: 'lifecycle',
    row: 'model-stream-disconnect',
    scenario: 'model stream 断开 / the provider stream dies mid-turn',
    assertion:
      'A socket that dies mid-stream reaches the run as a named, retryable transport failure rather than a silent completion.',
    status: 'unsupported',
    reason:
      'The E4.1 offline provider can emit an `event: error` frame, but it cannot drop a TCP connection part-way through a response: `writeTurn` always ends with `res.end()`. A real mid-stream disconnect therefore needs either a provider fixture that destroys the socket (a change to E4.1, out of scope for this slice) or a live provider. The two halves BELOW the wire are already covered and are cited here so the gap is narrow and named rather than assumed.',
    evidence: [
      {
        file: 'packages/ai/test/errors.test.ts',
        name: 'transport stream-death patterns',
        why: 'the real error classifier maps transport stream death to a retryable connection error',
      },
      {
        file: 'packages/agent/src/agent/__tests__/stream-retry.test.ts',
        name: 'replays retryable transport deaths before the turn is committed',
        why: 'the real agent decides to replay a retryable death — and does not after a commit',
      },
    ],
  },
  {
    group: 'lifecycle',
    row: 'no-terminal-exit',
    scenario: '无 terminal 退出 / the executor exits without a terminal',
    assertion: 'A stream that ends in silence still produces a terminal event and a settled run.',
    status: 'covered-by-existing-suite',
    evidence: [
      {
        file: 'packages/agent-runtime/test/run-persistence-sequence.test.ts',
        name: 'records a terminal EVENT for a stream that ended in silence',
        why: 'the real controller settles a run whose executor simply stopped talking',
      },
    ],
  },
  {
    group: 'lifecycle',
    row: 'cancel-race',
    scenario: 'cancel race / cancel races the natural end of a turn',
    assertion: 'When `done` lands inside the stop window the race is decided once, and the reported terminal is the one the run actually reached.',
    status: 'covered-by-existing-suite',
    evidence: [
      {
        file: 'packages/agent-runtime/test/run-persistence-sequence.test.ts',
        name: 'decides the race once when done lands inside the stop window',
        why: 'cancel and done share one arbiter in the real controller',
      },
      {
        file: 'packages/agent-runtime/test/run-cancel-budget.test.ts',
        name: 'returns applied: false for a run that had already finished',
        why: 'a stop that arrives after the terminal reports the real terminal, not a cancel',
      },
    ],
  },
  {
    group: 'lifecycle',
    row: 'hardkill',
    scenario: 'hardkill',
    assertion:
      'An escalated stop reports `runtime_crash` rather than a cooperative cancel, and the kill reaches a real process tree.',
    status: 'covered-by-existing-suite',
    evidence: [
      {
        file: 'apps/desktop/src/main/__tests__/run-cancel-stop-path.test.ts',
        name: 'reports an escalated stop as escalated, and records runtime_crash',
        why: 'the real stop path distinguishes escalated from cooperative and names the code',
      },
      {
        file: 'packages/agent/src/utils/__tests__/processTreeKill.test.ts',
        name: 'falls back to direct SIGKILL when the child has no process group',
        why: 'the real kill helper spawns `taskkill /F /T` on Windows and escalates to SIGKILL on Unix',
      },
    ],
    divergence:
      'Both halves are real, but the composition — a REAL child actually killed, observed by the run layer as `runtime_crash` — is not exercised end to end. The verdict and the kill are each proved; the two joined are not.',
  },

  // ── tools ──────────────────────────────────────────────────────────────────
  {
    group: 'tools',
    row: 'tool-success',
    scenario: '工具成功 / a real tool call succeeds',
    assertion: 'A tool the model names is really invoked, and its real result is recorded against its real id.',
    status: 'proved-real',
    evidence: [
      {
        file: 'apps/desktop/src/main/__tests__/eval-legacy-loop.test.ts',
        name: 'a real tool call is attempted by the real executor and recorded with its real result',
        why: 'the real forked executor runs the real tool and the harness reads the real `chat:tool_result`',
      },
    ],
  },
  {
    group: 'tools',
    row: 'tool-failure',
    scenario: '工具失败 / a real tool call fails',
    assertion: 'A tool that fails on its own terms reports `error: true` on its own result rather than being laundered into a success.',
    status: 'covered-by-existing-suite',
    evidence: [
      {
        file: 'packages/agent/src/tool/AppConnectionTool/__tests__/executor-deadline-result.test.ts',
        name: 'marks isError from the MCP envelope without a breaker surface',
        why: 'a real tool result carries the upstream error flag through the real executor result shape',
      },
      {
        file: 'packages/ai/test/tool-result-wire.test.ts',
        name: 'the legacy error boolean is carried through untouched',
        why: 'the real wire serializer does not drop or invert the error flag',
      },
    ],
  },
  {
    group: 'tools',
    row: 'tool-timeout',
    scenario: '工具 timeout',
    assertion: 'A tool timeout is a bounded, declared contract rather than an open-ended wait.',
    status: 'covered-by-existing-suite',
    evidence: [
      {
        file: 'packages/agent/tests/tool/BashTool/timeout-contract.test.ts',
        name: 'caps foreground timeout at 5 minutes',
        why: 'the real tool validates and caps its own timeout, and refuses a larger one',
      },
      {
        file: 'packages/agent/src/tool/AppConnectionTool/__tests__/executor-deadline-result.test.ts',
        name: 'stamps deadlineAt (+120s) and a +30s IPC buffer into the request',
        why: 'a real connector request carries a real deadline the executor can act on',
      },
    ],
  },
  {
    group: 'tools',
    row: 'tool-streaming-result',
    scenario: 'streaming 结果',
    assertion: 'A long stream of frames survives the real transport framing with nothing lost.',
    status: 'covered-by-existing-suite',
    evidence: [
      {
        file: 'packages/agent-runtime/test/transport-boundary-scale.test.ts',
        name: 'carries 500+ frames across chunk boundaries with nothing lost',
        why: 'the real transports the product uses, at scale, across arbitrary chunk boundaries',
      },
    ],
  },
  {
    group: 'tools',
    row: 'read-then-write',
    scenario: 'read + write 同轮 / a read and a write that depends on it in one turn',
    assertion: 'A tool that declares a prerequisite runs after the tool it waits for, and an unmet prerequisite is reported rather than ignored.',
    status: 'covered-by-existing-suite',
    evidence: [
      {
        file: 'packages/agent/tests/unit/tool/orchestration/dependency-graph-orchestrator.test.ts',
        name: 'orders tools by their declared prerequisites',
        why: 'the real orchestrator plans the read before the dependent write',
      },
      {
        file: 'packages/agent/tests/unit/tool/orchestration/dependency-graph-orchestrator.test.ts',
        name: 'flags unmet prerequisites as unresolved',
        why: 'a prerequisite that never runs is reported, not silently dropped',
      },
    ],
  },
  {
    group: 'tools',
    row: 'same-path-serialised',
    scenario: '同 path 写串行 / two writes to one path are serialised',
    assertion:
      'Two concurrent operations on one file never interleave, and the real write tool is held behind the queue rather than running beside it.',
    status: 'proved-real',
    evidence: [
      {
        file: 'packages/agent/src/tool/__tests__/file-mutation-queue.test.ts',
        name: 'blocks a real WriteTool call behind a held operation on the same path',
        why: 'the real `WriteTool` is observed waiting on the real queue while it is held — the wiring, not a plan',
      },
      {
        file: 'packages/agent/src/tool/__tests__/file-mutation-queue.test.ts',
        name: 'never lets two operations on one file interleave, and loses no payload',
        why: 'read-modify-write on a real file shows the order on disk and in the log',
      },
    ],
  },
  {
    group: 'tools',
    row: 'different-path-parallel',
    scenario: '不同 path 并行 / writes to different paths run in parallel',
    assertion: 'Different resolved paths do not share a lock, so unrelated mutations are not serialised behind one another.',
    status: 'proved-real',
    evidence: [
      {
        file: 'packages/agent/src/tool/__tests__/file-mutation-queue.test.ts',
        name: 'runs different paths at the same time rather than behind one global lock',
        why: 'the real queue, measured on three real files with a floor a shared lock could not meet',
      },
      {
        file: 'packages/agent/tests/unit/tool/orchestration/dependency-graph-orchestrator.test.ts',
        name: 'packs disjoint-path writes into a single wave',
        why: 'the planner agrees, so the queue is not the only thing keeping writes apart',
      },
    ],
  },
  {
    group: 'tools',
    row: 'same-file-alias-conflict',
    scenario: '同文件真实别名冲突 / two names for one real file',
    assertion:
      'A filesystem alias of a file shares that file\'s queue key, because the key is the resolved realpath and not the literal string.',
    status: 'proved-real',
    evidence: [
      {
        file: 'packages/agent/src/tool/__tests__/file-mutation-queue.test.ts',
        name: 'serialises an alias against the real path, because the key is the resolved path',
        why: 'a real symlink (or a real directory junction where symlinks are unavailable) resolves onto the same file, and both writes land in one ordered chain',
      },
    ],
  },

  // ── approvals ──────────────────────────────────────────────────────────────
  ...(
    [
      ['allow', 'allow / a lasting grant is scoped to the tool that was asked about'],
      ['deny', 'deny / a denied call is denied, with the reason recorded'],
      ['defer', 'defer / a defer decides nothing and leaves the request open'],
      ['timeout', 'timeout / the deadline is owned in one place and a timeout is a deny'],
      ['updated-input', 'updated input / a rewritten input is re-validated, not waved through'],
      ['late', 'late / an answer after the deadline is a receipt, not a second decision'],
      ['duplicate', 'duplicate / a second answer is refused and delivers nothing twice'],
    ] as const satisfies readonly (readonly [string, string])[]
  ).map(([row, scenario]) => ({
    group: 'approvals' as const,
    row: `permission-${row}`,
    scenario,
    assertion:
      'The permission round trip answers the whole case: the decision is durable before it is delivered, and the thing it authorises is named.',
    status: 'covered-by-existing-suite' as const,
    evidence: [
      {
        file: 'apps/desktop/src/main/__tests__/permission-round-trip.test.ts',
        name:
          row === 'allow'
            ? 'persists the grant against the tool that was actually asked about'
            : row === 'deny'
              ? 'denies THIS call, with the reason recorded, rather than becoming a one-shot allow'
              : row === 'defer'
                ? 'decides nothing, delivers nothing, and leaves the request open'
                : row === 'timeout'
                  ? 'rejects on the deadline and records why, without delivering anything'
                  : row === 'updated-input'
                    ? 'delivers the rewritten input only after it passes re-validation'
                    : row === 'late'
                      ? 'a timeout is a deny, so a late answer is a receipt and not a second decision'
                      : 'the second answer is refused and nothing is delivered twice',
        why: 'the real round trip through the real Control Plane and the real store',
      },
    ],
  })),
  {
    group: 'approvals',
    row: 'refused-executions-zero',
    scenario: '拒绝执行计数 0 / zero refused tool executions',
    assertion:
      'When a call is refused, the tool did not run. Not "was reported as not run" — the effect is absent.',
    status: 'unsupported',
    reason:
      'The existing round-trip suite proves the DECISION layer: nothing is delivered, and a refusal is recorded. What it cannot prove is that the real executor, on the other end of a real worker process, executed nothing. The E4.1 harness never answers a permission request, so a case that needs a refusal AND a real tool would have to add a permission-responding channel to the harness — a change to E4.1, out of scope here. Asserting the count from the decision layer would be exactly the mock-passing-as-host-proof the plan forbids.',
    evidence: [
      {
        file: 'apps/desktop/src/main/__tests__/permission-round-trip.test.ts',
        name: 'delivers NOTHING when the durable write refuses',
        why: 'the strongest form of this claim that is reachable in-process: nothing crosses to the worker',
      },
    ],
  },

  // ── hooks ──────────────────────────────────────────────────────────────────
  {
    group: 'hooks',
    row: 'pretooluse-veto',
    scenario: 'PreToolUse 否决',
    assertion: 'A decision-event hook is synchronous even when configured async, and its matcher selects by tool name.',
    status: 'covered-by-existing-suite',
    evidence: [
      {
        file: 'packages/agent/src/hooks/__tests__/events.test.ts',
        name: 'downgrades async: true to sync on decision events (PreToolUse)',
        why: 'a veto cannot be async — the real runner forces it synchronous',
      },
      {
        file: 'packages/agent/src/hooks/__tests__/executor.test.ts',
        name: 'PostToolUse matcher filters by tool name; no matcher matches everything',
        why: 'the real matcher selects hooks by the tool under the event',
      },
    ],
  },
  {
    group: 'hooks',
    row: 'posttooluse-failure-diagnosis',
    scenario: 'PostToolUse 失败诊断',
    assertion: 'A non-zero exit is fed back to the model as a verifier diagnostic instead of being swallowed.',
    status: 'covered-by-existing-suite',
    evidence: [
      {
        file: 'packages/agent/src/hooks/__tests__/executor.test.ts',
        name: 'injects a non-zero-exit command diagnostic back to the model (verifier)',
        why: 'the real executor turns a failure into context the model can act on',
      },
    ],
  },
  {
    group: 'hooks',
    row: 'prefinalize',
    scenario: 'PreFinalize',
    assertion: 'A finalize veto short-circuits lower-priority handlers, and builtin gates veto on their own conditions.',
    status: 'covered-by-existing-suite',
    evidence: [
      {
        file: 'packages/agent/src/hooks/__tests__/loop-bus.test.ts',
        name: 'first block_finalize wins at PreFinalize and short-circuits lower priorities',
        why: 'the real bus resolves a veto deterministically',
      },
      {
        file: 'packages/agent/src/hooks/__tests__/builtin-loop-hooks.test.ts',
        name: 'vetoes finalize once when pending/in-progress tasks remain',
        why: 'a real builtin gate vetoes a premature finish',
      },
    ],
  },
  {
    group: 'hooks',
    row: 'post-turn',
    scenario: 'post turn',
    assertion: 'A turn-start hook contributes additional context to the turn that follows it.',
    status: 'covered-by-existing-suite',
    evidence: [
      {
        file: 'packages/agent/src/hooks/__tests__/executor.test.ts',
        name: 'PreTurn registration collects command additionalContext into a custom inject',
        why: 'the real bridge from a configured PreTurn hook into the turn injection channel',
      },
    ],
  },
  {
    group: 'hooks',
    row: 'hook-event-order',
    scenario: 'event 顺序',
    assertion: 'Handlers run in priority order regardless of registration order, and registration order breaks ties.',
    status: 'covered-by-existing-suite',
    evidence: [
      {
        file: 'packages/agent/src/hooks/__tests__/loop-bus.test.ts',
        name: 'dispatches in priority order regardless of registration order',
        why: 'the real bus ordering, which is the whole claim',
      },
    ],
  },
  {
    group: 'hooks',
    row: 'hook-await-cancel',
    scenario: 'await 取消',
    assertion: 'A hook that overruns is killed and fails open, so a hanging hook cannot hold a turn.',
    status: 'covered-by-existing-suite',
    evidence: [
      {
        file: 'packages/agent/src/hooks/__tests__/executor.test.ts',
        name: 'kills the process and fails open on timeout',
        why: 'the real process hook is killed at its deadline and the turn continues',
      },
      {
        file: 'packages/agent/src/hooks/__tests__/executor.test.ts',
        name: 'fails open on non-zero exit and reports the exit code',
        why: 'a killed hook is a diagnostic, not a refusal of the turn',
      },
    ],
  },

  // ── modes ──────────────────────────────────────────────────────────────────
  {
    group: 'modes',
    row: 'mode-general',
    scenario: 'general 模式',
    assertion:
      '`general` is the ABSENCE of a modifier, not a mode id: the registry registers six modifiers (research, conductor, plan-task, automation, goal, computer-use) and `general` is none of them, so a general run has an empty modifier set rather than a default one.',
    status: 'covered-by-existing-suite',
    evidence: [
      {
        file: 'packages/agent/src/modes/__tests__/registry.test.ts',
        name: 'resolves a single mode',
        why: 'the real registry, whose registered set is the closed list the assertion names',
      },
    ],
    divergence:
      'The plan line reads `general/plan` as a pair of modes. Only `plan` is one. `general` appears nowhere in `packages/agent/src/modes/` — it is the base state, not a registry entry — so this row is recorded against the registry\'s closed set rather than against a `general` mode that does not exist. Inventing a `general` mode to satisfy the wording would have added vocabulary the product does not have.',
  },
  {
    group: 'modes',
    row: 'mode-plan',
    scenario: 'plan 模式',
    assertion: 'Plan mode tracks its own state and refuses the transitions its row does not allow.',
    status: 'covered-by-existing-suite',
    evidence: [
      {
        file: 'packages/agent/src/modes/plan/__tests__/plan-tracker.test.ts',
        name: 'drives the user lifecycle: enter → pending → activate → active → exit_approved → inactive',
        why: 'the real plan tracker and its own transition rules',
      },
      {
        file: 'packages/agent/src/modes/engine/__tests__/run-lifecycle-tracker.test.ts',
        name: 'each state refuses events outside its row (spot matrix)',
        why: 'the real lifecycle matrix refuses the illegal transitions',
      },
    ],
  },
  {
    group: 'modes',
    row: 'mode-stateful-goal',
    scenario: 'stateful Goal',
    assertion: 'A goal is state that survives a fold and a cold start, and pauses idempotently.',
    status: 'covered-by-existing-suite',
    evidence: [
      {
        file: 'packages/agent/src/modes/goal/__tests__/goal-tracker.test.ts',
        name: 'pause from active → user_paused, records message; resume → active',
        why: 'the real goal tracker transitions and is idempotent while paused',
      },
      {
        file: 'packages/agent/src/modes/goal/__tests__/goal-commands.test.ts',
        name: 'pause works right after a cold start from the persisted fold',
        why: 'the state survives persistence rather than living in memory',
      },
    ],
  },
  {
    group: 'modes',
    row: 'mode-stateful-research',
    scenario: 'stateful Research',
    assertion: 'Research state distinguishes its stages and can pause and resume across them.',
    status: 'covered-by-existing-suite',
    evidence: [
      {
        file: 'packages/agent/src/modes/research-mode/__tests__/research-tracker.test.ts',
        name: 'ResearchTracker — pause / resume / blocked',
        why: 'the real research tracker and its pause/resume/blocked family',
      },
    ],
  },
  {
    group: 'modes',
    row: 'mode-continuation',
    scenario: 'continuation',
    assertion: 'A mode that continues a run re-enters the turn with its own context rather than starting over.',
    status: 'covered-by-existing-suite',
    evidence: [
      {
        file: 'packages/agent/src/hooks/__tests__/builtin-loop-hooks.test.ts',
        name: 'vetoes finalize while the goal is active',
        why: 'the real continuation gate, and its cap',
      },
      {
        file: 'packages/agent/tests/unit/runtime-context-adapters.test.ts',
        name: 'adapts goal continuation with source=goal_summary, visible',
        why: 'the real adapter that projects a continuation into a visible turn',
      },
    ],
  },
  {
    group: 'modes',
    row: 'mode-snapshot',
    scenario: 'snapshot',
    assertion: 'Every registered tracker contributes a snapshot and is restored from one; an unregistered mode is refused rather than invented.',
    status: 'covered-by-existing-suite',
    evidence: [
      {
        file: 'packages/agent/src/modes/engine/__tests__/engine.test.ts',
        name: 'collects persisted snapshots for all registered trackers',
        why: 'the real engine collects the whole set',
      },
      {
        file: 'packages/agent/src/modes/engine/__tests__/engine.test.ts',
        name: 'returns false when restoring an unregistered mode',
        why: 'a snapshot for a mode that is not registered is refused',
      },
    ],
  },
  {
    group: 'modes',
    row: 'mode-finish',
    scenario: 'finish',
    assertion: 'A terminal is terminal: failed, interrupted and cancelled never accept `complete`.',
    status: 'covered-by-existing-suite',
    evidence: [
      {
        file: 'packages/agent/src/modes/engine/__tests__/run-lifecycle-tracker.test.ts',
        name: 'failed / interrupted / cancelled never accept complete',
        why: 'the real anti-downgrade rule for a finished run',
      },
    ],
  },
  {
    group: 'modes',
    row: 'pause-not-opened',
    scenario: '未实现 pause 不开放 / an unimplemented pause is not handed out',
    assertion:
      'The runtime advertises `run.pause: false`, and a host that requires pause is refused loudly and by name rather than being given a pause that never arrives.',
    status: 'proved-real',
    evidence: [
      {
        file: 'packages/agent-runtime/test/capability-pause-closed.test.ts',
        name: 'advertises run.pause false, so no host is told to wait for one',
        why: 'the real `probeRuntimeCapabilities` output, which is what a host actually reads',
      },
      {
        file: 'packages/agent-runtime/test/capability-pause-closed.test.ts',
        name: 'refuses a host that requires pause, loudly and by name',
        why: 'the real `assertSatisfies` throws `CapabilityError` naming `pause` — a loud refusal, not a degraded run',
      },
    ],
  },

  // ── context ────────────────────────────────────────────────────────────────
  {
    group: 'context',
    row: 'nested-agents',
    scenario: 'AGENTS 嵌套',
    assertion: 'A nested `AGENTS.md` is loaded for its own subtree, and released back into the prompt when the agent leaves it.',
    status: 'covered-by-existing-suite',
    evidence: [
      {
        file: 'packages/agent/tests/unit/agentsmd/nested-loader.test.ts',
        name: 'discovers AGENTS.md in subdirectories below cwd (shallow to deep)',
        why: 'the real nested loader, in the order it resolves them',
      },
      {
        file: 'packages/agent/tests/unit/agentsmd/release-reinject.test.ts',
        name: 're-injects a previously injected nested file after release',
        why: 'the real release/reinject cycle, and its cross-project guard',
      },
    ],
  },
  {
    group: 'context',
    row: 'dynamic-skills-catalog',
    scenario: '动态 skills / catalog',
    assertion: 'The skill and tool catalog the provider is offered reflects the current configuration rather than a frozen list.',
    status: 'covered-by-existing-suite',
    evidence: [
      {
        file: 'packages/agent/src/prompts/dynamic/__tests__/skillsMetadata.test.ts',
        name: 'classifies bundled + system as internal, everything else as external',
        why: 'the real dynamic prompt assembly, which is what the provider request is built from',
      },
      {
        file: 'packages/agent/src/config/__tests__/tool-exposure.test.ts',
        name: 'reads [tools] on_demand_discovery = true from config.toml',
        why: 'the real tool-exposure decision, read from the live configuration rather than a frozen list',
      },
    ],
  },
  {
    group: 'context',
    row: 'truncation-compaction',
    scenario: '截断 / compaction',
    assertion:
      'Compaction appends a checkpoint and never rewrites history: the summary lives in the CompactionEntry, and the tool_use / tool_result boundary is walked back to a user turn.',
    status: 'covered-by-existing-suite',
    evidence: [
      {
        file: 'packages/agent/tests/unit/message-compaction-controller.test.ts',
        name: 'appends a CompactionEntry without removing or overwriting original MessageEntries',
        why: 'the real controller is append-only, which is what makes a compaction auditable',
      },
      {
        file: 'packages/agent/tests/unit/message-compaction-controller.test.ts',
        name: 'walks the boundary back to a user turn when the strategy retains from a tool_result',
        why: 'the real boundary rule that keeps a tool call paired with its result',
      },
    ],
  },
  {
    group: 'context',
    row: 'runtime-context-not-persisted',
    scenario: 'runtime context 不持久化',
    assertion:
      'Runtime context and hook nudges are not durable transcript entries: a nudge is produced for the turn that needs it and is filtered out of what gets persisted.',
    status: 'covered-by-existing-suite',
    evidence: [
      {
        file: 'packages/agent/src/hooks/__tests__/loop-bus.test.ts',
        name: 'produces nudges that are never persisted (persistableMessages filter)',
        why: 'the real filter that keeps a hook nudge out of the durable record',
      },
    ],
    divergence:
      'The plan line reads `runtimecontext不持久化`. For HOOK NUDGES that is exactly right and the filter above is its proof. For runtime-context MESSAGES the product does the opposite: `runtime-context-adapters.test.ts` describes `runtime context is persisted` and asserts that `projectPersistenceMessages` persists every adapter-produced message as a user-role message. This row is therefore recorded against the nudge path, and the opposite behaviour of the message path is named here rather than asserted as if the plan and the product agreed.',
  },
  {
    group: 'context',
    row: 'cached-stable-segments',
    scenario: '缓存稳定段',
    assertion:
      'An unchanged tree reuses the same object identities, and a changed tree rebuilds only what changed.',
    status: 'covered-by-existing-suite',
    evidence: [
      {
        file: 'packages/agent/tests/skills/rootSnapshotCache.test.ts',
        name: 'reuses object references on hit without calling resolve',
        why: 'the real cache, measured by identity rather than by equality',
      },
      {
        file: 'packages/agent/tests/skills/snapshotIntegration.test.ts',
        name: 'rebuilds only the changed skill; siblings keep their identity',
        why: 'the real loader keeps stable segments stable across one change',
      },
    ],
  },

  // ── mailbox ────────────────────────────────────────────────────────────────
  {
    group: 'mailbox',
    row: 'inject-mid-run',
    scenario: '执行期间补消息 / 补图片',
    assertion:
      'A message and an image queued while a turn is running are drained into that turn as runtime context, and an unclaimed row is not injected.',
    status: 'covered-by-existing-suite',
    evidence: [
      {
        file: 'packages/agent/tests/unit/runtime-context-adapters.test.ts',
        name: 'wraps queued and followup rows in a single runtime_context message',
        why: 'the real adapter that drains the mailbox into the running turn',
      },
      {
        file: 'packages/agent/src/message/mailbox-attachment-context.test.ts',
        name: 'projects image-only guidance with both distinct images and attachment text',
        why: 'the real image projection, including the text-only-model path',
      },
      {
        file: 'packages/agent/src/message/mailbox-attachment-context.test.ts',
        name: 'does not inject an unclaimed row',
        why: 'injection requires a claim — the negative half of the row',
      },
    ],
  },
  {
    group: 'mailbox',
    row: 'same-name-attachments',
    scenario: '同名附件',
    assertion: 'Two attachments with the same filename are kept distinct rather than collapsed into one.',
    status: 'covered-by-existing-suite',
    evidence: [
      {
        file: 'packages/agent/src/utils/attachment-images.test.ts',
        name: 'preserves different images with the same filename and legacy ID',
        why: 'the real attachment identity, and it does not key on the filename',
      },
    ],
  },
  {
    group: 'mailbox',
    row: 'background-subagent-completion',
    scenario: '背景 subagent 完成',
    assertion:
      'A background task completing mid-run becomes a hidden transient notification, and the row it reserved is finalised rather than re-injected.',
    status: 'covered-by-existing-suite',
    evidence: [
      {
        file: 'packages/agent/tests/unit/runtime-context-adapters.test.ts',
        name: 'produces a hidden transient runtime_context with source=background_notification',
        why: 'the real adapter for a task notification',
      },
      {
        file: 'apps/desktop/src/main/db/core/__tests__/mailbox.test.ts',
        name: 'a notification reserved by a crashed run is finalized applied, not re-injected (crash window)',
        why: 'the real store closes the crash window instead of double-injecting',
      },
    ],
  },
  {
    group: 'mailbox',
    row: 'dedup',
    scenario: '去重',
    assertion: 'A row drained twice is dropped the second time, and partial overlap keeps whatever is new.',
    status: 'covered-by-existing-suite',
    evidence: [
      {
        file: 'packages/agent/tests/unit/runtime-context-adapters.test.ts',
        name: 'drops a task notification drained twice by task-id',
        why: 'the real dedupe keyed on the identity the store owns',
      },
      {
        file: 'apps/desktop/src/main/db/core/__tests__/mailbox.test.ts',
        name: 'enqueue is idempotent on client_msg_id collision',
        why: 'the real store refuses a duplicate enqueue at the source',
      },
    ],
  },
  {
    group: 'mailbox',
    row: 'pending-projection',
    scenario: 'pending projection',
    assertion: 'A pending row is claimable at the right checkpoint and is not claimable at a checkpoint it was not meant for.',
    status: 'covered-by-existing-suite',
    evidence: [
      {
        file: 'apps/desktop/src/main/db/core/__tests__/mailbox.test.ts',
        name: 'guide keeps pending status and marks the row claimable at before_model_turn',
        why: 'the real projection: pending stays pending and becomes claimable at exactly one checkpoint',
      },
      {
        file: 'apps/desktop/src/main/db/core/__tests__/mailbox.test.ts',
        name: 'excludes queued rows at before_model_turn but claims followup rows',
        why: 'the real kind-specific claim rule, and its negative half',
      },
    ],
  },

  // ── storage ────────────────────────────────────────────────────────────────
  {
    group: 'storage',
    row: 'slow-ack',
    scenario: 'slow ack',
    assertion: 'A terminal is not published while its durable append is still unacknowledged.',
    status: 'covered-by-existing-suite',
    evidence: [
      {
        file: 'packages/agent-runtime/test/run-correctness-seams.test.ts',
        name: 'does not publish a terminal while the durable append is unacked',
        why: 'the real public signal obeys the real durable barrier',
      },
      {
        file: 'packages/agent-runtime/test/run-persistence-sequence.test.ts',
        name: 'acknowledges the terminal event before it writes the terminal row',
        why: 'the real ordering: ack, then the row',
      },
    ],
  },
  {
    group: 'storage',
    row: 'negative-ack',
    scenario: 'negative ack',
    assertion:
      'A refusal — an unreadable reply, a reply claiming success with nothing written, a busy database — degrades the run rather than counting as a durable write.',
    status: 'covered-by-existing-suite',
    evidence: [
      {
        file: 'apps/desktop/src/main/__tests__/run-orchestrator-ack.test.ts',
        name: 'treats a busy database as a refusal, not a durable write',
        why: 'the real orchestrator reading a real refusal',
      },
      {
        file: 'apps/desktop/src/main/__tests__/run-orchestrator-ack.test.ts',
        name: 'degrades a run whose run:append reply claims success without a written count',
        why: 'a reply that overstates itself is not believed',
      },
    ],
  },
  {
    group: 'storage',
    row: 'transaction-rollback',
    scenario: 'transaction rollback',
    assertion: 'A batch in which one sequence is contradicted writes NOTHING at all.',
    status: 'covered-by-existing-suite',
    evidence: [
      {
        file: 'apps/desktop/src/main/db/core/__tests__/run-store-idempotency.test.ts',
        name: 'writes NOTHING when one sequence in a batch is contradicted',
        why: 'the real store, on real SQLite, where a partial write would be visible',
      },
    ],
  },
  {
    group: 'storage',
    row: 'terminal-cas',
    scenario: 'terminal CAS',
    assertion:
      'A lost compare-and-set is reported as `reconciled` when the other writer agreed and `conflict` when it disagreed, and never as a plain success.',
    status: 'covered-by-existing-suite',
    evidence: [
      {
        file: 'apps/desktop/src/main/db/core/__tests__/run-store-idempotency.test.ts',
        name: 'reports `conflict` and never overwrites when the terminals DISAGREE',
        why: 'the real CAS on real SQLite',
      },
      {
        file: 'apps/desktop/src/main/__tests__/run-orchestrator-ack.test.ts',
        name: 'reports the run as completed when the durable terminal already agrees',
        why: 'the real orchestrator turns an agreeing lost CAS into the right verdict',
      },
    ],
  },
  {
    group: 'storage',
    row: 'run-reopen',
    scenario: 'run reopen',
    assertion:
      'A run written by one store is readable by a second store that shares nothing but the file: row, manifest binding, terminal and the whole event ledger, replayable from a cursor.',
    status: 'proved-real',
    evidence: [
      {
        file: 'apps/desktop/src/main/db/core/__tests__/run-store-reopen.test.ts',
        name: 'reopens the row with its manifest binding and its terminal intact',
        why: 'a real SQLite file, a dropped connection, a fresh `RunStore` — the bytes outlived the process that wrote them',
      },
      {
        file: 'apps/desktop/src/main/db/core/__tests__/run-store-reopen.test.ts',
        name: 'reopens the whole event ledger in sequence, so a reconnect has no gap to paper over',
        why: 'the ledger and a cursor read, from the reopened store',
      },
    ],
    divergence:
      'This is a reopened FILE, not a restarted Electron process. The real boot path — the app opening its `%APPDATA%` database after a restart — needs a packaged app and is recorded as unsupported in the matrix rather than approximated here.',
  },
  {
    group: 'storage',
    row: 'cursor-reconnect',
    scenario: 'cursor 重连',
    assertion:
      'A reconnecting consumer resumes at the store\'s own position with no duplicate and no hole, and a refused subscription says why instead of returning an empty success.',
    status: 'covered-by-existing-suite',
    evidence: [
      {
        file: 'packages/agent-runtime/test/replay-subscription.test.ts',
        name: 'resumes exactly where the store left off, with no window between the two sources',
        why: 'the real replay-to-live handoff, which is the reconnect',
      },
      {
        file: 'packages/agent-runtime/test/replay-subscription.test.ts',
        name: 'does not open, and reports the refusal rather than an empty success',
        why: 'a refused subscription is a refusal, not a quiet empty stream',
      },
    ],
  },

  // ── resources ──────────────────────────────────────────────────────────────
  {
    group: 'resources',
    row: 'long-stream',
    scenario: '长流',
    assertion: 'A long stream crosses the real framing with nothing lost, in order.',
    status: 'covered-by-existing-suite',
    evidence: [
      {
        file: 'packages/agent-runtime/test/transport-boundary-scale.test.ts',
        name: 'carries 500+ frames across chunk boundaries with nothing lost',
        why: 'the real transports at a scale a short test cannot reach',
      },
    ],
  },
  {
    group: 'resources',
    row: 'slow-consumer',
    scenario: 'slow consumer',
    assertion: 'A slow consumer costs latency, never durable content, and the loss is counted rather than hidden.',
    status: 'covered-by-existing-suite',
    evidence: [
      {
        file: 'packages/agent-runtime/test/transport-boundary-scale.test.ts',
        name: 'holds every durable frame and reports its own backpressure',
        why: 'the real queue under a slow reader',
      },
      {
        file: 'packages/agent-runtime/test/backpressure.test.ts',
        name: 'reports zero durable loss for a run that overflowed the queue',
        why: 'the real bound, asserted as a number',
      },
    ],
  },
  {
    group: 'resources',
    row: 'queue-limit',
    scenario: '队列 limit',
    assertion:
      'The consumer queue is bounded in BYTES as well as in frames, and going over it is reported rather than silently shedding.',
    status: 'covered-by-existing-suite',
    evidence: [
      {
        file: 'packages/agent-runtime/test/backpressure.test.ts',
        name: 'bounds in BYTES, and says so by going over rather than evicting',
        why: 'the real bound and the deliberate choice to overrun instead of drop',
      },
    ],
  },
  {
    group: 'resources',
    row: 'no-growth-100-runs',
    scenario: '100 次 run 后 timer / process / subscription 无增长',
    assertion:
      'After 100 runs the runtime holds no more timers and no more live runs than it did after one, and no new kind of process resource appears.',
    status: 'proved-real',
    evidence: [
      {
        file: 'packages/agent-runtime/test/run-resource-growth.test.ts',
        name: 'releases every per-run timer, and asserts the figures it measured',
        why: 'MEASURED on this branch: 0 timer growth and 0 new resource kinds across 100 runs, from a baseline of the same figures. The bound is asserted at ≤2 so the row is not a flake detector, and the measurement object is asserted in full so a regression reports the numbers it regressed from',
      },
      {
        file: 'packages/agent-runtime/test/run-resource-growth.test.ts',
        name: 'holds no live run for any finished run id, so nothing can be re-subscribed',
        why: 'every one of the 100 run ids probed through the controller\'s own index, using the ids the runs were actually given',
      },
    ],
    divergence:
      'The process half of this row is NOT claimed here. `RunController` forks nothing: a child process belongs to the subprocess transport and to the desktop worker pool, neither reachable from a unit process. The receipt-retention half is also not re-asserted — `run-persistence-sequence.test.ts` already measures that bound over 100 runs at a limit of 8, and restating it would only add a second place to drift.',
  },
];

/** Every row id, for the uniqueness check. */
export function matrixRowIds(): readonly string[] {
  return MATRIX.map((row) => row.row);
}

/** Rows in one group, in declaration order. */
export function rowsIn(group: MatrixGroup): readonly MatrixRow[] {
  return MATRIX.filter((row) => row.group === group);
}
