# @duya/computer-use

桌面控制后端。拥有鼠标/键盘/滚动/截图/SOM 标注/录制的 backend 实现、应用允许-拒绝策略、输入安全校验与动作决策控制器。

## 1. 负责 / 不负责

**负责**

- 平台 backend：`DesktopBackend` 接口 + Electron 实现（Windows / macOS）+ MCP 驱动的 CUA backend。
- 应用访问策略（deny-by-default 允许清单）、输入安全校验（危险快捷键 / 危险文本）、动作决策与确认闸。

**不负责**

- 高层工具接入（`computer_use` / `computer_cua` 的 schema 与 ports）→ `@duya/capabilities`（`packages/capabilities/src/OSTool/index.ts`）；executor 绑定 → `@duya/host`（`packages/host/src/worker-tool-bindings/computer-use-tool.ts`）。
- OS 上下文（前台窗口、焦点实体）的**生产** → 本包只是被动读方（`packages/computer-use/src/index.ts:15-17`）。
- 工具注册与权限裁决 → `@duya/agent-runtime`（`packages/agent-runtime/src/authorization/permissions/permissions.ts:283`）。

## 2. 关键文件

| 文件 | 作用 |
| --- | --- |
| `packages/computer-use/src/access.ts:136` | `checkAccess()`——应用允许-拒绝策略；语义（`default_access = "deny"` / `denied_apps` 优先、大小写不敏感、子串 + glob）在 `:9-23`，策略类型 `AppAccessPolicy` `:30`。 |
| `packages/computer-use/src/safety/validator.ts:65` | `validateKeyCombo`；`validateText:111`、`validateMultilineShell:143`、`validateTextFull:172`。 |
| `packages/computer-use/src/safety/blocked-patterns.ts:28` | `BLOCKED_KEY_COMBOS`；`BLOCKED_TEXT_PATTERNS:65`、`BLOCKED_NEWLINE_SHELL_TOKENS:121`；扫描上限 `SAFETY_SCAN_MAX_LENGTH = 100_000` `:142`。 |
| `packages/computer-use/src/backend/electron/win32.ts:218` | `ElectronDesktopBackend`（nut-js 鼠标键盘 + `desktopCapturer` 截图）。 |
| `packages/computer-use/src/backend/mcp/cua-driver.ts:97` | `McpCuaDriverBackend`——走 MCP 驱动 CUA。 |
| `packages/computer-use/src/decide/controller.ts:150` | `actionForTarget()`；循环策略 `DEFAULT_DECIDE_LOOP_POLICY:94`、`DEFAULT_MAX_ACTIONS:12` `:128`。 |
| `packages/computer-use/src/decide/confirm-gate.ts:46` | `createExecutorConfirmGate()`——高风险动作前的确认闸（另有 `createBridgeConfirmGate:65`）。 |

公共面：`packages/computer-use/src/index.ts`（barrel），另有 `packages/computer-use/src/backend/index.ts`、`packages/computer-use/src/som/index.ts` 两个子路径导出。

## 3. 排障入口

| 症状 | 先看这里 | 为什么 |
| --- | --- | --- |
| 桌面应用访问被拒 / 该放行却拒了 | `packages/computer-use/src/access.ts:136` + `packages/computer-use/src/access.ts:9` | 拒绝码 `APP_BLOCKED` 在此产生；策略语义看头部注释。 |
| 危险输入没被拦住 | `packages/computer-use/src/safety/validator.ts:111` + `packages/computer-use/src/safety/blocked-patterns.ts:65` | 校验函数只查表，模式表在另一个文件。 |
| 点击 / 键入在 macOS 上没生效 | `packages/computer-use/src/backend/electron/darwin-injection.ts:85` | `decideDarwinClick` / `decideDarwinKeyDelivery:126` 决定注入方式。 |
| decide 循环不收敛 / 动作数超限 | `packages/computer-use/src/decide/controller.ts:94` + `packages/computer-use/src/decide/controller.ts:128` | 循环策略与最大动作数在这里。 |
| 截图 / SOM 标注不对 | `packages/computer-use/src/backend/electron/win32.ts:218` + `packages/computer-use/src/som/overlay.ts:51` | backend 负责取像，overlay 负责画标注。 |

## 4. 边界约束

- `architecture-policy.yaml:826-829`：模块 `legacy-computer-use`，`managed: false`——**本包的架构违规不阻断门禁**，但别把它当免罪金牌。
- 本包做重 IO（原生注入、屏幕捕获、UIA 探测），`packages/computer-use/src/recorder/` 还会起 worker 进程。
- **本包 barrel 头注释是过时的**：`packages/computer-use/src/index.ts:19-20` 说工具接线在 `packages/agent/src/tool/OSTool/`，那已是被搬走的旧路径（`packages/agent/src/tool/OSTool/index.ts` 现在只是转发 `@duya/host/worker-tool-bindings/os-tools`）。真实位置见 `@duya/capabilities` 的 `packages/capabilities/src/OSTool/`。
