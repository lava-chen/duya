# duya vs openclaw — CLI 实现程度对比

> **Date**: 2026-06-04
> **Reference projects**:
> - duya: `E:\Projects\duya` (Electron + Vite AI agent client)
> - openclaw: `E:\cloned-projects\openclaw` (standalone gateway/agent runtime)
>
> **Status**: Reference document. Anchors design decisions for plan 98
> ([`docs/exec-plans/active/98-cli-channel-cron-message.md`](../../exec-plans/active/98-cli-channel-cron-message.md)).

This document compares the CLI control planes of duya and openclaw. It
exists as **a project-local knowledge reference**, not a competitive
analysis — both projects target different audiences, but the
implementation gap drives concrete decisions about which duya
capabilities need to be exposed and how the registration architecture
should evolve.

---

## 1. 定位差异

| 维度 | duya | openclaw |
|---|---|---|
| **CLI 性质** | 桌面应用的**查询 / 控制平面** | **独立可执行产品**的 CLI |
| **进程模型** | 依赖 electron desktop 进程运行（127.0.0.1 HTTP） | 独立 daemon，可 systemd/launchd 安装 |
| **代码量** | 入口 + commands 合计约 **2,300 行** | 233 个 TS 文件，共 **45,550 行**（约 20×） |
| **顶层命令** | **10** 个（status / plugin / session / skill / mcp / provider / doctor / install-cli / uninstall-cli / setup） | **50+** 个 core + subcli |
| **目标用户** | 桌面应用的高级用户、开发者、自动化脚本 | 终端用户、CI/CD 流水线 |
| **权限模型** | 写操作 `--yes` + 审计日志，遵循 Phase 7 约束（参考 [`roadmap.md §3.2`](./roadmap.md)） | `--profile` / `--container` 隔离 + daemon 生命周期管理 |

**结论**：duya 是"thin control plane"，openclaw 是"CLI 即产品"。两者
**不应**对标命令数量；duya 的扩展方向是把**已有但未暴露**的运行时能力
补齐到 CLI，而不是堆叠 openclaw 风格的 standalone 功能。

---

## 2. 架构差异

### duya：薄壳 + HTTP 客户端

```
duya cli (命令行)
   ↓ HTTP /v1/*
electron main process (运行时、状态、resolver)
   ↑ 返回 frozen DTO
```

- 所有 `duya {plugin,session,skill,mcp,provider,status,doctor}` 子命令都**只调 `CliApiClient`**（`packages/agent/src/cli/api/client.ts:47-88`）
- **必须依赖 electron desktop 运行**。desktop 不可用 = CLI 不可用
- 127.0.0.1 only，无 remote control（[`roadmap.md §3.5`](./roadmap.md)）
- 输出策略：text/json 双格式（`api/format.ts`）

### openclaw：standalone daemon/gateway

- 自带 `daemon-cli/`（服务安装/启停/health 探活）、`gateway-cli/`（WebSocket RPC）、`cron-cli/`、`nodes-cli/`、`hooks-cli/`、`webhooks-cli/`
- 进程模型：可独立 install/launchd/systemd 服务
- 内置 `crestodian`（ring-0 自愈助手）、`dashboard`、TUI（`tui-cli.ts`）
- **Plugin CLI 动态注册**（`src/cli/program/command-registry.ts:367-389`）：插件可声明自己的 CLI 子命令，主程序 lazy 加载

---

## 3. 子命令覆盖对比

