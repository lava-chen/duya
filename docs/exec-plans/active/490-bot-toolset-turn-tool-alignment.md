# 490 — Bot 工具集对齐 Grok TurnToolFactories(真缺口)

> **Status**: Planning · **Priority**: P0 · **Owner**: TBD
> **总纲**: [473-grok-bot-framework-overview](./473-grok-bot-framework-overview.md)
> **前置**: [481-bot-toolset-unified-foundation](./481-bot-toolset-unified-foundation.md) (T1-T6 建档)
> **对比源码**: `E:\cloned-projects\grok-bot-0.18-reconstructed\source\host\runner\tools\turn-toolset.ts`

> ⚠️ **本 plan 经过完整资产审计后重写**,仅列真正的功能缺口。不再把已有工具误标为缺失。

---

## 1. 完整工具对照表

> 审计范围:`packages/agent/src/tool/` 全部 42 个 index.ts + 各工具 constants.ts wire name。

| # | grok TurnToolFactories | duya 等价工具 | Wire name | 状态 |
|---|---|---|---|---|
| 1 | `Task` | SubagentTool | `task` | ✅ 已有(grok 对齐注释写在源码) |
| 2 | `UpdateTodos` | TodoTool | `todo` | ✅ 已有 |
| 3 | `SendMessage` | SendMessageTool | `send_message` | ✅ 已有 |
| 4 | `SendToAgent` | SendToAgentTool | `send_to_agent` | ✅ 已有(481 T2,477 实现中) |
| 5 | `UpdateState` | UpdateStateTool | `update_state` | ✅ 已有(481 T1) |
| 6 | `tool_schema` | MCP 协议 | - | ✅ 已有(480 T4) |
| 7 | `tool_invoke` | MCP 协议 | - | ✅ 已有(480 T5) |
| 8 | `Read`(任何) | ReadTool | `Read` | ✅ 已有 |
| 9 | `Write`(任何) | WriteTool | `write` | ✅ 已有 |
| 10 | `externalShell` | BashTool | `bash` | ✅ 已有 |
| 11 | `boxShell` | BashTool (受限 workspace) | `bash` | ✅ 已有,workspace 隔离逻辑待补 |
| 12 | `WebSearch` | BrowserTool + 平台提取器 | `browser` | ✅ 已有 |
| 13 | `WebFetch` | ReadTool / BrowserTool | `Read`/`browser` | ✅ 已有 |
| 14 | `GenerateImage` | ImageGenerateTool | `image_generate` | ✅ 已有 |
| 15 | `Computer` | OSTool(computerUse) | `computer_use` | ✅ 已有 |
| 16 | `browser` | BrowserTool | `browser` | ✅ 已有 |
| 17 | `Screenshot` | canvas_capture | `canvas_capture` | ⚠️ 近似已有 |
| 18 | `CheckSubagent` | SubagentTool | `task` | ✅ 已有 |
| 19 | `MessageSubagent` | MessageSessionTool | `message_session` | ✅ 已有 |
| 20 | `StopSubagent` | SubagentTool.stop/resume | `task` | ✅ 已有 |
| 21 | `ReactToMessage` | - | - | 🔴 **缺失** |
| 22 | `CreateAgent` | - | - | 🔴 **缺失**(P0,用户点名) |
| 23 | `UpdateAgent` | - | - | 🔴 **缺失**(P0,与 CreateAgent 成对) |
| 24 | `CopyToBox`/`CopyFromBox` | - | - | 🔴 **缺失** |
| 25 | `BoxExecShell`(workspace 约束) | BashTool | `bash` | 🟡 逻辑待补(workspace 边界) |
| 26 | `mcpManagement` | MCP CLI / duya_cli | - | 🟡 部分已有,tool 封装缺失 |
| 27 | `CloudAgent` | - | - | 🟡 需评估 |
| 28 | `RequestBoxHelp` | - | - | 🟡 低优先级 |

---

## 2. 真缺口详解

### 2.1 CreateAgent(P0)

**描述**:创建一个 Bot 身份配置项,写入 `~/.duya/config.toml` `[agents.<id>]`,与 `duya agent create` CLI(plan 424)对齐。

> **架构分离**:Bot = 身份层(name/description/model/workspace);AgentProfile(tools/prompt/plugins)为独立管理接口,不在本 tool 范围内。

**grok 对应**:turn-toolset `createAgent` factory — 仅 name + description 两个字段。

**duya 现状**:plan 424 已有 `duya agent create` CLI;无等价的 LLM 可调用 tool。

**输入 schema**:
```ts
// 与 grok 对齐(必填 name,可选 description) + Duya identity 扩展
const CreateAgentSchema = z.object({
  name: z.string().min(1).describe("A short, human-readable name for the new bot."),
  description: z.string().optional().describe("The new bot's persona / instructions."),
  model: z.string().optional().describe("Model to use for this bot. Defaults to session model."),
  workspace: z.string().optional().describe("Working directory path for this bot."),
});
```

