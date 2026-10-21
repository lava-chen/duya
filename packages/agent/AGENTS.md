# @duya/agent

> **LEGACY 外壳，待退役。** 这里几乎没有实现，只有薄薄的再导出适配器。
> 新代码不要往这里加，也不要在这里找实现。

## 1. 负责 / 不负责

负责：
- 兼容旧导入路径的再导出层。只做四件事：agent 构造器、进程入口适配器、run 事件主干再导出、工具装配转发
- 公开面只有 4 个 export key：`.`、`./file-parser`、`./message`、`./context/os-context`（`packages/agent/package.json:17`）

不负责（实现都在别处）：
- worker 进程与命令循环 → `@duya/host`（`packages/host/src/worker-process-entry.ts:3833`）
- agent 会话与工具装配 → `@duya/host`（`packages/host/src/worker-session-runtime.ts:135`、`packages/host/src/worker-tools/builtin.ts:50`）
- 运行引擎 / seq 铸造 → `@duya/agent-runtime`
- 工具的真实实现 → `@duya/capabilities`（经 `packages/agent/src/tool/builtin.ts:8` 转发）
- 模式注册表 → `@duya/host`（`packages/host/src/worker-modes/modifiers/registry.ts:163`）

## 2. 关键文件（**全是 shim**）

| 文件 | 它其实是什么 |
| --- | --- |
| `packages/agent/src/agent/DuyaAgent.ts:6` | 8 行：`duyaAgent extends WorkerSession`，实现来自 `@duya/host/worker-session-runtime`（`:1`） |
| `packages/agent/src/process/agent-process-entry.ts:8` | 转发给 `@duya/host/worker-process-entry` 的 `startWorkerProcess`（`:4`） |
| `packages/agent/src/process/run-event-spine.ts:2` | 纯再导出 `@duya/host/run-event-spine` |
| `packages/agent/src/tool/builtin.ts:1` | 转发 `@duya/host/worker-tools/builtin`；`:8` 把 Read/Write/Edit/Grep/Glob/Bash 的真实实现从 `@duya/capabilities` 转发出来 |
| `packages/agent/src/tool/BrowserTool/BrowserTool.ts:1` | 2 行再导出，真实实现在 `@duya/host/worker-tool-bindings/browser-tool` |
| `packages/agent/src/tool/DuyaCliTool/` | 唯一还有本地内容的目录：消费 `@duya/cli/contract` 的 `duya_cli` 工具 |

目录名是**单数** `tool/`，复数形式 `tools/` 在磁盘上不存在（`packages/agent/src/` 下实测确认）。`packages/agent/src` 下仍有 803 个 `.ts` 文件，绝大多数是这种再导出 shim。

## 3. 排障入口

| 症状 | 先看这里 | 为什么 |
| --- | --- | --- |
| 想改 BrowserTool 却找不到逻辑 | `packages/agent/src/tool/BrowserTool/BrowserTool.ts:1` | 这里只有一行再导出；实现在 `@duya/host/worker-tool-bindings/browser-tool` |
| 想改 Bash/Write/Read 等工具 | `packages/agent/src/tool/builtin.ts:8` | 这一行说明真实实现在 `@duya/capabilities` |
| 以为改 `DuyaAgent.ts` 能改行为 | `packages/agent/src/agent/DuyaAgent.ts:1` | 它只是 `WorkerSession` 的子类壳，行为在 `@duya/host` |
| "这个包还在被谁用？" | `scripts/architecture/agent-retirement-gate.mjs` | 门禁扫描全仓引用；当前 `status: OPEN`、`legacyPackagePresent: true`、`runtimeVerificationRequired: true` |
| 以为已经退役完了 | `scripts/architecture/agent-retirement-gate.mjs` | `@duya/agent` 已从 `build-packages.mjs` 的 BUILD_ORDER 移除、无任何 `build:`/`typecheck:` script 指向它；门禁仍 `OPEN`，剩余阻塞是目录本身与元数据字符串 |

## 4. 边界约束

- 架构模块 `legacy-agent`，`managed: false`（`architecture-policy.yaml:321`），`migrateTo: agent-core`（`:375`）。这是有意保留的例外，不是漏配。
- 退役**未完成**：门禁 `node scripts/architecture/agent-retirement-gate.mjs --json` 当前报 `status: OPEN`。不要声称已关闭。
- 门禁不区分"活代码 import"和"元数据字符串"：`packages/host/src/run-orchestrator.ts:2045` 之类的 `packages/agent/src/...` 字符串也会被计入阻塞引用。
- 实测：没有任何生产源码 import `@duya/agent`——剩余命中都是门禁 fixture、测试与文案。但门禁仍判定 OPEN，所以构建层面它也没退出。