| 域 | duya | openclaw |
|---|---|---|
| **Plugin 生命周期** | 仅 `list` / `info`（只读） | **install / uninstall / update / list / policy / config / registry-refresh**（928 行 `plugins-cli.ts` + 多个子模块） |
| **Skill 生命周期** | `list` / `info` / `enable` / `disable`（写操作有 confirmation） | `skills-cli.ts` + `skills-cli.format.ts` |
| **Session** | `list` / `show`（只读） | `sessions list` + `tasks` 持久化任务状态 |
| **MCP** | `list` / `info`（只读） | `mcp` 子命令 + channel bridge 管理 |
| **Provider** | `list` / `info` / `add`（add 是 placeholder） | `models`（discover/scan/configure）+ `infer` + `capability` |
| **Status / Health** | `status`（调 desktop `/v1/status`） | `status` + `health` + `daemon status` + 多个 probe |
| **Doctor** | ✅ 12 项 runtime/desktop/plugin/session 分类检查 | `doctor` + `crestodian` 修复助手 |
| **Gateway/Daemon** | ❌ | ✅ 完整服务管理（install/start/stop/restart/probe/logs） |
| **Cron** | ❌ | ✅ `cron add/edit/list/remove`（5 个子文件） |
| **Message 收发** | ❌ | ✅ `message send/read/edit/delete/pin/reactions/poll/broadcast/thread/permissions-search/emoji-sticker/discord-admin` 等 **10+ 子命令** |
| **Hooks / Webhooks / Pairing** | ❌ | ✅ |
| **Channel** | ❌（但 gateway 内部已实现 telegram/qq/feishu 通道管理） | ✅ `channels-cli.ts` + `channel-auth.ts` + `channel-options.ts` |
| **Nodes（相机/画布/媒体/屏幕）** | ❌ | ✅ `nodes-cli/` + `nodes-camera.ts` + `nodes-canvas.ts` + `nodes-screen.ts` |
| **Sandbox / Exec policy / Approvals** | ❌ | ✅ `sandbox-cli.ts` + `exec-approvals-cli.ts` + `exec-policy-cli.ts` |
| **TUI / Dashboard** | ❌ | ✅ `tui-cli.ts` + `dashboard` + `proxy-cli` 调试代理 |
| **Docs 搜索 / QA / ACP** | ❌ | ✅ `docs-cli.ts` + `qa` + `acp-cli.ts` |
| **DNS / QR / System events** | ❌ | ✅ |
| **Setup / Onboard / Configure / Backup / Reset / Uninstall** | 只有 `setup` | ✅ 全套（交互式引导、备份、还原、卸载） |
| **CLI 自升级** | ❌ | ✅ `update-cli`（2225 行测试）+ `cli-compat` |

### duya 已有但 openclaw 没有

- **REPL 交互模式**（duya `repl.ts`）— openclaw 用 TUI 替代
- **MCP 集成在 agent 内部**（不是外部服务）— openclaw 把 MCP 当外部服务管
- **print / headless / 一次性 task 模式**（`-t`、`--print`、`--headless --script`）— openclaw 的 `agent` + `chat` 是不同路径
- **Session search LLM**（次级 LLM 总结 session）
- **Slash commands**（REPL 内置）

---

## 4. 关键工程能力差距

| 能力 | duya | openclaw |
|---|---|---|
| **命令注册架构** | 所有命令 inline 在 `index.ts`（~1200 行单文件） | `core-command-descriptors` + `register.{agent,backup,configure,message,onboard,setup,maintenance,subclis}.ts` + lazy loading（`register-lazy-command.ts`） |
| **Commander 体系** | 单 program 对象平铺 | program context、preaction hooks、root help fast path、routed command definitions、help formatter（`help-format.ts`） |
| **Plugin CLI 动态注册** | ❌ | ✅ `registerPluginCliCommandsFromValidatedConfig({ mode: "lazy" })` 允许插件扩展 CLI |
| **Profile/Container 隔离** | ❌ | ✅ `--profile` / `--dev` / `--container` + `applyCliProfileEnv` + `maybeRunCliInContainer` |
| **CLI respawn 策略** | ❌ | ✅ `buildCliRespawnPlan`（为子进程重置 PATH） |
| **版本快速路径** | ❌ | ✅ `tryHandleRootVersionFastPath` + 预计算 root help |
| **Dotenv / .env 加载** | 自实现简易版本 | ✅ `dotenv.ts` + `shouldLoadCliDotEnv`（cwd + stateDir） |
| **Windows argv 规范化** | ❌ | ✅ `normalizeWindowsArgv` |
| **Unhandled rejection / 崩溃恢复** | ❌ | ✅ `installUnhandledRejectionHandler` + `runFatalErrorHooks` + `restoreTerminalState` |
| **进度条 / UI 状态** | 简单 console 颜色 | ✅ `createCliProgress` 启动进度条 + 错误页 + taglines |
| **JSON 模式** | 简单 `renderJson` | 完整 `json-mode.ts` + 每个命令可选 `--json` |
| **补全（shell completion）** | ❌ | ✅ `completion-cli.ts` + `completion-fish.ts` + `completion-runtime.ts` |
| **测试覆盖** | install/uninstall + 部分 unit | 全命令覆盖：很多 `*.test.ts` 与命令 1:1 配套；`update-cli.test.ts` 单文件 2225 行 |