**已排除**(不属于 Bot 身份层,归 AgentProfile 管理接口):
- `agents_md` — global instructions,归 AgentProfile.globalInstructions
- `tools.{profile,allow,deny}` — 工具权限,归 AgentProfile.allowedTools/disallowedTools
- `plugins` — 插件列表,归 AgentProfile 扩展
- `prompt.sections` — prompt section 门控,归 AgentProfile.promptProfile

**权限**:默认 ask,高影响操作需要 user confirmation(419 权限总线)。

### 2.2 UpdateAgent(P0)

**描述**:更新已有 Bot 身份配置。与 CreateAgent 成对,操作同一个 `config.toml [agents.<id>]`。

**grok 对应**:
```ts
// grok updateAgentParameters
{
  agent_id: string;          // 必填
  name?: string;             // 可选
  description?: string;      // 可选
}
```

**输入 schema**:
```ts
const UpdateAgentSchema = z.object({
  agent_id: z.string().min(1).describe("The id of the bot to update."),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  model: z.string().optional(),
  // workspace 变更暂不允许(安全边界;后续可评估)
});
```

**已有资产**:plan 424 有 `duya agent update` CLI;无等价 LLM tool。

### 2.3 ReactToMessage(P0)

**描述**:对会话内消息添加 emoji 反应。

**grok 对应**:turn-toolset `reaction` factory;属于 `SAND_FORCED_STATIC_TOOL_NAMES`(无条件静态投放,grok bot 始终暴露)。

**grok 源码**:`source/host/runner/tools/sand-reaction-tool.ts` — 完整 schema 注入,非 hint。

**duya 现状**:无等价功能;488 channel-integration 有 `channelReaction` 类型定义。

**输入 schema**:
```ts
// 源: sand-reaction-tool.ts reactToMessageParameters
const ReactToMessageParameters = z.object({
  message_address: z.string().trim().min(1).describe(
    "The address of the USER message to react to — the [t3u]-style tag shown on their message. Only the user's own messages, never your own sends.",
  ),
  emoji: z.string().trim().min(1).max(16).describe(
    "A single common emoji to react with, e.g. 👍, ❤️, 😂, 🎉.",
  ),
});
```

**消息地址格式**:
```ts
// 源: source/shared/message-reference.ts
const MESSAGE_ADDRESS_EXACT = /^t(?:\d+u(?:a\d+)?|(?:\d+|b)[as]\d+)$/;
// 例:t3u、t10ua2、t5b3
```

**grok description 原文**(精确策略,供 duya 复写参考):
> "React to one of the USER's messages with a single emoji tapback (like an iMessage reaction)... Use this VERY sparingly, only when a reaction is the genuinely natural, human response and a reply would be overkill... It is NOT a substitute for a real reply when they asked you for something, and you never react just to seem friendly... It toggles: reacting the same emoji to the same message again removes your reaction... Fire-and-forget: it doesn't end your turn and returns nothing to act on."

**行为**:
- Toggle:同 emoji 再点同消息=撤回反应
- Fire-and-forget:不结束 turn,返回确认字符串即完成
- 权限:只对用户消息reaction,不对 bot 自己的发送

**存储**:写入 session reaction 记录(对应 488 channelReaction 类型),reaction 按 [t3u] 地址索引。

### 2.4 CopyToBox / CopyFromBox(P1)

**描述**:在 host 文件系统和 bot workspace 隔离目录之间安全传递文件。

**grok 对应**:turn-toolset `fileTransfer` 工厂,两个独立操作:
- `CopyToBox`:host → workspace
- `CopyFromBox`:workspace → host

**安全边界**:
- CopyToBox:只允许从 host 已知安全路径写入 workspace 内
- CopyFromBox:只允许从 workspace 内读出到 host 已知路径

**duya 现状**:无等价工具。BashTool 可直接 cp,但无 workspace 边界强制。

### 2.5 BoxExecShell(P1)

**描述**:在 bot workspace 隔离目录内执行 shell 命令,cwd 和路径访问都限制在 workspace 内。

**duya 现状**:BashTool 已存在,但 workspace 边界约束逻辑未实现。

### 2.6 MCP 管理工具(P2)

**描述**:MCP server 生命周期管理(增/删/查),包括:
- `AddMcpServer`:添加 MCP server 配置
- `RemoveMcpServer`:移除 MCP server
- `ListMcpServers`:列出已配置 MCP servers

**duya 现状**:duya_cli 有 `mcp` 命令;无 LLM 可直接调用的 tool。

### 2.7 CloudAgent(P3)

