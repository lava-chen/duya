# Plan 498: Connector 授权等待-恢复闭环 + 卡片状态机 + 提示词连接引导（grok-bot 对齐）

> **Status**: Implementation complete（手动冒烟待办）
> **Priority**: P0
> **Created**: 2026-09-05
> **前置**: Plan 450 Phase B（auth elicitation 卡片已落地，B3 自动重试留待办）、Plan 312（OAuth loopback）
> **参照**: `E:\cloned-projects\grok-bot-0.18-reconstructed` connector 卡片 + `McpAuthWaitRegistry` + `resumeAfterMcpAuth` + connector 系统 prompt（system-prompt.ts:185-186,165,191,245）

## Goal

完成 plan 450 B3 留下的自动重试，把 connector 授权体验对齐 grok-bot 的
"卡片即等待注册表" 闭环（授权完成后 agent 自动收到恢复信号并重试失败调用），
卡片从乐观文案升级为真实状态机，并把 grok-bot 的"帮助用户连接 connector"
提示词合同移植进 duya 的 Apps (Connectors) 系统段。

## 参照系（grok-bot 源码事实 → duya 映射）

| grok-bot 机制 | duya 对应 | 采纳方式 |
|---|---|---|
| 连接器卡片 variant connect/connected + Reopen/Retry | `ConnectorAuthRequiredCard`（overlay） | 状态机升级为四态；Reopen 由 Retry（重跑 connect 开新浏览器页）承担 |
| 工具结果要求 agent "end your turn"，授权后自动 resume | tool_result 只有裸错误提示 | `AppConnectionTool` 错误文案改为明确引导：卡片已展示、做完别的事就结束 turn、授权后自动恢复 |
| `McpAuthWaitRegistry`（main 侧 {connector→agentId}，TTL 1h） | 无 | **不引入**：duya 的等待状态已在 renderer `stream-session-manager.pendingConnectorAuthRequest`（按 session 持久 + remount 重放），sessionId 即恢复目标，main 侧注册表是重复状态 |
| loopback 回调 + 5s token 轮询双保险 | loopback 一次性 promise（3min 超时） | 不抄轮询（token 在本地 vault，loopback 可靠）；保留 3min 超时 |
| auth 完成事件广播 → 卡片翻转 + 隐藏提示恢复 turn | 无推送 | main `webContents.send('app-connection:connected')` 广播 → 卡片真翻转 + `handleSend` 发恢复 turn |
| 恢复 turn 用隐藏 prompt | `ChatStartCommand.options.displayContent` 已支持 | 恢复消息走既有 `handleSend` 管道；流进行中自动落 mailbox（queued/followup），天然处理并发竞争 |
| connector 系统 prompt 合同（明文点名征求同意 / 永不粘贴链接 / 挂起不绕道浏览器 / 事后 surface） | Apps section 只列目录无行为引导 | `buildAppsSystemSection` 增补 "Helping the user connect apps" 五条（Phase E） |

## Design Decisions

| Decision | Choice | Reason |
|---|---|---|
| D1 恢复触发方 | renderer（ChatView）驱动，非 main 唤醒 worker | duya 的 session 归属、mailbox 排队、乐观 UI 都在 renderer；main 唤醒 worker 需要新 HTTP 端点 + worker 命令 + 运行中竞争处理，收益为零 |
| D2 完成信号 | main 在 `appConnection:connect` 成功后 `webContents.send('app-connection:connected', {provider, connectionId})` | 覆盖两条路径：卡片点击授权、设置页重连；卡片自身 connect 结果与广播幂等合并 |
| D3 恢复消息形态 | 本地化可见用户消息（content = 恢复指示） | 消息是用户操作的诚实记录；mailbox 泡泡正确展示；模型按 provider 去重后重发原调用 |
| D4 重试去重 | `resumeTriggeredRef`（新 elicitation 到达时 re-arm）+ 卡片内 `resumedRef` 双层去重 | 卡片自身 connect 成功与 main 广播可能先后到达 |
| D5 卡片状态机 | `waiting → connecting → connected / failed(+error, Retry)` | connected 为真实状态（connect promise resolve 或 main 广播），不再是无条件乐观文案 |
| D6 prompt 对齐形态 | 只增补 `buildAppsSystemSection` 的静态引导行，不加管理工具 | duya 无模型驱动的 marketplace 安装（连接发生在设置页/卡片），模型角色是引导而非执行；section 仍只在连接集合变化时重渲染（prompt-cache 友好） |

