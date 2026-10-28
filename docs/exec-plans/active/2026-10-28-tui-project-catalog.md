# 统一 TUI 与桌面端的「项目」概念

状态：active · 负责人：codex · 更新：2026-10-28
分支：`codex/tui-project-catalog` · worktree：`.claude/worktrees/tui-project-catalog` · base：`220a63ff` · owner：本 agent

## 目标与边界

TUI 的 `/project` 从「会话投影派生的目录列表」改为「Host 已登记的项目列表」，并新增 `/project add <path> [name]` 把一个目录登记成项目。

用户可观察的变化：TUI 里 `/project` 列出的是带名称的**已登记项目**（桌面端注册过的、或用 `/project add` 登记过的），而不是「跑过会话的任意目录」。`E:\cloned-projects\codex` 这类从未跑过会话的目录，登记一次后两端都能看见。

允许修改：`packages/cli/src/tui/slash/project.ts`、`packages/command-catalog/src/index.ts`、相关测试；第二个 commit 另含 `packages/data/src/project-home.ts`（新）、`packages/host/src/project-api.ts`、`apps/desktop/src/main/db/core/projectService.ts`、`apps/desktop/src/main/ipc/project-entity-handlers.ts`。

本次**不**处理：桌面端项目列表语义与 UI 变更；`rename` / `remove`；会话↔项目绑定机制（`resolveWorkspaceBinding` / `findProjectForCwd`）；`catalogSync` 的自动登记行为。

关联：上级计划 [630 TUI 能力系列](630-tui-capabilities-series/README.md)；本计划**推翻** [633 TUI 项目切换](630-tui-capabilities-series/633-tui-project-switch.md) §「发现与决策」里「不取 `GET /v1/projects`…不新增第二处真值来源」的决定，理由见下。

## 验收

1. `npm run typecheck:all` 退出码 0。
2. `npm run architecture:check` 退出码 0，无新增违规（`packages/command-catalog` 为 `managed: true, requires: []`，本次只改数据不加 import）。
3. `npx vitest run packages/cli/src/tui/slash packages/cli/src/__tests__/chat-tui-project-switch.test.ts packages/command-catalog` 全绿；改动前的基线失败另行记录。
4. `npm run bundle:verify`：若第二个 commit 动了 `packages/host/src/project-api.ts`，它**在** worker bundle 输入闭包内，必须 `npm run bundle:worker` 并提交重建后的 `packages/host/bundle/`；只做第一个 commit 时预期 FRESH 且无需重建。
5. 真机：`npm run build:cli-dev` → `npm run dev:tui` → `/project add E:\cloned-projects\codex` → `/project` 应列出 `codex`；桌面端项目页出现同一个项目；切过去后状态行跟随新目录。

## 进度

- [x] 摸清两侧数据面：TUI 走会话投影，桌面端走 `projects` 表；`/v1/projects` 与 `HostSessionHttpClient` 已就绪，管道是通的
- [x] 用户决策：projects 表为唯一真值；未登记目录不进列表；TUI 至少要能 `add`；本次只做 TUI 侧
- [x] 独立 worktree 与依赖（根 `node_modules` 复用主检出，`@duya/*` 指向本 worktree）
- [x] commit 1：TUI `/project` 改读 `GET /v1/projects`，新增 `/project add`
- [ ] commit 2：**取消**（见「发现与决策」里 project home 播种那条）
- [ ] 门禁 + 真机冒烟 + PR

## 发现与决策

**桌面端有两条写 `projects` 表的路径，语义不同。** UI 表单注册（`CreateProjectDialog.tsx:230` 的 name 回落 `basename(paths[0])`，故 name 必非空）与 `catalogSync` 自动注册（`catalogSync.ts:263` → `projectResolver.ts:330` 的 `INSERT ... name=''`、单 path）。**`name !== ''` 因此是「显式登记」的可靠判别式**——catalogSync 的 step 2 / step 3 只 bump `last_seen_at`，不改 name。

**`catalogSync` 只在桌面端的 memory worker 里跑**（`apps/desktop/src/main/memory/memory-worker.ts`），所以只用 TUI 时 `projects` 表一直是空的——本机 700+ 会话、13 个 `working_directory`，表里 0 行。列表里那 6 个 `.claude/worktrees/*` 与 `E:\lavachen\pack` 就是「跑过会话的目录」被当成项目的结果。

