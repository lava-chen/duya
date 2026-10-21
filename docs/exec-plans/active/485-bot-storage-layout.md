# 485 — Bot 存储布局（Storage Layout for Bots：config.toml 声明层 + agents/<id>/ 身份目录）

> **Status**: Planning · **Priority**: P0 · **Owner**: TBD
> **总纲**: [473-grok-bot-framework-overview](./473-grok-bot-framework-overview.md)
> **立项**: 2026-09-02（473 系列完整性审计第二轮——**存储地基专项**：473–484 各 plan 都引用"bot 存储锚点"（身份/记忆 shard/头像/唤醒 marker/ack），却无人定义 bot 配置落盘模型）
> **前置**: plan 424（`[agents.<id>]` config.toml 读侧已接线）、custom-agent-creation（创建层已落地）
> **参考源码**：grok-bot `source/host/storage/agent-paths.ts`（agents 根/目录名=id/安全约束）、`source/host/agents/agent-profile.ts`（profile.json 单一身份源）、`settings-file.ts`、`agent-avatar.ts`、`source/host/host-paths.ts`（目录派生单点）；duya `electron/config/schema.ts`、`electron/config/agents.ts`

---

## 1. 为什么现在做 / 问题

473–484 系列每份 plan 都在移植 grok 的 bot 机制（唤醒/DM/群聊/记忆/压缩/可靠性），但没有一份回答过这些底层问题：

| 问题 | 现状 |
|---|---|
| bot 的身份（name/**title**/description/avatar）存在哪？ | 只有 config.toml 7 字段，无 title/avatar |
| bot 的可变状态（settings、头像文件、改名后的运行身份）放哪？ | 无处可放 |
| agentId 是什么格式？路径怎么安全派生？ | map key 即 id，无约束、无路径化规则 |
| 477 的 bot_id→session 映射、479 的 per-bot memory shard、484 的 ack/marker 落点在哪？ | 全部悬空 |
| `~/.duya` 顶层已有 20+ 目录（memory/workspace/skills/sessions/…），bot 数据往哪放？ | 无规划 |

grok 的答案（已逐文件核实）：**每 agent 一个目录 = agentId，`profile.json` 是单一身份源**，host 观察者模式（写文件 → fs.watch → 广播），改名不更目录。duya 不能照抄（用户手写 config.toml 而非 UI 生成 UUID），需要 duya 版折中。

## 2. 设计：双层存储模型

### 2.1 分层原则

| 层 | 载体 | 内容 | 写方 | 哲学 |
|---|---|---|---|---|
| **声明层（用户配置，不可变意图）** | `~/.duya/config.toml` → `[agents.<id>]` | model / workspace / agents_md / tools / plugins（424 定稿）+ name/description（初始值，见 §2.4） | 用户/CLI/表单 | duya 单一权威源哲学延续：用户想配什么写在 TOML |
| **身份层（可变状态，运行时权威）** | `~/.duya/agents/<id>/` 目录 | profile.json（name/title/description/avatar ref + schema version）、settings.json、avatar.<ext>、state/（后续 plan 落点） | 模型 update_state / UI / host | 对齐 grok：目录=id、profile.json 单一身份源、host 观察 |

**为什么保留 config.toml 声明层**：424/334 已把 duya 收敛为"config.toml 唯一权威源"，用户习惯手写 TOML；模型/UI 自改（改名/头像）是**运行时身份变更**，不应要求改 config.toml（会触发 hot-reload + 语义混淆）。两层各司其职。

### 2.2 目录结构（新文件路径派生模块）

```
~/.duya/
├── config.toml                      # 既有：声明层（[agents.<id>] 保留）
├── agents/                          # ← 新增：bot 数据根（与 memory/workspace 平级）
│   └── <agentId>/                   # 目录名 = agentId（人类可读 slug，见 §2.3）
│       ├── profile.json             # 身份源：{schemaVersion, name, title, description, avatarShape?, avatarColor?}
│       ├── settings.json            # {notifyOnAgentUpdates, hiddenFromSidebar, wake?}（与 profile 分离）
│       ├── avatar.png | avatar.<ext> # 头像文件（canonical avatar.png 优先；png/jpg/webp/gif/svg ≤5MB）
│       ├── state/                   # 预留：477 bot_id→session 映射、476 唤醒偏好、484 ack/marker
│       │   ├── session-binding.json
│       │   ├── pending-wakes.json   # （若 476 选文件落盘而非 core-db 表）
│       │   └── run-resume-markers.json
│       └── memory/                  # 预留：479 per-bot own shard（若 479 选目录方案）
└── …（其余 20+ 顶层项不动）
```