## Tasks

### Phase A: 工具侧引导（agent 行为对齐）✅
- [x] A1 `AppConnectionTool`：`connector_auth_required` 错误文案加引导（卡片已展示 /
      结束 turn 等待授权 / 授权后自动恢复），不再暗示模型立即重试
- [x] A2 单测 3 条：sendToMain 载荷 / 引导文案 / 其余错误码保留 reconnect 提示

### Phase B: main → renderer 完成信号 ✅
- [x] B1 `app-connection-handlers.ts`：connect 成功后广播 `app-connection:connected`
- [x] B2 `preload.ts`：`appConnection.onConnected` 订阅暴露
- [x] B3 `app-connection-ipc.ts`：`onConnected` 包装 + 既有测试扩展 2 条

### Phase C: 自动重试 + 卡片状态机 ✅
- [x] C1 ChatView：订阅广播匹配 pendingAuthRequest → `authCompletedFor` → 卡片
      finishConnected → `retryAfterAuth` 单点恢复（`handleSend` 发本地化恢复消息）
- [x] C2 卡片四态状态机 + Retry 按钮 + connected/failed 文案
- [x] C3 i18n zh/en（connected / retry / resumeMessage；删除弃用的 retrying 键）
- [x] C4 卡片组件单测 3 条（成功流转 / 失败+Retry / 广播与 connect 竞争去重）

### Phase D: 验证 ✅（含环境预存归因）
- [x] D1 触及文件测试全绿（32 tests / 4 files）；`typecheck:agent` 绿；
      web/electron tsc 与 HEAD 基线逐文件比对零新增（master HEAD 预存 bot 簇
      10 个错误 + electron 基线 4 个 app-connection-handlers 旧错误，均为并行会话 WIP）
- [x] D2 全量 vitest（src + packages/agent/src）失败集与 HEAD 基线一致（32 文件，
      全为预存/环境：ABI 锁、共享 .vite 缓存争用），diff 仅含本 plan 新测试文件
      与一次 node_modules 瞬时抖动（react-syntax-highlighter，主检出复跑 17 全过）
- [ ] D3 手动冒烟：revoke 授权 → agent 调工具 → 卡片 → 重新授权 → 卡片翻转 +
      自动恢复消息 + 重试成功
- [ ] D4 `npm run electron:build`（preload 变更需重编 electron）

### Phase E: 提示词对齐（grok-bot "help the user connect" 合同）✅
- [x] E1 `buildAppsSystemSection` 增补五条引导：connector 优先于浏览器/computer-use、
      缺失服务明文点名 + 指向 Settings → Extensions → Connections、永不编造/粘贴
      授权 URL、授权挂起期间不绕道且结束 turn 等恢复、重复任务受益时主动 surface
- [x] E2 单测 1 条断言五条全部存在；null 情形（无连接）prompt 不变
- [x] E3 确认注入点 profile 无关（`DuyaAgent` 共享 system prompt 组装段，
      bot 会话同样生效；grok-bot 对应合同见 system-prompt.ts:185-186/165/191/245）

## Non-Goals

- 卡片从 overlay 升级为消息流持久卡片（research 卡路径）——独立迭代，等 483 UI 簇落定
- main 侧等待注册表 / token 轮询 watch（见 D1 与参照系表）
- 授权 URL Reopen（duya 的 connect 一次性完成整个 flow，无长存 URL；Retry 等价覆盖）
- 模型驱动的 connector 安装/目录搜索工具（SearchPlugins/InstallPlugin 等）——duya
  无 marketplace 运行时，连接面在设置页；对齐只移植 prompt 合同不移植工具面
