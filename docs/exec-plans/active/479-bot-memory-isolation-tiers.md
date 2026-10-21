# 479 — Bot 记忆隔离层（Grok 式三层记忆：Own / User / Project + 三层注入）

> **Status**: In Progress（Phase 1+2 完成 2026-09-03，PR #36 已并入 recover480；Phase 2 分支 `feat/479-phase2`）· **Priority**: P0 · **Owner**: TBD
> **总纲**: [473-grok-bot-framework-overview](./473-grok-bot-framework-overview.md)
> **关联**: 吸收并落地 [2026-08-31 多 Agent Profile 设计](./2026-08-31-multi-agent-profile-design.md) 的 **B（记忆按 profile 分区）**；与 plan 104（ProactiveMemory）、430（RAG hook）、433（Stage1 增量编辑）、474（botMemory section）衔接。
> **参考源码**：grok-bot `source/host/runner/sand-memory.ts`（343 行，全链路纯函数）、`source/host/extensions/memory/`（memory-service / synthesis-service / agent-state）
>
> **目标**：把 duya 记忆系统扩展出 grok 式**三层隔离**结构，并在 system prompt 注入时实现**三层注入**（三个独立 section：bot 自己的记忆 / 共享用户记忆 / 项目记忆），含优先级合并、via 溯源、单写者 shard、预算与冻结快照。

---

## 1. grok 三层记忆机制（调研结论，sand-memory.ts 已核实）

| 层 | 内容 | 写入 | 关键常量/规则 |
|---|---|---|---|
| **① Own（bot 私有）** | 每个 assistant 一个 shard：`profile.md`（每轮都记住的"你是谁"级事实）+ `log/YYYY-MM.md`（带日期历史） | `update_state target:"memory" scope:"agent"` write/forget | recent 注入 ≤30 条 / 4000 chars；note 前缀淡出最快但留盘；每 6 轮 episode 摘要 |
| **② User（跨 bot 共享）** | 所有 assistant 共享的用户事实；**按写者分 shard（单写者）**，渲染时合并并标注 `[via <assistant>]` | `update_state scope:"user"`；修别人的事实 = 写进自己 shard，newest-wins | profile 4000 chars / recent 2000 chars；与 own 冲突时 **own 优先** |
| **③ Project（项目共享）** | opt-in join/leave；每个项目 `by-agent/<assistantId>/` shard；只注入已 join 的项目，上限 **cap 3**，其余列 `also a member of` | `update_state target:"project"` create/join/leave + `scope:"project"` write/forget | profile 2500 / recent 1500 chars；优先级 **own > project > user**（最具体的赢） |

全链路配套：
- **提取**：`isMemorableExchange` 门（寒暄跳过）→ profile/log/note 三分类 + `remove:` 显式遗忘 + dedupe key（小写归一）+ `NONE` 哨兵；episode（每 6 轮一句日志式总结，前缀 `[episode] `）。
- **召回排序**：`memoryRecallRank = log2(importance) + createdAt / (30d 半衰期)`；token-overlap 相关性召回（`selectRelevantMemories`）。
- **注入**：三个独立 section（own `renderMemorySystemPrompt` / user `renderUserMemorySystemPrompt` / project `renderProjectMemorySystemPrompt`），**冻结快照**（同 compactionEpoch 返回同一 render，sand-memory.ts:30-38）。
- **写入工具**：`update_state` 统一入口（target memory/project + scope + action）。

## 2. duya 现状与差距

| 维度 | duya 现状 | 差距 |
|---|---|---|
| 存储 | `memory_entries` 按 session+project 索引（plan 301-306/401-406） | 无 `tier`（agent/user/project）、无 `agent_profile_id`、无写者/溯源字段 |
| 分区 | 2026-08-31 plan B 只有方向（加 `agent_profile_id` 列） | 无三层结构、无共享层单写者语义 |
| 提取 | curation agent（403/417，确定性）+ 433 增量编辑政策 | 无 profile/log/note 分类、无显式 remove、无 episode、无寒暄门（104 Planning 中有 RealTimeCapture，需合并而非并行造轮子） |
| 注入 | `memorySection.ts` 动态段（单层）+ 430 RAG 首轮注入 | 非三层、无 via 溯源、无优先级声明、无冻结快照（474 只留了接口） |
| 写入工具 | curation 是 agent 管线；模型无直接 write/forget 工具 | 缺 `update_state` 式一等工具（→ 481 统一建档） |

