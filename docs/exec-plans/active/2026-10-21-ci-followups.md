# CI 提速的后续四项

状态：active · 负责人：待接续 · 更新：2026-10-21
分支：`codex/ci-typecheck-graph`（项1）· worktree：E:\Projects\duya\.claude\worktrees\typecheck-graph · base：052f85cb
关联：[CI 提速与测试瘦身](2026-10-21-ci-speed-and-test-diet.md)（#339 的历史，本文只管它之后的四项）

## 结论

#339 已合并（`052f85cb`），CI 提速已交付：Vitest 阶段 33分49秒 → 12分41秒，
E2E 移出 PR 路径后整轮 43 分钟 → 10分51秒。

剩下四项是**独立的四块工作**，各自的实测数据、设计和验收都在本文。
**不需要开 quarantine baseline**——历史红的修复由 PR #343 承担（另一会话），
已在它的 worktree 里实测过：#342 那 59 个既有红文件里 57 个转绿、1 个跳过、
只剩 1 个（`evals/agent/runner/run-suite.test.ts`）归它自己。

## 目标与边界

| 项 | 目标 | 改动范围 |
| --- | --- | --- |
| 1 | `typecheck:all` 按依赖图拆分（CI 上 7.5 分钟，剩下最大的一块） | `scripts/**`、`package.json`、CI workflow |
| 2 | 最慢 7 个测试文件的内部重构 | 指定的 7 个测试文件 |
| 3 | 触碰进程全局状态的测试文件分组串行跑 | `vitest.config.ts`、CI workflow |
| 4 | 12 个「实现已迁移、无人测试」的契约补测试 | `packages/host/tests/**`、`packages/capabilities/tests/**` |

本次不处理：E2E 复用单次 Electron 启动（等 E2E 重回 PR 路径时再做）、
`maxWorkers` 调大（前提是项 2 先把慢文件修好）。

## 验收

- 每项一个独立 PR；提交前跑 `npm run typecheck:all` 与 `npm run architecture:check`，退出 0。
- CI 上不得新增红：相对同一 base 的对照 run，失败文件集合不得出现新增项。
- 性能改动必须附**改动前后的实测对比**（同机、同命令、同范围）。
- 补测试不得放宽断言换绿：新增断言数必须 ≥ 删除断言数。

## 进度

- [x] 项1 调研：逐段计时 + 逐包构建计时，定位真实瓶颈
- [x] 项1 设计定案（见下）
- [ ] 项1 写代码
- [ ] 项2 取当前树的逐文件耗时基线
- [ ] 项2 重构
- [ ] 项3 定入选标准（现口径不可复现，见下）
- [ ] 项3 实现串行组
- [ ] 项4 等 #343 合并后开写

## 发现与决策

### 项1：瓶颈不在 tsc，在构建

逐段计时（2026-10-21，Windows / Node 24 / 20 核，`052f85cb` 树）：

| 段 | 秒 |
| --- | --- |
| `build:packages` | **207.1** |
| `typecheck:web-app` | 77.5 |
| `check:encoding` | 48.5 |
| `typecheck:electron:prepared` | 8.4 |
| 其余 15 段合计 | ~40 |

整条链 372.8 秒，其中**类型检查本身只有 114.1 秒**。

逐包构建耗时（`build:packages` 内部，合计 164.4 秒）：
`@duya/ui` **76.3s**、`@duya/web` **41.6s**、`@duya/agent` 18.0s、
`@duya/capabilities` 6.1s，其余 21 个包合计 ~22s（几乎全是 npm 启动开销）。

三条关键事实：

1. **`@duya/ui` 的 build 是 `tsc -p tsconfig.json --noEmit`** —— 它**不产出任何产物**，
   没有任何包依赖它的 dist。它是一个「藏在构建脚本里的类型检查」，却占了 76.3 秒。
2. `packages/ui/tsconfig.json` 继承 `apps/desktop/tsconfig.renderer.json`，其 `include`
   是根 `tsconfig.json` 的**子集**；根 tsconfig 走 `incremental`（renderer.json 里
   `incremental: true`），ui 显式关掉了（`incremental: false`）→ 每次都是全量。
3. `typecheck:all` 的链里没有 `typecheck:ui`——ui 的类型检查**只**由它的 build 承担。

**设计（V1）**：新增 `scripts/typecheck-all.mjs` 编排三阶段，检查一个不少，
只有并发关系变了：

| 阶段 | 内容 | 并发 |
| --- | --- | --- |
| 1 | `check:encoding` / `check:manifest-keys` / `check:test-coverage` / `check:no-ts-suppress` / `check:packaged-artifacts` | 5 路并行 |
| 2 | `build:packages`（排除 `@duya/ui`） | 与阶段 1 并行 |
| 3 | 13 个 typecheck（含 ui 的 `tsc`） | 有界并行（并发上限按内存定，`tsc` 各自要 6GB 堆上限，不能无界） |

`scripts/build-packages.mjs` 加 `--exclude <pkg>`（可重复），**默认行为不变**，
只供编排器使用。

预期 372.8s → ~208s（44%）。

**为什么先做 V1 而不是更激进的每包 DAG**：V1 只依赖一条已被证明的事实
（ui 不产出产物），风险面小；每包 DAG 需要给 13 个 typecheck 逐个推导
「消费了谁的 dist」，推错一条边就会让类型检查在产物就绪前跑 → 假红。
若要做，必须带一条**失败即回退串行重跑**的安全路径。

