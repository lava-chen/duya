# 权限决策总线 (Permission Decision Bus)

> **Status**: ✅ P0 完成（2026-08-11）；✅ P2 信任模型（2026-08-17）；P1 待办
> **Priority**: P0
> **Created**: 2026-08-11
> **Depends on**: 418 权限门修复（用户反馈的两个问题已修，本 plan 是追根）

---

## 背景：由两个小问题追到的大问题

用户反馈两个 MCP 权限问题（已修复，见 plan 418 末尾章节）：
1. MCP 工具默认 `discoverable` 不在 tool 列表
2. `[MCP permission gate] ... Switch the session to bypassPermissions or dontAsk` 权限错误

修复过程中发现三个**更深的架构问题**：

### 问题 A：审批状态通道是坏的（no-op）— P0 根因

`DuyaAgent.streamChat` 构造的 `ToolUseContext`（`DuyaAgent.ts:869`）是：

```typescript
getAppState: () => ({}),   // 永远空对象
setAppState: () => {},     // 写入即丢
```

而 `StreamingToolExecutor` 依赖它承载"批准标记"：
- `:1238` pre-check 批准后写 `_approvedToolUses[tool.id]`
- `:1363` throw-path 重试前读 `_approvedToolUses`
- `:1686` handlePermissionRequest 批准后写

**主路径上写入即丢、读取恒空** → "批准后重试"核心语义不可用。两个旁路因此诞生：
- `AskUserQuestionTool` 模块级 `pendingAnswers`（`AskUserQuestionTool.ts:126`，承载答案 payload）
- MCP gate 模块级 `approvedMcpToolUseIds`（`apply.ts`，本次修复新增，承载批准标记）

**现状 = 三个互不共享的审批状态通道**（appState 名义存在 / pendingAnswers / approvedMcpToolUseIds），每个新工具接权限都要自己发明一套。

### 问题 B：MCP 工具被排除在标准权限管线之外

内置工具（Bash/Read/Write/Edit）走完整管线：`canUseTool`（rules + riskTier + classifier）→ `checkPermissions` → pre-check 弹窗 → `_approvedToolUses`。MCP executor 是裸 `{ execute }`：
- 无 `checkPermissions`（pre-check 弹窗不适用）
- 无 riskTier 元数据（meta 字段存在但 MCP 注册未填）
- 抛 `PermissionRequiredError` 会踩问题 A 的坑（无限循环）

→ MCP 只有一条内联 gate，权限体验与内置工具完全不同（P1 接入标准管线）。

### 问题 C：权限模式读取类型化失效

原代码 `(agent as unknown as { activePermissionMode }).activePermissionMode` —— 属性**不存在**，
`as unknown as` 逃生舱让 TS 完全无法发现（bug 潜伏到用户实测）。`permissionMode` 是 private 无 getter；
mode 的真正权威载体在 `_buildPermissionContext.appState.toolPermissionContext.mode`（`DuyaAgent.ts:2188`），
与 gate 读取位置完全脱节（P1 统一为类型化 `PermissionContext` 注入）。

### 问题 D：信任模型粗糙（P2）

- `settings`（用户显式配置）与 `plugin`（市场安装）同等对待：永远 prompt
- 无"记住我的决定"（per-server 持久化批准）
- 用户显式配置本身是信任信号，架构未利用

---

## 设计总览：单一决策点 + 可靠状态通道 + 类型化上下文

```
                     ┌──────────────────────────────────────────┐
   工具调用           │  StreamingToolExecutor (唯一执行者)        │
 ──────────────────► │  1. canUseTool    (rules/riskTier/classifier) │
                     │  2. checkPermissions (per-tool 预检)        │
                     │  3. pre-check 弹窗 / throw 重试路径          │
                     │  4. _approvedToolUses  ← 唯一批准标记通道    │
                     └──────────────────────────────────────────┘
                                     │ 注入
                              ToolUseContext
                        getAppState/setAppState (真实 AppState)
                                     ▲
                    ┌────────────────┼────────────────┐
                    │                │                │
               内置工具           MCP 工具       AskUserQuestion
            (checkPermissions)  (接入同一管线)   (答案 payload)
```

---

## Phase 0 — 修好 appState 载体（钥匙）