---

## 5. duya 三个未暴露的域（plan 98 重点）

| 域 | duya 内部已实现 | CLI/HTTP 是否暴露 | openclaw 对应 |
|---|---|---|---|
| **message** | `electron/db/schema.ts:78-99` + `electron/db/queries/messages.ts:117` + IPC `db:message:getBySession` | ❌ 无 CLI、无 `/v1/sessions/:id/messages` 端点 | `message` 子命令族（10+ 子命令） |
| **cron** | `electron/automation/Scheduler.ts:50-72` + IPC `automation:cron:*` | ❌ 无 CLI、无 `/v1/crons` 端点 | `cron` 子命令族（5 个子文件） |
| **channel** | `electron/gateway/channel-directory.ts:1-110` + `channel_bindings` / `channel_offsets` 表 + gateway IM 平台（telegram / qq / feishu） | ❌ 无 CLI、无 `/v1/channels*` 端点 | `channels-cli.ts`（Discord/Matrix/TTS — 不同平台，但同形） |

**重要区别**：duya 的 "channel" 概念 = gateway 多 IM 平台下的 channel
（telegram 群、qq 群、feishu 群），**不是** openclaw 的 Discord/Matrix/TTS。
两边平台名不同，**但 schema 形状高度相似**：都包含 platform / channel
directory / channel binding / channel status / long-poll offset。
plan 98 直接对齐 duya 现有能力，不引入 openclaw 风格的多通道。

---

## 6. plan 98 设计决策的对比依据

| 决策 | 依据 |
|---|---|
| **duya CLI 保持 thin control plane** | §2 架构差异 — duya 不需要 standalone daemon |
| **新加 channel/cron/message 命令** | §5 三个未暴露域 — duya 内部已实现，CLI 缺失 |
| **channel 不引入 Discord/Matrix/TTS** | §5 duya 的 channel 已经是 telegram/qq/feishu |
| **cron 写操作遵循 Phase 7 (--yes + 审计 + 关联 ID)** | §4 openclaw 有 `--profile` / `--container` 但 duya `roadmap.md §3.2` 已确立写操作约束 |
| **命令注册用 descriptor + 共享 registry** | §4 openclaw 的 `core-command-descriptors` + `register-lazy-command` 是成熟模板；duya 现在的 1191 行 index.ts 是债务 |
| **不做 lazy load** | openclaw 的 `enablePositionalOptions()` + `exitOverride()` 复杂度对 ~30 命令以下过度工程 |
| **不做 plugin CLI 动态注册** | duya 插件系统暂未要求 CLI surface（参考 `electron/plugins/PluginManager.ts`） |
| **message DTO 隐藏 `viz_spec` / `sub_agent_id`** | `roadmap.md §3.4` — 不泄露内部字段 |

---

## 7. 量化对比

| 维度 | duya | openclaw | 比值 |
|---|---|---|---|
| 顶层命令数 | 10 | 50+ | 1 : 5 |
| CLI 代码行数 | ~2,300 | ~45,550 | 1 : 20 |
| 命令注册文件数 | 1（index.ts） | 30+（program/） | 1 : 30 |
| 平台支持命令 | 0 | 4（discord/matrix/tts/bluetooth） | 0 : 4 |
| 写操作类别 | 2（skill, install-cli） | 10+（plugins/secrets/hooks/etc） | 1 : 5 |
| 自动补全 | 无 | 完整（bash/zsh/fish） | 0 : 3 |

---

## 8. 总结

duya CLI 是"**给桌面应用配的查询/管理窗口**" — 处于 Phase 0-8 完成
的控制平面早期阶段。openclaw 是"**CLI 即产品的完整工程**" — 包含独立
daemon、plugin 扩展机制、shell 补全、崩溃恢复、自升级等。

**duya 应**：
- 把已有但未暴露的域（message / cron / channel）补齐到 CLI — 即
  plan 98 的 Phase B/C/D
- 借鉴 openclaw 的命令注册架构（descriptor + 共享 registry）— 即
  plan 98 的 Phase A
- **不应**盲目堆命令数量 — 保持 thin control plane 定位

**openclaw 应**：
- 已经是 production-grade，独立发展

---

*This document is a snapshot as of 2026-06-04. It does not duplicate
the binding design contract in [`roadmap.md`](./roadmap.md) — for
implementation constraints, see there.*