**描述**:在云端启动 agent 并获取结果。

**duya 现状**:无等价。

**评估项**:与既有的 SubagentTool(进程内)关系,是否需要独立 tool。

---

## 3. 不再重复建设的工具(已有充分覆盖)

以下 grok 工具 duya 已有等价实现,不再在本 plan 里建档:

| grok 工具 | duya 等价 | 说明 |
|---|---|---|
| `Task` | `task` (SubagentTool) | 源码注释明确写"aligned to Grok's task tool" |
| `UpdateTodos` | `todo` (TodoTool) | 已完整实现 |
| `SendMessage` | `send_message` (SendMessageTool) | 已完整实现 |
| `SendToAgent` | `send_to_agent` (SendToAgentTool) | 477 实现中 |
| `WebSearch` | `browser` + 平台提取器 | BrowserTool 已支持 google/twitter/youtube 等 |
| `WebFetch` | `Read`/`browser` | 已有多种读取工具 |
| `GenerateImage` | `image_generate` | ImageGenerateTool 已完整实现 |
| `Computer` | `computer_use` (OSTool) | ComputerUseTool 已完整实现 |
| `MessageSubagent` | `message_session` (MessageSessionTool) | 已完整实现 |

---

## 4. 实施顺序与步骤

### Phase 1 — 核心 P0 缺口(P0 工具)

#### CreateAgentTool
- [ ] **490-P1-CreateAgent-1**: 创建 `packages/agent/src/tool/CreateAgentTool/` 目录
- [ ] **490-P1-CreateAgent-2**: schema + execute:读 config.toml → 追加 `[agents.<id>]`
- [ ] **490-P1-CreateAgent-3**: 注册到 builtin.ts + registry.ts(走 BOT_TOOLSET 追加逻辑)
- [ ] **490-P1-CreateAgent-4**: 权限总线接入(419 checkPermissions,默认 ask)
- [ ] **490-P1-CreateAgent-5**: 单测:权限矩阵(name clamp,重复报错,workspace 自动创建)
- [ ] **490-P1-CreateAgent-6**: 与 plan 424 `duya agent create` CLI 行为对齐验证

#### UpdateAgentTool
- [ ] **490-P1-UpdateAgent-1**: 创建 `packages/agent/src/tool/UpdateAgentTool/`
- [ ] **490-P1-UpdateAgent-2**: 读-改-写 config.toml;workspace 字段防改
- [ ] **490-P1-UpdateAgent-3**: 注册 + 权限 + 单测
- [ ] **490-P1-UpdateAgent-4**: 与 plan 424 `duya agent update` CLI 协同

#### ReactToMessageTool
- [x] **490-P1-ReactToMessage-1**: 创建 `packages/agent/src/tool/ReactToMessageTool/`。→ constants.ts + ReactToMessageTool.ts + index.ts；参数 messageId + emoji（grok 的 `[t3u]` 地址对用物即 duya message id）。
- [x] **490-P1-ReactToMessage-2**: 写入 session reaction 记录。→ 走正常消息管道（messageDb.append → MessageLog rollout/index）：新增 MessageSource='reaction'（message-source.ts 联合 + inferMessageSource 显式白名单 + BOT_DIRECT_VISIBLE_SOURCES + PERSISTED_METADATA_KEYS 'reaction'），行内 metadata.reaction = {targetId, emoji, by, set}；toggle 语义在工具内（message:getBySession 扫描 + 折叠 + 追加缩减集），只允许 user/send_message 气泡（NOT_REACTABLE 拒绝 tool_use/thinking）。
- [x] **490-P1-ReactToMessage-3**: 注册（走 SAND_FORCED_STATIC 逻辑：无条件静暴露，不进 BOT_TOOLSET 追加）。→ builtin.ts exposeMode 'always'。
- [x] **490-P1-ReactToMessage-4**: 单测。→ `__tests__/react-to-message.test.ts` 14 例（resolve/toggle/目标校验/NO_SESSION/BRIDGE_ERROR/暴露面）+ discoverability 3 例。UI pill 渲染仍待 491 P2 面（数据已在 bot-direct 投影内可见）。
  > 注：CreateAgent/UpdateAgent 两节已由 plan 492 P4 以 `tool/AgentManagementTool/` 交付（2026-09-05，见 492 记录），其 490-P1-CreateAgent-*/UpdateAgent-* 任务随之关闭。

### Phase 2 — P1 缺口

#### CopyToBox / CopyFromBox
- [ ] **490-P2-FileTransfer-1**: 创建 `CopyToBoxTool` + `CopyFromBoxTool`
- [ ] **490-P2-FileTransfer-2**: workspace 边界校验(安全路径验证)
- [ ] **490-P2-FileTransfer-3**: 注册 + 权限 + 单测

