# CI 提速与测试瘦身

状态：active · 负责人：mavis 会话 · 更新：2026-10-21
分支：codex/ci-speed-and-test-diet · worktree：E:\Projects\duya\.claude\worktrees\ci-speed-diet · base：577c7749 · owner：mavis

## 目标与边界

普通 PR 的 CI 从 43 分钟降到 15 分钟内；退役包不再占用测试资源；矩阵不再声称它没有的覆盖。
允许修改：`.github/workflows/test.yml`、`scripts/ci/**`、`vitest.config.ts`、`packages/agent/tests/**`、
`packages/agent/src/**/*.test.ts`、`e2e/**`、`evals/agent/matrix/rows.ts`、架构 census 与 baseline。
本次不处理：`packages/agent` 源码本身、E2E 复用单次 Electron 启动、typecheck 依赖图拆分、
最慢 7 个测试文件的内部重构。

## 验收

- `npm run ci:test-scope` 对纯元数据 `package.json` 改动不再返回 `full`。
- 并行与串行两次全量 vitest 的失败文件集合一致（并行不得引入新失败）。
- `npm run check:test-coverage`、`npm run architecture:check` 退出 0。
- `packages/agent` 下只剩 MCP conformance 门禁与 real-worker fixture。

## 进度

- [x] 基线：串行 23分23秒 / 并行 4分20秒，两次失败集合对比（并行仅新增 1 个超时用例）
- [x] W1 根 `package.json` 元数据改动不再升级为全量 unit + E2E
- [x] W2 CI 去掉全局 `--no-file-parallelism`，改为 `--maxWorkers=2`
- [x] W3 删除 `packages/agent` 291 个测试文件，同步 include globs / slice-census / 架构 baseline
- [x] W4 清理低价值测试：删除调试性质 E2E、修正 macOS 专属断言、修正 conductor 入口
- [x] 矩阵重指：28 条引用改指继任者，19 条无继任者的引用移除，10 行降级为 `unsupported`
- [x] 验证：改动后全量 vitest、typecheck:all、architecture:check
- [x] CI 归因：以 PR #338（同 base、无代码改动、`test` job 真跑全量）为对照做双向差集
- [x] 修并行暴露的两个测试隔离缺陷（`task-store.test.ts`、`worker-transport-write-queue.test.ts`）
- [x] 架构期望值 `module-dependency` 重 pin 127 → 123（归属按载体文件逐条证明）

## 发现与决策

- CI 的串行不是 Vitest 配置，而是 workflow 里写死的 `--no-file-parallelism`（`test.yml:392-399`），
  理由是"稳定的临时测试命名空间"；实测 369 个测试文件用 `mkdtemp`，固定路径极少 → 全面串行属过度反应。
  **本地实测：串行 23分23秒 → 并行 4分20秒。**
- 并行只引入 1 个新失败：`coalescing-throughput.test.ts` 的 10 虚拟分钟场景在默认 10s 预算下超时
  （实测 13s，与并行无关，串行那次是侥幸通过）→ 给该用例显式 30s 预算。
- `packages/agent` 占 281/1459 个被跟踪测试文件（19%），且是 AGENTS.md 标注的退役层。
  删除 291 个（146 个 src 内联 + 135 个 tests/ + 11 个测试基建，保留 2 个文件）。
- 保留两件：MCP conformance L1–L9（AGENTS.md 写明的门禁）、`real-worker.mjs`
  （agent-runtime 的传输测试 spawn 它，且它 import agent 的构建产物，搬走会产生新的架构违规边）。
- `slice-census.txt` 是冻结的逐文件清单，删文件必须同步维护，否则门禁报漂移。
- 矩阵 `rows.ts` 在 HEAD 上就有 27 个引用文件已不存在（#311/#337 迁移遗留）。
  删 agent 测试会把缺失数推到 41；重指 28 条引用后**降到 0**，门禁由红转绿。
- 12 个契约的继任者"无人测"是**既有洞**：它们的实现早已迁到 host/capabilities，迁走时就没人测。
  这 10 个矩阵行因此降级为 `unsupported` 并在 `reason` 里写明缺口与归属模块。
- conductor E2E 失败的根因：主导航（conductor 入口）只在 sidebar 的 **Work tab** 渲染，
  而应用默认停在 Bots tab → 三个 spec 各自白等 20 秒。修法是共享 helper + 给 Work tab 补 testid。
