# 619 — conductor canvas 剥离为外部 plugin（mini app + MCP）

> 状态：进行中 —— 切片 1（外部 mini app 接入面）已落地，切片 2 起未开工。
> 归属：独立计划。与 [610 架构收口系列](./610-architecture-series/README.md) 正交；
> 与 [616 duya_app 内置 MCP 层](./616-duya-app-mcp-layer.md) 有交集，接缝见 §4。
> 分支 `refactor/conductor-canvas-plugin`，worktree `.claude/worktrees/conductor-plugin`，基线 `7e60070e`。

## 0. 一句话

画布今天是「仓库内的一个包 + 主渲染器里的一个面板 + 一组内部注册的工具」。
目标形态是「一个外部 plugin」：UI 作为 mini app 由宿主加载，agent 侧能力由 plugin 自带的
MCP server 提供，两侧都只经公开协议接入，仓库内不再有 `@duya/conductor` 的引用。

## 1. 目标形态

```
duya-canvas plugin（装在插件目录里，不在 workspace 里）
├── .duya-plugin/plugin.json
│     apps[]: { appId: 'canvas', entry: 'apps/canvas/index.html', requiredCapabilities, stateSchemaVersion }
│     capabilities.mcpServers[]: { name: 'canvas', command, args }
├── apps/canvas/        ← mini app：画布 UI（打包后的渲染器）
└── server/             ← MCP server：画布工具

宿主（只保留通用 plugin 基础设施，不知道画布是什么）
├── Mini App 宿主：沙箱 webview + source 校验 + 会话/令牌
├── plugin app 实例/授权/调用三套 Host API（已存在）
└── MCP client（已存在）
```

## 2. 已核实的事实（本 worktree 实测，2026-10-20）

| 事实 | 位置 | 对方案的影响 |
| --- | --- | --- |
| 画布渲染器**自包含**：外部依赖只有 react / rbush / zod，零 workspace 引用 | `packages/conductor/src/renderer/**` 全量 import 扫描 | 可以独立打包成 mini app，不必先解耦 |
| 宿主能力靠窄契约注入（providers / refine agent / settings） | `packages/conductor/src/renderer/host.ts:128` | mini app 侧写一个适配器即可 |
| 画布数据走 Electron MessagePort（`getConductorPort`）+ `conductor:snapshot` | `packages/conductor/src/renderer/ipc/conductor-bridge.ts:14` | **外部化的主要工作量**：数据通道要重接 |
| agent 侧画布工具已经是跨进程协议：`conductor:executor:rpc` → Main `ConductorExecutorProxy` | `packages/capabilities/src/canvas/ipc-request.ts:50` | 改成 MCP server 有现成落点 |
| 画布工具由 conductor mode 注入，不在 builtin registry | `packages/host/src/worker-modes/modifiers/conductor-mode.ts:59` | 迁到 MCP 时注入面要一起换 |
| plugin manifest 支持 `apps[]`，entry 必须是包内真实文件 | `apps/desktop/src/main/plugins/manifest.ts:258` | mini app 的**声明面已存在** |
| plugin manifest 支持 `capabilities.mcpServers[]` / `components.mcpServers[]`（command+args） | `apps/desktop/src/main/plugins/manifest.ts:568` | plugin 自带 MCP server 的**声明面已存在** |
| **`apps[].entry` 今天没有任何宿主加载它** | 全仓 grep：entry 只出现在 manifest 校验里 | 缺的是「门」，不是「声明」 |
| Host 已有 plugin app 实例 / 授权 / 调用三套 API | `apps/desktop/src/main/cli/desktop-host-api.ts:216` | mini app 的落地依赖已就位 |

## 3. 切面

| 切片 | 交付 | 独占路径 | 完成判据 |
| --- | --- | --- | --- |
| **S1** ✅ | 外部 mini app 接入面：Main 侧会话/授权、preload 通道、renderer 宿主（沙箱 webview + source 校验）、安装面板入口、外部插件样例 | `apps/desktop/src/main/plugins/plugin-app-{sessions,host}.ts`、`apps/desktop/src/preload/index.ts`、`packages/ui/src/{lib/plugin-app-ipc.ts,components/plugin-apps/**}`、`packages/ui/src/components/settings/capabilities/PluginManagementView.tsx`、`plugins/examples/**` | 外部插件的 App 能被加载；访客只能请求 bind/invoke/revoke 三种消息；主进程按会话重新校验 |
| **S2** | canvas 作为 plugin 交付：把 `packages/conductor/src/renderer` 打成独立 bundle 进 plugin 的 `apps/canvas/`；plugin 带一个 MCP server | `plugins/duya-canvas/**`（新目录，不进 workspace）、打包脚本 | 装上这个 plugin 就能看到画布 mini app；agent 侧工具由 plugin 的 MCP server 提供 |
| **S3** | 画布数据通道外部化：MessagePort + `conductor:*` IPC → plugin app instance state（Host 已有的通用 store） | `packages/conductor/src/renderer/ipc/**`、`apps/desktop/src/main/conductor/**` | 画布状态落在 plugin 拥有的实例状态里，mini app 与 MCP server 读写同一份 |
| **S4** | agent 侧画布工具从 conductor mode 注入改为 plugin MCP server（走 `mcp__canvas__*`） | `packages/capabilities/src/canvas/**`、`packages/host/src/worker-modes/modifiers/conductor-mode.ts`、renderer 工具行 | 工具来源变成外部 MCP server；权限/命名/profile 规则按反解后的原名匹配 |
| **S5** | 删除内部耦合：移除 `packages/conductor`、`packages/capabilities/src/canvas`、`packages/agent/src/tool/CanvasConductor` 及其引用 | 上述三处 + `packages/ui/src/App.tsx`、`packages/ui/tsconfig.json` | 全仓无 `@duya/conductor` 引用；`architecture:check` 无新增违规 |

S1 先行是因为 S2–S5 全部依赖「外部 mini app 能被加载」这一前提；声明面（manifest）与
落地依赖（Host 三套 API）都已存在，缺的只是宿主。

## 4. 与 616 的接缝（已由 owner 裁决）

616 走的是**内置进程内 MCP**：canvas 工具从 conductor mode 注入改为 `duya_app` 这个
host-owned MCP server 的工具（`docs/exec-plans/active/616-duya-app-mcp-layer.md` §4 的 T610c）。

**2026-10-20 owner 决策**：616 的 T610c 已标 ⛔ ——「canvas 系列不再由 616 承担，即将从 app
内部剥离、改为对外提供服务，由他人负责」。616 只保留**共享面**：命名空间 / 权限 / profile
规则（T610e 已交付，PR #318）。

因此接缝已定，不再是待协调项：

| 归属 | 内容 |
| --- | --- |
| 616 | 命名空间反解、`source: 'app'` 权限分支、profile 规则 —— 外部 plugin 的工具**复用**这一层 |
| 本计划（S4） | canvas 的**注册面**迁移：谁提供这些工具（外部 plugin 的 MCP server，而不是 conductor mode 注入）+ renderer 路由 |

S4 开工前的动作只剩一个：**读 616 的 T610e 交付（PR #318）已交付的共享面**，在其之上换掉
注册面，不重复做改名与权限规则那一半。

## 5. 未覆盖（不属于本计划的完成声明）

- 人工授权 UI：grant 路由是 bearer-token + 拒 Origin 的特权面，不证明人点了同意。
- 双 App / 双实例样本与重启持久化隔离。
- 跨进程 TOCTOU：授权在最后一次检查与实际副作用之间仍有窗口。
- S1 的 webview 宿主只有单元测试覆盖，尚未用真 Electron 跑过一次端到端。
