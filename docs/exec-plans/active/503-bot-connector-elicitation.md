# Plan 502: Bot Connector Elicitation（bot 主动发起应用连接）

## 背景

用户问"bot 对 app connector 的能力边界，能否主动连接"后的差距补齐。调研结论（2026-09-06）：

- duya 现状：bot 只能**使用**已连接的 connector 工具（Plan 312 descriptor 管线），授权失效时走
  **被动**重授权卡（Plan 498：`chat:connector_auth_required` SSE → 卡片 → OAuth → resume）。
  没有 agent 主动发起首次连接的工具；Gmail/Calendar 甚至不是注册 provider
  （`providers/registry.ts:86` 注释明确预留）。
- grok-bot 0.18 参照（`E:\cloned-projects\grok-bot-0.18-reconstructed`）：
  `SearchPlugins` / `InstallPlugin` / `AuthenticateMcpServer`（`source/host/runner/tools/sand-mcp-management-tools.ts:285-442`）
  —— agent 主动发起、用户点同意完成、授权后 `resumeAfterMcpAuth` 自动唤醒。
- rakazo 参照：连接是设置侧流程（Composio/Pipedream 经纪 OAuth），无聊天内 elicitation。

## 本 plan 范围（用户指令：直接接入工具，只暴露 bot 侧，UI 同步做）

1. **`appConnection:catalog` RPC**（worker→agent server→main）：provider 目录 + 连接状态 DTO。
   接满全部中继点：`agent-process-entry.ts`（toolIpcRequest 分支 + response case）、
   `worker-manager.ts`（allow）、`router.ts`×2（转发）、`server/index.ts`（response 回路）、
   `agent-server-lifecycle.ts`（解析，动态 import 避免 DB 未就绪时提前建单例）。
2. **agent 侧两个工具**（`packages/agent/src/tool/AppConnectorManageTool/`）：
   - `list_app_connectors`：catalog 投影（provider 就绪度 + 合并连接状态），无凭据。
   - `connect_app`：grok AuthenticateMcpServer 契约——唯一合法授权入口；发
     `chat:connector_auth_required`（`variant: 'connect'`）让 UI 弹连接卡；工具结果指示
     模型停止重试、结束回合；UI 授权完成后自动发 resume 消息。已连接则短路；未知
     provider 返回合法 id 列表。
3. **bot-only 暴露边界**：`builtin.ts` 注册 `discoverable` + `bot-toolset.ts` BOT_TOOLSET
   精确名提升（plan 496 机制，第一轮可见）。交互主会话 agent 刻意不暴露（tool_search
   可达但不在默认表；连接走设置页）。
4. **variant 贯穿**：`router.ts` normalizeWorkerEvent 透传 `variant`（缺省 'reauth'）、
   `stream-session-manager.ts`（`ConnectorAuthRequiredData` 类型别名）、
   `ConnectorAuthRequiredCard`（connect/reauth 双文案）、`ChatView`（resume 消息分支）、
   i18n zh/en 四个新键。

## 刻意不做

- Gmail/Calendar provider 注册（需要独立 OAuth consent 设计，registry 注释已预留）。
- `disconnect_app` / 运行时插件安装（455 Phase C 范畴）。
- connect_app 直接触发 OAuth（绕过用户同意）——grok 的 question-widget 守卫等价物就是
  卡片本身的 Authorize 按钮。

## 状态

- [x] P1: catalog RPC 全链路
- [x] P2: list_app_connectors / connect_app 工具 + 单测
- [x] P3: builtin 注册 + BOT_TOOLSET
- [x] P4: variant 贯穿 + 卡片/ChatView/i18n + 卡片测试
- [x] P5: typecheck:all（仅预存红 ManageRoutineTool.ts:274，plan 499 簇归因）+
      electron tsc（改动行区间无错）+ vitest（18+4 绿）
- [ ] P6（后续）: Gmail/Calendar provider；disconnect；455C 运行时装载
