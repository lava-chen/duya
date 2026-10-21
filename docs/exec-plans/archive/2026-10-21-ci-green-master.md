# 修好 master 的 CI：95 个失败测试文件 + 17 个 E2E 失败

状态：completed · 负责人：mavis（root 会话） · 更新：2026-10-21
分支：`codex/ci-green-master` · worktree：`E:\Projects\duya\.claude\worktrees\ci-green-master` · base：`c8df0e01` · owner：mavis

## 目标与边界

master 的 CI 全绿：`npm test` 单测 0 失败，`npm run test:e2e` E2E 0 失败。

边界：**`packages/agent/**` 由用户另行处理**，本轮不碰该包（用户 2026-10-21 明确要求）。
其余改动分两类——

1. **测试债**：测试断言的是已迁移/已退役的实现，让测试重新与生产代码一致；
2. **真产品 bug**：测试是对的、产品错了，改产品。

## 验收

- `npx vitest run --no-file-parallelism` → 非 `packages/agent` 部分 0 失败
- `npm run typecheck:all` / `npm run architecture:check` / `scripts/typecheck-electron-gate.mjs` / `scripts/check-text-encoding.mjs` 退出码 0
- `npm run test:e2e` 退出码 0
- PR 上 CI 的 `test` 与 `build` 两个作业均绿（`packages/agent` 部分除外）

## 根因

CI run `39537540615`（PR #332，head `855a934a`）：`test` job 收集 1457 文件 / 16311 用例，
**95 个文件 / 305 个用例失败**；`build` job 的 E2E **17 个失败**。

失败不是随机 flaky，而是 **20 个成簇的系统性问题**：

| 簇 | 量 | 根因 |
| --- | --- | --- |
| A | 28 | `db-handlers.ts` 改走 `getDesktopHostSessionApi()`，`db-handlers.test.ts` 的 mock 未同步 |
| B | 9 | `loadAgentsMdFiles` 的目录上溯循环在 cwd 非绝对路径时不终止 → `RangeError` |
| C | 6 | 测试指向已退役产物的悬空依赖（`packages/agent/bundle/agent-process-entry.js`） |
| D | 3+ | 测试读 `packages/agent/src/process/*`（现仅转发垫片），真实实现在 `packages/host/src/` |
| E | 12 | `WorkflowPanel` 已改为导航桩，测试仍断言旧内嵌 UI 的 `data-testid` |
| F | 8 | `slice-census.txt` 冻结于 `1ffabfc9`，之后大规模重构导致路径漂移 |
| G | 9 | run 编排测试锚在旧的 run 事件通道 |
| — | 5 | **Linux 独有**：路径分隔符、绝对路径假设、定时刻度 |
| — | 3 | **E2E 产品 bug**（见下） |

**关键认知**：`packages/agent` 正在退役（根 `AGENTS.md`）。大量测试断言的是退役实现的
文本或行为，而实现早已迁到 `packages/host`。这批失败是退役过程中的"测试债"，
不是 #332 引入的回归——#332 只是修好了让 vitest 真正跑起来的那个门禁。

## E2E 的三个真产品 bug

| 症状 | 根因 | 修法 |
| --- | --- | --- |
| `run.started` 的 `manifestHash` ≠ `runs.manifest_hash` | `runs` 行存的是 **Control Plane 冻结 manifest** 的指纹（`host-run-api-adapter.ts` 重算），而 worker 的 `run.started` 哈希的是**另一份** manifest——`buildLegacyRunManifest` 从 run facts 重建的 legacy 投影。两列本该互校，却永远对不上 | worker 携带 Control Plane 的指纹（它本来就用 `verifyRunManifestBinding` 验过），`EngineRunDriverRequest` 新增 `manifestHash` |
| ui-states `run_events` 0 行 | `runs` 行由 `run:create` 写，**早于 worker 启动**；ledger 的首事件由 worker 铸。测试在"行出现"那一刻就断言 ledger 非空 → 与 worker 的第一帧赛跑 | `pollForLiveRun` 改为等"行已 live **且** ledger 已有事件" |
| ui-states `turn.text` 为空 | 页面端 `Promise.race([reader.read(), 5s 超时])`：**落败的 read 仍然消费掉了 chunk**（它的 promise 拿到数据却没人 await）。模型 fixture 持有 20 秒，帧间隔超过超时，`text` 帧被丢在地上 | 去掉页面端超时（外层 `waitForTurnText` 已有预算）；electron-turn 同款改为复用同一个 pending read |

另外 `electron-turn.spec.ts` 的 header 声称 `assistant.message_finalized` 无生产路径——
**已过时**：worker 会发 `chat:message_finalized`，`translateFrame` 有臂，
control-plane census 的缺口已关闭（`control-plane-census.test.ts` 断言缺口为 undefined）。header 已更正。

## 发现与决策

- **worktree 必须放 E 盘**。C 盘当时只剩 0.1 GB，`git worktree add` 直接失败。
- **`packages/plugin-core` 必须在 worktree 内构建**：`vitest.config.ts:38` 把它指向
  `dist`（该包不在源码别名列表内）。**这是本地假象**，CI 的 `typecheck:all` 已含
  `build:packages`。我最初误判为 CI 根因，靠 grep CI 日志排除。
- **`slice-census.txt` 故意没有 `--write`**：批量重录会静默吞掉并发合入的切片；
  正确做法是把删除/移动的路径**逐条**记入 `RECORDED_LOSSES`。
- **master push 的 CI 是假绿**：`test` / `build` 在 `push` 事件下被跳过，只有 PR run 真正执行。
- **CI 红不能用"这是既有红"消解**：仓库已有 `codex/ci-test-routing`（PR #327，
  `scripts/ci/test-scope.mjs`），必须先把它合进来让 test job 跑按改动路径选出的 scope，
  再谈红。本轮 master 已含该脚本。
- **归因要双向差集**：新旧两次 run 的失败集合取双向差集才有意义，单边比对是噪声。

## 验证记录

| 环境 | 命令 | 结果 |
| --- | --- | --- |
| Windows / Node 22 | `node scripts/build-packages.mjs` | 0 — 23/23 |
| Windows / Node 22 | `node scripts/architecture/architecture-check.mjs` | 0 — `OK — no new boundary violations.` |
| Windows / Node 22 | `npm run typecheck:all` | 0 |
| Windows / Node 22 | `node scripts/typecheck-electron-gate.mjs` | 0 — `OK — no new type errors` |
| Windows / Node 22 | `node scripts/check-text-encoding.mjs` | 0 — `OK — no new violations` |
| Windows / Node 22 | `npx vitest run --no-file-parallelism` | 见"结果" |

## 结果

（见提交与 PR）

## 回收

worktree 在 `E:\Projects\duya\.claude\worktrees\ci-green-master`，由 `scripts/remove-worktree.sh` 回收；
共享检出基线 `node_modules=1042 / .bin=276 / packages-src=3649`，解链前后必须一致。