- `e2e/ipc/computer-use-permissions.spec.ts` 无条件断言 `platform === 'darwin'`，
  而 CI 的 E2E 跑在 ubuntu → 必然失败。TCC 是 macOS 专属契约，改为平台限定。
- **master 的 run 不能用作 CI 归因对照**：CI 分流（#327）后 push 到 master 时 scope 为空，
  `test`/`build` job 被 skip，近期 3 条 master run 全部如此 → 绿色是假证据。
  合法对照是 PR #338：同一 base `577c7749`、只改文档、`test` job 真跑全量（1457 文件 / 95 失败）。
- 删 agent 测试连带让 `selfTest.module-dependency` 少 4 条（127 → 123）。按**载体文件**在
  base 树与 HEAD 树之间做差集证明：那 4 条分属 3 个被删文件，**仍然存在的文件违规数变化为 0**
  → 解析器没漏看，债是被删掉的。关系式对齐：base 127+2777=2904，HEAD 123+2639=2762=边总数。
  `.architecture-baseline.json` 未重录（2785 指纹、0 失效，那 4 个早已不在里面）。
- 并行暴露的两个红都是**测试隔离缺陷**，不是产品缺陷：
  `task-store.test.ts` 的 `withTempDir` 在 Promise settle 前删目录（异步读被删 → store 返回 `[]`）；
  `worker-transport-write-queue.test.ts` 的被测模块把 `isDraining` 放在模块作用域，前一个用例
  留下"挂起"状态后，后一个用例的 50 帧只入队不写出（CI 症状：期望 50 次、实际 0 次）。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| 577c7749 clean | Windows / Node 24 / 20 核 | `npx vitest run`（并行） | 1（有既有失败） | 4分20秒，87 失败文件 / 16286 用例 |
| 577c7749 clean | 同上 | `npx vitest run --no-file-parallelism` | 1 | 23分23秒；剔除中途删除产生的 164 个收集错误后 55 个真实失败 |
| 工作区 | 同上 | 失败集合差集 | — | 并行仅新增 1 个（超时用例），串行独有 0 个 |
| 工作区 | 同上 | `npx vitest run scripts/ci/test-scope.test.ts` | 0 | 36/36 通过 |
| 工作区 | 同上 | `npm run check:test-coverage` | 0 | every tracked test file is collected |
| 工作区 | 同上 | `npm run architecture:check` | 0 | OK — no new boundary violations（142 个失效指纹已收缩） |
| 工作区 | 同上 | `npx vitest run evals/agent/matrix/matrix.test.ts` | 0 | 16/16 通过；引用缺失 27 → 0 |
| c0647db1 | 同上 | `npx vitest run`（并行，全量） | 1 | 4分59秒，1177 文件 / 13284 用例 / 55 失败文件 |
| c0647db1 | 同上 | `npm run typecheck:all` | 0 | 231 已知错误 / 111 键，0 新增 |
| c0647db1 | 同上 | `npm run architecture:check` | 0 | OK — no new boundary violations |
| c0647db1 | 同上 | `architecture-check.mjs --self-test` | 2 | `module-dependency expected 127, counted 123` |
| c0647db1 + base 树物化 | 同上 | 两树按载体文件差分 | — | 4 条差异全部来自 3 个被删文件；未删文件变化 0 个 |
| e0a5e911 | 同上 | `architecture-check.mjs --self-test` | 0 | module-dependency 123；关系式 123+2639=2762 OK |
| a7f056fd | 同上 | `npx vitest run packages/host/tests/` | 1 | 7 个失败文件，与 CI 清单逐一对照**全部是既有红** |
| a7f056fd | 同上 | `npm run typecheck:all` | 0 | exit 0 |

## 接续 / 结果

实现完成并已提交（6 个 commit），PR #339 已开：
https://github.com/lava-chen/duya/pull/339
回收：未回收（PR 未集成，未经授权不合并）。
下一步：CI 全量 run 通过后由用户决定是否合并。

遗留（已写入 PR body 的"本次不做"）：
最慢 7 个测试文件的内部重构、E2E 复用单次 Electron 启动、`typecheck:all` 按依赖图拆分、
12 个"实现已迁移、无人测试"的契约补测试、把触碰进程全局状态的测试文件（静态扫出 23 个）
单独分组串行跑。