**Host 侧已有全套项目 API，管道是通的。** `packages/host/src/project-api.ts` 提供 list/get/create/update/delete，路由 `packages/host/src/http-server.ts:3241`（GET/POST）与 `:3269`（GET/PATCH/DELETE），由 `local-host.ts:912` 注入。TUI 的 `ctx.client` 是 `HostSessionHttpClient`，已实现 `HostProjectApiV1`（`http-client.ts:2379-2409`）。**Host 侧本不需要新增路由。**

**`canonical_root` UNIQUE 但 `paths[]` 不 UNIQUE**（`packages/data/src/project-store.ts:132`）。所以 `/project add` 必须先按 path 找已有行，否则会出现两个 canonical_root 不同的项目共享同一路径。`createProject` 抛 `project_conflict`（`project-api.ts:59`，HTTP 409，见 `http-server.ts:5484`）时也是同一个信号的另一个出口。

**先登记、再切换，这个顺序是承重的。** CLI 切换目录走 `registerLocalDirectory` → `registerWorkspaceDirectory`（`packages/data/src/workspace-resolver.ts:223`），而它内部先调 `resolveWorkspacePathReference`，**后者会查 Project 层**（`findProjectForCwd` → `ensureWorkspaceForProject`）。所以只要 `projects` 行先于目录注册存在，会话就绑到那个项目的 workspace 上；反过来（先切换后登记）则会新建一个 `project_id` 为 NULL 的 workspace，注册的项目与之无关。

**project home 播种：本轮不做，且原计划的 commit 2 取消。** 桌面端注册项目时会在 `~/.duya/projects/<id>/` 播种 `plans/` 骨架与 `AGENTS.md`（`project-entity-handlers.ts:283-287`），Host 的 `createProject` 不播种。但把播种逻辑下沉到 `packages/data` 让 Host 一并播种，**在 TUI 侧没有收益**：

- plan 工具自己会建目录（`packages/host/src/worker-tool-services/plan.ts:172` 的 `mkdirSync(..., {recursive:true})`）；
- project-home 的 AGENTS.md 来源要靠 `projects:resolveProject` 解析出 projectHome，而 **standalone Host 的 `worker-db-bridge.ts` 没有这个分支**——它只走桌面端的 DB bridge；CLI 这条路上 run manifest 的 `projectId` 恒为 null（`packages/host/src/worker-engine-driver.ts:167`）。

所以播种出来的文件在 TUI 侧没有人读。要让 TUI 登记的项目真正与桌面端对齐，缺的是「Host 能把目录解析成 projectHome」这一段，不是播种本身——那是独立的一块，且会动到桌面端（与本次「桌面端不动」的边界冲突）。

**桌面端根本没有 `/project`。** catalog 里 `/project` 的 `surfaces` 是 `['cli']`；桌面端弹出层不显示它，手动输入会被当成普通文本发给模型（`packages/ui/src/lib/commands/executors/registry.ts:77-80`）。桌面端切换目录的两个入口语义都与 CLI 相反或更弱：`SessionSelector` 改的是**当前**会话的 `working_directory`（`conversation-store.ts:1453`），而 CLI 的 `/project` 是**开新会话**；`/add-dir` 只写 recent folders，不进 `projects` 表。所以两端共享的是**项目实体**，切换动作本身仍各行其是。

**`packages/cli/src/tui/slash/**` 与 `packages/command-catalog/**` 都不在 worker bundle 的 metafile 输入闭包里** → 纯 TUI 改动不产生需要提交的产物。

**catalog 的子命令不与 handler 交叉校验**（`packages/command-catalog/tests/catalog.test.ts:64` 只要求小写 token），`slash-commands.test.ts` 的硬编码命令名列表里已有 `'project'` → 加子命令不撞契约测试。

**`/project add` 的参数规则**：首个 token 是路径，其余是名字；含空格的路径要加引号（`/project add "C:\My Projects\app"`）。选择器里的「登记一个目录…」行走 `promptText` 单独输入路径，没有这个歧义。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `220a63ff` 干净 | Windows 11 / Node 24.16.0 | `node scripts/architecture/bundle-verify.mjs` | 0 · FRESH 0/1015 | base 上已提交的产物与源码一致，无需重建 |

## 接续 / 结果

未实现。下一个动作：在本 worktree 写 commit 1（`packages/cli/src/tui/slash/project.ts` 改读 `listProjects()` + 新增 `registerProject()`）。
回收：未回收（成果未集成）。
