# 退役 `packages/agent` 的测试套件

状态：active · 负责人：mavis 会话 · 更新：2026-10-21
分支：codex/agent-test-retirement · worktree：E:\Projects\duya\.claude\worktrees\agent-test-retirement
base：5b12f721 · PR：#342 · owner：mavis

> 从 PR #339（CI 提速）拆出。删除 291 个测试文件是一次**测试体系迁移**，
> 需要单独审查覆盖率与迁移依据，不能混在性能优化里一起评审。

## 目标与边界

退役层不再占用 CI 资源；评估矩阵不再声称它没有的覆盖。

允许修改：`packages/agent/**`、`evals/agent/matrix/rows.ts`、`vitest.config.ts`、
`scripts/architecture/slice-census.txt`、`.architecture-baseline.json`、
`scripts/typecheck-electron-baseline.txt`、`architecture-policy.yaml`。
本次不处理：`packages/agent` 源码本身、12 个无人测契约的补测试。

## 验收

- `packages/agent` 下只剩 MCP conformance 门禁与 real-worker fixture。
- 评估矩阵引用的缺失文件数 0，`matrix.test.ts` 全绿。
- `npm run check:test-coverage`、`npm run architecture:check`、
  `architecture-check.mjs --self-test`、`npm run typecheck:all` 全部退出 0。
- 两个 baseline **只减不增**。

## 进度

- [x] 删除 291 个测试文件（146 src 内联 + 135 tests/ + 11 测试基建），保留 2 个
- [x] 同步 `vitest.config.ts` include glob、`slice-census.txt`、两个 baseline、4 处活注释
- [x] 矩阵重指：28 条改指继任者，19 条无继任者的移除，10 行降级为 `unsupported`
- [x] 架构期望值 `module-dependency` 重 pin 127 → 123（归属按载体文件逐条证明）

## 发现与决策

- `packages/agent` 占 281/1459 个被跟踪测试文件（19%），是 AGENTS.md 标注的退役层；
  其中 31 个是**已知的失败文件**——既占资源又不提供回归信号。
- **保留 2 个，各有理由**：
  - `packages/agent/tests/integration/mcp-conformance.test.ts` — AGENTS.md 写明的
    MCP 连通性 L1–L9 门禁；
  - `packages/agent/tests/process/fixtures/real-worker.mjs` — agent-runtime 的传输测试
    spawn 它，且它 import agent 的构建产物 `dist/process/worker-protocol.js`；
    搬到 agent-runtime 会产生**新的**架构违规边（fixture 自己的注释记录了这点）。
- `slice-census.txt` 是冻结的逐文件清单，删文件必须同步维护，否则门禁报漂移。
- 矩阵 `rows.ts` 在删除前就有 27 个引用文件已不存在（#311/#337 迁移遗留）；
  删除把缺失数推到 41，重指 28 条后**降到 0**，门禁由红转绿。
- **12 个契约的继任者"无人测"是既有洞**：实现早已迁到 host/capabilities，迁移时测试没跟着走。
  删除 agent 的测试**没有制造新洞**——那些文件测的是 agent 里的**遗留副本**。
  这 12 个洞在矩阵里被逐条写明（`reason`），而不是被掩盖。补测试是独立任务。
- 删文件连带让 `selfTest.module-dependency` 少 4 条（127 → 123）。按**载体文件**在
  base 树与本分支之间做差集证明：那 4 条分属 3 个被删文件，**仍然存在的文件违规数变化为 0**
  → 解析器没漏看，债是被删掉的。关系式对齐：base 127+2777=2904，本分支 123+2639=2762=边总数。
- `.architecture-baseline.json` **未重录**：2785 个指纹、0 个失效——那 4 个指纹早已不在里面。
  类型门禁 baseline 299 错/146 键 → 231 错/111 键。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| 577c7749 clean | Windows / Node 24 / 20 核 | `npx vitest run`（并行） | 1（有既有失败） | 1457 文件 / 16286 用例 / 87 失败文件 |
| 改动后 | 同上 | `npx vitest run`（并行，全量） | 1 | 1177 文件 / 13284 用例 / 55 失败文件 |
| 改动后 | 同上 | `npx vitest run evals/agent/matrix/matrix.test.ts` | 0 | 16/16 通过；引用缺失 27 → 0 |
| 改动后 | 同上 | `npm run check:test-coverage` | 0 | every tracked test file is collected |
| 改动后 | 同上 | `npm run architecture:check` | 0 | OK — no new boundary violations |
| 改动后 | 同上 | `architecture-check.mjs --self-test` | 0 | module-dependency 123；关系式 123+2639=2762 OK |
| 改动后 | 同上 | `npm run typecheck:all` | 0 | 231 已知错误 / 111 键，0 新增 |

## 接续 / 结果

实现完成并已提交（2 个 commit），PR #342 已开：
https://github.com/lava-chen/duya/pull/342

回收：未回收（PR 未集成，未经授权不合并）。

**与 #341 的重叠**：#341 修改了本 PR 删除的 9 个 agent 测试文件
（`tests/cli-control-plane/**`、`SubagentTool/__tests__/subagent-engine-run.test.ts`）
及 `packages/agent/package.json`。那些测试在基线 CI 上是**绿的**，#341 是在改健康代码。
合并顺序：本 PR 先合，#341 再 rebase。

**与 #339 的关系**：#339 只做 CI 提速与质量修正，两边无文件重叠。
