# @duya/capabilities

工具实现层 + 纯工具契约 + 路径/命令权限策略。拥有 Read/Write/Edit/Glob/Grep/ApplyPatch/Shell/OSTool 的实现、MCP 客户端、以及决定"这条命令/这个路径能不能跑"的策略。浏览器自动化由官方市场 Browser 插件提供。

## 1. 负责 / 不负责

**负责**

- 工具契约（`Tool` / `BaseTool` 接口 / `ToolDefinition` / `ToolRegistry` 接口）与工具实现。
- 权限与安全策略：灾难路径、灾难命令、只读命令、是否在工作区内。
- MCP 客户端、连接、目录（catalog）。

**不负责**

- 工具**运行时注册表**（真正把工具挂进会话的那个）→ `@duya/agent-runtime`（`packages/agent-runtime/src/tools/catalog/registry.ts:247`）。注意 `ToolRegistry` 这个名字在本包 `packages/capabilities/src/contracts/tool.ts:315` 也有一份，那是**契约接口**，不是运行时实现。
- 权限会话级裁决（放行/拒绝的唯一决策点）→ `@duya/agent-runtime`（`packages/agent-runtime/src/authorization/permissions/permissions.ts:283`）。
- 生命周期类型（Goal / Task / Session）→ `@duya/agent-protocol`。
- 扩展装配机制 → `@duya/tooling`（本包只用它的 `ToolContributor` **声明**，见 `packages/capabilities/src/fs-contributors.ts:15`）。

## 2. 关键文件

| 文件 | 作用 |
| --- | --- |
| `packages/capabilities/src/contracts/tool.ts:122` | 纯契约：`BaseTool` 接口 `:122`、`Tool` 接口 `:128`、`ToolDefinition` `:233`、`ToolRegistry` 接口 `:315`。无 IO。 |
| `packages/capabilities/src/BaseTool.ts:80` | `BaseTool` 抽象基类；`PermissionRequiredError` `:60`。 |
| `packages/capabilities/src/permissions/policy.ts:837` | 安全策略全家：`isCatastrophicPath:521`、`checkPathSafety:557`、`isCatastrophicCommand:796`、`analyzeCommandSafety:837`、`isReadOnlyCommand:982`、`isCatastrophicToolCall:1032`、`isToolWithinWorkspace:1138`；词汇表 `packages/capabilities/src/permissions/types.ts:425`。 |
| `packages/capabilities/src/ReadTool/ReadTool.ts:206` | FS 工具栈起点：Write `packages/capabilities/src/WriteTool/WriteTool.ts:86`、Edit `packages/capabilities/src/EditTool/EditTool.ts:112`、Glob `packages/capabilities/src/GlobTool/GlobTool.ts:25`、Grep `packages/capabilities/src/GrepTool/GrepTool.ts:266`、ApplyPatch `packages/capabilities/src/ApplyPatchTool/ApplyPatchTool.ts:353`。 |
| `packages/capabilities/src/ShellCommandTool/BashTool.ts:268` | Shell 工具；`packages/capabilities/src/ShellCommandTool/PowerShellTool.ts:22` 继承自它。 |
| `packages/capabilities/src/MCP/MCPManager.ts:665` | `MCPManager`；内部 `MCPClient` 类 `:104`、`connect()` `:363`、超时默认 startup 30 s `:48` / tool 120 s `:49`。 |
| `packages/capabilities/src/MCP/capability-catalog.ts:26` | 给模型看的"schema-free 目录"（`MAX_SERVERS = 12`）；必须逐字节稳定以喂 prompt cache。 |

公共面：`packages/capabilities/src/index.ts`（barrel）+ `packages/capabilities/src/contracts/index.ts` + `packages/capabilities/src/permissions/index.ts`。

## 3. 排障入口

| 症状 | 先看这里 | 为什么 |
| --- | --- | --- |
| 文件系统工具报错 / 路径被拒 | `packages/capabilities/src/ReadTool/ReadTool.ts:206` + `packages/capabilities/src/permissions/policy.ts:557` | 路径安全判定在 `checkPathSafety`，工具只是执行方。 |
| Shell 失败 / 输出乱码 | `packages/capabilities/src/ShellCommandTool/BashTool.ts:268` + `packages/capabilities/src/utils/shellDetector.ts:315` | `detectShell()` 决定实际用哪个 shell。 |
| Shell 权限误判（该问不问 / 不该问却问） | `packages/capabilities/src/permissions/policy.ts:837` + `packages/capabilities/src/permissions/policy.ts:982` | `analyzeCommandSafety` 与 `isReadOnlyCommand` 是两套判定，别只看一个。 |
| MCP server 连不上 | `packages/capabilities/src/MCP/MCPManager.ts:363`（`MCPClient.connect`） | 连接与握手在此；静态路径检查在 `@duya/plugin-core`（`packages/plugin-core/src/mcp/resolve.ts:415`）。 |
| 疑似 SSRF / 打到内网地址 | `packages/capabilities/src/utils/urlSafety.ts:152` + `packages/capabilities/src/utils/urlSafety.ts:199` | `resolvePublicIP` + `isSafeUrl`。 |

## 4. 边界约束

- `architecture-policy.yaml`：模块 `capabilities`，`managed: true`。依赖边界以策略文件为准；不再依赖内置 Computer Use 包。零容忍，架构门禁直接阻断。
- **`packages/agent/src/tool/` 下 335 个文件是 re-export shim**，实现都在这里。不要去 agent 包里找实现——例如 `packages/agent/src/tool/BaseTool.ts` 只是转发到 `@duya/capabilities/BaseTool`。
- 本包做重 IO（fs、进程 spawn、MCP 通信），**不是** `core` 层纯模块，不要往这里塞协议类型。