## 3. 设计

### 3.1 存储层（core-db migration）

`memory_entries` 增列：
- `tier: 'agent' | 'user' | 'project'`（旧数据迁移：有 project → project，否则 user；单 bot 场景等价旧行为）
- `agent_profile_id`（own 层的归属 bot / 共享层的写者）
- `kind: 'profile' | 'log' | 'note'`（对齐 grok 三分类；episode 以 `[episode] ` 前缀落 log）
- `dedupe_key`（小写归一唯一索引，tier 内去重）

冲突规则：同 `dedupe_key` 且同 shard → newest-wins 更新；共享层合并渲染时跨 shard 去重、保留最早 via。

### 3.2 三层注入（对齐 474 的 section 框架）

三个 SectionDef（`packages/agent/src/prompts/bot/memory/`）：

| Section | 来源查询 | 预算（对齐 grok） | 附加规则 |
|---|---|---|---|
| `memoryOwn` | tier=agent AND agent_profile_id=当前 bot | 30 条 / 4000 chars | 声明 own > project > user 优先级 |
| `memoryUser` | tier=user，跨 bot 合并 | profile 50 条/4000 chars + recent 15 条/2000 chars | 每条标注 `[via <botName>]`；无 profile 时提示可 grep 落盘历史 |
| `memoryProject` | tier=project AND bot 已 join，按活跃度排序取 cap 3 | profile 2500 + recent 1500 chars/项目 | 未注入项目列 `also a member of` |

- 三层各自**冻结快照**（对齐 473 §2.5.1 E1/E2 双键：内容版本 + 压缩纪元——memory 内容变了 → 内容键失效重渲；压缩 persist 推进 summaryEpoch → **无条件重渲一次**（对齐 grok `FrozenMemorySnapshot{render, compactionEpoch}`：纪元不变复用冻结渲染，纪元推进才重渲染 live memory 并存新快照）；474 的 `botEpoch`/`summaryEpoch` 双键为此处复用源）。
- 普通（非 bot）会话：三层退化为单层渲染（user/project 合并），行为向后兼容。
- RAG（430）：检索时按 tier + 可见性过滤——bot 的 own shard 不得进其他 bot 的检索结果；共享层全可检。

### 3.3 写入与提取

- **写入工具**（归 481 统一建档）：`update_state` 风格，target=memory/project、scope=agent/user/project、action=write/forget（project 另有 create/join/leave）。单写者规则：只能写自己的 shard；修改共享事实 = 写入自己 shard 的更正项（newest-wins）。权限默认：own=allow，user/project=ask（走 419 决策总线）。
- **提取管线**：合并 104 的 RealTimeCapture 到 grok 形态——寒暄门（isMemorableExchange）→ 单次非流式调用产 profile/log/note + remove（433 增量编辑协议承载）→ dedupe → 落库；每 6 轮 episode 摘要。extract 用独立轻量模型（对齐 422 compact_model 思路）。
- **召回**：保留现有 RAG 向量路径为主；补充 grok 的 rank 公式（importance log2 + 30d 半衰期）作为排序特征（104 已有 scoring，做融合不做替换）。

## 4. 分阶段实施

### Phase 1 — 存储
- [x] **P1.1** migration（tier/agent_profile_id/kind/dedupe_key + 旧数据回填）+ store 查询方法（by-tier/by-shard/合并召回）+ 单测。（0010 `memory_tier_index` + `electron/memory-state/tierIndex.ts` + `rebuildTierIndexFromFiles` 回填/dry-run/removed 清理）
- [x] **P1.2** 冲突规则（newest-wins、跨 shard dedupe）纯函数 + 单测。（`electron/memory-state/tierConflicts.ts`：`newestWins`/`resolveShardConflicts`/`dedupeAcrossShards`/`mergeTierRecall`）

### Phase 2 — 三层注入
- [x] **P2.1** `memoryOwn`/`memoryUser`/`memoryProject` 三个 SectionDef + via 溯源渲染 + 预算截断 + 单测。（`packages/agent/src/prompts/bot/memory/`：tierReader 文件侧读取 + render 纯渲染 + sections 注册；tierConflicts 移至 agent 包，electron 侧 re-export shim；loader 填充 ctx.memory 并解析 roster writerName）
- [x] **P2.2** 冻结快照接入双键纪元（内容哈希 + summaryEpoch 压缩纪元）；普通会话退化路径回归测试；单测覆盖"同双键二次渲染逐字节一致 / 仅压缩推进强制重渲 / 仅内容变化重渲"。（ctx.memory 已在 epoch.ts computeBotContentHash 内；装配实例跨轮持久，快照语义由框架双键直接承载）
- [ ] **P2.3** 430 RAG 的 tier 过滤 + 回归。

