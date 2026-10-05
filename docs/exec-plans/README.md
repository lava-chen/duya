# Execution Plans

> **This is the first place to check before any work!** See workflow below.

***

## Quick Workflow

```
1. Read Active Plans below — each row states ONE concrete next action.
2. Pick the top row, read that plan file, execute its next action.
3. When it is done: `git mv` the file into completed/ and drop its row here.
4. New idea, not committed to? Put the file in backlog/ and add a Backlog row.
```

***

## Structure

```
exec-plans/
├── active/    # the only commitment list. Every row has a concrete next action.
├── backlog/   # designed but unstarted. Not a commitment; no row promises work.
└── completed/ # finished plans, kept for decision logs — LOCAL ONLY, not in git
```

The tech-debt ledger now lives with plan 587, which is the single execution
route for the monorepo / agent-harness work:
[`587-agent-harness-monorepo/reference/10-tech-debt-tracker.md`](./active/587-agent-harness-monorepo/reference/10-tech-debt-tracker.md).
The old `docs/architecture/` series and `MONOREPO_RFC.md` were moved into
`587-agent-harness-monorepo/reference/` and are marked historical — they are
decision logs, not a second ordering. (`docs/architecture/README.md` and the
root `MONOREPO_RFC.md` remain as pointers to that directory.)
A stale `exec-plans/tech-debt-tracker.md` from 2026-08 may still be on disk; it
is not the ledger and is not tracked.

**What is in version control:** `active/` and `backlog/` only — those are what a
new session reads. `completed/` is a local archive, so the Completed section
below names plans in **plain text rather than links**: 264 of the 366 completed
plans on disk were never committed, and a link to them would be dead on a fresh
clone. A plan becomes tracked when it is written, and stays tracked after it
moves to `completed/` only if it was already added.

Rules:

- **active/** is a commitment list. A plan belongs here only if it has a
  next action someone could start today. Cap it; do not let it grow back.
- **backlog/** is an idea shelf. Leaving something here is a valid outcome.
- A plan leaves `active/` the moment its last phase lands, not when someone
  remembers to archive it. Status headers in plan files are advisory only —
  this index is the source of truth.

***

## Verified baseline (2026-10-03 · `master @ 1e6d0b0e`)

**Read this before picking up any plan.** Every number here was measured, not
copied from a plan file. `npm test` was measured **twice, on two platforms** —
they do not agree, and the CI number is the one that matters.

### Gates

| Command | State | Note |
| --- | --- | --- |
| `npm run typecheck:all` | ✅ exit 0 | **本地必须从干净检出验证；CI 已于 PR #135 在 ubuntu/windows/macos 三个 runner 上全绿** |
| `npm run architecture:check` | ✅ exit 0 | 801 violations, 0 blocking, baseline 799（2 条已失效指纹经分类后手工删除） |
| `npm run architecture:self-test` | ✅ exit 0 | 547 / 35 / 16 / 162 / 25 / 16 / 0 |
| `npm run check:encoding` | ✅ exit 0 | |
| `npm run check:test-coverage` | ✅ exit 0 | 1 known orphan in baseline |
| **`npm test`** | ❌ **exit 1** | **失败文件数：本地 (Windows) 45 / CI (ubuntu) 64。失败"测试数"不是基线——它随构建状态变（clean 75 → build 后 101）。权威口径是 (file, test, signature) 集合，见下。** |

**只有"失败文件数"是可比的，测试总数不是。** 本地 (Windows) 实测 **45 个失败文件**，
可从两种状态复现（clean 安装 75 个失败测试 / build 之后 101 个失败测试）——
所以 45 站得住，测试总数站不住，因为分母（collect 量）本身随构建状态变。
CI (ubuntu, run `37099318050`, 同一 SHA) 实测 **64 个失败文件**，collect 量与本机一致
(1009 文件 / 11873 测试)。本机侧的权威口径是 G0.1 记录的 **103 个
(file, test, signature) tuple**，分类 77 deterministic / 25 environment-infra /
1 已证 flake（二次运行证实）。

> 本行曾发布 "Local (Windows): 45 files / **112** tests"。**112 既非 COLD (75) 也非
> WARM (101) 任何一种状态**，且 `1e6d0b0e..0e13d4cd` 之间没有任何测试文件改动，
> 因此它无法从任何状态复现。**一个复现不出来的数字不是基线**，已删除而非替换。
> 比较一律按 (file, test, signature) 集合做，不按总数——总数正是当初把这一行写错的
> 原因。证据见 `docs/exec-plans/active/587-agent-harness-monorepo/11-execution-log.md`。

### ⚠️ 硬规则：本地绿 ≠ CI 绿，**反过来也成立**

**报告任何闸门结果前，先确认它是"干净检出"跑出来的，并且知道它跑在哪个 OS 上。**

这不是理论，而且**两个方向都翻过车**。

**方向一（本地绿 / CI 红）—— 已修。** 2026-10-03 实测：`typecheck:all` 本地
**exit 0**，CI **连续 6 次全红**，每次都挂在 `Run typecheck`。根因是
`typecheck:all` 依赖 `packages/agent-protocol/dist/`，而本地那个 `dist` 是历史
`build:agent` 的残留 —— **本地那个绿是缓存的产物，不是证据**。
已由 PR #135 修复（`typecheck:all` 现在按依赖顺序先 `build:protocol` →
`build:core`；三个 agent 包的 `clean` 同时删 `tsconfig.tsbuildinfo`），
并已在 `37095893167` 上于 **ubuntu / windows / macos 三个 runner 全部验证通过**。

**方向二（本地红得少 / CI 红得多）—— 仍然成立，且尚未修。**
`npm test` 本地 45 个文件红，CI **64** 个红。同一份代码，差 19 个文件。
详见下一节。那 22 个 CI-only 失败里有一组是**权限检查在 Linux 上不触发**，
只看本地 `npm test` 的人永远不会知道它存在。
这是**文件集合**的对比，不是测试总数的对比——两边的测试总数口径不同，不可相减。

复现 CI 条件：

```bash
# 把所有 workspace 的 dist 与 tsbuildinfo 移开，等价于干净检出
for d in packages/* apps/desktop; do
  [ -d "$d/dist" ] && mv "$d/dist" "$d/dist.ci-sim"
  [ -f "$d/tsconfig.tsbuildinfo" ] && mv "$d/tsconfig.tsbuildinfo" "$d/tsconfig.tsbuildinfo.ci-sim"
done
npm run typecheck:all          # 期望 exit 0
```

`npm run build:agent` 之后可以把 `.ci-sim` 后缀的目录丢掉。

> **同一类病已出现三次**：TD-0 是 architecture baseline 用旧 resolver 录的；
> TD-7 是 `tsconfig.tsbuildinfo` 在 `dist` 没了之后仍声称"已构建"；
> TD-8 是测试基线只在一个 OS 上量过一次。
> **共同教训：任何"上次跑过就跳过"的机制，都必须在产物消失时失效。**
> 不失效的结果是本地永远绿、干净环境永远红，而差异要到 CI 才暴露。
> 同一句话换个主语也成立：**任何只在一种环境下量过的数字，都不是基线。**

### 查闸门状态先看 CI，不要只信本地

```bash
gh run list --limit 5              # 最近运行
gh run view <id>                   # 哪一步挂的
gh run view <id> --log-failed      # 实际错误
```

**用时长判断失败位置比读日志快。** `Run typecheck` 挂了 → 整个 run 约
1m30s 就结束（本地 typecheck 要 145s+，所以它根本没跑完）。
run 超过 10 分钟还在跑 → typecheck 过了，挂在后面的测试上。
PR #135 之前的 4 个 run 分别在 1m36s / 4m42s / 5m30s 挂，全是 typecheck；
`37095893167` 跑了 13m18s，是因为它终于过了 typecheck 然后在测试上挂。

The two architecture gates were **red before this session** (`self-test` exit 2,
`check` exit 1 with 641 blocking) because `.architecture-baseline.json` had
been recorded by a pre-fix resolver. Fixed in PR #132. **Resolver变更需对比新旧指纹并审查baseline/self-test同步变化；真实新增违规必须先修，禁止整批重录掩盖新增边。**

### The test suite is red, and the number depends on where you run it

The same code was measured twice, minutes apart, on two platforms:

| Run | Platform | Failing files | Failing tests | Passing tests |
| --- | --- | --- | --- | --- |
| CI `37095893167` (`Run tests`, ubuntu) | Linux | **64** | **187** | 11,592 |
| Local `npm test` (Windows 11, same tree) | Windows | **45** | **112** | 11,679 |

**The sets only partly overlap. Diffing them is the whole point:**

| | Count | Meaning |
| --- | --- | --- |
| Fail on **both** | **42** | Real, platform-independent debt. Start here. |
| **CI-only** (pass on Windows) | **22** | Windows assumptions baked into the test or the code. |
| **local-only** | **3** | 2 load-dependent flakes in `packages/agent` + 1 unrelated `plugin-core` suite. |

> ⚠️ **An earlier version of this file stated "42–45 is the honest floor" and
> told you to treat it as such. That was wrong in a way that would have cost
> you a day.** It was a **Windows-local** number. On CI the same code fails
> **64** files. If you had taken 42 as your floor, every one of the 22 CI-only
> failures would have looked like a regression you introduced.
>
> **The floor is 64, and it is a Linux number.** A local `npm test` is a
> *necessary* check but it is not a *sufficient* one — same failure mode as the
> typecheck gate above, just running the other direction.

#### The 22 CI-only failures, classified

Every row below was read out of the CI log, not inferred. **Most are not test
bugs, and one of them is a real hang in production code.**

| # | Class | Files | Evidence from the CI log |
| --- | --- | --- | --- |
| 6 | **Windows paths hardcoded in the test** | `memory-state/{pathsMigration,projectResolver,workspaceOverrides}`, `services/file-snapshot-restore`, `services/browser/extension-installer`, `prompts/dynamic/skillsMetadata` | `expected '/home/runner/work/duya/duya/D:/projec…' to be 'd:/projects/alpha'`; `to contain '<location>E:\skills\pdf\SKILL.md</loc…'` |
| 3 | **Windows-only command / OS branch** | `ipc/ide-handlers`, `hooks/executor`, `core/media-allowlist` | `expected "spy" to be called with [ 'where.exe', … ]`; `expected 127 to be 1` (127 = command not found) |
| 5 | **Permission behaviour genuinely differs** ⚠️ | `permissions/{permissions,securityPolicy}`, `src/permissions/policy-read-permission`, `src/tool/ApplyPatchTool`, `agents/server/router-project-roots` | `expected 'allow' to be 'deny'`; `expected 'Applied 1 operation(s):\n  - updated …' to contain 'Permission denied'` |
| 4 | **Filesystem / OS semantics** | `ipc/{cua-handlers,files-handlers,project-entity-handlers}`, `services/browser/profile-detector` | `expected { success: true, tree: [] } to deeply equal { success: false, … }`; `expected [] to deeply equal [ 'Default:rain', … ]` |
| 2 | **Real bug — infinite loop** 🐛 | `tests/unit/prompts/{promptStructure,visualVerification}` | `RangeError: Invalid array length` at `packages/agent/src/agentsmd/loader.ts:582` |
| 1 | **Env detection** | `packages/voice/tests/env` | `expected false to be true` |
| 1 | **Git error text differs** | `ipc/git-handlers` | expects `"Untracked paths outside the workspace cannot be reviewed inline."`, Linux yields `"Unable to load this diff."` |

##### 🐛 The one that is an actual defect, not a test problem

`packages/agent/src/agentsmd/loader.ts:580-584`:

```ts
while (currentDir !== path.parse(currentDir).root) {
  dirs.push(currentDir)
  currentDir = path.dirname(currentDir)
}
```

This loop only terminates if `path.dirname` eventually lands exactly on
`path.parse(...).root`. On Windows (`path` → `path.win32`) that holds. **On
POSIX it does not, for any relative path**: `path.parse('.').root === ''` and
`path.dirname('.') === '.'`, so `'.' !== ''` stays true forever — `dirs` grows
until it throws `RangeError: Invalid array length`, i.e. after allocating a
multi-gigabyte array.

`AgentsMdManager.refreshForTask` passes `cwd: projectPath` straight through
(`packages/agent/src/agentsmd/manager.ts:107-108`) with no `path.resolve()`.
**So any relative `projectPath` hangs the agent on Linux/macOS.** The tests
hitting it are the two prompt tests above. Not fixed here — it changes
production behaviour and needs a decision on where to normalize. Tracked as
TD-9.

##### ⚠️ The permission row is the one to be careful with

These are not tests asserting the wrong string. They assert that **a permission
check fires** (`expected 'allow' to be 'deny'`, `expected … to contain
'Permission denied'`), and on Linux it does not fire. **Changing the
expectation to match Linux deletes a security assertion instead of fixing a
bug.** Decide which platform carries the intended behaviour before touching
them.

##### One suite that silently stops protecting anything

`core/media-allowlist.test.ts:55` reads
`process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp'`. On Linux both env
vars are unset, so it falls back to a path that does not exist and
`mkdtempSync` throws in `beforeEach`. **The whole file dies** — including the
cases named *"refuses config.toml"*, *"refuses secrets.json"*, *"refuses a
private SSH key"*, *"refuses a sibling directory"*. That suite is a P0
regression guard for media-path escapes, and **on Linux CI it asserts nothing
at all**. It looks like an ordinary test failure; it is a silent loss of
security coverage.

#### The 42 shared failures

| Owner | Files |
| --- | --- |
| `apps/desktop` | 22 |
| `packages/agent` | 17 |
| `scripts/__tests__` | 2 (`memory-rag-hook` `SyntaxError: Unexpected end of JSON input`, `memory-search-skill`) |
| `packages/agent-protocol` | 1 (`13-citation-drift`) |

Arithmetic that must add up: local `45 = 42 + 3`, CI `64 = 42 + 22`.
The 3 local-only files are `packages/agent/tests/integration/{DuyaAgent,RealTasks}.test.ts`
(load-dependent) and `packages/plugin-core/tests/app-schema-marketplace-compat.test.ts`
(unrelated — it passes on Linux, which is its own smell, but not this debt).

The earlier Windows-local runs of the same day differed by 3 suites. **1 of those
3 was a real fix** (`02-cycle-budget.test.ts`, PR #133). **The other 2 were
load-dependent flakes** in `packages/agent` — the first run logged
`[vitest-worker]: Timeout calling "onTaskUpdate"` under parallel load. Do not
"fix" a flake you did not cause.

**Treat 64 / 187 as the floor, not as your regression.** Before you start,
record the `npm test` output **on the runner OS you care about**; if your branch
ends with a *different* set of failures, that is on you.

`e2e` was **not** run — it needs `npm run electron:build` first.

### 架构计划：**只有一个**，是 [610 架构收口系列](./active/610-architecture-series/README.md)

**2026-10-05 起，600 / 601 / 602 不再是独立计划，而是 610 的三章。**
它们此前各有编号空间（`S0–S7` / `A–C` / `Phase 0–3`）、各声明一个"唯一 next action"、
且互不引用对方的顺序约束 —— 那不是三份计划，是**三个互相不知情的真相源**。

| 章 | 原来是什么 | 现在 |
| --- | --- | --- |
| [01 分层架构落地](./active/610-architecture-series/01-layered-architecture/README.md) | 600（`S0`–`S7`） | A 线主干。README §4 已冻结为历史契约 |
| [02 Headless Control Plane](./active/610-architecture-series/02-headless-control-plane/README.md) | 601（`A`/`B`/`C`） | B 线 |
| [03 SQLite 驱动](./active/610-architecture-series/03-sqlite-driver/README.md) | 602（`Phase 0`–`3`） | C 线，**可选旁支**，已退出关键路径 |
| [10 切片 A1 契约](./active/610-architecture-series/10-slice-a1-g7-loop-detection.md) | — | 当前唯一 next action |
| [11 切片 A0 契约](./active/610-architecture-series/11-slice-a0-client-runtime-axis.md) | — | 客户端运行时轴 |

**推进顺序、每片的唯一 next action 与完成标志、放弃条件，只在 610 里回答一次。**
587 的合同与历史推导已被第 01 章接管，不再单独排期。

三条本轮实测的更正（都曾推错方向）：

- **602 的立论前提被推翻。** `better-sqlite3@13.0.3` 依赖 `node-addon-api`，是 **N-API 插件**；
  同一个 `prebuilds/win32-x64.node` 在 Node 24.16.0（ABI 137）与 Electron 44.2.0（ABI 149）下
  **都加载成功**。所以 602 的理由从「逃出 ABI 问题」变成「删掉一个原生依赖」，
  600 的「S6 等 602 Phase 2」约束随之撤销。
- **~~600 的 11 份计划文档不在任何分支上~~ 这句话是错的。** 它们一直在
  `docs/600-plan-archive`（1 ahead / 0 behind），并没有丢。当时只查了 `origin/*` 与工作区，
  把「不在 master 上」读成了「不在任何分支上」，并据此推了三轮计划。
- **601 推翻了 600「`apps/web/` 本系列不建」的裁决。** 该裁决无机器强制
  （`apps/web` 在所有 declared root 之外），推翻它不需要先改门禁。

***

## Active Plans (37)

> 架构主线已收束为 **610 一项**（原 600/601/602 已收为其三章；587 的合同被其第 01 章接管）。
> 其他产品计划保留独立范围。**架构执行顺序以 610 为准**，不能从历史编号另排队列。

### The dependency shape, which the table below does not show

Extracted from the plan headers (2026-10-03). This is what actually determines
the order you can work in:

```
473 ──┬─ 474  475  478  479  485  488  489  490  491  492      ← 扇出阻塞 10 个
      │        └──────┘  └────┘  └─────────┘  └──┘
      │           │       │         │
      │           │       └────┬────┘
529 ──┘                    525
429 ── 448
452 ── 455 ── 460          ← 455 ↔ 460 互为依赖（见下）
587：G0 → R1 → R2 → T3/E4 → M5/C6 → D7 → H8
```

**Three things a flat priority list hides:**

1. **473 is the largest fan-out in the repo** — ten plans wait on it. It is
   an umbrella tracker, not an implementation plan, so it will not "complete"
   the way the others do; its own index note says it closes when 478 P2.3
   lands. Treat it as a coordination surface, not a work item.

2. **455 ↔ 460 is a cycle, but a phase-level one.** 460's header says it
   "must complete 455 Phase A/B first"; 455's remaining Phase D is the REST
   template work that 460 describes. A flat graph cannot express that — the
   next action is *455 Phase A/B*, not "455".

3. **525 waits on two different plans** (485 and 479), and its own next
   action is a data migration with a destructive `--apply`. Sequence it after
   both, and get the migration rehearsed before running it against anything
   you cannot rebuild.

### Verified: what the next-action column claims

Each row was checked against the working tree, not against its plan file.
Four were wrong and are corrected below; these five were checked and are
**still true**, so the row is safe to act on:

| Plan | Checked | Result |
| --- | --- | --- |
| 496 | `packages/agent/src/worktree/` | does not exist — "0 code" is accurate |
| 443 | `DUYA_RIPGREP_PATH` in `GrepTool` | not wired |
| 585 | `ephemeral-batcher.ts` | not created |
| 573 | browsing-history table + `browser:history-*` IPC | neither exists |
| 460 | `.app.json` files in repo | zero |

| Plan | Priority | Next action |
| --- | --- | --- |
| **[610-architecture-series](./active/610-architecture-series/README.md)** | **P0** | **唯一的架构计划。** 600 / 601 / 602 已收为它的三章,不再各自独立。**唯一 next action:A1** —— 修 `isTurnLoopModule`,让 G7 认出真正的 turn loop 而不是把 worker 入口报成违规;A2–A7 的验收都挂在它上面 |
| [587-agent-harness-monorepo](./active/587-agent-harness-monorepo/README.md) | P1 | 合同与历史推导已被 610 第 01 章接管(`01-layered-architecture/10-takeover-from-587.md`)。**不再单独排期**,只作为查证来源 |

> **只有一个架构计划。** 610 的切片表 A0–A7 / B1–B3 / C1 是全部的架构工作,
> 每一片的唯一下一动作与完成标志见
> [610 §5.1](./active/610-architecture-series/README.md#51-每片的唯一-next-action)。
> 本表此前并排列 600/601/602 三行,三行各自声明一个"唯一 next action"而互不引用对方 ——
> 那不是三份计划,是**三个互相不知情的真相源**。现已消除。
| [08-31-multi-agent-profile-design](./active/2026-08-31-multi-agent-profile-design.md) | P1 | Implement plan 7.2 memory partition by profile (migration + `[memory] partition` toggle) _(section C partially done via 481/477)_ |
| [popover-autoflip](./active/237-popover-autoflip.md) | P1 | Migrate `HoverPopover` to `usePopoverPlacement`, then `SlashCommandPopover` / `ModelSelector` |
| [permission-decision-bus](./active/419-permission-decision-bus.md) | P0 | Add `checkPermissions` + `riskTier` to the MCP tool registration path _(P0/P2 done; P1 open)_ |
| [search-tools-hardening](./active/443-search-tools-hardening.md) | — | Wire `DUYA_RIPGREP_PATH` + timeout/abort into `GrepTool` spawn _(tasks A-G untouched)_ |
| [read-edit-freshness-protocol](./active/448-read-edit-freshness-protocol.md) | P1 | Phase 2/3 — **Task E 已落地**（`WriteTool.ts` 已含 read-first 快照检查），下两项见 plan |
| [multi-protocol-and-wrapper-layer](./active/451-multi-protocol-and-wrapper-layer.md) | P0 | Implement Phase 5 Vertex (`api/google-vertex.ts` + `providers/vertex.ts`) _(2 wrappers still inline)_ |
| [mcp-direct-and-plugin-unification](./active/452-mcp-direct-and-plugin-unification.md) | P1 | Remove the dead MCP submenu branch + merge the Apps/MCP constant sections _(Phase B absorbed by 455 D3)_ |
| [open-connector-registry](./active/455-open-connector-registry.md) | P1 | Close Phase D: run `typecheck:all` + full vitest and record the result |
| [rest-template-connector](./active/460-rest-template-connector.md) | P1 | Convert the slack `slack_search_messages` connector to a `.app.json` REST template |
| [grok-bot-framework-overview](./active/473-grok-bot-framework-overview.md) | P0 | Close the plan 10 acceptance list once 478 P2.3 (automation group seeding) lands _(umbrella tracker)_ |
| [bot-system-prompt-sections](./active/474-bot-system-prompt-sections.md) | P0 | Create the demo bot toml and run G1 prompts typecheck + unit tests (P3.3) |
| [bot-compaction-increment](./active/475-bot-compaction-increment.md) | P1 | Implement `automationReminderFingerprint` in turn-prep (P3.1) |
| [shared-rooms-group-chat](./active/478-shared-rooms-group-chat.md) | P1 | Wire cron automation to seed a group room (P2.3) |
| [bot-memory-isolation-tiers](./active/479-bot-memory-isolation-tiers.md) | P0 | Add the tier filter to the 430 RAG injection path (P2.3) |
| [bot-storage-layout](./active/485-bot-storage-layout.md) | P0 | Add `fs.watch` on `agents/<id>/profile.json` -> roster broadcast (P3) |
| [bot-channel-integration](./active/488-bot-channel-integration.md) | P1 | Add the P4.3 connector manifest registry (Discord/Slack) to `wake/channels` _(24/33 done)_ |
| [bot-chat-dataflow-and-complete-cards](./active/489-bot-chat-dataflow-and-complete-cards.md) | P0 | Complete P0.2 - persist card payloads for all 5 SendMessage types _(4/32 done)_ |
| [bot-toolset-turn-tool-alignment](./active/490-bot-toolset-turn-tool-alignment.md) | P0 | Add the workspace-constrained bash mode to `BashTool` (P2 BoxShell) |
| [bot-chat-messaging-feel](./active/491-bot-chat-messaging-feel.md) | P0 | Implement the P0.1 delivery phase machine in `conversation-store` _(1/11 done)_ |
| [bot-to-bot-grok-parity](./active/492-bot-to-bot-grok-parity.md) | P0 | Extend the bot-direct source whitelist so agent DM entries render (P3) |
| [worktree-framework-implementation](./active/496-worktree-framework-implementation.md) | P0 | Create `packages/agent/src/worktree/` and wire SubagentTool `isolation:'worktree'` _(research done, 0 code)_ |
| [bot-connector-elicitation](./active/503-bot-connector-elicitation.md) | P1 | Add the `disconnect_app` action + tool row in `AppConnectorManageTool` _(P6b only open item)_ |
| [image-preview-modal-unification](./active/511-image-preview-modal-unification.md) | P1 | Delete the 3 legacy preview components, then collapse the `preview.css` legacy rules _(Phases 3-4 unfinished)_ |
| [code-review-history](./active/518-code-review-history.md) | P2 | Build `<HistoryPanel>` (Branches/Commits tabs) and wire it into CodeReviewPanel _(Phase 2 UI missing)_ |
| [memory-footprint-and-lifecycle-reclamation](./active/521-memory-footprint-and-lifecycle-reclamation.md) | P1 | Wire `BrowserPanel` unmount -> `releaseBrowserMemory` (Phase 1a) _(Phases 1-5 open)_ |
| [project-entity-and-plan-management](./active/525-project-entity-and-plan-management.md) | P1 | Run `scripts/migrate-projects-paths.ts --apply` on the dev DB, then delete 522 _(5.1 still pending)_ |
| [projects-core-db-and-main-db-migration](./active/534-projects-core-db-and-main-db-migration.md) | P0 | Run the Phase 3.6.a static scan of `widget.*` callers and log `[CONDUCTOR_DUAL_WRITE]` counts _(3.6 not started)_ |
| [project-menus-use-dropdownmenu](./active/535-project-menus-use-dropdownmenu.md) | — | Replace the `BotContactListItem` inline submenu with a `MenuAction` of `kind:'submenu'` _(Phase 3 open)_ |
| [project-context-injection-v2](./active/536-project-context-injection-v2.md) | P1 | Add the current `projectId`/name to the bot memory system-prompt section (L3) _(only L3 open)_ |
| [workflow-independent-runtime](./active/560-workflow-independent-runtime.md) | P0 | Land the Phase 5 `wf.agent` Go/No-Go spike: bind `runAgent` in the child process and journal `nodeKind:'agent'` + usage, or fall back to option C _(Phases 1-4 landed (Phase 4 checkbox list is stale))_ |
| [browser-core-upgrade](./active/573-browser-core-upgrade.md) | P0 | Phase 3: add the core-db browsing-history table + migration, hook webview main-frame `did-navigate`, expose `browser:history-*` IPC plus the history view _(Phases 1/1b/2/2b landed)_ |
| [cua-tree-richness](./active/576-cua-tree-richness.md) | P1 | Phase 3 in the ps1 C# probe walk: emit `children_total/shown/offset` for container nodes, plus `surface_kind` and the new-window settle poll _(Phases 1-2 landed)_ |
| [mcp-capability-core-convergence](./active/580-mcp-capability-core-convergence.md) | P0 | Run Phase 0's real-machine Notion baseline (instrumented around `RemoteMcpConnector`/`MCPClient` discovery) to record `pages=N, total=M` _(Phases 0/3/4/5 open)_ |
| [session-archive-hardening](./active/582-session-archive-hardening.md) | P0 | Storage 与生命周期补强（G1–G4 / UI 轨 G5–G9）—— **此前未列入本索引，2026-10-03 补上**；前置 plan 549 已于 PR #56 落地 |

***

## Backlog (10)

Designed, not started. Nothing here is promised work.

| Plan | Why it is not active |
| --- | --- |
| [button-unification](./backlog/309-button-unification.md) | 0-byte file: delete or write |
| [duya-ai-model-list-lazy-loading](./backlog/426b-duya-ai-model-list-lazy-loading.md) | 0/21, nothing started |
| [failclosed-command-parsing-and-content-rules](./backlog/443-failclosed-command-parsing-and-content-rules.md) | content rules remain dead code |
| [external-agent-invocation](./backlog/482-external-agent-invocation.md) | no code started |
| [bot-reliability-ack-and-resume](./backlog/484-bot-reliability-ack-and-resume.md) | no code started |
| [dock-layout-and-window-management](./backlog/527-dock-layout-and-window-management.md) | idea only |
| [multi-path-sidebar-rendering](./backlog/530-multi-path-sidebar-rendering.md) | blocked on 525 Phase 2 `--apply` |
| [model-call-trace](./backlog/561-model-call-trace.md) | 0/40, unstarted |
| [tab-shell-workbench](./backlog/571-tab-shell-workbench.md) | 0/28, unstarted |
| [chain-ab-runtime-merge-evaluation](./backlog/581-chain-ab-runtime-merge-evaluation.md) | decision doc only; execution deferred to plan 582+ |

***

## Completed Plans (366)

Archived for decision logs. Not an index of current work.

### Agent Core & Message (120)

- proactive-memory-enhancement · code-agent-profile-runtime-wiring · agent-mailbox · 06-15-subagent-lifecycle-ownership-migration · 09-chat-attachment-edit-queue · 09-tool-use-group-progress-titles
- file-edit-tool-ui-redesign · duya-agent-refactor · subagent-task-notification · agent-core-audit-report · html-preview-in-tool-rows · tool-row-auto-collapse
- interagent-message-session · mode-architecture-unification · on-demand-tool-discovery · agent-package-cleanup · session-search-overhaul · memory-v2-phase-1a-schema-projects-catalog
- memory-v2-phase-1a2-lease-heartbeat-cas · memory-v2-phase-1a3-projection-outbox · memory-v2-phase-1b-extractor · memory-v2-phase-1c-worker-main-process-e2e · memory-v2-phase-2-consolidator-and-recall · multi-model-reasoning-architecture
- agent-message-domain-framework · prompt-contributor-integration · message-persistence-simplification · plugin-management-unification · core-db-package-foundation · core-db-state-aggregates
- core-db-electron-wiring · core-db-legacy-import · core-db-rollout-foundation · core-db-state-aggregates · core-db-electron-wiring · core-db-legacy-import
- electron-cleanup-repair · session-goals-ui-state-persistence · storage-alignment-improvements · core-db-rollout-process-events · duya-agent-refactor · memory-pipeline-unblock
- memory-curation-tool-foundation · memory-curation-ledger-staging · memory-curation-validator-runner · memory-curation-publisher-projection · memory-curation-prompt-canary-layout · memory-curation-rebuild-adhoc-retire
- agents-md-loader-alignment · nested-agents-md-loading · voice-library · agent-voice-setup · goal-mode · mode-state-machine-framework
- mode-tracker-framework · plan-tracker-state-machine · mode-state-persistence · agent-loop-wiring · plan-mode-frontend-session · workflow-mode-design
- deterministic-curation · tool-protocol-adaptation · agent-profile-completion · goal-observability-persistence · goal-ui · compaction-strategy-consolidation
- deep-research-state-machine · config-driven-custom-agents · hook-loop-bus · voice-pipeline-overhaul · harness-signal-contracts · agent-worktree-isolation
- provider-stream-coverage · main-agent-worktree-tools · context-ring-single-estimator · token-accounting-cache-health · skills-reload-snapshot-cache · streaming-durable-dedup
- app-connection-approval-parity · app-connection-codex-alignment · wake-agent · computer-use-mode · codex-marketplace-and-install · agent-wake-bus
- agent-dm-messaging · appended-tool-schema-catalog · message-threads · host-persistent-tool-permission · session-tool-minimal-loop · rollout-as-first-class-data
- bot-compact-agent-not-initialized · compaction-loop-fix-and-ui-progress · computer-use-harness-gaps · context-window-resolution · compaction-summary-quality-guards · marketplace-source-fallback-mirror
- multi-source-default-and-dynamic-tabs · plugin-format-adapter-layer · context-ring-persistence-and-throttle · token-usage-double-count-fix · unify-session-and-project-actions · jev-system-one-integration
- prompt-module-flatten · compaction-consolidation · workflow-rpa-agent-design · prompt-slimming · rpa-recorder-computer-use-framework · prompt-gating-consolidation
- prompt-asset-cleanup · element-tree-enumeration-overlay · bash-foreground-soft-yield · structural-computer-use · workflow-run-live-nodes-and-agent-watch · macos-native-computer-use
- windows-cua-alignment · context-accounting-ledger · cua-minimized-window-access · duya-agent-api-design · duya-agent-core-implementation · duya-agent-integration

### Infrastructure & Research (53)

- bash-worker-implementation · 09-bug-sweep · automation-cronjob-workflow · agent-core-audit · localhost-auto-open-from-bash · singleton-daemon-architecture
- agent-harness-project-grounding · built-in-browser-fallback · async-task-inbox · cookie-import-app-bound-fix · recent-session-directory · gateway-agent-capability-and-workspace
- self-improvement-system · platform-gateway · streaming-state-architecture-refactor · logging-and-auto-update · multi-source-update-fallback · code-review-workspace
- remove-legacy-message-bridge · mailbox-legacy-cleanup-assessment · telegram-hermes-gap-completion · projection-layer-compression · low-spec-performance · unified-permission-gate
- bot-routines-and-listeners · deepseek-tui-feature-parity · agent-communication-architecture-v2 · messagelist-scroll-jump-and-freeze · browser-parallel-fetch-text-only · electron-directory-restructure
- compact-ui-history-retention · archive-design-parity-with-codex · agent-directory-restructuring · goal-mode-v2 · minimax-small-wins · code-review-line-comments
- research-mode · gateway-ipc-refactor · browser-parallel-isolation · async-nonblocking-subagent · research-mode-loop-improvement · external-agent-import
- tool-path-permission-refactor · chat-ux-improvement-plan · duya-implementation-phase1 · duya-implementation-phase2-3 · duya-implementation-phase4-5 · duya-project-structure
- duya-source-code-integration · first-test-problems-analysis · first-test-problems · harness-comparison-docs · problems

### App Shell / UI (46)

- 06-15-right-sidebar-redesign · office-workspace · input-option-popover-alignment · skills-completion-plan · turn-review-history · no-project-session
- subagent-nested-session · chat-generative-ui · beta-launch-preparation · onboarding-experience-overhaul · skills-system-cleanup-and-system-skills · inline-task-row
- document-parser-service · browser-search-tooling · startup-landing · memory-rag-hook · memory-setup-cli-and-skill · memory-rag-settings-ui
- stage1-policy-incremental-edits · skill-tool-expose-and-system-gui · cli-skill-listing-alignment · focus-mode · skills-sync-fix · browser-latency-optimizations
- browser-webview-parallel-isolation · sidebar-section-refactor · unified-attachment-card-visual · run-surface-threadkind-consolidation · channel-attachments · modal-unification
- sidebar-awaiting-input-pill · browser-tab-group-management · shared-agent-channel-root · dwf-browser-node · dwf-zcode-parity-resume-compile-actor-escalate · background-command-list-and-output-panel
- system-reminder-taxonomy-sanitize-rebuild · finalize-final-mailbox-poll · exit-boundary-user-message-separation · mailbox-delivery-receipts · recap-feature · researcher-codex-ui-alignment
- plugin-codex-ui-alignment · research-agent-memory-and-literature-plugin · sidebar-project-management · session-archive-hardening

### CLI / Cron / Provider (39)

- plugin-cli-completion · plugin-system-cleanup · duya-config-into-cli · research-mode-persistence-hardening · node-file-parser-and-read-integration · cron-cli-bugfix
- cli-channel-list-and-help · database-architecture-refactor · zero-router-architecture · database-ownership-unification · cli-surface-expansion · cli-packaged-smoke-fixes
- provider-ui-interaction-architecture · provider-card-redesign · provider-inline-edit-page · provider-masked-key-bug · nextjs-to-vite-migration · gateway-cli-channel-message-fixes
- e2e-ipc-test-coverage · skill-learning-inbox · cron-shared-session · mcp-loading-implementation · ai-provider-factory-alignment · single-provider-source-builtin-catalog
- config-toml-unification-tasks · config-toml-unification · config-consumer-unification · cron-definition-configstore · gateway-user-authz · cron-single-source-refactor
- ipc-path-safety-hardening · provider-error-surfacing-and-retry-notice · gateway-minimal-router · duya-cli-tool · cli-channel-cron-message · cli-split-and-control-plane
- duya-cli-argv-and-deprecate-cron-tool · ai-provider-settings · cli-tool-fix

### Foundations (legacy 01-99) (35)

- tool-interface-enhancement · context-compaction-system · compact-critical-fix · query-engine-separation · tool-orchestration-enhancement · abort-controller-propagation
- openharness-comparison-and-improvement · messageport-architecture · config-manager-implementation · message-port-lifecycle · tool-stream-buffer · sse-to-messageport-unification
- api-routes-to-ipc-migration · data-persistence-fixes · draft-skill-manager · self-improver-core · skill-agents · skill-prompts
- integration-testing · prompt-mode-architecture · telegram-enhancement · multi-agent-profile-system · agent-self-management · extension-install-ux
- chat-input-paste-fix · subagent-live-rendering-sidebar · parallel-agent-orchestration · agent-server-http-sse-migration · context-design · orchestrator-design
- sse-protocol · message-queue-abort-integration · message-rewind-edit-resend · plugin-development-skill · canvas-interaction-core-refactor

### Conductor / Canvas (34)

- 06-16-conductor-iterative-visual-refinement · file-preview-workspace · attachment-unification · conductor-main-agent-injection · conductor-canvas-style-and-group · canvas-smart-layout-and-hit-test
- canvas-knowledge-workspace · cron-automation-ui-runtime-hardening · conductor-multi-canvas-management · canvas-element-editing-and-scene-architecture · conductor-finite-widget-layout · human-like-browser-backend
- project-database-element · tool-history-integrity · canvas-tool-find-empty-space-and-capture-region · canvas-capture-splash-and-manage-broadcast · conductor-overview · global-connector-registry-design-suite
- tool-catalog-snapshot · conductor-foundation · conductor-canvas-ui · conductor-agent-orchestration · conductor-widget-extensibility · conductor-blueprint-implementation
- canvas-capture-region-canvas-coords · canvas-element-data-model · canvas-agent-free-form-tools · canvas-workbench-runtime · conductor-canvas-v2-type-system · conductor-canvas-v2-native-rendering
- conductor-canvas-v2-connector · conductor-canvas-v2-mindmap-frame-toolbar · conductor-canvas-v2-agent-integration · mindmap-interaction-correction

### Plugin / MCP / App Connection (21)

- mcp-security-layer-hardening · plugin-workflow-templates · app-connection-oauth · first-party-plugin-catalog · agent-plugins-compat · mcp-marketplace-install
- hook-row-in-message-flow · live-tool-input-streaming · connector-auth-resume-card · plans-plugin-mcp · skills-mention-and-catalog-codex-alignment · skill-context-accounting-and-invocation
- builtin-plugin-flexibilization · schema-manifest-llm-friendly · hook-system-full-enhancement · plugin-discovery-multi-source · plugin-lifecycle-version · marketplace-system-implementation
- structured-error-handling · plugin-security-enterprise-policy · skill-system

### Bot Series (14)

- 08-13-grok-harness-turn-semantics · 08-13-grok-synthetic-reason-and-working-directory · 08-13-grok-task-todo-alignment · bot-toolset-unified-foundation · multi-bot-chat-ui · bot-direct-handoff-2026-09-05
- bot-session-physical-isolation-and-generation-rotation · bot-direct-ask-cards · bot-long-session-grok-parity · bot-tool-approval-cards · bot-run-scheduler · bot-stability-layers
- bot-title-and-id-minting · bot-hbs-migration

### Browser (2)

- browser-navigate-snapshot-projection · one-click-extension-install

### Tool Catalog (1)

- 09-tool-catalog-unification

### Automation (1)

- cron-editor-redesign

***

## Tech Debt

Tracked in
[`587-agent-harness-monorepo/reference/10-tech-debt-tracker.md`](./active/587-agent-harness-monorepo/reference/10-tech-debt-tracker.md)
(TD-0 … TD-9). That file is marked historical for *execution ordering* — 587 is
the live route — but the TD entries themselves are still the record of what is
broken and what is only baselined.

## Principle

A plan is not progress. Landed code is progress.