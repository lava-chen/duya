# Plan 502 — Bot title 字段补齐 + id 铸造单点化（grok 对齐）

> **Status**: ✅ 实现完成（2026-09-06） · **Priority**: P1 · **Owner**: 502 session
>
> **来源**: grok 0.18 对比发现：profile.json 的 title 在 grok 是潜伏字段（schema 有、
> 零消费方，模型面身份只有 name+description）；duya 侧后端全通（profile.json schema、
> updateBotProfileIdentity、listBots、BotContactListItem 副标题渲染均已就绪）但 UI 无入口。
> id 机制：grok = 宿主 `randomUUID()` + `agentDirExists` 防撞，用户零参与；duya = renderer
> deriveBotIdFromName 预派生（best-effort）+ main allocateBotId 权威，存在双实现漂移。

## 改动

### Title 全链路（后端已有，本次只补 UI + 创建种子）

- `electron/config/agents.ts`：`AgentUpsertInput.title?: string`；`seedBotProfileIfMissing`
  接收 title 写入 profile.json（仍不进 config.toml，485 §2.4 决策不变）。
- `src/lib/agent-profile-ipc.ts`：renderer 侧 `AgentUpsertInput` 加 title 镜像。
- `use-bot-contact-form.ts`：title state + seed + 保存走 `updateBotIdentity`（IPC 早已支持）。
- `CreateBotDialog` / `EditBotDialog` / `BotSettingsPanel`：三处 UI 加「头衔 / Role title」
  输入框（name 与 description 之间）；BotSettingsPanel 的实时写穿 unchanged 判断同步纳入。
- i18n：`bot.create.roleTitle` / `bot.create.roleTitlePlaceholder`（en+zh；`bot.create.title`
  键已被对话框标题占用，不混用）。
- 侧栏渲染零改动：`BotContactListItem` 一直就是 `contact.title || contact.description` 副标题。

### id 铸造单点化（对齐 grok：宿主铸造、防撞、用户零参与）

- `config:agents:create` IPC：id 允许为空 —— 空 → `slugifyBotIdFromName(name)` 铸造，
  再经 `createConfigAgentUnique`/`allocateBotId` 对 config+磁盘+墓碑三处查重，返回真实 id。
- `CreateBotDialog` / `AgentsSection`：不再客户端预派生，传空 id；CreateBotDialog 删除
  `existingIds` prop（app-sidebar 调用方同步）。
- 删除 renderer 侧 `deriveBotIdFromName` + `randomBotIdSuffix`（bot-contacts.ts）及其测试
  块——slug 规则唯一来源收敛到 electron `slugifyBotIdFromName`。
- 保留可读 slug（`name-<6hex>` 防撞）而非 grok 的裸 uuid：duya 的 id 兼任 config.toml key、
  `send_to_agent` 寻址与群成员声明，语义可读是 duya 的加分项；机制属性（单点铸造+防撞+
  用户只起名）与 grok 完全一致。

## 测试

- `electron/config/__tests__/agents.test.ts` 增 5 例：title 种子/空缺省、identity 写入与
  清空、listBots 回传、非 ASCII 名的 generic-base 铸造。
- 结果：agents.test 36/36、bot-contacts.test 33/33；web typecheck 本簇文件零命中；
  electron tsc 本簇文件零错误（db-handlers.test 的 13 个错误为 HEAD 预存红，与本 plan 无关）。

## 不做

- 不把 title 暴露给模型（update_state profile 不加 title，grok 同款边界，485 §2.4 维持）。
- 不改 id 为不可读 uuid（见上）。
