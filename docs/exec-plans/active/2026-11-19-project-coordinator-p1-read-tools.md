# <任务：Project Coordinator 只读工作区（P1）>

状态：active · 负责人：claude-code/session-project-coordinator-p1 · 更新：2026-11-19
分支：codex/project-coordinator-p1-read-tools · worktree：/home/lavachen/Projects/duya/.claude/worktrees/project-coordinator-p1-read-tools · base：26e16dc70（P0 分支 `codex/project-coordinator-p0-tool-surface` 的 head）· owner：claude-code/session-project-coordinator-p1

## 目标与边界

按 [设计 §14](https://github.com/lava-chen/duya/pull/643) 的 P1 阶段，给 Project Coordinator 接入只读工作区能力：

- Coordinator 白名单增加 `read` / `glob` / `grep`；仍不给写面（`write` / `edit` / `bash` 不在白名单）。
- 读根取 Coordinator 绑定项目的 `canonical_root`，由 Host 按调用注入；越界、`..`、符号链接逃逸一律拒绝。
- 没有可信项目根时按失败关闭处理（读全部拒绝），不退回“无限制”。

关联：前置 [P0 工具面](2026-11-19-project-coordinator-p0-tool-surface.md)（PR [#644](https://github.com/lava-chen/duya/pull/644)，未合并，本 PR 叠在其上）；设计 §14.1 / §14.4 / §14.6 T20 / §14.7。

不在本次范围：P2（`write/edit` 与文件化知识）、P3（`bash` 观察）、P4（canonical `session` 增加 `read/send`）、P5（`send_message`）；UI 与 IPC 形态不变；Host 侧项目写 API 与 HTTP 连续性投影不变。

## 验收

- **T20**：`read` / `glob` / `grep` 只能读 Coordinator 绑定项目的工作区；绝对路径越界、`..`、符号链接逃逸被拒；此时没有写能力。
  - 越界绝对路径 → 拒绝。
  - 相对路径经 `..` 逃出根 → 拒绝。
  - 根内符号链接指向根外 → 拒绝（realpath 比对）。
  - 无绑定 / 无可信根 → 全部拒绝（失败关闭）。
  - Coordinator 工具表不含 `write` / `edit` / `apply_patch` / `bash` / `powershell` / `todo` / `catalog` / `invoke`。
- `npm run typecheck:all` 退出码 0。
- `npm run architecture:check` 退出码 0，且未新增 baseline 指纹。
- 相关测试：`packages/capabilities/tests/`（读根约束）、`packages/host/tests/worker-profiles/types.test.ts`（白名单）、`packages/host/tests/worker-tool-registry*.test.ts`（按调用注入根）。

## 进度

- [x] 能力层：`ToolUseContext` 增加按调用的 `allowedRoots`，三个读工具统一执行
- [x] Host 层：按调用解析 Coordinator 可信项目根并注入
- [x] 白名单与提示词
- [x] T20 测试与门禁

## 发现与决策

1. 可见性过滤的 allowlist 对 eager 工具同样生效（`packages/agent-runtime/src/authorization/tool-filter.ts:125`），profile 的 `allowedTools` 走 `profileAllowedPatterns`（`packages/agent-composition/tools-selection.ts:25`）。因此 P1 只需把三个读工具名加进 profile 白名单，不需要改暴露策略。
2. `read` / `glob` / `grep` 在 Host 是**共享单例**（`packages/host/src/worker-tools/builtin.ts:64`、`:43`、`:72`），构造函数已有 `allowedRoots` 但 Host 未传。按用户裁定（§14.7 第 1 项）采用「按调用注入可信项目根」，因此根随调用进入 `ToolUseContext.options.allowedRoots`，不写进共享实例。
3. 「可信」的判定分两段，各由其所有者负责：*这个会话是不是 Coordinator* 由 profile id 判定（`isProjectCoordinatorProfile`，Host 自己的会话配置）；*根是哪个* 由 Host 的数据库判定（`projects.getByCoordinatorSession(sessionId).canonical_root`），worker 不能自带路径。两者都不来自模型输入。
4. 失败关闭需要显式信号：空根集合在既有语义里表示「不限制」。因此语义定为 `allowedRoots === undefined` = 无调用方限制；`allowedRoots` 存在但为空 = 没有可信根，全部拒绝。
5. `glob` 的模式可带最多三层 `..`（`isPatternSafe`），只检查搜索目录不足以拦住 `../..`。因此除搜索目录外，还要把模式的字面前缀解析成绝对路径再判根。
6. 符号链接逃逸由 `isPathWithinRoots` 的 realpath 比对负责（`packages/sandbox/src/allowed-roots.ts:64`），目标不存在时退回词法判断——读工具的目标一般存在，符合「读」的场景。
7. §14.7 第 3 项的残余问题本次按最保守解释落地：读根只有 `canonical_root`，多路径项目的其他 `paths[]` 与根外的 `docs-local/` 都不放开。该项仍标记为待用户裁定，不写成已具备。

## 验证记录

环境：Linux 7.2.15-300.fc45.x86_64 / Node v26.13.0；检出为独立 worktree，依赖走 worktree-local junction。

| SHA / dirty 范围 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- |
| 26e16dc70（干净） | `node scripts/junction-worktree.mjs . --primary /home/lavachen/.codex/worktrees/project-coordinator-tool-picker/duya` | 0 | worktree 内 61 条 junction，无穿越共享链接安装 |
| 62e1d2c42（干净） | `npx vitest run packages/capabilities/tests packages/host/tests` | 0 | 336 个文件通过 / 2901 通过 / 2 跳过；含新增 `packages/capabilities/tests/readAllowedRoots.test.ts`（11 例）与 `packages/host/tests/project/read-roots.test.ts`（5 例） |
| 62e1d2c42（干净） | `npm run typecheck:all` | 0 | 全仓通过；`typecheck:evals` 报 164 条既有基线错误，无新增 |
| 62e1d2c42（干净） | `npm run architecture:check` | 0 | `OK — no new boundary violations`；tolerated 3206 / baseline 2530；`63 baseline fingerprint(s) no longer triggered` 属既有漂移（见 2026-10-25 约定），本切片不重记 baseline |
| 62e1d2c42（干净） | `npm run check:encoding` | 0 | `OK — no new violations (11 known)` |
| 62e1d2c42（干净） | `git diff --check -- packages/capabilities packages/host/src packages/host/tests` | 0 | 手写源无行尾空白；生成的 bundle 除外（压缩产物，非本切片手写） |
| 62e1d2c42（干净） | `npm run test -w @duya/capabilities`（子目录 cwd） | 1 | **基线失败**：`tests/mcp/report-viewer-example.test.ts` 用 `process.cwd()` 定位 `plugins/examples/report-viewer/...`，子目录 cwd 下路径不存在导致 MCP 连接失败；仓库根跑同一文件通过（`npx vitest run packages/capabilities/tests/mcp/report-viewer-example.test.ts` → 1 passed），与本次改动无关 |
| 3a1aa453e（干净） | `npm run bundle:worker` | 0 | 重建 `packages/host/bundle/`（worker-entry.js 5.50 MB） |
| 3a1aa453e（干净） | `npm run bundle:verify` | 0 | `FRESH 0/1123 bundle inputs changed after the bundle commit` |

## 接续 / 结果

已实现：能力层新增 `packages/capabilities/src/utils/allowed-roots.ts`，`ToolUseContext.options.allowedRoots` 承载按调用的可信根，`read` / `glob` / `grep` 三个工具统一按「工具自身根 ∩ 调用方根」判定，`glob` 额外判模式的字面前缀（`globPatternBase`）以拦住 `..` 逃逸；Host 侧新增 `packages/host/src/project/read-roots.ts` 与 `project:binding-root` 桥接，根由 Host 依可信 attempt 的 session id 从 `projects.getByCoordinatorSession(...).canonical_root` 解析，worker 不自带路径；Coordinator 白名单加 `read` / `glob` / `grep`，写面仍无，identity/operation 提示词改写。

已验证：见上表。T20 五个子项逐条有用例：越界绝对路径、相对路径经 `..` 逃逸、根内符号链接指向根外、无绑定 / 无可信根全部拒绝、Coordinator 工具表不含写面。

已交付：分支 `codex/project-coordinator-p1-read-tools`，commit `62e1d2c42`（feat）、`3a1aa453e`（bundle）、文档提交；PR 叠在 PR #644（P0）之上，待开 Draft。

未提交路径：无（worktree 内 `node_modules` junction 与 `docs-local` 之外的临时产物均未入库）。

副作用：未合并、未发布、未改动共享检出；未触碰 P2–P5 的任何范围。

回收：未回收（worktree 与分支保留给本次任务的 PR 与后续集成）。

下一步：开 stacked Draft PR 并等 CI / review；集成需用户授权。§14.7 第 3 项（多路径项目的其他 `paths[]` 与根外的 `docs-local/` 是否放开）仍待用户裁定，本次按最保守口径落地。
