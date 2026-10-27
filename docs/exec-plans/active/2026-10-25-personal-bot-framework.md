# 个人长期 Bot：统一领域边界与可靠迁移

## S1–S6-A integration preview — 2026-10-26

- Owner: Codex root; linked worktree `/workspace/work/bot-integration`, branch
  `codex/bot-s1-s6-integration`, base `origin/master @ d80ca3c6`. User authorized
  the first preview step: combine selected branches, not merge to master.
  Managed-worktree/context/CodeGraph tools unavailable; Git and versioned plans
  provide the snapshot. Original PR branches are unchanged and retained.
- Assembled with one merge commit per selected PR head, in the order below.
  All eleven exact heads are verified ancestors of the preview. Rebased S1–S3a
  and older stacked ancestry coexist; no original commits were rewritten.

| Slice / PR | Selected head | Preview merge |
| --- | --- | --- |
| #500 `codex/bot-framework-s1` | `a04b6d27` | `27674860` |
| #502 `codex/bot-framework-s2` | `5e06887a` | `b7bb8e45` |
| #503 `codex/bot-framework-s3a` | `01342b44` | `b6b0b37a` |
| #504 `codex/bot-framework-s3b` | `a692d74b` | `34bb03e4` |
| #506 `codex/bot-framework-s3c` | `aaa78d44` | `87f7fb3b` |
| #509 `codex/bot-framework-s4` | `64f1cf4e` | `bbdaebb9` |
| #511 `codex/bot-framework-s4-feishu` | `600bf624` | `384bd798` |
| #515 `codex/bot-framework-s5` | `9edc7c84` | `8eb70873` |
| #520 `codex/bot-s5-review` | `f3477278` | `6979354b` |
| #513 `codex/bot-framework-s6` | `b41ab523` | `e05fe0f6` |
| #519 `codex/bot-s6-followup` | `35cad06a` | `62250c45` |

- Source conflict resolutions: `data/src/index.ts` retains inbox exports and
  adds BotDispatchStore. `host/src/local-host.ts` keeps master's newer
  lease-resilience no-argument shutdown and adds Bot dispatcher lifecycle.
  Independent S5/S6 architecture and execution records are both retained;
  the handoff keeps newer S1–S3a resync facts. The index points here.
- Generated worker conflicts were temporarily held at the current artifact in
  intermediate checkpoints, then rebuilt once from the final combined source.
  Those checkpoints are assembly history, not individually validated releases.
- The first final typecheck invocation caught an automatically merged duplicate
  `@duya/bot` dependency; identical versions were collapsed to one. An inherited
  duplicate `schedule` test key was removed, preserving its intended daily cadence.
- Combination checks: all eleven selected heads are ancestors; no unmerged
  index entries. Eight distinct focused suites / 148 tests passed (the
  Scheduler suite was rerun after its duplicate-key cleanup). The data inbox
  suite ran 30 cases; the first smoke command's obsolete inbox filename matched
  no file and was corrected before this total was recorded.
- Final worker generated artifacts and Electron main/preload were rebuilt.
  Architecture gate passed, no new boundary findings; baselines unchanged.
  Final `npm run typecheck:all` exited 0 on the combined source after the
  duplicate-key fix. Committed bundle freshness is checked before publication.
  Remote selected heads were rechecked and all eleven remained unchanged.
  Dependency overlays point workspace names to this worktree; only compatible
  third-party modules and private picomatch type declarations are reused.
- Scope remains an integration preview. No production Bot ownership changed,
  no main/master update, no PR merged, no live external send. Full-stack
  regression, real worker/IPC/Electron validation and authorized integration
  remain subsequent work; the repository's final commit gates are run here.

## S1–S6 集成落地 — 2026-10-27

- Owner: 本会话 root；worktree `.claude/worktrees/bot-s1-s6-merge`；分支
  `codex/bot-s1-s6-integration`（PR #521，base `origin/master`）；独占路径：PR #521
  分支与本计划文件。合并前的来源检出 `.claude/worktrees/bot-framework-*` 保持原位。
- 授权与方式：用户选择「以 #521 集成分支单一落地」，而不是把 11 条堆叠 PR 逐条
  rebase 后分别合并。理由：11 条分支各自持有一份被跟踪的 `packages/host/bundle/`
  产物，逐条合并会把「产物重生成」重复 11 次；组合分支已保留每个切片的独立 merge
  提交，提交粒度不丢，且 CI 只跑一遍。落地用 merge commit，不 squash。
- 合并 `origin/master @ a99e1444`（自 `d80ca3c6` 起 master 又并入 #510/#512/#514/
  #518/#525/#517）：6 处冲突。三个生成产物 `bundle/worker-entry.js`、
  `bundle/worker-metafile.json`、`bundle/BashTool/BashWorker.js` 按[构建](../../development/build.md)
  的规矩重生成而不手工合并；`packages/host/package.json` 同时保留 `./bot` 与
  `./provider-management` 两个导出映射；两份计划文档两侧内容都保留。
- 修掉组合分支上仍红的三处（CI 上 #521 的 `test` job 为此失败）：
  - `packages/data/src/bot-scheduler-store.ts` 与 `bot-outbox.ts` 的迁移改用
    `CREATE TABLE IF NOT EXISTS`，与核心库既有迁移写法一致。原先用裸
    `CREATE TABLE`，重试一次启动就会在 `bot_scheduler_owners already exists`
    上失败——桌面迁移测试「整表应用两次」直接红。
  - `packages/agent-protocol/src/` 里指向 desktop router 的行号引用按本次 bot
    切片造成的位移逐条重算（router.ts 在 import 与两处 hunk 共 +10 行），否则
    citation drift 测试报 4 处「引用区间不含所命名的符号」。
- 验证（本检出，win32 / Node 24.16.0 / Vitest 3.2.4）：
  `npm run typecheck:all` 退出 0；`npm run architecture:check` 新增违规 0（3 条既有
  baseline 指纹失效未 `--write`）；`npm run bundle:verify` FRESH 0/1014；bot 相关
  套件 37 文件 416 例全绿（packages/bot、data bot 三套、host bot 与 worker-prompts、
  memory `__tests__`）；architecture 脚本 + UI bot 32 文件 480 例全绿（退出码来自
  `[vitest-worker]: Timeout calling "onTaskUpdate"`，与 S0 记录同签名，无用例失败）；
  desktop bot 五文件 46 例全绿。
- Windows 检出注意：`scripts/inline-modules.mjs` 在 Windows 上把
  `packages/capabilities/src/ModuleTool/inline-content.ts` 生成成 CRLF，与入库的 LF
  版本字节不同，会让 `bundle:verify` 报 STALE 且不产生真实 diff。用
  `git -c core.eol=lf checkout -- <file>` 复位后再重建产物即可。
- 外部副作用：仅 `origin/codex/bot-s1-s6-integration` 远端分支与 PR #521 更新。
  未改生产 Bot 归属，未发任何外部消息，未动用户数据。
- 下一步：#521 最新 head 的五检查全绿后转 ready 并用 merge commit 合并；合并后
  逐条关闭 #500 / #502 / #503 / #504 / #506 / #509 / #511 / #513 / #515 / #519 / #520
  （它们的提交已随组合分支进入 master），并回收本次检出；S7 旧路径退役另立切片。

## S5 independent review — 2026-10-26

- Owner: Codex root, linked worktree `/workspace/work/bot-s5-review`, branch
  `codex/bot-s5-review`, base #515 `9edc7c84`. Managed worktree/context and
  CodeGraph tools unavailable; Git and versioned plan provide shared state.
- Review scope: cross-Bot memory isolation, grant revocation/cache refresh,
  write-ahead forget and startup recovery. No merge or production state change.
- Plan: record affected baseline; reproduce symbolic-link boundary bypasses;
  fix recall and repair path handling; test grant revocation and crash windows;
  run type/architecture/build gates; retain evidence and deliver a draft PR.
- Exclusive paths: memory path helper/ledger and tests, Host Bot memory readers
  and tests, Stage 1 extractor, Desktop tier writer/forget recovery and tests,
  worker bundle and plan docs.
- Findings reproduced before fixes: three Host cases followed linked
  files/directories/shard roots or state files; two repair cases modified linked
  or unrelated files; two Stage 1 cases committed a forgotten canonical key,
  including with `existingKeys: null` and forget during inference.
- Fixed: shared path resolution rejects linked ancestors/files and hard links;
  grant/membership readers and all recall tier scans use it. Foreground writes,
  forget and recovery enforce canonical memory layouts. Ledger paths also reject
  Windows drive syntax/NUL on every OS. Recovery leaves unsafe paths untouched.
- Stage 1 no longer presents forgotten keys as reusable identities. It re-reads
  tombstones after inference and rejects a matching normalized canonical key
  before any output/projection write. This is an exact-key guarantee; semantic
  paraphrases and already-folded summaries remain explicitly out of scope.
- Validation (Linux / Node 24.19.0, base `9edc7c84` plus this review diff):
  initial affected baseline 5 files / 46 tests passed, with extractor file-keys
  blocked at collection by missing AI dist. Host dependency build passed;
  subsequent defect reproductions failed 3/16 Host, 2/5 repair and 2/6 extractor
  cases before fixes. Final affected regression: 44 files / 519 tests passed.
  This uses real temporary files/SQLite and a scripted LLM, not a live account.
- Architecture gate passed with no new violations and no baseline edits.
  Worker bundle regenerated. Main/preload build passed. Full desktop build
  attempted but blocked by unavailable Electron binary download. No live
  Electron or packaged-app assertion is claimed.
- Full `npm run typecheck:all` exited 0 on the final review source. The
  already-declared picomatch types resolve through a private worktree overlay
  to the prior task's private dependency install; no shared install was changed.