**路径派生**：新增 `electron/config/agent-paths.ts`（对齐 grok `agent-paths.ts`），单点导出：
- `getDuyaAgentsRoot()` = `~/.duya/agents`
- `resolveDuyaAgentDir(agentId)` = join(agentsRoot, agentId)，带安全校验（见 §2.3）
- `getBotProfilePath(agentId)` / `getBotSettingsPath(agentId)` / `getBotAvatarPath(agentId)`
- 禁止任何模块自行拼路径；agentId 不得含路径分隔符/`.`/`..`。

### 2.3 agentId 规范（不照抄 grok 的 UUID）

duya 用户手写 config，id 是人类可读 slug（`frontend-expert`），**保留 slug 并加约束**（对齐 grok `isSafeFolderId` + `assertValidSandAgentId`）：

- 格式：`^[a-z0-9][a-z0-9-]{0,62}$`（kebab-case，非空、无首尾空白、无大写/下划线/点）。
- **目录名 = agentId，改名（name）永不更目录**——agentId 是稳定主键，全链路（477 session 绑定、479 shard、484 marker、roster、connector secrets）都以它寻址。
- 校验函数 `isSafeBotId` + `assertValidBotId` 纯函数 + 单测（含路径逃逸用例 `..`/绝对路径）。
- 现有 config key 若含非法字符（大写等）：迁移决策记录（Phase 1 只报警告，Phase 4 提供重命名工具）。

### 2.4 profile.json = 运行时身份源（含 title）

```jsonc
// ~/.duya/agents/<id>/profile.json
{
  "schemaVersion": 1,
  "name": "Frontend Expert",        // 显示名（身份）
  "title": "前端架构与 React 专家",   // 副标题/职衔（grok 语义：展示元数据，不参与身份比较）
  "description": "…",
  "avatarShape": "",                // 可选（grok 兼容字段，duya 可暂不用）
  "avatarColor": ""
}
```

- **title 语义（对齐 grok，agent-profile.ts:29/44 + agent-summaries.ts）**：name=唯一身份名（进 system prompt、身份比较只看 name+description）；title=可选展示副标题（roster 下发、`hasIdentity` 判定、UI 展示），模型 update_state **不**直接改 title（grok 只有 UI/host 能改 title），duya 同样：模型自改 name/description，title 归 UI/CLI。
- **双写规则（关键决策）**：`config.toml [agents.<id>].name/description` 只在**首次创建**时 seed profile.json；此后运行时身份以 profile.json 为准，config.toml 的 name 仅作**展示回退**（profile.json 缺失时读取）。更新链统一为：写 profile.json → 通知 ConfigStore 侧把 name 同步为展示值（可选）或保持不同步并在 schema 注释说明。**不要求两处强一致**——避免把"用户声明"与"运行身份"搅成单源。
- **写盘原子性**：对齐 grok `writeSandProfileFile`（tmp + rename），fs.watch 才能稳定捡变更。

### 2.5 与各 plan 的接口预留（本 plan 只划地，不实现）

| 消费者 | 落点 | 状态 |
|---|---|---|
| 474 botIdentity section / update_state profile.set | 读 profile.json → botIdentity；写走 §2.6 工具链 | 485 Phase 2 提供读写 API |
| 477 per-bot 常驻会话绑定 | `state/session-binding.json`（或 core-db 表，实施时二选一） | 477 P3.1 消费 |
| 476 唤醒偏好 / 484 ack-marker | `settings.json` 扩展 + `state/*.json` | 476/484 消费 |
| 479 per-bot memory shard | `memory/` 目录（若 479 选目录方案；表方案则无） | 479 P1.0 决策 |
| 483 roster/头像/改名 | profile.json + avatar 文件 → profile_watch 广播 | 483 P0 消费 |
| 481 update_state 工具 | `profile.set {name,title?,description}` / `avatar.set` executor | 481 T1 扩展 |

## 3. 分阶段实施

### Phase 1 — 地基纯函数
- [x] **P1.1** `electron/config/agent-paths.ts`：agentsRoot/agentDir/profile/settings/avatar 路径派生 + 单测（含逃逸用例）—— 2026-09-02 落地，见 §7。
- [x] **P1.2** `isSafeBotId`/`assertValidBotId` + 现有 config key 合法性扫描（只报 warning）+ 单测 —— 2026-09-02 落地，见 §7。
- [x] **P1.3** profile.json schema（含 title）+ read/write（原子写）+ 单测（缺字段默认值、schemaVersion 迁移钩子）—— 2026-09-02 落地，见 §7。

