# 633 TUI 项目切换

状态：active（PR 已提交待集成） · 负责人：codex（本检出） · 更新：2026-10-26
分支：`codex/633-tui-project-switch` · PR：[#518](https://github.com/lava-chen/duya/pull/518)（`cbe23fc6` + `64a12a51` + `3a1b4882`） · worktree：`.claude/worktrees/633-project-switch` · base：`d80ca3c6` · owner：本 agent

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

- [x] Host 项目列表路由：**不需要新增**（见「发现与决策」第一条）。
- [x] TUI `/project`：列表、选择、新建会话、添加目录（`packages/cli/src/tui/slash/project.ts`）。
- [x] chat.ts 会话根参数化；状态行显示当前目录。
- [x] catalog spec（`packages/command-catalog/src/index.ts`，`surfaces: ['cli']`）。
- [ ] 真机验收：`duya tui` 内切换后 Read/Bash 作用域随项目变化（尚未跑，见验证记录）。

## 发现与决策

- 采用「切项目 = 开新会话」而非原地改绑：session 的 workspace 绑定被 rollout/工具权限多处依赖，改绑风险大于收益；接续旧项目用 `/resume`。`SessionCheckoutService` 把 `extensions.executionLocation.cwd` 与 `row.workingDirectory` 锁在一起（`packages/host/src/workspace/session-checkout-service.ts`：两者不一致时 `read()` 直接拒绝），实证了原地改绑会立刻让 `/worktree` 的围栏失效。
- 项目清单取自本地会话投影（`GET /v1/local/sessions` 的 `workingDirectory` + `recencyAt`），不取 `GET /v1/projects`：Host 已在前者里逐条返回绝对路径，客户端按目录分组即得「项目 + 会话数 + 最近使用」，因此本切片不动 `packages/host/`，也就不需要 `bundle:worker` 重建。代价要写清楚：**注册过但一个会话都没有的 Desktop 项目不会出现在选择器里**，这类目录靠「Add a directory…」行或 `/project <path>` 到达。
- 排序键用 `recencyAt`（最后一次开 turn）而不是 `updatedAt`：后者被改名/归档顶一下就会把项目推到选择器最前，用户看到的是自己刚收拾过的而不是刚干过的。
- 状态行显示的是 `executionCwd()`（绝对路径）而不是项目名，与目标那句「显示当前项目名」不完全同形；沿用既有 statusText 拼接，不新增第二处真值来源。
- `/project` 需要循环动作 `actions.startSessionInDirectory`，跨的是会话边界而不是记录字段：`session_updated` 那种 outcome 只换 record，不会重挂 watch/clearTranscript，所以走 loop action（与 `/fork`、`/archive` 同侧）。缺 actions 的表面（headless 调用）在 `run()` 入口就拒绝，而不是让用户挑完才发现不能切。
- 添加目录做成选择器末行 + `promptText`，不是计划里写的 `a` 键位：现有 `chooseFiltered` 没有键位通道，加键位属于 630a 的面板原语范围。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `d80ca3c6` + 本切片 9 文件 | win32 / Node 24.18 / worktree 633 | `npx vitest run packages/cli/src/tui/slash/__tests__/project.test.ts` | 0 | 19 passed（分组/排序/大小写折叠/`~`/选择器/无 UI 退化/参数式/忙拒绝/Host 拒绝上报） |
| 同上 | 同上 | `npm run -w @duya/cli typecheck` | 2 | 仅剩 `src/tui/client-lease-holder.ts:116` 两处 `HostClientLease.lost` 报错，属检出内 `@duya/host` 已构建声明陈旧（该文件未被本切片修改）；本切片文件零报错 |
| 同上 | 同上 | `npm run architecture:check` | 0 | `OK — no new boundary violations.`；另报 3 条 baseline 指纹未被触发（未 `--write` 收窄，留给集成后重验） |
| `3a1b4882`（head） | GitHub Actions ubuntu-22.x | PR CI `test` / `typecheck` / `architecture` / `build` | 见下 | 首轮（`cbe23fc6`）：typecheck / architecture / build / test scope **pass**，`test` **fail 1 例** —— `chat-tui-project-switch.test.ts > keeps a per-session checkout cursor ahead of the surface directory` 超时；本机未能复现运行（见下） |
| 待执行 | — | 本机 `packages/cli` 套件 | — | **本检出跑不了任何 `chatTui` 循环级测试**：`@duya/ai/context` 经共享 junction 解析到主检出 `E:/Projects/duya/packages/ai/dist/context.js`，连未改动的 `packages/cli/src/__tests__/chat-empty-session.test.ts` 都以 `Failed to load url` 报错（既有环境缺口，非本切片引入；CI 侧 50 files / 521 tests 正常） |

## 接续 / 结果

已提交为本 PR（https://github.com/lava-chen/duya/pull/518），**未集成**（等用户授权）。与 630a（#512）、632（#514）、634（#516）互不依赖，可独立 review。

- 首轮 CI 那 1 例失败已定位为测试自身的时序：它在 `startAgentRun` 一被记录就提交 `/project`，此时上一轮 turn 还持有会话，命令回的是忙拒绝，等的那句 notice 当然不来。`3a1b4882` 改成先等 busy 落回，并把同文件里两处固定 sleep 换成「等它断言的那句话」，慢机器上不再可能因为「什么都没处理」而假绿。该修正**只经 CI 验证**，本机跑不了。
- 下一条动作：等 head `3a1b4882` 的 `test` 转绿再谈集成；集成后在合并后的 master 上补 `npx vitest run packages/cli packages/command-catalog` 与 `npm run typecheck:all`（fake 的 `watchAgentRunEvents(runId, { signal })` 形状已按 `packages/cli/src/tui/remote-session-watch.ts:144` 核对），再做真机验收「切换后 Read/Bash 作用域随项目变化、`/status` 与状态行跟随新目录」。