### Phase 3 — 写入与提取
- [ ] **P3.1** 提取管线（寒暄门/三分类/remove/episode，433 协议承载）+ 单测；104 RealTimeCapture 合并决策记录。
- [ ] **P3.2** `update_state` 工具（写侧；schema/权限在 481 定稿）+ 单测。
- [ ] **P3.3** rank 融合（104 scoring + grok 半衰期）。

### 验收
- [ ] e2e：两个 bot（A/B）+ 用户——A 学到用户事实写共享层；B 的 prompt 出现 `[via A]`；B 写自己的 own shard；join 一个项目后 prompt 出现 project 段且 cap 3 生效。
- [ ] 同 epoch 二次渲染逐字节一致；跨 epoch 变更生效。
- [ ] `npm run typecheck:all` + memory 相关单测全绿。

## 5. 非目标 / 风险

- 非目标：不迁移记忆物理存储形态（仍是 memory_entries，不做 grok 的纯文件 shard 文件夹——"shard"在这里是逻辑单写者分区）；不重写 curation agent。
- 风险：三层注入 token 膨胀 → 预算硬上限 + cap 3 + note 淡出；旧数据迁移歧义 → 迁移脚本带 dry-run 报告。

---

## 6. 可行性审计修正（2026-09-02 逐行核实代码后）

1. **重大修正：`memory_entries` 表已被删除**。migration 0009 `DROP TABLE memory_entries`（`electron/memory-state/migrations/0009_drop_legacy_phase2.sql.ts:28-30`）；现源真理 = 磁盘文件 manifest + `curation_publications` 表（0008 建，memory-state.db，独立于 duya-main/duya-core）。**§3.1 的"memory_entries 加列"作废**，改为二选一（P1.0 决策）：① 新 migration `0010_*.sql.ts`（`migrations/index.ts` MIGRATIONS 数组追加，memory_schema 表记 version+sha256，禁改已应用版本）建 tier 结构表；② 扩展文件 manifest（对齐 curation 现架构）。倾向 ②+① 混合：tier/归属放 manifest frontmatter，查询索引建 0010 表。另：0007 旧 schema 已有 scope/project_id/kind/canonical_key 列——三层语义有历史先例可参照。
   **→ P1.0 决策（2026-09-03，已实施）：采纳 ②+① 混合。** 文件树为真理源：own tier = `~/.duya/agents/<agentId>/memory/`（选 485 目录方案）；user tier = `~/.duya/memory/` 现有树（items/entities/global 为 legacy 回填范围）；project tier = `~/.duya/memory/projects/...`（Phase 3 写侧落地）。0010 表 `memory_tier_index` 为**可重建查询索引**（entry_id = sha256(tier|writer|project|dedupe_key)，dedupe_key 小写归一并入 CHECK 约束，file_path 唯一，shard 唯一索引），非真理源。回填规则：project_id 非空 → project tier，否则 user tier；kind 一律 'note'（legacy 无 profile/log）；retired 文件跳过。Phase 3 写侧经 `upsertTierEntry` 接入，own/project tier 文件索引由写路径直接维护（rebuild 扫描仅覆盖 legacy 三目录，不碰 agents//projects/ 行）。
2. **memorySection 现状**：`prompts/sections/dynamic/memorySection.ts:20-96` 纯文件渲染（summary.md，12k 截断），dynamic section **每轮重算**（非首轮），注册于 `prompts/configs/general.ts:79`，无条数上限。三层 section 的注入点即在此侧改造；"仅首轮注入"的假设不成立（对 479 是好事：每轮可注入）。
3. **RAG tier 过滤工作量上修**：`documents` 表**无 session/project 列**（`scripts/memory-rag-lib.mjs:532,591`；`electron/memory/rag_search.ts:191,233` 全局扫描）——tier 过滤需给 documents 加列 + 改两处查询 + 重建索引，从 P2.3 一个小任务升为独立工作项。
4. **死代码警示**：`packages/agent/src/memory-state/memory_entries_rebuild.ts` 引用已删 schema，属过时死代码——479 实施时顺手清理，勿在其上扩展。**→ 已清理（Phase 1）**：`parseCanonicalFile` 拆至 `canonical_file.ts`（extractor/memory-handlers/回填三个消费方改 import），rebuild 函数与其 cache 测试随 0009 已删表一同移除；phase_d_no_dangling 守护测试不受影响。
5. **写入方**：curation 流水线（`electron/memory/curation_*.ts`）写 manifest/公开物；479 的 `update_state` 写路径必须接入同一 manifest 结构（不另开写入口），per-shard 单写者约束在 manifest 目录层实现（对齐 grok by-writer shards 的目录语义反而更自然——文件系统天然按写者分目录）。