### Phase 2 — 与 424 接线
- [x] **P2.1** `upsertConfigAgent`（`electron/config/agents.ts`）创建时同步 seed `agents/<id>/profile.json`（name/description 从 config 复制）+ 单测 —— 2026-09-02 落地，见 §8。
- [x] **P2.2** 读侧：botIdentity 渲染（474 的 `botIdentity` section）与 roster 改为读 profile.json 优先、config.toml 回退 + 单测 —— 2026-09-02 落地，见 §8。
- [ ] **P2.3** `update_state` executor 的 profile.set/avatar.set 落 profile.json/avatar 文件（对齐 grok `createSandAgentState`；工具 schema 归 481，本 plan 只做 executor 底层）+ 单测。

### Phase 3 — 观察者与 settings
- [ ] **P3.1** profile/settings/avatar 变更观察（复用 ConfigStore watch 或 fs.watch——实施时选一）→ 事件 `agents.profile_changed`/`agents.settings_changed`（483 P0.1 已定义，此处供事件源）+ 单测。
- [ ] **P3.2** settings.json 读写（notifyOnAgentUpdates/hiddenFromSidebar/wake 偏好骨架）+ 单测。

### Phase 4 — 收口与迁移
- [ ] **P4.1** 顶层 `~/.duya` 目录归类文档（新增 agents/ 后 20+ 顶层项各归何类：全局共享 / per-bot / 运行时缓存），更新 ARCHITECTURE.md。
- [ ] **P4.2** 非法 agentId 迁移工具（slug 化重命名，干跑报告先行）。
- [ ] **G1** `npm run typecheck:all` + 全单测绿；demo：建 bot → 目录生成 profile.json → 模型 update_state 改名 → UI 即时刷新（483 P0 链路打通）。

## 4. 非目标

- 不做 477/479/484 的具体实现（本 plan 只划地 + 提供读写 API）。
- 不迁移 `~/.duya` 既有 20+ 顶层项（只新增 agents/ + 文档归类）。
- 不引入 UUID agentId（保留人类可读 slug；grok 的 UUID 是为 UI 自动创建设计的，duya 用户手写 TOML 不适用）。
- 不做 `store.db`/blob 体系（duya 已有 core-db/rollout 消息存储；profile/settings 用 JSON 文件即可，不必 SQLite）。

## 5. 风险

- **双源漂移**（config.toml name vs profile.json name）：§2.4 规则明确"profile 优先、config 仅 seed 与回退"，UI 编辑走同一条写链；仍漂移时以 profile.json 为准并记日志。
- **既有 config key 非法字符**：Phase 1 只警告不阻断（P4.2 给工具），避免破坏现有用户。
- **目录爆炸**：每 bot 一个目录 + 子目录，量级同 grok（每 bot 常驻目录）；无 bot 数量上限约束（grok 上限 50 是产品策略，duya 视 config 手写天然受限）。
- **回滚**：纯新增目录与 API，config.toml 不变；开关关闭即退回纯 config 模式（profile.json 缺失回退路径 P2.2 保证）。

---

## 6. 完整性审计定位（2026-09-02）

本 plan 源自 473 系列完整性审计第三轮——用户质询"bot 除了 name 还有 title；bot 配置文件建在哪、是 JSON 吗、路径怎么定；~/.duya 怎么规划；bot 配置包含什么"。逐文件核实 grok（agent-paths/agent-profile/settings-file/agent-avatar/host-paths）与 duya 现状（config schema/agents.ts/424）后确认：**存储布局是 473–484 集体空白的地基项**，故单独立项并登记为系列存储前置（依赖关系：485 Phase 1-2 → 474/477/479/483/484 消费）。

---

## 7. Phase 1 落地登记（2026-09-02 晚）

用户选定"现在就把 485 Phase 1 落地"。三个新模块 + 23 单测全绿：

