# Plan 2026-08-31 — 多 Agent Profile 设计（系统提示词 / 记忆分隔 / 通信）

> **Status**: Planning · **Priority**: P1 · **Owner**: TBD
> **Goal**: 把 duya 当前分散在 plan 224 / 105 / 202 / 222 / 424 / 430 里的多 agent 能力收敛到一份「profile 设计文档」，补齐三件事：
> 1. 更简易的系统提示词构建系统（让用户/项目方能低门槛自定义 profile 的 prompt）
> 2. 记忆系统按 profile 分隔（不同 agent 有自己的长期记忆）
> 3. 多 agent 之间的通信系统（cross-session / cross-agent）
>
> 参考：xAI 2026-08-11 发布的 Grok Bot（always-on AI teammate）开源复刻 — [elie222/rakazo](https://github.com/elie222/rakazo)（TS 95.9%，1.6k stars）；其结构：`packages/{contracts,core,db,memory,adapters,chat-ui}` + `apps/{api,desktop,web}` + `.agents/skills/<name>/SKILL.md`。用户的"多 agent 构想很接近这个项目"指的就是 rakazo 式的 per-agent persona + memory + bus。

---

## 1. Summary

duya 当前**已经**实现了多 agent 的几乎全部基础组件，但缺一份"组合总览"和三个明确的扩展面：

| 已有 plan | 状态 | 角色 |
|---|---|---|
| 224 Mode Architecture Unification | ✅ 完成 | Profile / Mode / Permission 三层正交 |
| 105 Code Agent Profile Runtime Wiring | ✅ 完成 | Code profile runtime + tool diagnostics |
| 202 AgentMailbox | Planning（P0）| Chat-runtime in-run instruction pipeline（无 cross-session） |
| 222 MessageSession tool | ✅ 完成 | 跨 session Q&A 工具（cycle detection） |
| 424 Config-Driven Custom Agents | ✅ 完成（读侧）| `[agents.<id>]` toml 驱动 + `agents_md` globalInstructions 注入 |
| 430 Memory RAG Hook | ✅ 完成 | UserPromptSubmit hook 检索注入首轮 |
| 104 ProactiveMemory | Planning | RealTimeCapture + scoring + decay archival |
| 413/413a-e Mode State Machine | ✅ 完成 | ModeTracker 框架 + 持久化 |
| 411 Goal Mode | ✅ 完成 | Session-level 自主多轮 + N-skeptic 核验 |
| 423 Deep Research Mode | ✅ 完成 | Session-level research 状态机 |

本 plan **不重写**它们，而是：

- **A**：给"profile 的系统提示词构建"加**简易化层**（plan 224 的 `PromptSystem` 已经声明式，本 plan 加「profile 作者 UI + toml 字段对 promptSection 的直接映射 + 模板片段」）
- **B**：把**记忆**显式按 profile 分区（现状：`memory_entries` 已按 session+project 索引，没显式按 `agent_profile_id` 索引；本 plan 加 `agent_profile_id` 列 + per-profile namespace + per-profile recall）
- **C**：把**多 agent 通信**做成正式的 "Agent Bus"（plan 202/222 已经是子集，本 plan 加 explicit cross-agent message envelope + routing + visibility）

---

## 2. 与 Grok Bot 复刻（rakazo）的对照

| 概念 | rakazo | duya 现状 | 本 plan 动作 |
|---|---|---|---|
| **Agent persona 文件** | `.agents/skills/<name>/SKILL.md` | `~/.duya/config.toml [agents.<id>]` + `agents_md` 注入 | 复用（plan 424 已落地） |
| **Memory 单独成包** | `packages/memory` | 散在 `packages/agent` 多个目录 | 不强行拆包，文档化"memory 子系统边界" |
| **Contracts（边界契约）** | `packages/contracts` | 隐式在各 TS interface | 不强行建包，ARCHITECTURE 加边界章节 |
| **Core（agent loop）** | `packages/core` | `packages/agent/src/agent/` | 不动 |
| **Adapters（provider）** | `packages/adapters` | `packages/ai` + `packages/agent/src/llm` | 不动 |
| **DB（状态层）** | `packages/db` | `electron/db/core/` | 不动 |
| **Per-bot sandbox computer** | 共享 Linux 50-bot 上限 | Multi-Agent Process（CPU/2 上限） | 现有 |
| **Bot-to-bot messaging** | implicit via shared DB | AgentMailbox（in-run）+ MessageSession（tool） | 扩展成显式 "Agent Bus" |
| **Durable memory load (#37)** | `packages/memory/src` 注入 agent context | `memorySection.ts`（动态段） | 已对齐 |

**结论**：rakazo 的核心设计思想 duya 已经具备；缺的是**显式命名 + 边界文档 + 三个扩展面**。

---

## 3. 目标 / 非目标

### 3.1 Goals

- **A. 简易 profile 作者体验**：让"写一个 agent profile"像"填一份 form + 写一份 AGENTS.md"那么轻；不再要求用户懂 `PromptSystem` / `PromptSection` / `enableSections` 这些内部术语。
- **B. 记忆按 profile 分区**：同一个用户可以为"前端专家 / 后端专家 / 论文助理"各自建独立记忆库；profile A 的记忆不污染 profile B。
- **C. Agent Bus**：profile A 可以**显式**发"结构化消息"给 profile B（当前只有 MessageSession tool 的"一次性 Q&A"形态）；支持 reply / fanout / cite 上下文。

### 3.2 Non-goals

- 不重写 PromptSystem；不在它之上再加一层 DSL
- 不把 memory 物理拆到独立 package；保留在 `packages/agent` 但文档化边界
- 不引入新的 IPC 协议；Agent Bus 复用现有 child_process IPC + Mailbox IPC + MessageSession 工具
- 不动 plan 411（goal）/ 423（research）/ 413a-e（state machine）

---

## 4. 设计 — A. 简易系统提示词构建

### 4.1 现状回顾

- `AgentProfile` 是基础工具集 + system prompt + 默认权限（plan 224）
- `PromptSystem` 是声明式配置（plan 224）+ 四份 config（general/code/research/gateway）（plan 224）+ 段级门控（`enableSections` / `disableSections`）
- 每个段是 `packages/agent/src/prompts/{general,code,research,gateway}/sections/<name>.ts` 导出字符串
- `[agents.<id>].agents_md` 读入 `globalInstructions` 作为独立 `<system-reminder>` 块注入（plan 424）

### 4.2 简易化的具体动作

| 动作 | 落地位置 | 说明 |
|---|---|---|
| **A1. toml 直接指定 sections** | `CustomAgentConfig` 加 `prompt.sections: { disable?: string[]; enable?: string[] }` 字段 | 跳过 `promptProfile` JSON 层；用户在 toml 直接写 section 名 |
| **A2. toml 指定 promptSystem 模板** | `CustomAgentConfig.promptSystem: string`（已有）+ `prompt.template: 'general' \| 'code' \| 'research' \| 'gateway' \| 'minimal' \| 'none'` 字段 | 简化取值；不暴露 promptSystem registry 全集 |
| **A3. agents_md 模板片段** | `~/.duya/agents/templates/<name>.md` | 内置 frontmatter 模板（goal / research / coding / writing）；用户 fork → 改 AGENTS.md 即可 |
| **A4. profile 作者 UI** | `src/components/settings/AgentsSection.tsx` 新增 "Create from template" 按钮 | 选模板 → 复制到 `~/.duya/agents/<id>/AGENTS.md` + 写入 `[agents.<id>]` 段 |
| **A5. AGENTS.md 模板提示** | `packages/agent/skills/development/agent-create/SKILL.md`（plan 424 已建）补一节 "template snippet" | 教用户用 5 段式 AGENTS.md（identity / rules / tools / memory scope / comms） |

**关键约束**：上述动作不动 `PromptSystem` 本身；只加 toml 字段映射 + UI 入口 + 模板。`PromptSystem` 的声明式优势保留。

---

## 5. 设计 — B. 记忆按 profile 分区

### 5.1 现状回顾

- **Memory v2**（plan 301–306 / 401–406 / 417 / 430）：curation agent + staging + publish state machine + RAG hook
- **存储**：`memory-state.db`（独立 SQLite）+ `memory_entries` 表；按 `project_id` 索引（plan 301a）
- **检索**：plan 430 在 UserPromptSubmit hook 触发，扫 `[memory.rag]` scan_paths` 召回
- **缺失**：**没有** `agent_profile_id` 列。同一 profile（前端专家 / 后端专家）跑两个 session 会共享同一片记忆

### 5.2 分区的具体动作

| 动作 | 落地位置 | 说明 |
|---|---|---|
| **B1. schema 加 `agent_profile_id` 列** | `electron/db/schema.ts` migration `add_agent_profile_id_to_memory_entries_<n>` | nullable；旧条目保留为 `null`（兼容） |
| **B2. recall 加 profile filter** | `packages/agent/src/memory/recall.ts`（待定位具体文件）| 默认 filter：`agent_profile_id === current_session.profile`；UI 暴露"include other profiles"开关 |
| **B3. capture 加 profile tag** | `RealTimeCapture`（plan 104）+ 写入端 | 写 memory 时写入当前 session 的 `agent_profile_id` |
| **B4. config 暴露 partition 开关** | `~/.duya/config.toml [memory]` 加 `partition_by_profile: bool`（默认 false）；true 时强制 B1/B2/B3 生效 | 让用户先升级后切开关；零破坏 |
| **B5. UI 提示** | `src/components/settings/MemorySettings.tsx` 加 toggle + 风险说明 | "off 后所有 profile 共用；on 后按 profile 分桶" |
| **B6. cross-profile recall** | recall 层加 `include_profiles: string[]` 选项；RAG hook 默认 `include_profiles=[current]`，UI 高级选项可加 | 给"前端专家想看后端专家之前怎么解决 OAuth"这种场景留口子 |

**rollback**：B1 列 nullable，B4 默认 false；用户没切开关时行为完全等同当前；切了再回滚也只需 `UPDATE memory_entries SET agent_profile_id=NULL`。

**测试**：
- Unit：`memory_partition` — capture → 不同 session.profile → 不同 entry.tag
- Unit：recall filter — profile A session 只返回 profile A 的 entries
- Unit：cross-profile — `include_profiles: ['A', 'B']` 合并返回

---

## 6. 设计 — C. Agent Bus

### 6.1 现状回顾

- **plan 202 AgentMailbox**：in-run 用户→agent 消息通道（同一 session，pending/observed/applied/cancelled 四态；claim 协议）
- **plan 222 MessageSession tool**：跨 session agent Q&A（一次性 minimal mode 调用；cycle detection；tool 形态）
- **plan 224 Mode / Permission**：profile 决定 base tools
- **缺**：跨 **profile** 通信没有标准化 envelope；AgentMailbox 只支持 user→agent 不支持 agent→agent；MessageSession 是 tool 形态（不是持续 channel）

### 6.2 Agent Bus 设计 — **2026-09-02 反向修正：envelope 折进 transcript，不起独立表**

> **本节是初稿（独立 `agent_bus_messages` envelope 表 + 路由层）的反向修正**，详见 §9 Decision G。
> 修正理由：duya 已有 MessageLog 双层存储（plan 333/441，JSONL rollout + `message_index` SQLite 索引）作为 session 唯一 transcript；grok-bot 0.18 的 transcript-store / agent-to-agent-messaging 也把 DM/群聊折进同一 transcript 表（信封作为 entry 内可选字段，不入专用列）；477 §2.1 / 478 §2.1 已落地 grok 式路径。再起 `agent_bus_messages` 独立 envelope 表会导致同一份消息同时落两处（mailbox envelope + transcript entry），且前端要展示"两个 bot 的对话历史"时只能查到一半；UI 视图散落也使侧栏联系人（483）难以聚合。envelope 折进 MessageLog transcript 是与 grok 对齐度最高、与 477/478 已落地路径一致、且零额外表的方案。

**结论**：保留 `AgentBusMessage` 作为 in-flight 路由壳（不持久化），落地时把 envelope 折进 `MessageEntry.fromAgent/toAgent` 可选字段；`fromSessionId/to.kind/replyTo/visibility/traceId` 等只在传输层需要的字段不入 transcript。

### 6.3 Agent Bus envelope schema — **MessageLog entry 扩展字段（2026-09-02 修正）**

```ts
// packages/agent/src/memory/types.ts（沿用 plan 333/441 MessageEntry）
interface MessageEntry {
  // ... 既有字段（role / content / timestampMs / images / metadata ...）

  /** agent→agent 入站信封：来信方 bot 身份（对齐 grok agent-to-agent-messaging.ts） */
  fromAgent?: { id: string; name: string };
  /** agent→agent 出站信封：去信方 bot 身份（kind 区分 agent/group，对齐 grok shared-rooms.ts） */
  toAgent?:   { id: string; name: string; kind: 'agent' | 'group' };
  /** 群聊来信方（对齐 grok shared-rooms.ts fromUser） */
  fromUser?:  { name: string; avatarUrl?: string };
  /** 幂等 / 线程关联（对齐 grok send-message-shaping.ts + clientNonce，477 §2.5） */
  clientMsgId?: string;              // 去重键（transcript 关联）
  clientNonce?: string;              // 端到端投递幂等（连 UI 重试都不重发）
  digest?: string;                   // 正文哈希，防篡改（send-acceptance.ts 对等物）
  replyTo?: { messageId: string };   // 可选显式线程（483 决定 UI 呈现）
}
```

- **入站 DM**：发送方 session 的 transcript 记 `{role:'assistant', toAgent:{id,name,kind:'agent'}}`；**接收方 session 的 transcript 记 `{role:'user', fromAgent:{id,name}}`**（对齐 grok：收到的 DM 以 user 角色呈现，带 `[agent:<name>]` cue，agent-messaging.ts:83-118）。
- **群聊**：用户/真人进群消息记 `{role:'user', fromUser:{name, avatarUrl?}}`；bot 进群消息记 `{role:'assistant', toAgent:{id,name,kind:'group'}}`。
- **运行时落盘**：active session → 内存 `cache: MessageEntry[]`（plan 333/441 cache）；非 active session → `MessageLog.appendMessage(entry)`（写 JSONL + 索引）。
- **AgentBusMessage 仍保留为 in-flight 路由壳**（`fromSessionId/to.kind/replyTo/visibility/traceId` 等只在传输层需要的字段不进 transcript），不持久化；落地时只把 `from/to envelope` 折进 `MessageEntry.fromAgent/toAgent`，业务正文（`body`）作为 `content`。

### 6.4 Agent Bus 的具体动作（2026-09-02 修正：删除独立表）

| 动作 | 落地位置 | 说明 |
|---|---|---|
| **C1. ~~agent_bus_messages 表~~ → MessageLog envelope 字段** | `packages/agent/src/memory/types.ts`（MessageEntry 扩字段）+ `electron/db/core/message-log.ts`（projection 支持 partner 过滤，见 §6.5） | **不建新表**；envelope 作为 entry 可选字段；与 477 §2.1 / 478 §2.1 已落地路径对齐 |
| **C2. ~~IPC handlers~~ → 复用 mailbox 既有 handler** | 复用 `electron/ipc/mailbox-handlers.ts`（已有 + 扩 `markBotPartnersRead`）；projection 走 `electron/ipc/message-log-handlers.ts` | **不新建 `agent_bus_handlers`**；DM 落库走 mailbox 已有路径（plan 202），partner 视图走 mailbox GROUP BY 投影（§6.5 B） |
| **C3. 工具 `send_to_agent`** | `packages/agent/src/tool/SendToAgentTool/`（481 落地） | `send(to, text, priority?, images?, ...)` / 落 mailbox `kind=agent_dm` + 记录 `clientNonce`（477 §2.5 幂等） |
| **C4. 路由：profile → active session** | `electron/agent-process-pool.ts` 暴露 `listActiveSessionsByProfile(profileId)` | tool 调用时把 `to.kind='profile'` 解析为当前 active 的任一 session（多 session 时 round-robin / 优先 latest） |
| **C5. 投递目标** | agent process 在 streamChat 启动时拉取 mailbox `kind=agent_dm`（已有机制），把 envelope 注入为 runtime-context envelope（runtime-context-adapters 通道；plan 408b 已建） | 不需要新 IPC channel |
| **C6. cycle detection** | `packages/agent/src/tool/SendToAgentTool/cycle-detect.ts` | traceId 跨 agent 路由；同一 traceId 同 profile 出现第二次则 `chain_depth_exceeded` |
| **C7. UI surface** | `src/components/chat/AgentBusBubble.tsx`（新建） | ChatView 中 inbox 风格的 pending 列表（与 MailboxBubble 分开）；支持 mark-read |

**与现有能力的关系**：

- AgentMailbox（plan 202）是 **user→agent** 单向通道；Agent Bus 是 **agent↔agent**（及 agent→同 profile active session）；两者**并存**。
- MessageSession tool（plan 222）是 **一次性 sync Q&A**；Agent Bus 是 **持久 envelope + 异步 reply**（request/reply/notify）；互不替代。
- Agent Bus 复用 AgentMailbox 的 claim / 9-point checkpoint 思想；不重写 AgentMailbox。

**rollback**：只回滚 §6.5 D 的 migration（`DROP COLUMN kind_meta` + 3 个 partial index）；其他为既有表扩字段/扩 query，无需动 mailbox / MessageLog / envelope 字段。

### 6.5 partner 侧栏与 projection 逻辑（2026-09-02 第二轮修正 — JSONL-first）⭐

> **第二轮修正**（用户审计指出）：duya 是 JSONL-first 架构，`message_index` 只存 7 列元数据 + `file_offset` / `byte_len`，**payload 始终从 JSONL rollout 文件读**，SQLite 不缓存消息内容（plan 333/441）。第一稿的 `bot_conversation_partners` 表把 `last_msg_preview` 等 payload 反向入库，违反这个原则；且 duya 已有 `mailbox_items` 实现 claim/observe 状态机 + `client_msg_id` 唯一索引，完全可承担"未读 + 联系人列表"。
>
> **重新决定**：**不新增 partner 关系表**。联系人、未读、最近预览都从已有数据**投影**出来 ——
> - **联系人 + 未读**：`mailbox_items` `kind='agent_dm'` + `meta.fromAgentId` GROUP BY，partial index `idx_mailbox_claim_ready` 命中。
> - **最近预览**：`message_index` 取最新 seq + `file_offset/byte_len` → JSONL slice 实时读。
> - **mark-read**：UPDATE `mailbox_items` `status='observed'`。

**A. mailbox 行 + meta JSON 扩展（不新建 partner 表）**

```ts
// electron/db/core/mailbox.ts — MailboxKind CHECK 约束扩展
enum MailboxKind {
  queued                  // plan 202 原生
  followup                // plan 202 原生
  background_notification // plan 202 原生
  agent_dm                // ← 新增（477 §2.6 已规划）
}

// meta JSON 字段示例（无 schema migration 成本）
{
  "fromAgentId":   "frontend-expert",
  "fromAgentName": "Frontend Expert",
  "toAgentId":     "backend-expert",
  "clientNonce":   "uuid-v4",          // 477 §2.5 幂等键
  "digest":        "sha256-...",
  "replyTo":       "msg-id-xxx"
}
```

**B. 侧栏联系人列表 — 一次 SQL 投影（对齐 grok `kv.conversationPartners` 语义但用 SQL）**

```sql
-- electron/db/core/mailbox.ts 新增 queryBotPartners(sessionId, kind='agent_dm')
SELECT
  json_extract(meta, '$.fromAgentId')        AS partner_id,
  json_extract(meta, '$.fromAgentName')      AS partner_name,
  COUNT(*) FILTER (WHERE status='pending')   AS unread_count,
  MAX(created_at)                            AS last_msg_at,
  COUNT(*)                                   AS total_msgs
FROM mailbox_items
WHERE session_id = :sessionId AND kind = 'agent_dm'
GROUP BY partner_id
ORDER BY last_msg_at DESC;
```

- **role 对称**：同一查询改 `$.fromAgentId` → `$.toAgentId` 即得对侧视角。
- **群聊**：`$.toAgentId = 'group:<roomId>'` 同样支持。
- **性能**：mailbox 行级已有 `(session_id, status, priority, created_at)` partial index（plan 202），`agent_dm` 行同走该 index；GROUP BY partner_id 在内存聚合（partner 数量 ≤ 6）。

**C. 最近预览 — 从 MessageLog JSONL 切片读（payload 不入 SQL）**

```ts
// electron/db/core/message-log.ts — 新增 method
async getLastMessagePreviewForPartner(
  sessionId: string,
  partnerAgentId: string,
): Promise<{ preview: string; ts: number } | null> {
  const row = this.db.prepare(`
    SELECT id, file_offset, byte_len, created_at
    FROM message_index
    WHERE session_id = ?
      AND json_extract(kind_meta, '$.fromAgentId') = ?
    ORDER BY seq DESC LIMIT 1
  `).get(sessionId, partnerAgentId);
  if (!row) return null;
  const line = await readJsonlSlice(
    this.resolvePathOnDisk(sessionId),
    row.file_offset, row.byte_len
  );
  return { preview: line.content.slice(0, 80), ts: row.created_at };
}
```

- **关键原则**：预览文本**只在读取那一刻从 JSONL 切**，SQLite 不缓存。N 个 partner = N 次磁盘 slice，但每条 line 都很小（几 KB），且 OS page cache 命中后接近零成本。
- **侧栏 UI 渲染时序**：先渲染联系人列表（SQL，毫秒级），再异步填预览（JSONL slice，几百 ms 延迟可接受，与现有 message list skeleton 一致）。

**D. message_index 扩字段 — `kind_meta` JSON 列 + 3 个 partial index（payload 元数据不下库）**

```sql
-- electron/db/core/migrations/NNN_add_envelope_indexes_to_message_index.sql
ALTER TABLE message_index ADD COLUMN kind_meta TEXT;
  -- 形如: {"fromAgentId":"...","toAgentId":"...","groupId":"..."}

CREATE INDEX idx_index_session_partner_in
  ON message_index(session_id, json_extract(kind_meta, '$.fromAgentId'), seq DESC)
  WHERE json_extract(kind_meta, '$.fromAgentId') IS NOT NULL;
CREATE INDEX idx_index_session_partner_out
  ON message_index(session_id, json_extract(kind_meta, '$.toAgentId'), seq DESC)
  WHERE json_extract(kind_meta, '$.toAgentId') IS NOT NULL;
CREATE INDEX idx_index_session_group
  ON message_index(session_id, json_extract(kind_meta, '$.groupId'), seq DESC)
  WHERE json_extract(kind_meta, '$.groupId') IS NOT NULL;
```

- **回填旧 entry**：`kind_meta` 列 nullable，旧 entry 无 envelope → 留空，**不在回填里反推 agent 身份**（§9 风险 2）。
- **与 §6.3 envelope 字段双层**：JSONL payload 保留完整 `MessageEntry`（含 `fromAgent/toAgent/fromUser` 对象）；`message_index.kind_meta` 只存必要 ID 用于 SQL 投影，**不进 payload 内容**。
- **写入触发点**：`MessageLog.appendBatch()` 在 `deriveKind(ev.payload)` 处同步算 `kind_meta` 并入库（同一事务）。

**E. "点开 A↔B 看完整对话" — MessageLog listByPartner 投影**

```ts
// electron/db/core/message-log.ts — listByPartner 新增
interface TimelineQuery {
  sessionId: string
  range?: { sinceSeq?: number; untilSeq?: number; limit?: number }
  partnerAgentId?: string          // ← 新增
  groupId?: string                 // ← 新增（478 §2.1 群聊）
}

listByPartner(q: TimelineQuery): StoredEvent[] {
  // 继承 plan 333/441 listBySession,SQL 加 partner 过滤:
  //   WHERE session_id = ?
  //     AND (json_extract(kind_meta, '$.fromAgentId') = :partnerId
  //       OR json_extract(kind_meta, '$.toAgentId')   = :partnerId)
  //   ORDER BY seq ASC
  // 读 JSONL slice 按 file_offset 顺序合流（plan 333 已实现 listBySession 的 slice 逻辑）
}
```

- **与 grok 对齐**：`MAIN_TRANSCRIPT_MESSAGE_FILTER_SQL` 的语义（WHERE fromAgent OR toAgent），但走的是 `message_index` 上的 JSON 索引列，**不走独立 envelope 表**。
- **零额外表 + 复用已有 storage path**：与现有 `listBySession` 走同一路径，只是 WHERE 子句多一个 partner 谓词 + 用 partial index 命中。

**F. mark-read — 复用 mailbox 状态机**

```ts
// electron/ipc/mailbox-handlers.ts（已存在，扩 handler）
markBotPartnersRead({ sessionId, partnerAgentId }) {
  return db.prepare(`
    UPDATE mailbox_items
    SET status='observed', observed_at=:now
    WHERE session_id = :sessionId
      AND kind = 'agent_dm'
      AND status = 'pending'
      AND (
        json_extract(meta, '$.fromAgentId') = :partnerAgentId
        OR json_extract(meta, '$.toAgentId')  = :partnerAgentId
      )
  `).run({ sessionId, partnerAgentId, now: Date.now() });
}
```

- **零新增 IPC 通道**：复用 `mailbox:*` 既有 IPC 命名空间；renderer 通过 `mailbox-ipc.ts` 已暴露的 client 加一个 method。

**G. 与 grok 的对齐（修正后对照表）**

| 维度 | grok-bot 0.18 | duya 改造后（JSONL-first） |
|---|---|---|
| 通讯历史存储 | 每 agent 独立 SQLite + `transcript_entries` JSON entry（含 envelope 字段） | 既有 MessageLog（plan 333，JSONL 主存）+ `message_index.kind_meta` 索引列 |
| 联系人侧栏 | `kv.conversationPartners` JSON 数组（去重排序） | mailbox GROUP BY `meta.fromAgentId`（单 SQL，partial index 命中） |
| 未读计数 | 暂无（agent-messaging 的 status 字段） | mailbox `status='pending'` 过滤（已有 claim 协议） |
| 最近预览 | 实时算（transcript.json 中 lastEntry.content） | JSONL slice 实时算（payload 不入库） |
| mark-read | inbox `.cleared` 状态机 | mailbox `status='observed'`（已有状态机） |
| 群聊 transcript | group 也存为 agent session | MessageLog 同表 + `kind_meta.groupId` 索引列 |
| **新增表** | 0（每 agent 一 DB 复用） | **0**（全部复用 mailbox + message_index） |
| **新增 migration** | 0 | 1（`message_index` 加 `kind_meta` 列 + 3 partial index） |

**H. 回滚方案**

只回滚 §6.5 D 的 migration（`DROP COLUMN kind_meta` + 3 个 partial index）即可，无需动 mailbox / MessageLog / envelope 字段；不影响 plan 333 / 441 既有数据结构。

---

## 7. 文件清单

#### 7.1 A 简易系统提示词构建

- Modify: `electron/config/schema.ts`（CustomAgentConfig 加 prompt 段字段）
- Modify: `packages/agent/src/agent-profile/config-agents.ts`（读新字段 + 注入）
- Modify: `packages/agent/src/agent/session/agent-shell.ts`（接受新字段）
- Create: `~/.duya/agents/templates/{coding,writing,goal,research,minimal}.md`
- Modify: `packages/agent/skills/development/agent-create/SKILL.md`（加 5 段式模板说明）
- Modify: `src/components/settings/AgentsSection.tsx`（"Create from template" 按钮）
- Modify: `src/lib/agent-profile-ipc.ts`（listCustomAgents 解析新字段）

#### 7.2 B 记忆按 profile 分区

- Create: `electron/db/core/migrations/NNN_add_agent_profile_id_to_memory_entries.ts`（migration id 递进 plan 433 已用到的下一号）
- Modify: `electron/db/core/schema.ts` + `memory-state.db` schema
- Modify: `packages/agent/src/memory/{capture,recall}.ts`（按 plan 104/430 文件定位）
- Modify: `electron/config/schema.ts`（[memory] partition 开关）
- Modify: `src/components/settings/MemorySettings.tsx`（toggle + 风险说明）

#### 7.3 C Agent Bus（2026-09-02 第二轮修正：JSONL-first，删 partner 表，复用 mailbox + message_index）

- **Modify**: `packages/agent/src/memory/types.ts`（MessageEntry 加 `fromAgent/toAgent/fromUser/clientMsgId/clientNonce/digest/replyTo` 可选字段）
- **Modify**: `electron/db/core/message-log.ts`（`listByPartner()` 投影参数 + `appendBatch()` 同步算 `kind_meta` 入索引 + `getLastMessagePreviewForPartner()` JSONL slice）
- **Create**: `electron/db/core/migrations/NNN_add_envelope_indexes_to_message_index.sql`（`message_index` 加 `kind_meta` 列 + 3 个 partial index；§6.5 D）
- **Modify**: `electron/db/core/mailbox.ts`（MailboxKind CHECK 扩 `'agent_dm'` + 新增 `queryBotPartners()` / `markBotPartnersRead()`）
- **Modify**: `electron/ipc/mailbox-handlers.ts`（扩 `markBotPartnersRead` handler）
- **Modify**: `electron/preload.ts`（envelope 字段暴露给 renderer）
- **Modify**: `electron/agent-process-pool.ts`（listActiveSessionsByProfile；profile → active session 路由）
- **Create**: `packages/agent/src/tool/SendToAgentTool/SendToAgentTool.ts`（替代原 `AgentBusTool`；481 落地）
- **Create**: `packages/agent/src/tool/SendToAgentTool/cycle-detect.ts`
- **Create**: `packages/agent/src/tool/SendToAgentTool/envelope.ts`（envelope 编解码纯函数；含 nonce/digest/replyTo）
- **Modify**: `packages/agent/src/tool/builtin.ts`（注册 SendToAgentTool）
- **Modify**: `packages/agent/src/runtime-context-adapters.ts`（接收侧把 mailbox `kind=agent_dm` 折进 runtime-context envelope）
- **Create**: `src/components/chat/AgentBusBubble.tsx`
- **Modify**: `src/components/chat/ChatView.tsx`（集成 AgentBusBubble + partner 过滤视图）
- **Modify**: `src/lib/mailbox-ipc.ts`（renderer 客户端，加 `markBotPartnersRead` method）

**删除清单**（初稿 + 第一轮修正方案不再实施）：

- ~~`electron/db/core/agent-bus.ts`~~（初稿 envelope 表）
- ~~`electron/db/core/migrations/NNN_add_agent_bus_messages.ts`~~（初稿）
- ~~`electron/ipc/agent-bus-handlers.ts`~~（初稿）
- ~~`packages/agent/src/tool/AgentBusTool/`~~ → 由 `SendToAgentTool/` 替代
- ~~`electron/db/core/bot-partners.ts`~~（第一轮修正 partner 表已废，改用 mailbox GROUP BY）
- ~~`electron/db/core/migrations/NNN_bot_conversation_partners.sql`~~（同）
- ~~`electron/ipc/bot-partners-handlers.ts`~~ → mailbox-handlers 已扩 handler

#### 7.4 文档

- Modify: `ARCHITECTURE.md`（新增章节「多 Agent Profile 设计」：分层对照 rakazo + A/B/C 三个子系统）
- Modify: `docs/exec-plans/README.md`（注册本 plan）
- Create: `docs/design-docs/2026-08-31-multi-agent-profile-design.md`（设计总览）

---

## 8. 测试矩阵

| Layer | 路径 | 覆盖 |
|---|---|---|
| Unit | `packages/agent/src/agent-profile/config-agents.test.ts` | A 段字段 / template 注入 |
| Unit | `packages/agent/src/memory/recall.test.ts` | B profile filter + cross-profile |
| Unit | `electron/db/core/mailbox.test.ts` | C `queryBotPartners()` / `markBotPartnersRead()` |
| Unit | `electron/db/core/message-log.test.ts` | C `listByPartner()` 过滤 / `getLastMessagePreviewForPartner()` JSONL slice |
| Unit | `packages/agent/src/tool/SendToAgentTool/cycle-detect.test.ts` | C traceId cycle detection |
| Unit | `packages/agent/src/tool/SendToAgentTool/envelope.test.ts` | C envelope 编解码 + nonce/digest/replyTo |
| IPC | `electron/ipc/__tests__/mailbox-handlers.test.ts`（扩 case） | C markBotPartnersRead handler |
| Migration | `electron/db/core/__tests__/add-envelope-indexes.test.ts`（新增） | C `kind_meta` 列 + 3 partial index 命中 |
| E2E | Playwright MCP | 新建 profile from template → 切到 MemorySettings 看 partition → 启 A agent 触发 SendToAgent send → 落 `mailbox.kind='agent_dm'` → B agent ChatView 看到 bubble + 侧栏 partner 列表（mailbox GROUP BY 投影）|
| 回归 | `npm run typecheck:all` | 通过 |

---

## 9. 决策日志

### 设计决策

- **Decision A（不重写 PromptSystem）**：现状 PromptSystem 已经声明式 + 段门控；简易化只加 toml 字段映射 + 模板 + UI。重写只会拖延并破坏 plan 424 的稳定性。
- **Decision B（per-profile partition 默认 off）**：旧条目无 `agent_profile_id`，迁移期不能强制分区。`partition_by_profile=false` 是默认；用户显式开关后才生效；旧条目在 off 状态下被所有 profile recall。
- **Decision C（AgentBus 是 envelope + 异步；不替代 AgentMailbox / MessageSession）**：三件事服务三种交互：AgentMailbox = user→agent 实时打断；MessageSession = agent↔agent 一次性 Q&A；AgentBus = agent↔agent 持久 envelope + reply/notify。
- **Decision D（traceId cycle detection 而非全局 deny list）**：cycle detection 跨多 agent traceId；profile 自己 fanout 自己两次仍允许（不同实例），同 traceId 同 profile 出现第二次拒绝；轻量、渐进。
- **Decision E（不拆 memory 到 packages/memory）**：与 rakazo 不同；duya 已有 memory-state.db + packages/agent 子系统，物理拆包重命名成本远大于收益；改用 ARCHITECTURE 文档化边界。
- **Decision F（agent_bus tool 默认 enable 候选名单）**：只对 `kind: 'main'` profile 默认 enable；`subagent` / `special` 默认 disable（special：gateway / cron / conductor-refine / memory-curator 不需要发 envelope）。
- **Decision G（2026-09-02 新增 — envelope 折进 transcript 而非独立表）**：初稿 C1 计划起独立 `agent_bus_messages` envelope 表 + 路由层（`AgentBusMessage` 全字段持久化）。审计 grok-bot 0.18 transcript-store / agent-to-agent-messaging 后确认：grok 把 DM/群聊消息作为 `transcript_entries` 的 `kind:'message'` entry，envelope（`fromAgent/toAgent/fromUser`）作为 entry 内可选字段，不入专用列。duya 侧 MessageLog（plan 333/441）已是 session 唯一 transcript，再起 envelope 表会让同一消息落两处（mailbox + transcript），且前端"点开 A↔B 看对话历史"需 join 两层。**决定**：envelope 折进 `MessageEntry` 可选字段（`fromAgent/toAgent/fromUser` + 幂等 `clientMsgId/clientNonce/digest/replyTo`），`AgentBusMessage` 仅作 in-flight 路由壳不持久化；同时新增 `bot_conversation_partners` 表做"侧栏联系人 + 未读"（grok `kv.conversationPartners` 的 SQLite 等价物，但带未读/预览/时间戳能力）。原 C1/C2 文件清单整段删除，迁移到 `SendToAgentTool/` + `bot-partners-handlers.ts`（详见 §7.3 删除清单）。
- **Decision G'（2026-09-02 追加 — JSONL-first 原则，删除 partner 关系表）**：Decision G 又建议新增 `bot_conversation_partners` 表存 `last_msg_preview/unread_count/total_msgs` 等投影缓存。**用户审计指出**这违反 duya 存储架构 —— `message_index` 只存 7 列元数据 + `file_offset/byte_len`，payload 始终从 JSONL rollout 读，SQLite 不缓存消息内容；且 duya 已有 `mailbox` 表实现 claim/observe 状态机 + `client_msg_id` 唯一索引，完全可承担"未读 + 联系人列表"。**决定**：**删除 partner 关系表**。联系人 / 未读 / 预览全部走投影：
  - **联系人 + 未读**：`mailbox_items` `kind='agent_dm'` + `meta.fromAgentId` GROUP BY，partial index `idx_mailbox_claim_ready` 命中。
  - **最近预览**：`message_index` `kind_meta.fromAgentId` 索引 + `file_offset/byte_len` → JSONL slice 实时读。
  - **mark-read**：UPDATE `mailbox_items` `status='observed'`。
  - **唯一新增 migration**：`message_index` 加 `kind_meta` JSON 列 + 3 个 partial index；其他全为既有表扩字段 / 扩 query。详见 §6.5 A-H。

### 已知 follow-up

- AgentBus.subscribe 实时推送（Phase 2：本 plan 走 poll 模式，list 按需拉）
- AgentBus 持久消息可被 SessionSearch 召回
- AgentBus 跨进程 fanout（跨 multi-agent Process 时汇总）

### 风险与回滚

- 风险 1：B1 schema 加列若已有数据需写迁移。缓解：列 nullable；migration 只加列 + index，旧条目保留 NULL。
- 风险 2（2026-09-02 第二轮修正）：C envelope 字段扩展需修改 `MessageEntry` schema 与 `message_index` 加 `kind_meta` 列；旧 entry 无 envelope 字段 → `kind_meta` 留空（nullable），**不在回填里反推 agent 身份**（旧 DM 历史 partner 列表需要新 DM 触发后才能累加，旧 entry 的 `meta` 字段为空不影响 projection）。缓解：① envelope 字段全部 optional；② migration `NNN_add_envelope_indexes_to_message_index` 加列 nullable + 3 partial index，旧 entry 不回填；③ AgentBusBubble 用 lazy load + try/catch 兼容老版本 envelope 缺失。
- 回滚：每子任务独立 commit；A / B / C 可独立回退；不引入跨 PR 依赖。

---

## 10. 顺序

按规范**必须 worktree + PR**：

1. **Step 0**：开 `worktree feat/multi-agent-profile-design`（基于 master）
2. **Step 1**：A 简易化（最小风险，独立 commit）
3. **Step 2**：B 记忆分区（schema migration + 默认 off，独立 commit）
4. **Step 3**：C Agent Bus（**零新表、1 migration、4 文件改动**，独立 commit；JSONL-first 路径见 §6.5/§6.4/§7.3）
   - **Step 3a — Schema & Migration**：MessageEntry 加 envelope 字段（types.ts）+ `NNN_add_envelope_indexes_to_message_index.sql`（`kind_meta` 列 + 3 partial index）。落地后 `npm run typecheck:all` 必须通过。
   - **Step 3b — Mailbox 扩 `agent_dm` + projection**：mailbox.ts `MailboxKind` CHECK 扩 + `queryBotPartners()` GROUP BY + `markBotPartnersRead()` UPDATE；mailbox-handlers 扩 handler。配套单测 `mailbox.test.ts` 覆盖。
   - **Step 3c — SendToAgent tool + runtime-context**：SendToAgentTool（替代原 AgentBusTool）+ cycle-detect + envelope 纯函数；runtime-context-adapters 把 mailbox `kind=agent_dm` 折进 envelope 注入；agent-process-pool 加 `listActiveSessionsByProfile` 路由。配套 `envelope.test.ts` / `cycle-detect.test.ts`。
   - **Step 3d — UI / renderer**：envelope 字段暴露 preload；AgentBusBubble 组件；ChatView 集成 + partner 过滤视图；mailbox-ipc 客户端加 `markBotPartnersRead` method。Playwright MCP 烟测 partner 侧栏 + DM 落库。
5. **Step 4**：ARCHITECTURE.md + design-doc（最后）
6. **Step 5**：`npm run typecheck:all` + 全量单测 + Playwright MCP 烟测
7. **Step 6**：PR → 用户 review

---

## 11. 与现有 plan 的关系

| Plan | 状态 | 本 plan 是否冲突 |
|---|---|---|
| 224 Mode Architecture Unification | ✅ 完成 | 互补（profile 是 224 的一层） |
| 105 Code Agent Profile Runtime Wiring | ✅ 完成 | 互补（code 是 preset 之一） |
| 202 AgentMailbox | Planning | 互补（user→agent 实时打断） |
| 222 MessageSession tool | ✅ 完成 | 互补（一次性 Q&A） |
| 424 Config-Driven Custom Agents | ✅ 完成 | 互补（A 直接基于 424 toml schema） |
| 430 Memory RAG Hook | ✅ 完成 | 互补（B 在 recall 层加 profile filter） |
| 104 ProactiveMemory | Planning | 互补（B 的 capture 改造复用 104） |
| 413/411/423 | ✅ 完成 | 不动 |
| 408 / 408b AGENTS.md loader | ✅ 完成 | 互补（A 用 408 的 AGENTS.md loader 注入） |

**结论**：本 plan 是「整合 + 增量」，不是替代；与活跃 plan 无任何 cross-block 依赖。