## 7. 读侧激活（2026-09-05，对齐 481 写侧布局 + grok 使用说明）

读侧（`packages/agent/src/prompts/bot/memory/tierReader.ts`）原先只扫 §6 P1.0 决策的目录约定，与 481 `tierWriter` 实际落盘布局不一致——写进 shard 的记忆永远进不了 prompt。本次修正：

1. **user tier 扫描根**：legacy 三目录（memory/items|entities|global）之外，增加全部 per-writer shard `agents/<agentId>/user/**`（shard 目录属主 = writerId）；**project tier** 从 `memory/projects/<id>/**` 改为 `projects/<projectId>/agents/<writerId>/**`（tierWriter 布局，shard 目录名 = writer）。shard 文件仅按 tier frontmatter 读（不再走 legacy 回退）。
2. **frontmatter 词表打通**：`readTierFile` 的 kind 取 `kind ?? claim_type`（tierWriter 写 `claim_type: profile|log|note`）；writerId 仍以 `agent_profile_id ?? 目录属主` 解析（tierWriter 的 `scope_id` == 目录属主，无需读取）。
3. **memoryUsage 静态 section**（`memory/usage.ts`，catalog 序位于 memoryOwn 前）：对每个 bot 会话常驻渲染——own/user 层语义、shard 路径（loader 经 `ctx.memoryRoots` 注入绝对路径，epoch 内容哈希已纳入）、update_state 写法（own 免确认 / user 要确认）、"修他人共享事实=写进自己 shard, newest-wins"、优先级声明。解决鸡蛋问题：内容 section 空层不渲染，无此段则新 bot 永远不知道私有记忆可写（own 层恒空）。渲染标题用 `###` 层级，与 memoryUser 的 `## Shared user memory` header 断言不冲突。
4. **basicPrompt 记忆段**：legacy 的 summary.md/MEMORY.md 描述改为 tier 表述，指向下方注入的 memory sections。
5. 未动：`gatewayConfig.test.ts` 的 `configProtection` 断言为 HEAD 既有失败，与本次无关。
6. **bot session 排除出 session 记忆管线**（同日）：`selectEligible`（`packages/agent/src/memory-state/eligibility.ts`）新增 `excludeAgentProfileIds`——`agent_profile_id` 命中名单的 rollout 永不进入 Stage 1 提取；`diagnoseEligibility` 增加 `botExcluded` 桶。memory-worker 每次清扫从 `~/.duya/config.toml [agents]` 解析 bot id（`MemoryWorkerDeps.listBotAgentIds` 可注入，解析失败 fail-open）。bot 的记忆供给 = update_state 写 tier store（+后续 P3.1），与 chat 会话提取管线彻底分流。catalogSync 仍逐字复制（其契约是不做 eligibility 过滤，Plan 302）。
   **→ 实测修正（2026-09-05 晚，dev 日志暴露两处）：** ① 排除子句原先拼在整条 SQL 之后（`LIMIT :limit` 后面），SQLite 把它折叠进 LIMIT 表达式、`r` 别名出界 → `no such column: r.agent_profile_id`，每轮 selectEligible 报错。已改为 BASE + 排除子句 + ORDER BY/LIMIT 尾段拼接（真库复现验证：错误形态与修复形态均确认）。② core `sessions` 现会给 bot 会话写 `agent_type='bot'`，memory-state `rollout_catalog` 的 CHECK 白名单（0001 迁移，已应用不可改）没有 'bot' → 4 个 bot session 每轮 sync 报 CHECK 约束失败。既然 479 本就不让 bot session 进管线，catalogSync 的两个入口（syncAllFromMainDb / syncSessionFromMainDb）现在直接跳过 `agent_type='bot'` 的会话并不落 catalog 行，已存在的旧行走 markRolloutDeleted tombstone（provenance 保留、source_status='deleted' 天然不 eligible）。