#### BoxExecShell
- [ ] **490-P2-BoxShell-1**: BashTool workspace 约束模式(与普通 bash 并列,非新建 tool)
- [ ] **490-P2-BoxShell-2**: 集成测试(workspace 内命令能跑,workspace 外命令被拒)

### Phase 3 — P2 缺口

#### MCP 管理工具
- [ ] **490-P3-McpMgmt-1**: 创建 `McpManagementTool`
- [ ] **490-P3-McpMgmt-2**: 封装 duya_cli mcp 命令逻辑
- [ ] **490-P3-McpMgmt-3**: 注册 + 单测

### Phase 4 — P3 缺口

#### CloudAgent 评估
- [ ] **490-P4-CloudAgent-1**: 评估是否需要独立 tool,或复用 SubagentTool

---

## 5. 验收条件

- [ ] `CreateAgentTool` 创建的 bot 出现在 `duya agent list`,配置写入正确
- [ ] `UpdateAgentTool` 改动后,bot 行为在下一条消息中变化
- [ ] `ReactToMessage` reaction 记录可被 UI 渲染(488 channel-integration 后端到端)
- [ ] `CopyToBox`/`CopyFromBox` 路径边界校验正确(workspace 外路径拒绝)
- [ ] BoxExecShell 在 workspace 内受限执行
- [ ] `npm run typecheck:all` 全绿;Vitest 单测全通过

---

## 6. Amendment 记录

- 2026-09-04: 重写。确认 duya 已有 Task(UpdateTodos)/SendMessage/SubagentTool 等工具,原 plan 90% 内容为误判。重新鉴定真缺口:仅 CreateAgent/UpdateAgent/ReactToMessage/CopyToBox/CopyFromBox/BoxExecShell/McpManagementTool 未实现。
- 2026-09-04: **CreateAgent/UpdateAgent 执行责任移交给 plan 492**(bot 间交互全面对齐)——492 已核实 477 的消费者接线状态并涵盖 roster 热更新与契约层接线,工具落地放 492 P4 以共享同一验收链;本 plan 余下范围 = ReactToMessage/CopyToBox/CopyFromBox/BoxExecShell/McpManagementTool。
- 2026-09-04: **SendMessage 规范补齐(grok 对齐,先行落地)**。对照 grok-bot 0.18 `send-message-tool.ts` / `send-message-schema.ts` / `send-message-reminder-middleware.ts`,把 SendMessage 的三层能力补到与 grok 相当(工具本体已存在,补的是规范与运行时):① 工具描述全文移植(ack≠delivery、meaningful beats 节奏、图片同气泡规则、widget 完整生命周期含回合语义、secret-request 安全与回合语义、权限卡自适应引导;drop:sand-msg 引用链/request_box_help — duya 无对应渲染器/工具);② schema 字段描述 + 自教学校验错误(TYPE_FIELDS 表 + "Nothing was sent. Re-send as separate calls"恢复指引);③ **SendMessageReminderMiddleware 移植**为 `builtin.send-message-reminder` PreTurn hook(`hooks/send-message-reminder.ts`,grok 默认阈值:沉默提醒 >6 次 quiet 工具调用,早期结果提醒每沉默段一次),仅注册于工具集含 SendMessage 的 run(即 bot 会话),注入走 plan 426 runtime-context 通道(不落盘);④ botCommsRules section 增加 "Talking to the user" 小节(scratchpad/沉默例外/节奏/ack≠delivery),budget 1200→2400;⑤ RuntimeContextSource 新增 `send_message_reminder`(+STARTS_PROMPT_TURN 表 key,mid-turn=false)。验证:agent 包 tsc 0 错,新增 20 单测 + 既有 48 全绿。typecheck:all 当前剩余 7 错均在 src/ 前端(489 P0.3/455 其他会话在途,与本改动无关)。
- 2026-09-05: **ReactToMessage 交付(P1 四项全关)**,落在未提交 WIP(489/491/496)之上。实现取 duya 对应物而非字面移植:grok 的 `[t3u]` 地址 → duya message id;grok 的 transcript-entry reactions 数组 → 独立 MessageSource='reaction' 行(metadata.reaction = {targetId, emoji, by, set},随 messageDb.append 走正常消息管道,无新表);toggle 在工具内折叠(getBySession 扫描 → 追加缩减集,append-only 管道无单行删除);可反应对象放宽到 user + send_message 气泡(bot-direct 视图双方都是可见气泡,比 grok 仅 user 更合理),tool_use/thinking 返回 NOT_REACTABLE。注册 exposeMode 'always'(SAND_FORCED_STATIC 对齐),不进 BOT_TOOLSET。测试 14+3 例;agent tsc 绿。UI pill 渲染仍归 491 P2 面。
