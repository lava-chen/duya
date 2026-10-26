# 633 TUI 项目切换

状态：active · 负责人：未认领 · 更新：2026-10-26
分支：未建 · worktree：未建 · base：master · owner：无

## 目标与边界

用户在 TUI 输入 `/project` 列出 Host 已注册的项目（名称 + 根路径 + 会话数），选择一个后以该目录为根新建会话（或经确认列出该项目最近会话供 `/resume` 式接续）；transcript 顶部状态行显示当前项目名。也支持 `a` 添加新目录注册为项目。

允许修改：`packages/cli/src/tui/slash/`（新 `project.ts`）、`packages/cli/src/chat.ts`（会话创建不再硬绑启动 cwd）、`packages/host/src/`（如需补项目列表路由）、`packages/command-catalog/src/index.ts`（新 spec）。
本次不处理：Desktop 的多项目侧栏（已有）、worktree 语义（归 `/worktree`）、把旧会话改挂到新项目（session 与工作区根的绑定关系保持不可变）。

关联：[系列](README.md)。不依赖 630a——单列表即可，用现有 `chooseFiltered`；后续可迁移到新原语。621 生命周期（[621](../621-coding-workspace-lifecycle-harness.md)）的注册 API 是既有底座。

## 现状事实（2026-10-26 核对）

- TUI 会话创建以 `process.cwd()` 调 `client.registerLocalDirectory`（`packages/cli/src/chat.ts:495`，`http-client.ts:1004`），workspaceId/rootId/projectName 写入新 session；启动 cwd 即项目，运行期无切换入口。
- Host 项目解析三来源 override/working_directory/cwd（`packages/host/src/local-project-api.ts:9-19`）；注册与路径在 `packages/host/src/workspace/{registration,paths}.ts`，装配在 `workspace-lifecycle-api.ts`（plan 621，两 Host 共用）。
- 会话级切换已有 `/resume`（adoptSession）；`add-dir` 只声明 desktop（catalog）。

## 验收

- `duya tui` 内：`/project` 列出≥2 个已注册项目，切换后新会话的工具（Read/Bash）作用域根目录随项目变化并在 `/status` 正确显示；旧会话不受影响；`a` 注册一个未跟踪目录成功。
- `typecheck:all`、`architecture:check`、`npm test -- packages/cli packages/host` 相对基线零新增失败。

## 进度

- [ ] Host 项目列表路由（若缺）：返回已注册项目 + 会话计数。
- [ ] TUI `/project`：列表、选择、新建会话、add-dir 注册。
- [ ] chat.ts 会话根参数化；状态行显示项目名。
- [ ] catalog spec + 可用性（requiresSession=false）+ 平价测试。

## 发现与决策

- 采用「切项目 = 开新会话」而非原地改绑：session 的 workspace 绑定被 rollout/工具权限多处依赖，改绑风险大于收益；接续旧项目用 `/resume`。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| 待执行 | win32 / Node 24 | 验收清单全部命令 | — | 基线在开工检出重记 |

## 接续 / 结果

下一步：建实现 worktree，先核对 Host 是否已有项目列表路由（读 `http-server.ts` 路由表）；完成判据是 `/project` 端到端可用。可随时穿插开工，不阻塞其他切片。