**不删任何检查、不改任何门禁阈值。**

### 项2：缺一份当前树的基线

原审计报告点名的 7 个文件里，4 个在 `packages/agent`（已被 #342 删除）：
`prompt-digest` / `ModelProviderSelector` / `one-shot-calls` / `visualVerification` /
`chat-tui-host-stop-continue` / `DuyaAgent.plan315` / `promptStructure`。

起点：取一份当前树的逐文件耗时（CI 的 vitest 日志里有每文件耗时；
或本地全量并行跑一遍再解析），拿到当前的 top 7 再动手。

约束：不得放宽断言换绿；每个改动都要与基线比耗时**和**行为，
「注释写得再详实」不能替代对照。

### 项3：原口径「23 个」不可复现

按不同口径静态扫出的候选数：

| 口径 | 文件数 |
| --- | --- |
| 触碰 `process.stdout/stderr.write` | 13 |
| 再加 `process.env` 变更与 `vi.stubGlobal` | 102 |
| 再加 `process.chdir/exit/on` | 112 |

**判据必须可复现**。建议用「实测在并行下会失败」作为入选依据，
静态扫描只用来圈候选——扫描是候选，判据是实测。

机制：vitest 拆成两个 project（普通并行组 + 串行组），串行组 `fileParallelism: false`。

前提说明：#339 已经把 CI 改成 `--maxWorkers=2` 并行化，且**新增红 = 0**，
所以这一项是**防 flake 的保险**，不是当前任何红的修复。

### 项4：前置是等 #343

#342 把 19 条矩阵行降级为 `unsupported`，其中 12 个属于「实现已迁移、无人测」。
每行的 `reason` 里写明了新归属模块：

| 归属模块 | 缺口 |
| --- | --- |
| `packages/host/src/managed-shell/process-tree-kill.ts` | kill 到达真实进程树 |
| `packages/capabilities/src/file-mutation-queue.ts` | 同文件写串行；realpath 别名共用队列 key |
| `packages/host/src/worker-modes/goal/goal-commands.ts` | goal 跨折叠与冷启动存活 |
| `packages/host/src/worker-context/runtime-context-adapters.ts` | continuation 上下文、后台任务投影、去重、崩溃窗口 |
| `packages/host/src/worker-context/mailbox-attachment-context.ts` | 执行期间补消息/图片 |
| `packages/host/src/worker-agents-md/` | 嵌套 `AGENTS.md` 的加载与释放 |
| `packages/host/src/skills/rootSnapshotCache.ts` + `loader.ts` | 缓存稳定段 |

**等 #343 合并再开写**：#343 改了 `packages/host/src/worker-agents-md/loader.ts`
等实现，现在写测试等于白写。

验收：每个补的测试让对应矩阵行能从 `unsupported` 变成 `covered-by-existing-suite`，
且矩阵门禁仍绿（`npx vitest run evals/agent/matrix/matrix.test.ts`）。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| 052f85cb | Windows / Node 24 / 20 核 | 逐段计时 `typecheck:all` | — | 总 372.8s；build:packages 207.1s、web-app 77.5s、encoding 48.5s、类型检查合计 114.1s |
| 052f85cb | 同上 | 逐包 `npm run -w <pkg> build` 计时 | 0 | 合计 164.4s；ui 76.3s、web 41.6s、agent 18.0s、capabilities 6.1s |
| 09dfbac3（#342） | 同上 | `npm run check:test-coverage` | 0 | every tracked test file is collected |
| 09dfbac3（#342） | 同上 | `npm run architecture:check` | 0 | OK — no new boundary violations |
| fd460c3c（#343 worktree） | 同上 | 跑 #342 那 59 个红文件 | 1 | 57 passed + 1 skipped + 1 failed（`run-suite.test.ts`） |

## 接续 / 结果

| PR | 内容 | 状态 |
| --- | --- | --- |
| #339 | CI 提速与质量修正 | **已合并** `052f85cb` |
| #342 | 退役 `packages/agent` 291 个测试 | open，head `09dfbac3`；`build` job 已绿，`test` job 因既有红而红（新增红 = 0） |
| #343 | 修 master 的 59 个既有红（另一会话所有） | open，head `fd460c3c` |
| #344 | 项1 + 本文档 | 待提 |

**合并顺序**：#339（已合）→ #342 → #343 → 项1 的 PR。

文件级重叠：#343 与 #342 重叠 3 个文件，其中 `evals/agent/matrix/rows.ts` 与
`packages/agent-runtime/test/coalescing-throughput.test.ts` 的 blob **完全相同**
（#343 采用了 #342 的版本），只有 `scripts/architecture/slice-census.txt` 必然冲突
（#343 也改了 `slice-classification.ts`）→ 由 #343 rebase 后重生成。

回收：未回收（#342、#343 未合并，未经授权不合并）。

下一步：实现项1——新增 `scripts/typecheck-all.mjs` 三阶段编排 +
`build-packages.mjs` 的 `--exclude`，用逐段计时验证 372.8s → ~208s，
并证明排除 ui 后的构建产物集合与完整构建一致。完成判据：
`npm run typecheck:all` 退出 0、错误数与基线一致（231 已知错误 / 111 键）、
CI 上 typecheck step 墙钟下降。