| 文件 | 职责 | 设计要点 |
|---|---|---|
| `electron/config/agent-id.ts` | id 校验（P1.2） | `BOT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/`（485 §2.3 kebab 约束，比 grok `isSafeFolderId` 更严）；`isSafeBotId`（type guard）/`assertValidBotId`（路径安全边界，抛错含 pattern 提示）/`findInvalidBotIds`（config key 扫描，只报不抛，Phase 4 迁移工具用）。拒绝 `..`/`a/b`/`a\b`/大写/下划线/点/空格/`-lead`/超长 |
| `electron/config/agent-paths.ts` | 路径派生单点（P1.1） | `getDuyaAgentsRoot()`（= compass `resolveConfigRoot()` + `/agents`，test-namespace 天然隔离）→ `resolveDuyaAgentDir`（先 assertValidBotId）→ profile/settings/avatar.png/state/memory 路径。**禁止其他模块自行 join agents 路径**。逃逸用例（`..`、绝对路径、大写）全部在单测钉死 |
| `electron/config/bot-profile.ts` | profile.json 读写（P1.3） | `BotProfile{schemaVersion,name,title,description,avatarShape?,avatarColor?}`（485 §2.4 字段集 + grok 兼容）。**title 语义**：展示副标题、写时 trim、可留空；读时 title 非 string 兜底 `''`。原子写 = tmp + rename（同目录，fs.watch 消费者永远看不到半写文件）；缺字段默认值（schemaVersion 缺失 → 当前版本）；`readBotProfile(file, migrate)` 迁移钩子——版本不符才触发（默认 identity），当前版本零触发。grok `writeSandProfileFile` 语义对齐 |

**文件落点选择**：485 §2.5 只指定了 `electron/config/agent-paths.ts`；id 校验（agent-id.ts）与 profile 读写（bot-profile.ts）按领域就近放 config/（duya 单一权威源哲学），P2 与 ConfigStore/`upsertConfigAgent`（agents.ts）接线时同层引用无环。

**验证**：3 测试文件 23 用例全绿（agent-id 8 / agent-paths 5 / bot-profile 10）；`electron/tsconfig` 全量 `tsc --noEmit` 通过（新文件零错误）。

**待办（Phase 2 起）**：① `upsertConfigAgent` 创建时 seed `agents/<id>/profile.json`（P2.1）；② `loadBotPromptContext`（474 侧）改 profile.json 优先、config 回退（P2.2）；③ update_state executor 写 profile（P2.3，工具 schema 归 481）。

---

## 8. Phase 2 落地登记（2026-09-02 晚 · 与 424 接线）

双层模型读写打通——"config 写声明、目录放身份"从设计变为运行时事实：

**P2.1 — 创建即 seed（写侧，electron/config/agents.ts）**
- `upsertConfigAgent` 判定 `isNewAgent`（id 原本不在 agents map）→ 调 `seedBotProfileIfMissing`：`getBotProfilePath(id, store.getConfigDir())` 写入 profile.json（name/description 从 config 复制、title=''）。
- **关键设计**：① seed 路径用 **store.getConfigDir()**（configPath 的 dirname），保证与 ConfigStore 同根——测试里 store 指向临时目录，seed 落在临时目录而非真实 `~/.duya`；为此给 `ConfigStore` 加了公共 `getConfigDir()`。② **只 seed、不覆盖**：profile.json 已存在（运行时身份，可能被模型 update_state 改过）→ 跳过，config 更新永不回写运行身份（485 §2.4 双写规则）。③ `isSafeBotId` 不通过的旧 id 跳过 seed（Phase 4 迁移工具处理），seed 失败只 console.warn 不回滚 config 保存。
- 测试（agents.test.ts +3）：首次创建生成 profile.json / 运行时身份不被 re-upsert 覆盖 / 删除重建不覆盖既有 profile。

**P2.2 — 读侧 profile 优先（agent-core）**
- 新增 `packages/agent/src/agent-profile/bot-profile-reader.ts`：worker 直读 `profile.json`（对齐 424 "worker 直读 config"先例，不走 main round-trip）。含 `isSafeBotId`（BOT_ID_PATTERN 镜像 electron agent-id.ts——agent-core 无法 import electron，复制 + 注释互指）→ `resolveBotProfilePath`（同根防逃逸）→ `readBotProfileIdentity`（容错：缺文件/坏 JSON/无 name → null）。
- `loader.ts`（474）改造：self 身份 **profile.json 优先**（`profile.name/description` 覆盖 config 的 name/description），roster 每项也 profile 优先、config entry 兜底。config 根复用 `resolveConfigRoot()`（config-agents.ts 现导出）。
- 测试（sections.test.ts +3）：self profile 优先（运行时改名生效）/ roster profile 优先 / 无 profile 回退 config。

**验证**：agent bot 测试 28 用例绿（新增 3）；electron config 测试 82 用例绿（新增 3 + ConfigStore getConfigDir 无回归）；agent 包与 electron 全量 `tsc --noEmit` 通过。

**边界声明**：P2.3（update_state executor 落盘）留待 481 工具建档时做——本 plan 只把读写层打通；avatar 文件、settings.json、观察者（Phase 3）与迁移工具（Phase 4）维持原计划。