- Delivery: preserve branch `codex/bot-s5-review` and its linked worktree;
  publish only as a draft follow-up targeting `codex/bot-framework-s5` (#515).
  Final bundle freshness is checked on the committed payload before publishing.
  No merge is authorized. Next: review the follow-up, integrate the prerequisite
  stack in order, then repeat Electron validation on a prepared runner.
- Acceptance: ungranted memory cannot be read through file/directory links;
  recovery cannot modify a linked or unrelated file; legitimate recall and
  ordinary crash recovery remain intact. Adversarial concurrent filesystem
  replacement is outside this path-check guarantee.

## S5 execution — 2026-10-26

- Owner: root agent; isolated linked worktree `.claude/worktrees/bot-framework-s5`,
  branch `codex/bot-framework-s5`, base `codex/bot-framework-s4-feishu` @ `600bf624`
  (stacked: S1–S4 are still unmerged). No merge is authorized.
- Decision (user-confirmed): peer user shards require an **explicit grant, fail
  closed**; revocation/forget lands **next turn via a durable recall revision**
  folded into the frozen-section key, while ordinary memory writes stay frozen
  until compaction (keeps Plan 501 L1).
- Status: implemented and verified locally; the two review defects are fixed in
  `c5326a69`; published as draft
  [PR #515](https://github.com/lava-chen/duya/pull/515) (base
  `codex/bot-framework-s4-feishu`). Unmerged; no merge is authorized.
- Delivered: `@duya/bot` `context/snapshot.ts` (pure `BotContextSnapshot`:
  bot revision, recall revision, authorized scopes; `parseMemoryAccessGrant`
  fail-closed); host `worker-prompts/bot/memory/access.ts` reads
  `agents/<bot>/state/memory-access.json`; `tierReader.readUserTierEntries` now
  takes an authorized shard list instead of scanning every agent, and project
  ids/writer dirs are validated as path segments; `loader` builds one snapshot
  per turn from config revision + grants + `state/projects.json` + forget ledger
  and renders memory only from `snapshot.memory`; `framework`/
  `epoch.botVolatileSectionCacheKey` key volatile sections on
  `bot:<id>:v:<recallRevision>:<epoch>:<section>`; the runtime passes
  `recallRevision`.
- Forget is durable at four layers: file retirement + tier-index removal
  (existing), `<memoryRoot>/.forget-ledger.json` revision (frozen prompt
  re-renders next turn), and tombstone keys merged into Stage 1's dedupe set.
  The curator prompt also receives a bounded `forgotten_facts` block so an old
  rollout summary cannot write the fact back into an area page.
- Review follow-up (2026-10-26, fix commit `c5326a69`):
  - **Grant contract is all-or-nothing.** The old parser filtered invalid
    entries and kept the valid half, so a mixed file still widened recall past
    what the user wrote — contradicting the "fail closed" promise. One invalid
    entry now rejects the whole file, and `buildBotContextSnapshot` re-validates
    the grant instead of trusting the caller, so a hand-built invalid grant
    yields no peer shards either.
  - **Forgetting is crash-recoverable.** The ledger is now the *write-ahead*
    record: it is written before the canonical file is retired and it names the
    path being retired. Recall readers (`tierReader`) skip every tombstoned
    path, so a crash between the ledger write and the retirement cannot expose
    the fact, and the desktop memory-worker startup repair
    (`memory-state/forgetRecovery.ts`) finishes the retirement and drops the
    index row. The repair is idempotent; the ledger file format moved to
    version 2 (`entries[]` with `paths[]`), and a version-1 file still reads.
  - The failure window is pinned by tests: the desktop test writes the ledger
    while the file is still `status: active` and the index row still present,
    then asserts the repair flips it to `retired` and removes the row; the host
    test asserts the still-active file is not recalled.
- Acceptance evidence (all local, win32 / Node 24.18.0; re-measured at the
  review-fix commit `c5326a69`):
  - named S5 tests 74 cases green across 7 files:
    `packages/bot/tests/context-snapshot.test.ts` (11, incl. all-or-nothing
    grant), `packages/memory/src/__tests__/forget_ledger.test.ts` (9, ledger v2
    entries + paths), `extractor.file-keys.test.ts` (5, incl. tombstone survives
    retired file), `apps/desktop/.../tierWriter.test.ts` (10, forget bumps the
    ledger + tombstones), `apps/desktop/.../forgetRecovery.test.ts` (3, crash
    window completed / idempotent / no-op),
    `apps/desktop/.../curation_single_shot.test.ts` (23, incl. forgotten block
    present/absent), `packages/host/tests/worker-prompts/bot-memory-s5.test.ts`
    (13: own+legacy only without grant, granted shard visible, revocation moves
    the gate while an ordinary write does not, unsafe project ids dropped,
    volatile re-render on gate change but not on content change, a tombstoned
    but un-retired file is not recalled).
  - `packages/host/tests` + `packages/bot/tests` + `packages/memory/src`:
    255 files passed / 1 skipped, 2350 passed / 5 skipped (exit 0).
  - desktop `memory` + `memory-state`: 29 files, 337 passed (exit 0).
  - `npm run typecheck:all` exit 0; `npm run architecture:check` exit 0 (no new
    violations; 2955 total, all baselined, baseline untouched); bot-boundary
    PASS (R1 MEASURED 10 files / 0 forbidden edges); retirement ratchet PASS
    (772 current / 772 baseline / 0 new). Desktop `tsconfig.main` 178 errors,
    all pre-existing (base moved; none in the S5 files).
  - `npm run bundle:worker` rebuilt `packages/host/bundle` from the final source
    and committed it with the fix; `npm run bundle:verify` reports FRESH at
    `c5326a69` (0/1009 inputs changed).
- Honest deferrals / limits: (1) audience-based memory filtering (design §7
  "记忆按受众过滤") is not implemented — S4 channel admission already gates
  allowed senders, and the worker has no per-turn audience field; it stays an
  open item. (2) The `forgotten_facts` curator guard is prompt-level; the
  structural guarantees are the Stage 1 dedupe tombstone (re-extraction) and
  the ledger path tombstone (recall visibility, including the crash window).
  (3) Conversation summaries already folded into context are not rewritten
  ("必要时重建受影响
  摘要" remains a separate slice). (4) Grant authoring is a documented JSON file
  contract; no Desktop UI/RPC yet. (5) The grant file is user-owned state; the
  bot itself has no writer for it. (6) Remote CI cannot report on this branch:
  the repo's `Test` workflow only runs on `master` pushes, so no run exists for
  `codex/bot-framework-s5` (same for the S1–S4 branches). A remote signal only
  appears once the stack reaches master, which is not authorized.

## S6 review follow-up — 2026-10-26

- Owner: Codex root; managed worktree/context/CodeGraph tools unavailable.
  Git and versioned plan supply context. Exclusive paths: automation scheduler,
  schedule helpers/tests, cron-file store and the three plan/architecture docs.
  Linked worktree: `/workspace/work/bot-s6`.
- Continue S6-A from PR #513 (`b41ab523`), isolated branch
  `codex/bot-s6-followup`; S5 PR #515 remains independent. Remote S1–S4
  prerequisites remain unmerged; no integration or production ownership change.
- Review found admission loss: the old tick advanced `last_run_at` before
  enqueue. Now atomically write the exact scheduled batch and fingerprint to
  `cronjob.toml` before admission, then acknowledge each accepted fire in order.
  Failed admission stops the batch; restart reuses its original fire identities
  even after the clock advances. Lost acknowledgement replays the same key for
  Host inbox dedup. Concurrent ticks share one in-flight pass.
- `skip` now checks the newest due occurrence, preventing a missed old occurrence
  from permanently starving future on-time fires. Reject zero/overflowing
  intervals; one-shots respect `endAt`.
- Guarantee scope: durable wake acceptance/dedup belongs to Host-owned Bots
  (S3c). Legacy in-memory wake ownership is not upgraded by this change.
  Schedule edits invalidate a mismatching pending fingerprint; disabled jobs
  retain pending work without dispatch. Full pause/revocation remains S6-B.
- Baseline: three affected suites / 72 tests passed before changes.
  Final targeted regression: three suites / 78 tests passed. Expanded automation
  and wake run: 10 files / 124 assertions passed, 14 files failed at collection
  due to missing workspace dist exports (ai/plugin-core) and the Electron
  binary; no assertion in those files ran.
- After dependency builds, expanded retry executed 137 passing / 8 skipped
  assertions; 12 files remained red (Electron collection failures and a
  sandbox-blocked localhost listener). Retrying the HTTP RunResult suite with
  localhost permission passed all 8 tests. No product assertion was weakened.
- Architecture gate passed, no new boundary violations, baseline untouched.
  Main/preload `npm run build:electron` passed. Full `electron:build` failed
  in its Electron binary prerequisite (download unavailable); no packaged or
  live Electron claim.
- Final `npm run typecheck:all` retry exited 0 on Linux / Node 24.19.0,
  source commit `e22e8fe0`. Initial run stopped at missing `@types/picomatch`;
  installed the already-declared 4.0.3 type package under private `work/deps`
  and added worktree-local capability/Host resolution links. Shared dependency
  installation untouched. Electron type ratchet reported no new errors.
- Delivery: [draft PR #519](https://github.com/lava-chen/duya/pull/519), base
  `codex/bot-framework-s6` (#513), implementation `e22e8fe0`. User explicitly
  authorized pushing this payload and creating the PR. Remote head verified;
  no CI checks/reviews reported yet, no merge. Keep branch and worktree.
- Next: review #519 alongside #513; integrate only after prerequisite stack
  review/CI, repeat Electron-dependent validation on a prepared runner, then
  begin S6-B budget/quiet-hours/pause/revocation/approval as a separate slice.

## S6 execution — 2026-10-26

- Owner: Qoder root; isolated linked worktree `.claude/worktrees/bot-framework-s6`,
  branch `codex/bot-framework-s6`, base `600bf624` (S4-Feishu tip on
  `codex/bot-framework-s4-feishu`; prerequisite stack #500 → #502 → #503 →
  #504 → #506 → #509 → #511, all unmerged).
- Base decision (user-selected): S6 stacks on S4 and skips S5. S5
  (memory/prompt snapshots) is owned by another session in
  `.claude/worktrees/bot-framework-s5` (branch `codex/bot-framework-s5`,
  HEAD `600bf624`, unpushed) and this worktree leaves it untouched. The
  time-trigger half of S6 needs only S3–S4 and asserts no snapshot contract, so
  it can land ahead of S5.
- Slice S6-A — 已实现 / 已验证, not merged: deterministic routine fire identity
  plus offline catch-up inside the existing Desktop automation owner. No new
  schema, no new Host owner, no desktop → `@duya/bot` import: a Bot-bound fire
  still enters through the S3c managed wake port, so the Host inbox keeps
  collapsing replays on `sourceEventId = auto:<routineId>:<fireKey>`.
  - `routineFireKey(routineId, schedule fingerprint, scheduled instant)` is now
    the fire identity (`r1:...`), and the tick claims the scheduled instant
    instead of the wall clock, so a late tick or a restart cannot drift the
    phase. Manual "run now" keeps a random `manual:<uuid>` key: a second click
    is a second fire, not a duplicate.
  - `planDueRoutineFires` implements the policy persisted as `misfire_policy` /
    `max_catch_up` in `cronjob.toml` (defaults `latest` / 1; `bounded` clamped
    to 1..5). `latest` fires the newest missed instant once after a multi-day
    outage, `bounded` fires the newest N ascending, `skip` drops an instant
    older than the 5-minute grace window. DST needs no special case: instants
    come from croner's timezone-aware `nextRun`, and the 23 h / 25 h gaps are
    pinned by tests.
  - Two first-run defects surfaced while rewriting the tick and are fixed here
    because the nextFire contract cannot hold otherwise. `once` schedules could
    never fire through the polling tick (`computeNextRunAt` returns `at` only
    while it is still future, so `nextRunAt <= now` never matched); a one-shot
    now fires late exactly once, whatever the policy. A never-run `every` job
    anchored on `now` on every read, so its first occurrence never became due;
    it now anchors on `created_at`, as `cron` already did.
  - A standalone (non-Bot) cron stays single-fire and claims the wall clock: it
    has no inbox to dedupe a burst, and replaying its backlog would spawn one
    throwaway session per missed instant. The stored policy applies once the job
    is bound to a Bot, and the value persists through binding so the user's
    choice is not lost.
- Not in this slice (S6-B+): daily schedule summary, budget CAS, quiet hours,
  pause / revocation of queued responsibility, approval admission, and a UI
  control for the misfire policy (today it is editable in `cronjob.toml`; the
  create / update IPC already accepts both fields).
- Verification — 2026-10-26, Windows 10 x64, Node v24.18.0, base `600bf624`,
  dirty scope = the seven `apps/desktop/src/main/automation` files below.
  - `npm run build:packages` — 22 packages, exit 0.
  - `npm run typecheck:all` — exit 0 (build:packages, protocol / client-core /
    core / workflow / runtime / web / web-app / electron / cli / voice / evals).
  - `node scripts/typecheck-electron-gate.mjs` — OK, no new type errors
    (178 known across 101 keys; 10 keys shrank, baseline not re-recorded).
  - `node scripts/architecture/architecture-check.mjs` — OK, no new boundary
    violations, baseline untouched.
  - `npx vitest run apps/desktop/src/main/automation apps/desktop/src/main/wake`
    — 24 files / 240 tests passed, exit 0. S6 adds 28 cases (14 `schedule`,
    8 `Scheduler`, 6 `cron-file`); every pre-existing case stayed green.
  - `npm run check:encoding` / `check:no-ts-suppress` / `check:test-coverage` —
    exit 0.
  - Environment note: this worktree's `node_modules` is a junction to the main
    checkout that predates `packages/bot`, so `packages/node_modules/@duya/bot`
    was added as a worktree-local junction; no install ran through the shared
    link. Before `build:packages`, every `@duya/<pkg>/<subpath>` import in the
    Electron gate failed with TS2307 (missing `packages/*/dist`); those errors
    were environmental and cleared after the build.
- 待验证: no renderer/Electron run (no UI change), and the bounded catch-up is
  proven against a mocked wake dispatcher — the real `auto:*` `sourceEventId`
  dedup is the S3c contract and is unchanged here.
- Delivery: draft [PR #513](https://github.com/lava-chen/duya/pull/513), base
  `codex/bot-framework-s4-feishu`. Unmerged; keep the worktree and branch until
  the S1–S4 stack integrates and S5 lands, then rebase S6-B on the merged tree.

## S4 execution — 2026-10-26

- Owner: Codex root; isolated linked worktree `.claude/worktrees/bot-framework-s4`,
  branch `codex/bot-framework-s4`, base S3c `aaa78d44`. Existing PRs remain unchanged.
- Plan: establish the affected baseline; add core-db outbox and atomic terminal
  settlement; wire trusted per-event channel admission and fenced delivery in
  Host; connect Telegram, then Feishu in a separate platform commit/PR; expose
  durable delivery state through the Desktop bridge and existing channel cards.
- Acceptance: replay returns the same inbox receipt; identity cannot cross a
  binding; terminal settlement cannot lose a delivery obligation; an interrupted
  send is reconciled or marked unknown without blind resend; no credentials in
  durable payloads, projections or errors. Verify local transport faults, restart,
  relevant regressions, typecheck, architecture and Electron build.
- Managed worktree/context/CodeGraph tools unavailable; Git, PR heads and the
  versioned plan supply shared-state evidence. No merge is authorized.
- Telegram implemented: core migration 48 adds `bot_outbox`; terminal validation,
  reply insertion and inbox settlement share one transaction. A committed send
  claim is fenced; interrupted sends become `unknown`, never automatically
  resent. Vault credentials are resolved only by the Host transport. Connection
  replacement/revocation invalidates queued targets. Ownership transfer refuses
  unresolved deliveries. Existing legacy scheduling remains the default.
- Channel replies use explicit SendMessage submissions captured with their Run
  attempt. They are queued durably and released by terminal input settlement.
  Plain assistant text remains private; if no SendMessage was submitted, the Host
  records a blocked missing-reply obligation. Repeated identical
  submissions reuse the same receipt, and distinct messages retain their order.
  Legacy non-channel turns keep their existing delivery path (retirement is S7).
  Unsupported/oversized output is a visible blocked obligation, never a partial
  send reported as complete. Telegram text is limited to one 4096-character
  provider message per receipt; no automatic multi-message split is claimed.
- Desktop admits each Telegram update by its stable provider ID and awaits the
  durable receipt before advancing the polling offset. Startup replay is not
  truncated. Read-only IPC and delivery cards show pending/sending/delivered/
  unknown/blocked independently of Run completion.
- Baseline at `aaa78d44` (Linux / Node 24.19.0, clean independent npm ci):
  Host dependency build exit 0; 4 affected suites / 66 tests passed. After changes:
  13 affected suites / 164 tests passed; the initially blocked Electron-import
  suite passed all 6 tests after installing the verified Electron 44.9.1 binary.
  Real Host/SQLite/child-process suite: 4 tests passed, including channel receipt
  replay after restart with one worker dispatch and one transport send. New
  outbox/channel fault suites: 10 tests passed (included in the 164 above).
- Chromium via local Playwright (MCP unavailable): five durable states, unknown
  guidance, remote receipt, light/dark and 375px layout passed with no page errors.
  This is component browser verification with a fixture IPC response, not a real
  Electron renderer IPC claim. `electron:build` passed. Architecture gate passed
  with no new boundary violations. `npm run typecheck:all` exit 0 on the final
  Telegram source; generated worker artifacts rebuilt by `electron:build`.
- At the Telegram checkpoint, Feishu was the next slice: preserve IDs/media and await
  admission before transport ACK; bypass the legacy cross-account dedup file for
  managed admission. Do not treat a live adapter's void send result as a receipt.

### S4 platform delivery and final verification

- Telegram foundation delivered as draft [PR #509](https://github.com/lava-chen/duya/pull/509),
  foundation `b1f81198` plus explicit-message correction `64f1cf4e`, base
  `codex/bot-framework-s3c`. This is implemented and locally
  validated, not merged. The original S3c branch remains unchanged.
- Feishu continuation uses the same isolated worktree on branch
  `codex/bot-framework-s4-feishu`, base `64f1cf4e`; exclusive paths extend to the
  Feishu gateway transport and its tests. No new scheduler, Run loop or database
  owner. The Host adapter resolves vault credentials and validates the actual
  provider message receipt; it supplies a stable UUID but does not assume an
  unlimited provider dedup window or retry unknown sends.
- Final output-contract review corrected the initial Telegram implementation's
  use of ordinary assistant text. The shared follow-up keeps SendMessage as the
  sole explicit external voice, through the existing tool execution and worker
  bridge. The tool reports queued/pending, never delivered, before a remote
  receipt exists. Host checks the captured current attempt and exact target;
  private text and stale/cross-binding submissions cannot become deliveries.
  Missing replies, failed Runs and recovery-required inputs remain visible
  blocked obligations. This correction is part of the Telegram foundation PR.
- Feishu message/media/thread/rich-text IDs are preserved. The connector awaits
  durable admission. Managed WebSocket consumers acknowledge all reassembled
  fragments after commit; webhook consumers return failure on a failed commit
  and permit the identical signed retry. After successful acceptance, nonce
  replay protection remains active. Managed admission bypasses the legacy global
  message-ID cache; per-owner/Bot/binding inbox identity owns dedup. Legacy
  consumers retain their existing ACK timing. Current sender/chat allowlists are
  checked at admission, and binding/account replacement fences outbound work.
- Final affected regression: 26 files / 263 tests passed (exit 0), including
  SQLite rollback/fences, real Host restart/worker execution, both transports,
  media IDs, delayed/failed/multipart ACKs, signed retries, and UI regression.
  The final admission subset was rerun after allowlist revalidation: 4 files /
  32 tests passed. Host dependency build exit 0. Full typecheck and architecture
  gates passed; final source typecheck and regenerated artifacts are rechecked
  before the platform commit. Final `typecheck:all`, `architecture:check` and
  `electron:build` all exited 0; no architecture baseline was increased. The
  final real-worker proof uses different private text and SendMessage content:
  only the explicit content was delivered (4 resident tests passed). Committed
  worker bundle at `64f1cf4e` is FRESH, with 0/1006 changed inputs.
- Local Playwright verified receipt cards in Chromium. An isolated Xvfb binary
  was downloaded/extracted under `work/` (no system installation), removing the
  earlier DISPLAY blocker. Real Electron IPC smoke: 4 existing logger cases
  passed. New `e2e/ipc/bot-delivery.spec.ts` passed against the actual
  preload → IPC → Desktop Host → migrated SQLite store: an unknown receipt
  remains unknown with attempt 1 after repeated queries and is absent for a
  different Bot. Its first attempt exposed an ESM-only test-fixture loader
  mistake (`require` unavailable); the fixture now uses `createRequire` and
  namespaces each run. The test was rerun on the final Electron build and passed
  (exit 0). No production assertion was relaxed. An E2E-only protocol import
  exposed a new architecture edge; the test now uses its local wire projection
  shape instead of increasing the baseline.
- Evidence: Linux / Node 24.19.0 / Electron 44.9.1; logs, fixture home, extracted
  display server, UI screenshots and npm dependencies remain local in `work/`,
  `.e2e-userdata/` and `node_modules/`. Neither platform has used live account
  credentials or sent to a real remote conversation. Full IPC/turn coverage and
  prerequisite PR review/CI remain integration work; these are draft PRs.
- Binding identity is stable across display/policy edits; a separate authorized
  snapshot revision fences old queued output without defeating event dedup.
- Delivery: Feishu implementation `73ad69cd` is draft
  [PR #511](https://github.com/lava-chen/duya/pull/511), base
  `codex/bot-framework-s4 @ 64f1cf4e` ([PR #509](https://github.com/lava-chen/duya/pull/509)).
  Both branches are published, unmerged and preserved. The current worktree has
  only the local `work/` scratch directory outside version control; no production
  Bot owner was transferred. Review/CI must follow the prerequisite stack before
  any authorized integration; local green checks do not claim remote CI approval.
- Next after S4 review/integration: S5 memory/prompt snapshots. Keep the S4
  worktree and both unmerged branches; do not recycle or switch production
  scheduler ownership as part of this implementation task.

## S3c execution — 2026-10-26

- Owner: Codex root, `codex/bot-framework-s3c`, isolated linked worktree
  `.claude/worktrees/bot-framework-s3c`, base S3b `a692d74b` plus S2
  `3a35e047` integrated at `3bfaca2a`. Existing PR branches are not edited.
- Goal: complete the S3 acceptance matrix before declaring S4 ready. Persist
  per-Bot scheduler ownership and fence Run admission; forward Desktop input
  and revoke renderer execution for migrated Bots; preserve wake payloads,
  preemption/redrive, terminal reconciliation, restart and rollback evidence.
- Desktop keeps its current database owner and Agent Server executor. The
  shared Host scheduler is assembled over those existing ports; no second
  database connection owner or Run orchestrator is introduced.
- Implemented: migrations 46–47 persist owner epochs and preemption intents;
  Run creation atomically validates ownership, inbox lease and dispatch
  reservation; Host admissions carry fenced dispatch tickets; Desktop routes
  `sendTurn`, kickstart, claim and cancel through the Host-owned inbox only for
  opted-in Bots, preserving the legacy scheduler as the default. Accepted user
  input and its preemption intent commit in one SQLite epoch transaction.
  Cancellation names the exact Run ID; restart reconciliation redrives a
  cancelled background obligation from its stored WakeItem, retains user
  attachments, and sends malformed or exhausted work to recovery/dead-letter
  state. Ownership transfer requires drained Runs, inbox entries, wakes and
  preemption intents.
- Validation on final source: `npm run typecheck:all` exit 0;
  `npm run architecture:check` exit 0 with no new boundaries; four focused
  Vitest files, 59 tests, exit 0; `npm run electron:build` exit 0. The IPC
  E2E command attempted 50 cases but could not create a window in this runtime:
  Electron reports `Missing X server or $DISPLAY`; its default `/home/agent`
  test home is also not writable here. No IPC E2E assertion ran. The real
  Agent Server HTTP adapter's dispatch-ticket/canonical-Run-ID/specific-cancel
  tests passed (12/12) alongside the Host dispatcher and Wake routing tests;
  repeat the full IPC suite in CI or an X-enabled runner.
- S4 entry: S3 now supplies durable Bot input ownership and a fenced Run
  executor seam. S4 can start the data outbox and channel adapters. Its first
  work must define per-message channel event identity and acknowledgement
  recovery: the current legacy channel Wake envelope is not yet a durable
  per-event inbox/outbox receipt. Preserve this as an explicit S4 scope; do not
  infer channel delivery completion from S3c's Wake dispatch result.
- S2's classification/rule-file fixes are included; S1/S2/S3a/S3b review and
  CI remain with their existing owners. This branch is not yet integrated.
- Delivery: implementation commit `1795543e` on
  `codex/bot-framework-s3c`; draft [PR #506](https://github.com/lava-chen/duya/pull/506)
  targets `codex/bot-framework-s3b`. S3c is implemented and locally validated,
  but remains unmerged and the real IPC suite still needs an X-enabled runner.
- Worktree residue: the root/package `node_modules` workspace symlink overlay
  remains untracked and unstaged; `.e2e-userdata/` and `test-results/` are kept
  as evidence from the failed Electron launch attempt.
- Dependency setup: reused compatible S3b third-party modules with a worktree
  workspace overlay. Managed-worktree/context/CodeGraph tools unavailable;
  Git, current PR heads and versioned plans provided the shared-state evidence.


## S3b execution — 2026-10-26

- Owner: Codex root; branch `codex/bot-framework-s3b`; isolated worktree
  `.claude/worktrees/bot-framework-s3b`; foundation `bf9b62c8` (S2) plus
  `6c5d6229` (S3a), combined at `0a87a2f8`.
- Existing PR review belongs to other agents. This branch does not update
  #500, #502 or #503. Their fixes will be merged before integration.
- Scope: dispatch-key admission in the existing Run owner, a fenced data
  adapter over S3a tables, an opt-in Host inbox dispatcher and resident lifetime.
  Desktop routing remains S3c; legacy scheduling stays unchanged by default.
- Plan: record targeted baseline; implement admission and claim fencing; wire
  headless dispatch/reconciliation and shutdown; test lost responses, restart,
  stale claims and client disconnect; run repository gates and open a PR.
- Acceptance: one dispatch key never sends a second execution; expired claims
  cannot dispatch or mutate a new claim; a persisted terminal settles its input;
  ambiguous reservations/running rows become explicit recovery obligations;
  resident work survives the last client, then releases the Host when drained.
- Tools: managed worktree / workspace context / CodeGraph tools unavailable;
  isolated linked worktree and Git/PR/plan evidence used instead.
- Environment: Linux, Node 24.19.0. A clean install found S2's missing
  `@duya/bot` lock entry; independent dependencies are being prepared locally.
  No existing PR branch was changed.
- Implemented: opt-in `LocalHostHandle.botInputs`, scoped/fenced claim adapter,
  dispatch admission in the existing Run owner, restart reconciliation, and
  resident idle protection. An ambiguous start is a durable `recovery_required`
  dead letter; it never starts a second executor. Legacy routing is untouched.
- The isolated clean install also required declaring Host's existing Bot
  dependency and the two missing workspace lock entries (16 additive lock
  lines). This branch carries those prerequisites without changing #502.
- Validation on the S3b dirty tree: `typecheck:all` exit 0;
  `architecture:check` exit 0 with no new violations; Bot boundary PASS;
  `electron:build` exit 0; worker bundle rebuilt. Full affected regression:
  35 files / 239 tests passed, plus dispatcher 12/12 after correcting a test
  that wrongly assumed ordering between different Bots (priority is per Bot).
  The combined final coverage is 36 files / 251 tests. New tests: 15.
  Final Host runtime subset: 4 files / 36 tests, exit 0. A refused start
  without a reservation is retained once rather than retried forever.
- Runtime evidence: a real child-process Run survives the last HTTP client
  lease, reaches its durable terminal and releases the Host; a pending accepted
  input executes once after a real Host restart. Provider calls are stubbed;
  this is Host/process/persistence validation, not live-model or UI validation.
- Test environment: writable isolated `os.homedir()` preload for fixtures;
  Electron 44.9.1 archive verified against the package checksum after automatic
  download failed. Build warned that bundled ripgrep could not be downloaded;
  the build completed with its existing fallback. Raw logs stay in `work/`.
- Next: publish the S3b draft on the combined S2/S3a foundation (base master
  so PR CI runs), record its PR here, then integrate
  the independently reviewed S1/S2/S3a heads before S3c transfers Desktop
  scheduling ownership. Keep this worktree and all unmerged branches.
- S3c entry points checked: Desktop owns an embedded `HostSessionHttpServer`
  in `apps/desktop/src/main/cli/desktop-host-api.ts` and forwards execution via
  `createDesktopRunExecutionApi`; it does not call `startLocalHost`. Do not open
  a second database owner to enable this dispatcher. Transfer the Bot owner
  explicitly, forward `dispatchBotTurn`/`enqueueWakeItemForSession`, and reject
  `claimScheduledUserTurn` for migrated Bots. Preserve existing preemption,
  redrive, attachments, turn epochs and renderer event projections in that slice.
- Delivery: [Draft PR #504](https://github.com/lava-chen/duya/pull/504),
  implementation `e4c5019c0b83d3ffe1d1f5bfe1cfe1027a18f88a` on
  `codex/bot-framework-s3b`. Final staged-source `typecheck:all` exit 0,
  architecture exit 0, Bot boundary PASS and committed bundle FRESH.
  No user data migrated; no production scheduler switched; no PR merged.
  PR CI/review and prerequisite integration remain pending. Keep the worktree;
  ignored `work/` contains local logs and dependency-isolation fixtures only.


状态：active，设计已交付（draft PR #483 待 review）；S0 门禁与行为基线切片已实现并验证，待 PR review / CI · 负责人：Codex / root · 更新：2026-10-25
分支：`plan/bot-framework-foundation` · worktree：`.claude/worktrees/bot-framework-plan` · base：`270ba52869b6414094e553dd7f9abde5a1e429f7` · owner：本会话 root

## 目标与边界

本次交付是可评审的设计与迁移计划：定义长期个人智能体，明确 Bot 领域包、Host 运行装配、数据与记忆的唯一归属；以真实源码和四产品官方资料约束决策。后续按本计划切片逐步实现。

本次独占：本文件、`docs/design-docs/personal-bot-framework.md`、`docs/references/personal-agent-products.md` 及各自导航入口；仅文档。没有创建空 package、改 prompt、运行用户数据迁移或切换生产执行。

设计合同见[个人 Bot 框架](../../design-docs/personal-bot-framework.md)，依据与现有入口见[产品核实](../../references/personal-agent-products.md)。这两份文件维护合同和证据，本文件只维护排期、验收与接续。

前置与避让：610 保有通用 Run / Session / worker；622 保有层门禁与依赖测量；619 保有 prompt 双通道；620 保有会话记录合同；621 保有 managed workspace。Bot 切片调用这些服务，不接管其状态表，不重建 DAG、Run 引擎或审批系统。

## 本次设计验收与进度

- [x] 检查起始工作区无用户修改，fetch origin 并 pull 最新 master。
- [x] 从 `origin/master @ 270ba528` 建立独立 linked worktree；没有可用 managed worktree / workspace_get_context / CodeGraph 工具，以 Git 和版本化计划对账。
- [x] 核实当前 Host、Desktop wake、profile、memory、渠道与 Run 接缝；旧会话助手正文无法读取，已在依据中标明。
- [x] 按用户确认的四产品补读架构 / 安全 / 使用文档；完成八维对照，区分公开机制、源码事实和推导。
- [x] 写出领域合同、唯一 owner、失败窗口、迁移 / 删除标准与后续切片。
- [x] 完成导航、相对链接、Git 可见性、编码和 diff 检查；记录根门禁实际结果。
- [x] 提交文档切片并创建 [draft PR #483](https://github.com/lava-chen/duya/pull/483)，保存 review / 实施接续。
- [ ] S0–S7 生产迁移逐片验收；本次不勾选。

## 迁移切片

切片按顺序推进；同一数据根 / Bot 同时只有一个调度 owner。S1 建立端口后才开始 S2 提包。S3 的 durable 启动受理补齐前，S1 的 facade 只能委托旧调度器，不能伪装已可 headless 执行。

| 切片 | 交付与独占路径建议 | 依赖 | 完成标准 / 预计评审粒度 |
| --- | --- | --- | --- |
| **S0 边界与行为基线** | Bot 实际消费者清单、导入闭包探针、现有行为夹具；`scripts/architecture` 中 Bot 专属门禁与测试，计划证据 | 当前可开始；核对 622 01–04 真实 head | Bot→Host / UI→Host 反向边变异红→绿；现有身份、prompt、wake、投递行为具名基线。1 个门禁 PR |
| **S1 Host Bot 接口** | `host/src/bot` facade / ports，protocol 最小 DTO，Host 启动装配及 profile 写入接缝；旧 Desktop 调度作为过渡 adapter | S0 | Desktop/TUI 查询同一 Bot；create/update revision 冲突拒绝，错误不吞；不新增第二 scheduler。身份 journal 与跨文件修复测试。1–2 个窄 PR |
| **S2 提取 Bot 领域包** | `packages/bot` 的 domain/application/ports，host adapter，workspace/build/gates 必要接线 | S1；622 Host / 相关包层归属已落地或等价门禁实证 | 新包 managed、下向依赖受测、零 Electron/SQLite/fs/provider；至少一个真实 Host 用例消费，行为夹具不变。纯移动与行为修改分开 |
| **S3 持久唤醒与 resident** | data additive inbox / dispatch receipt；Host Run 幂等启动接缝、Bot dispatcher、lease 与恢复；Desktop bot handler 转发 | S2；Run receipt / fence 前置实证 | 无 UI 也能执行；Run 已受理响应丢失后不重复启动；旧 claim 无效；关闭最后客户端不误停 resident。先存储合同、再 Host 接线、最后切流，约 3 个 PR |
| **S4 投递与渠道** | data outbox；Host channel adapters；先 Telegram、再 Feishu 证明扩展接口；Desktop bridge / UI cards | S3；610 T22 范围对账 | 重复 inbound 一个 receipt；跨 binding 身份拒绝；发后崩溃进入 receipt reconciliation / unknown；无凭据泄漏。每平台独立 PR |
| **S5 记忆与 prompt 快照** | memory 范围过滤 / 遗忘 API，host BotContextSnapshot adapter，替换 worker 直接扫描；619/620 合同对齐 | S3；相关 memory owner 接缝 | own/user/project 授权隔离；撤权立即生效；prompt / 工具暴露对照不变；摘要不会复活已遗忘条目。人格变更另立切片 |
| **S6 持续责任与自主性** | Bot responsibility / attention 纯策略，现有 Goal / routine 端口，Host 预算与通知装配 | S3–S5；现有审批执行链 | 日程摘要闭环、离线 catch-up、预算 CAS、安静时段、暂停与授权撤销、审批准入；不重建 Task / DAG。按用户可见闭环拆 PR |
| **S7 旧路径退役** | Desktop wake / channel 业务退为 adapter 或删除，旧导出 / pending-wake bridge 清理，架构事实文档 | 所需 S3–S6 路径与各客户端已验收 | 消费者归零；新旧不能同时执行；fixture 迁移 / 回退 / 打包验收齐备，旧表最后 contract。独立删除 PR |

不以包数量、代码行数或搬了多少文件验收。每个 PR 都应说明一个用户行为、旧调用→新调用、失败时的结果与旧 adapter 退出条件。生产路径修改需相应 runtime / UI / 打包检查。

## 现有模块 → 目标归属

| 现有模块 / 旧任务 | 目标与退出条件 |
| --- | --- |
| `host/config-agents`、Desktop `config/bot-*`、485 | S1：Host 单写入口、规范 Bot view；保留 TOML / profile 兼容，旧 writer 消费者为零后删除 |
| protocol wake + core wake queue | 复用；S2 只迁 Bot 特有规则，不复制来源类型或通用队列 |
| Desktop `wake/*`、473 调度部分 | S3：Host Bot dispatcher；Desktop 只发送命令 / 展示状态，移除 renderer claim 执行权 |
| data `pending-wakes`、484、610 T22 | S3/S4：统一 delivery reconciliation 合同；T22 通用子会话完成事件仍由 610 owner 提供，Bot 只消费，不能两边实现同一唤醒 |
| Desktop `automation/*`、475、478 | S6：复用 Scheduler 与 routine 定义，触发适配器调 Bot acceptInput；通用非 Bot automation 保留原所有者 |
| Desktop `channels/*`、488、503 | S4：Host adapter + vault / connector 端口；不把 channel transport 和 AppConnector 视为同一概念 |
| `host/worker-prompts/bot`、474、479、536 | S5：有类型且受授权的 context；模板仍经既有 prompt 管线，memory 状态由 memory owner 维护 |
| `host/worker-tools/bot-builtin`、490 | 继续用现有 capability 工具，通过 Host Bot service 端口调领域；不在 bot 包实现 Shell / MCP |
| ui Bot chat / store、489、491 | S4 / S7：卡片和状态使用统一 query/event 投影；不以 SSE done 冒充对外投递完成 |
| DM / room、492、478 | 复用 Session / message envelope；S4 / S6 保持授权、hops 与防循环预算，不重做编排器 |

473–503 的历史 checkbox 不在本次批量改写。上述表只记录新合同覆盖关系；每个执行切片进入旧任务代码前，核实其剩余行为并在原计划加具名后继，确认完成或转交后再归档，避免两套调度工作队列。

## 风险、回退与数据窗口

| 风险 | 切流前证据 | 回退动作 |
| --- | --- | --- |
| 新旧调度同时执行 | 持久 owner epoch + 旧入口拒绝 + 双启动故障测试 | drain/暂停输入 → 交接 owner epoch → 切 adapter；禁止两者同时消费 |
| Run 受理后响应丢失 | 同 dispatchKey 查回 canonical runId；重启故障测试 | 保留 journal 对账；未可恢复 Run 标为 recovery_required，不盲目重跑 |
| 新 inbox 不能被旧版本理解 | 旧 marker 导入 dry-run、旧 reader 兼容夹具、记录新版本最低要求 | 先 drain 新队列或用有损项显式报告的 back-export；不能只 git revert |
| 身份文件与配置不一致 | 每个写入步骤 crash fixture，revision 冲突与修复 | durable create/update intent 驱动补齐，保留原始文件副本 |
| 远端动作已完成但 receipt 丢失 | provider 幂等 / 查询能力合同，unknown 路径演练 | 暂停 outbox，人工或 provider receipt 对账，不自动补发 |
| prompt 变动与目录迁移混杂 | 相同输入快照和工具 manifest 对照 | 保留旧组装 adapter；人格 / policy 变更分开开关与评审 |
| 机器离线被误报为持续服务 | resident 健康、租约与 catch-up 测试 | UI 明示离线与待处理，不承诺断电运行 |

迁移开关是设计要求，当前尚无这些开关：按 Bot ID 选择调度 owner，初始默认 legacy。shadow 只做只读比较，不调模型、不写 memory、不发工具与消息。切换步骤与 owner epoch 必须作为同一迁移命令校验；schema contract 只在回退窗口关闭后进行。

## 实施验收矩阵

每条由对应切片新增或复用具名测试；下表是待实现的测试要求，不能读作本次已通过。

| 场景 | 必须观察到的结果 | 所属 |
| --- | --- | --- |
| 同一 owner 由 Desktop 与 TUI 并发创建 / 更新 | 一份身份，requestId 去重，revision conflict 明确返回 | S1 |
| 同输入重投、两个 Bot 同 workId | 同 Bot 重投同 receipt；不同 Bot 相互隔离 | S3 |
| 在 inbox commit 后、dispatch 后、Run terminal 后杀 Host | 逐点重启对账，无丢失义务、无第二 executor | S3/S4 |
| user 抢占 background、旧 worker 延迟回报 | 绑定具体 runId/attempt；fence 拒绝旧写入；后台义务保留 | S3 |
| 最后客户端离开 / 重连 | resident 继续；client-scoped 行为不变；重连只读 replay | S3 |
| 发送已成功但未记 receipt | 幂等 provider 对账；不支持的进入 unknown，不能假成功 | S4 |
| 外部群成员 / DM 冒用 owner | 无权改 policy 或批准动作；记忆按受众过滤 | S4/S5 |
| 项目 membership 撤销、记忆遗忘后再压缩 | 立即禁止召回；旧摘要不复活记忆；审计保留边界明确 | S5 |
| 用户时区、DST 跳时 / 重复时、机器错过三天 | nextFire 与 fireKey 确定；按 misfire 策略限量补偿 | S6 |
| 预算并发预留、安静时段、暂停在途 / 排队责任 | 无超额派发；不重复打扰；审批与撤权照常生效 | S6 |
| 新增第二渠道 / 插件 | 改 adapter 不改领域与 Run loop；conformance 与真实接线通过 | S4/S7 |
| 旧版本 fixture 升级后回退 | 保留身份、历史、未投递义务与已完成动作；冲突可报告 | S7 |

每片执行根门禁；变更 main/preload 需 Electron 构建与真实桥；UI 用 Playwright；worker 或依赖 / 打包边界需重新构建并验证真实 Host→worker→provider 夹具→ledger。已有单测通过不替代后台 resident 和恢复链路。

## S0 执行记录（2026-10-25）

已实现、已验证、未合并。分支 `codex/bot-framework-s0`（base＝本计划分支 `plan/bot-framework-foundation` @ `1618a909`，PR 目标 master，交付 commit `24590d10`）；worktree `.claude/worktrees/bot-framework-s0`；owner 本会话。622 真实 head 核对：01 已合并（#399）、02 已合并（#405，README 状态滞后）、03/04 仍 todo——S0 依赖的 slice-graph / 门禁基建已就绪。

**交付（S0 = 1 个门禁 PR）**

- `scripts/architecture/bot-boundary-gate.mjs/.ts/.test.ts`，三条规则：
  - **R1 bot 下向**：`packages/bot/src/` 出现后，其全部非测试源文件的 value import 只允许 `@duya/agent-protocol` / `@duya/agent-core`；种子覆盖全部源文件而非 barrel，子路径无法绕过；不穿行 allowlist 包（agent-core 自己的依赖归它自己的门禁管）。包未提出时如实报 `pending`，目录存在但无源码报 `blind`。
  - **R2 反向边**：`agent-protocol / agent-core / agent-runtime / data / memory` 五包不得 value-import bot（"runtime 不知道 bot 存在"是 import 语句级语义，直接边扫描）。
  - **R3 客户端轴**：`packages/ui` / `packages/client-core` 不得 value-import `@duya/host` 或 desktop main / preload / renderer（622-05 的 Bot 切片；`packages/cli` 不在本规则内，其本地 Host 启动边归 G11-1 管）。
  - 防假绿：scanned 只计成功读取的文件并设 floor（R2≥100、R3≥100，实测 333 / 652）；Windows 瞬时读失败重试一次，仍失败计入 `unreadable` 上报。首版曾把 walk 计数当 scanned、且绝对路径转换错误导致全树假绿，被 census 全 0 暴露后重写——该教训已写进代码注释。
- `--census`：可复跑的消费者清单探针（下表）。
- 接线：`npm run architecture:bot-boundary`、test.yml architecture job 新 step、`architecture-ci-wiring.test.ts` 断言（防"有门禁没人跑"）。
- 测试 13 例：live 树绿（R1 pending / R2 R3 零发现、unreadable=0）＋三规则变异红→绿（value import 红；demote 成 `import type` 后绿且 typeOnly 计数可见）＋ blind/finding 拒绝判定＋ census 组存在性断言（含"退役层 `packages/agent` 是 host bot prompt 最大消费方"这一承重事实，移动归属时必须同 PR 更新）。

**反向边探针（本次树实测）**：UI / client-core → host / desktop 的 value 与 type 边均为 0；agent-core / runtime / protocol / data / memory → host / desktop 均为 0；host Bot 模块 value 闭包内 host 文件 187 个，全部下向包，不触 desktop / electron 路径。

**消费者清单**（`node scripts/architecture/bot-boundary-gate.mjs --census`；完整数字可复跑）

| 组 | 消费者要点 | 迁移注意 |
| --- | --- | --- |
| host/worker-prompts/bot（24 文件） | 29 个消费者；最大方是退役层 `packages/agent`（25 文件），desktop 仅 3（wake-dispatcher / routine-wake / config/groups） | S5 prompt 快照的现役面；退役层镜像副本是 S2 提包时的主要清退对象 |
| host/worker-prompts/configs/bot、worker-tools/bot-builtin | 各 1–2 个消费者，均含 agent 镜像 | 同上 |
| host/config-agents/bot-*（3 文件） | host 内部 2 处 | S1 Host 单写入口落点 |
| data/pending-wakes + protocol/wake* | data 4 / protocol barrel 1 | S3 inbox 合同的现有底座 |
| desktop/wake/*（19 文件） | 11，全部 desktop 内部 | S3 退役对象；现状 desktop 串联合同的实证 |
| desktop/channels/*（23 文件） | 7 | S4 退役对象 |
| desktop/automation/*（28 文件） | 14 | S6 复用 Scheduler，触发适配 |
| ui/chat/bot*（50 文件） | 2（Composer / GroupRoomChatView） | S4/S7 统一投影 |

**行为基线**（本检出实测全绿；迁移切片以同名测试对照，不以数量对照）

| 域 | 具名测试 | 结果 |
| --- | --- | --- |
| 身份 | `config-agents-write` / `agent-profile-config` / `worker-db-bridge-config-agents` / `bot-toolset` | 4 文件 29 用例 |
| prompt | host `tests/worker-prompts/`（partition / profile-sections / mode-composition / digest） | 4 文件 28 用例 |
| wake | desktop `wake/__tests__/`（dispatcher / preemption / idle / automation / ack-redrive / watchdog 等） | 10 文件 94 用例 |
| 投递 | desktop `channels/__tests__/`（delivery / telegram connector+offset / inbound-filter / secret-store 等） | 9 文件 117 用例 |
| bot 专属桌面面 | ipc `bot-channel-handlers` / config `bot-profile`+`bot-identity-rpc` / cli `bot-channels` / agents router `provider-fallback` | 5 文件 46 用例 |

## S1 执行记录（2026-10-25）

已实现、已验证、未合并。分支 `codex/bot-framework-s1`（base＝master `f24166ec`——S0 已由用户合入 #495，S1 提交 rebase 至其上，PR 目标 master）。

**交付（S1 = Host Bot 接口，1 个窄 PR）**

- `@duya/agent-protocol/bot-api`：Bot 身份的 wire DTO——`BotRecord`（canonical 视图：profile.json 优先、config 兜底、id 最后）、`CreateBotCommand`（带 `requestId` 幂等）、`UpdateBotCommand`（带 `expectedRevision`）、`BotCommandReceipt`（形状兼容 legacy `{id,name}`）、`BotErrorCode` 四值联合。只放身份：调度 / inbox / 投递的 DTO 属于 S3/S4，wire 不承诺未实现的行为。
- `config.toml` schema 增加 `revision` 字段：facade 创建=1、每次 facade 更新 +1；0=前 facade 时代条目。facade 是唯一 revision 权威。
- `host/src/bot/`：`ports.ts`（ConfigStore/Profile 两个端口，Host 文件后端与 Desktop store 后端各一套适配器）、`journal.ts`（`<agentsRoot>/.identity-journal.jsonl` 追加式意图账本：create/update 意图先行，applied 标记收尾，requestId→receipt 去重跨进程存活，损坏尾行计数不炸加载）、`service.ts`（应用服务：create/update/get/list/repair；revision 冲突以 `bot_revision_conflict` 结构化拒绝并携带 stored/expected；update 一个意图覆盖 config + profile 两处身份写入，repair 同步补齐）、`bridge-assembly.ts`（bridge 惰性单例，首分发执行 repair）。
- 接线：`worker-db-bridge` 的 legacy `config:agents:create/update` 改走 service（响应形状不变），新增 `bot:create/update/get/list` 四动作；Desktop `db-bridge` 同构（store 后端适配器 `bot-application.ts`）。Desktop 与 TUI 从此共用同一套 create/update/read 语义。
- 未新增第二调度器：Desktop wake dispatcher 仍是唯一调度 owner（S3 前置合同）。

**测试（22 例新增，全绿）**：service 14（canonical 视图合并、revision 冲突结构化拒绝、requestId 去重同进程+跨进程、崩溃窗口 repair 四态：create 补齐/确认已应用/冲突保留/torn tail 计数、软删过滤、内存端口同用例）+ bridge 8（legacy 形状回归 + bot:* 全契约）。

**过程中的实证教训**（已写进代码）：journal 意图行初版漏写 `v` 字段，被自己的加载守卫判为 corrupt，dedup/repair 全部静默失效——由测试暴露后修复 writer 而非放松 guard。Windows 瞬时文件锁的处理延续 S0 的 readImports 重试约定。

## S2 执行记录（2026-10-26）

已实现、已验证、未合并。分支 `codex/bot-framework-s2`（base＝S1 分支 `codex/bot-framework-s1` @ `9fdf40fe`，栈式 PR）。实现由子 agent 在专用 worktree 执行、协调者独立复核全部门禁。

**交付（S2 = packages/bot 领域包提取，纯移动）**

- `packages/bot`（name `@duya/bot`，managed）：`src/domain/`（BotIdentityEntry 及子形状、BotProfile 纯类型、applyIdentityPatch/buildUpsertedAgent/canonical 合并/bot-id 纯规则、BotServiceError；allocateBotId 的随机后缀改为注入 `randomSuffix`）；`src/journal/`（BotIdentityJournalState 纯状态机 + InMemoryBotIdentityJournal，文件格式与文件名不变）；`src/ports/`（IdentityStorePort/ProfilePort/JournalPort）；`src/application/`（createBotService，repair/revision/requestId 语义一字未改）。
- Host 侧 `host/src/bot/` 变薄为适配器：toml-config-store / fs-profile-store / file-journal + 组装；index.ts re-export S1 全部导出名——`apps/desktop` 零 diff（git diff 为空），`worker-db-bridge.ts` 一行未改。
- 接线：`architecture-policy.yaml` 声明 bot 模块（managed、requires [agent-protocol]、host.requires + bot）；`scripts/build-packages.mjs` BUILD_ORDER 插入 @duya/bot；vitest.config WORKSPACE_SOURCE_ALIASES + bot。三个 baseline JSON 一字未动。
- 测试：S1 的 22 例语义原样保留（host 文件后端 13 + bridge 8 + 内存 1），新增 21 例纯测试（注入式后缀、状态机接缝、100 次耗尽/截断/corrupt/seq 续号/dedup 仅对 applied 生效）。

**门禁翻转**：bot-boundary gate R1 由 PENDING 翻为 **MEASURED，9 个 bot 源文件 0 findings**（import 闭包仅 agent-protocol）——S0 预言的"包出现即受测"成立。R2 OK(336)、R3 OK(654)。

**验证**（协调者独立复核）：build:packages 0（bot 先于 host）；vitest 5 文件 43 例全绿；typecheck:all 0；architecture:check 新增违规 0（3 条既有 fingerprint 失效未 --write）；retirement ratchet 772/772；host 全量 2000 passed / 5 skipped；desktop diff 空；packages/bot/src 零 `node:*` 导入。

**裁量记录**（子 agent 报告，协调者认可）：randomSuffix 为可选注入（bot 内 Math.random 兜底，host 注入 crypto——保 desktop 零 diff）；worktree 内手工补 @duya/bot junction（junction-worktree.mjs 从主检出枚举包，看不见本 worktree 新包）；boundary-gates LAYERS 未动（host 本不在 LAYERS scope，bot 仅 import protocol 无 finding）。
## S1–S3a 集成前重 base（2026-10-26）

三条 PR 在 `d80ca3c6` 上全部 DIRTY。冲突只落在被跟踪的生成产物 `packages/host/bundle/{worker-entry.js,worker-metafile.json,BashTool/BashWorker.js}`，源码零冲突；处理方式与「S0 执行记录」同一条：重放源码提交后 `npm run bundle:worker` 重生成并提交产物，不手工合并生成内容，细则见[构建](../../development/build.md)。

| 分支 / PR | base | 新 head | 历史处理 |
| --- | --- | --- | --- |
| `codex/bot-framework-s1` / #500 | `d80ca3c6` | `a04b6d27` | 8 个提交原样重放，末尾补 1 个产物提交 |
| `codex/bot-framework-s2` / #502 | 新 S1 head | `5e06887a` | 只重放 5 个真实提交；丢弃 2 个纯产物提交与 1 个空 CI retrigger 提交，末尾统一重生成一次产物 |
| `codex/bot-framework-s3a` / #503 | `d80ca3c6` | `01342b44` | 1 个源码提交 + 1 个产物提交 |

净评审面不变（22 / 47 / 10 文件）。三条最新 head 的五检查 architecture / build / test / test scope / typecheck 全部 pass，`mergeable=MERGEABLE`、`mergeStateStatus=CLEAN`。

合并顺序仍是 #500 → #502 → #503（见交接文档「接手的第一步」）。因为 `packages/host/bundle/` 是被跟踪产物且每条分支各自重生成过一次，**每合并一条，剩余分支都会重新变 DIRTY**；一次重同步只需 `git rebase origin/master` + `npm run bundle:worker` + 提交产物，本次实测单条约 5 分钟本机验证（不含 CI 等待）。

重 base 用的检出：`.claude/worktrees/bot-rebase`（本切片独占）。三个来源检出 `.claude/worktrees/bot-framework-s0 / -s2 / -s3a` 仍停在被替换掉的旧 head（`e20e5ccc` / `3a35e047` / `6c5d6229`），PR 未合并前保留，但**从这些检出再次强推会把冲突态历史推回去**，接手方先确认 owner 已退出。

## 关键决策

- 本次 master 从 `2baa95df` fetch 到 `270ba528`，master pull --ff-only 成功；原 `work` 分支保留。最新 tree 与旧会话时间点明显不同，全部迁移定位以最新源码为准。
- 目标一个 `@duya/bot` 领域包；Host 保留 I/O、工具和执行装配，data / memory 保持原所有权。先接缝、再门禁与提包、最后增强。
- Bot lifetime、Session、Run、AgentProfile、Responsibility 分别建模；不新增第二套任务 / Run 状态机。
- 现有 pending_wakes / Host CRUD 不足以证明可靠后台服务；Run dispatchKey 幂等 receipt 是生产切流硬前置。
- 四产品映射与官方链接已由用户确认。Muse 公开了部分安全架构，但四产品都没有提供本次所需的完整崩溃恢复 / 副作用重放合同；不能视为完整开源实现。旧助手正文仍无法读取。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| 起始 `2baa95df` | Linux / Git | status、fetch、master pull --ff-only | 0；到 `270ba528`，master 与远端一致 | Git log / origin/master |
| 干净源码 `270ba528`，仅依赖链接 | Linux / Node 24.19.0 | junction-worktree dry-run / setup | 0；独立 workspace overlay | 54 links；不穿链接 install |
| 同上 | 默认 sandbox | architecture:check / typecheck:all | 2 / 1；child process spawn EPERM，尚非代码失败 | 已申请正常子进程权限重跑 |
| `270ba528`，文档新增；无代码修改 | Linux / Node 24.19.0，允许子进程 | `npm run architecture:check` | 0；2841 findings 全为既有 tolerated，新增违规 0 | 未改 baseline；不能据此声称历史债已清 |
| 同上；构建依赖为共享第三方目录 | 同上 | `npm run typecheck:all` 首次有效运行 | 2；capabilities build 的 TS7016：缺少 @types/picomatch | manifest / lock 已声明，当前共享安装未提供；只在独立 work 目录补齐后重试 |
| `270ba528` + 本次 7 文档 | Linux / Node 24.19.0 / TypeScript 5.9.3 | `npm run typecheck:all` 完整重跑 | 0；含全部 workspace 构建与类型 / ratchet / recorder checks | 同一 @types/picomatch 4.0.3 在独立 work deps 安装，仅为 capabilities / host 建本检出私有 overlay；共享依赖未写入。不是 clean install / 跨平台 CI 结论 |
| `270ba528` + 仅本次文档 | Linux / Node 24.19.0 / Vitest 3.2.4 | `node node_modules/vitest/vitest.mjs run packages/agent-core/test/profiles/bot-toolset.test.ts packages/host/tests/config-agents-write.test.ts packages/host/tests/agent-profile-config.test.ts` | 0；3 文件 / 25 用例通过 | 真实已有测试；复用当前安装，非 clean npm ci / CI 证明 |
| 同上 | 同上，Electron binary 缺失 | 先前 4 文件运行另含 Desktop wake-dispatcher、channel-ack-redrive 两 suite | 1；Host 14 用例通过，2 wake suite 在加载期失败：Electron failed to install correctly / fetch failed | 没有执行到 wake 断言；不下载或删除共享 Electron 安装，不将其写成回归通过 |
| 同上 | Python 3 / Git | 7 文档 UTF-8、相对链接、tracked/planned visibility 对照 base | 新断链 0；138 条本地链接中 1 条 base 已失效 | 原有 README→2026-10-24-dynamic-workflow-package.md 不在 base tree，本次未修改 |
| 同上 | Git | `git diff --check` / 三个新增文件 check-ignore | 0 / 未被忽略 | 本次只暂存 7 个具名文档 |
| `1618a909` + S0 三件套与接线 | win32 / Node 24.16.0 / Vitest 3.2.4 | `npx vitest run scripts/architecture/ --no-file-parallelism` | 0；19 文件 335 用例全绿（含本次新增 13 例与 wiring 断言） | 1 个 vitest worker RPC 超时噪音未影响结果；本机内存压力需单文件串行 |
| 同上 | 同上 | `npm run architecture:check` | 0；无新增违规 | 2 条既有 baseline fingerprint 失效为既有债务，未顺手 `--write` |
| 同上 | 同上 | `node scripts/architecture/bot-boundary-gate.mjs` 与 `--census` | 0；R1 pending / R2 OK(333) / R3 OK(652)，PASS | 消费者清单见 S0 执行记录 |
| 同上 | 同上 | 行为基线五组（见 S0 执行记录表） | 0；全绿 | 首次 identity 运行 1 文件加载失败，归因 C 盘 0 可用（工具 stdout 落 C:%TEMP%），清理后重跑全绿；本机 Electron 可加载，#483 记录的 Linux wake 加载失败未复现 |
| 同上 | 同上 | `npm run typecheck:all` | 0；含全部 workspace 构建与类型 / ratchet / recorder checks | 本检出 junction 依赖直接通过（@types/picomatch 已在树内），无需 #483 时代的私有 overlay |
| 同上 | Git | 暂存具名文件（gate 三件套、package.json、test.yml、wiring 测试、本计划、README 行） | — | 不入 Git：junction 链接、/e/tmp 日志 |
| `24590d10` 首推 | ubuntu 22.x CI | architecture job | 1；agent-retirement reference ratchet FAIL：773/772，测试断言字符串字面量新增 1 条退役层引用（`bot-boundary-gate.test.ts:333`） | ratchet 只减不增，禁 bump baseline；修法=断言去退役路径字面量，改钉结构性事实（成员/消费方数下限+desktop 接线），退役层身份由 census 输出与计划文档承载 |
| `c8946122`（ratchet 修复后 head） | win32 本地 | `node scripts/architecture/agent-retirement-gate.mjs`（pipefail 取真实退出码） | 0；ratchet PASS 772/772 / 0 new | 本地与门禁+retirement 测试 24 例全绿 |
| `d80ca3c6` + S1 重放 8 提交＋产物重生成 | win32 / Node 24.16.0 / TypeScript 5.9.3（检出 `.claude/worktrees/bot-rebase`，junction 依赖） | `npm run architecture:check` | 0；无新增违规 | 2883 findings 全为既有 tolerated；3 条 baseline 指纹失效未 `--write` |
| 同上 | 同上 | `npm run bundle:verify` | 0；FRESH 0/991 | 产物先取 base 版本占位，末尾一次重生成后转 FRESH |
| 同上 | 同上 | `node scripts/architecture/bot-boundary-gate.mjs` | 0；R1 pending / R2 OK(336) / R3 OK(651) | 与 S0 记录同判定 |
| 同上 | 同上 | `npm run typecheck:all` | 0；含全部 workspace 构建 | 首跑前需先 `build:packages`，否则 host 测试加载期报 `@duya/plugin-core` 子路径解析失败 |
| 同上 | 同上 | host bot facade 2 文件＋身份 3 文件 | 0；22 例（首轮另 39 例含 1 文件加载失败） | 失败归因新检出缺 dist，构建后复跑全绿；未跳过用例 |
| 新 S1 head + S2 重放 5 提交 | 同上 | architecture / `bundle:verify` / bot-boundary / retirement | 0；FRESH 0/1000 | R1 转 MEASURED：9 个 bot 源文件 0 禁止边；ratchet 不增 |
| 同上 | 同上 | `packages/bot` + host bot + 身份 8 文件 | 0；68 例 | S2 为纯移动切片，行为夹具不变 |
| 同上 | 同上 | `npx vitest run scripts/architecture/ --no-file-parallelism` | 1；19 文件 335 用例全过 | 退出码来自 `[vitest-worker]: Timeout calling "onTaskUpdate"` 未处理错误，与 S0 记录同签名，无用例失败 |
| 同上 | 同上 | `npm run typecheck:all` | 0 | 前置：手工补 `@duya/bot` 的 overlay 链接，见[worktree](../../development/worktree.md) |
| `d80ca3c6` + S3a 重放 1 提交＋产物重生成 | 同上 | `packages/data` 全套 17 文件 | 0；115 例（含 `bot-inbox-store` 30 例） | S3a 只改 data / protocol，不触 host 源码 |
| 同上 | 同上 | `bundle:verify` / `architecture:check` / `typecheck:all` | 0；FRESH 0/990 | 清理本切片构建残留（ignored `packages/bot/`）后 bot-boundary 回到 R1 pending PASS——残留会让 R1 报 BLIND 并 FAIL |
| 三条最新 head `a04b6d27` / `5e06887a` / `01342b44` | ubuntu 22.x CI（PR #500 / #502 / #503） | architecture / build / test / test scope / typecheck | 全 pass | #500 test 8m2s、#502 test 8m0s、#503 test 9m51s；CI 结论覆盖本机验证 |
| 同上 | Git | 三条远端分支 `--force-with-lease` 重推 | 0 | 外部副作用仅远端分支与 PR head；未合并、未发布、未回收任何检出 |
| `c8946122` | ubuntu 22.x CI（PR #495） | architecture / build / typecheck / test / test scope 五检查 | 全 pass；test 8m33s 含新测试文件在 Linux 首跑 | CI 结论覆盖本机验证；PR 待 review 与集成授权 |
| S1 全量（host src/bot + protocol bot-api + 两 bridge + schema revision） | win32 / Node 24.16.0 / Vitest 3.2.4 | `npx vitest run packages/host/tests/ --no-file-parallelism` | 0；1984 passed / 5 skipped（含 S1 新增 22 例与既有 identity/prompt 基线） | host 全域回归 |
| 同上 | 同上 | `npm run build:packages` / `npm run typecheck:all` | 0 / 0 | workspace 全构建与类型门禁 |
| 同上 | 同上 | apps/desktop tsconfig.main tsc --noEmit | 206 errors＝base 基线逐条持平，本次 0 新增 | desktop main 预存错误按文件归因（base 对照） |
| 同上 | 同上 | `npm run architecture:check` / bot-boundary gate / agent-retirement ratchet | 0 / PASS（R3 652） / PASS 772/772 | 三门禁全绿；2 条既有 fingerprint 失效未顺手 shrink |

## 接续 / 结果

实施期的状态、已定合同与剩余切片的开工指引另见[交接报告](2026-10-26-personal-bot-framework-handoff.md)。

已完成源码调查、设计与文档验证，生产实现未开始。设计交付 commit：`eaf9d86d`；后续仅补本节的 PR 接续记录。只提交 7 个具名文档；依赖 symlink、私有 work deps / 日志不入 Git，构建未产生需提交的源码差异。外部副作用：任务分支已推送并创建 draft PR；未改用户 DB、未合并或发布产品。

PR：[draft #483](https://github.com/lava-chen/duya/pull/483)，待 review / CI；没有申请或执行合并。当前工具无法读取原 ChatGPT 完整线程；必要时由后续对话补全文，不阻塞有源码支撑的方案。
回收：保留 worktree 与分支，等待设计 review / PR 集成，不执行删除。

**S1–S3a 重 base 接续（2026-10-26 第三会话）**：三条 PR 已重 base 到 `d80ca3c6` 并推最新 head，冲突归零、五检查全绿（详见上方「S1–S3a 集成前重 base」与其验证行）。外部副作用：三条远端分支被 `--force-with-lease` 覆盖，来源检出保留在旧 head 未回收；未合并任何 PR，未发布。已实现的记录落点：本次重 base 的历史收紧只发生在 #502（丢弃 2 个纯产物提交与 1 个空提交），源码 diff 未变。**下一步**：等集成授权按 #500 → #502 → #503 逐条合并；每合一条，对下一条重复 `git rebase origin/master` + `npm run bundle:worker` + 提交产物并重跑门禁。S3b（#504）当前 CI 有 2 处失败且仍 CONFLICTING，排在 S3a 集成之后再处理。

**S0 切片接续（2026-10-25 第二会话）**：`bot-boundary-gate` 三件套＋CI 接线＋census＋四域行为基线已在本节上方「S0 执行记录」落地并全量验证；PR：[#495](https://github.com/lava-chen/duya/pull/495)（base＝`1618a909`，目标 master；diff 含 #483 的 7 个文档祖先提交，review 面只有 S0 commit `24590d10`）。S0 的验收——Bot→Host / UI→Host 反向边变异红→绿、具名行为基线——已满足：门禁 13 例（3 规则变异＋live 树绿＋census）＋ 既有行为测试五组全绿。外部副作用：仅远端分支与 PR，未合并；worktree 保留待 review。**下一步**：S1 Host Bot 接口（`host/src/bot` facade / ports、protocol 最小 DTO、profile 写入接缝，旧 Desktop 调度作过渡 adapter）；进入前先核对 #483 与本 PR 的 review 状态，S1 的 facade 在 S3 durable 受理落地前只能委托旧调度器。

**S1 切片接续（2026-10-25 第三会话）**：Host Bot 接口已落地（见「S1 执行记录」），分支 `codex/bot-framework-s1`（base＝master `f24166ec`，S0 已合并后 rebase）。S1 验收——Desktop/TUI 同一 Bot 语义、revision 冲突结构化拒绝、requestId 跨进程去重、身份 journal 崩溃修复——已由 22 例具名测试满足；两 bridge legacy 形状回归全绿。**下一步**：S2 提取 `packages/bot` 领域包（domain/application/ports 下沉、host adapter、workspace/build/gates 接线、bot-boundary gate R1 由 pending 翻为 measured），前置＝S1 PR 集成或与 S0 同栈评审。

**S2 切片接续（2026-10-26 第四会话）**：packages/bot 提取已落地（见「S2 执行记录」），R1 门禁已翻 MEASURED。**下一步**：S3 持久唤醒与 resident——S3a 存储合同（bot_inbox + bot_dispatch_receipts + reserve/confirm receipt 操作）已派发；S3b 为 openRun 加 dispatchKey 幂等受理接缝（receipt 预留 runId，复用 Control Plane 的 reused 拒绝重派语义）+ Bot dispatcher + resident lease；S3c Desktop bot handler 转发切流。