| # | 文件 | 改动 |
| - | --- | --- |
| 1 | `packages/agent/src/agent/DuyaAgent.ts` | `streamChat` 内持有 per-call 真实 `AppState`（`let turnAppState: AppState = {}`），`getAppState: () => turnAppState`、`setAppState: (f) => { turnAppState = f(turnAppState) }` |
| 2 | `packages/agent/src/mcp/apply.ts` | MCP gate direct-allow 后同步写 `context.setAppState` 的 `_approvedToolUses[toolUseId]`（与 StreamingToolExecutor 同通道）；模块级 `approvedMcpToolUseIds` 降级为兜底（读时两通道都查） |
| 3 | `packages/agent/src/tool/AskUserQuestionTool/AskUserQuestionTool.ts` | 不改代码；注释补充 `pendingAnswers` 与 `_approvedToolUses` 的关系（payload 存储 vs 批准标记） |

**验证**（已落地，全绿）：
- `packages/agent/tests/mcp/runtime-closure.test.ts` Case 12 增补：allow 后 `context.getAppState()._approvedToolUses` 可见 + no-op setAppState 宿主仍走模块级兜底（79 条 mcp 测试全过）
- `packages/agent/tests/unit/StreamingToolExecutor.test.ts` 新增 plan 419 块（3 条：pre-check 批准标记在 execute 可见 / PermissionRequiredError 重试不二次弹窗 / deny 不执行）；并修复了该文件两个既有问题：① 消息形态回归（plan 315 后 tool 消息是 `role:'tool'`+string，测试仍按数组块过滤）② BRANCH2 对 queued 工具 5s/个 的兜底等待（非并发安全 SYSTEM 工具 N 个串行 = N×5s，3 个就超时）——queued 时改 10ms 轮询，文件从 ~21s 降到 ~0.8s
- `npm run typecheck:all` 通过

## Phase 1 — MCP 接入标准管线（后续）

- MCP executor 增加 `checkPermissions`（复用 pre-check 弹窗，approval 标记走 `_approvedToolUses`）
- MCP 注册填 `riskTier` 元数据
- 权限模式类型化：`ToolUseContext` 注入 `PermissionContext`（mode + rules + riskTier lookup），删除 `as unknown` 探测
- 模块级 `approvedMcpToolUseIds` 在 appState 通道验证可靠后移除

## Phase 2 — 信任模型（✅ 2026-08-17 落地「非交互免审」）

- `settings` 来源默认 allow（用户显式配置 = 信任信号）；`plugin`/`local` 保持 prompt
- per-server 持久化批准（"记住我的决定"）
- 权限请求生命周期统一（abort 清理 pending、超时语义一致）

### P2 落地：后台/网关/MCP 非交互操作免审（2026-08-17）

用户反馈：MCP 工具、gateway 各种工具、后台命令**不应因为拿不到用户批准而被卡死**。已随本次会话落地：

| # | 文件 | 改动 |
| - | --- | --- |
| 1 | `packages/agent/src/mcp/permission-gate.ts` | `settings` 来源 MCP 默认 `allow`（用户显式配置 = 信任信号）；清理 switch 中不可达的 `settings` 分支 |
| 2 | `packages/agent/src/mcp/apply.ts` | 无审批通道（headless/后台）时**隐式放行**并记录 WARN 日志，而非直接 deny |
| 3 | `packages/agent/src/permissions/permissions.ts` | `dontAsk` 加入 bypass 模式集合（后台上下文等同 bypassPermissions）；`send_artifact`（gateway 工具）加入 `GLOBAL_ALWAYS_ALLOWED_TOOLS` |

**验证**（全绿）：
- `permission-gate.test.ts`（16）/ `permissions.test.ts`（23）/ `runtime-closure.test.ts`（23）共 62 条测试通过
- `tsc --noEmit`（packages/agent）通过
- 说明：P2 剩余两项（per-server 持久化批准、权限请求生命周期统一）仍待做

---

## 风险

| 风险 | 应对 |
| --- | --- |
| 修好 appState 后 AskUserQuestion 弹窗次数变化（pre-check 标记现在可见，throw-path 不再二次弹窗） | 行为改进方向（少弹一次）；回归测试覆盖 |
| 其他 host（orchestrator / agent-shell）的 ToolUseContext 可能仍是 no-op | 模块级兜底保留到 P1 验证；扫描调用点 |
| `setAppState` 语义是"函数返回全量新 state"（非 merge） | 实现严格按签名：`turnAppState = f(turnAppState)` |
