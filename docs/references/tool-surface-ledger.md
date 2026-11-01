# 工具面能力台账（W0）

2026-10-31：[工具暴露与 Harness 调用链收敛](../exec-plans/active/2026-10-31-tool-surface-and-harness-convergence.md) W0 台账交付。逐工具登记注册/有效暴露与去留裁定，消除"其他工具以后再说"的盲区；裁定是方向不是已实施的暴露变更——任何暴露变化仍按 W4/W5/W6 的验收与灰度走。

证据：[Draft PR #555](https://github.com/lava-chen/duya/pull/555) 的请求级 census（真实 WorkerSession 链，8 场景，base `a33bbb05`）。原始 JSON 在 `docs-local/research/tool-surface-w0/`（本地，gitignored）；本表只留提炼结论。场景总数：registry 49（45 builtin + 2 fixture MCP + 2 fixture connector）；终列 worker-hint 23 / worker-search 21 / worker-mention 24 / bot-hint 33 / bot-search 31 / bot-mention 34；终列 schema 字节 13.3k–23.0k，描述字节 8.2k–18.2k。

## 怎么读

- **注册**：registry 注册值（census）。**worker / bot**：默认配置首轮是否终列（bot = `full` base profile + `applyBotToolset`，[F10 修订] bot 无独立注册表）。
- **字节**：canonical `input_schema` JSON 序列化 UTF-8 字节；非 token 数。
- **裁定**：保留 / 按需 / CLI / 产品 MCP / 外部 / 待决。待决必须带核对动作。
- MCP 与 App Connector 不逐行登记（数量随用户配置变化），按类别登记策略。

## 台账

### 基础工作工具（617 范围）

| 工具 | 注册 | worker/bot | 字节 | 裁定 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `read` | eager | 双见 | 1222 | 保留 | 617 B1 补扁平 offset/limit；50KB 上限已有 |
| `write` | eager | 双见 | 365 | 保留 | W7 与 edit/patch 组合评测后再定默认集 |
| `edit` | eager | 双见 | 787 | 保留 | 617 B3 保留 edits[] + 单次形态 |
| `apply_patch` | eager | 双见 | 318 | 保留 | F16：partial 结果契约先修；freeform 仅 provider 支持时试 |
| `glob` | eager | 双见 | 580 | 保留 | 是否与 grep 合并以 W7 实测决定 |
| `grep` | eager | 双见 | 1169 | 保留 | 443 rg 链路在途，避免同文件冲突 |
| `bash` | eager | 双见 | 757 | 保留 | 617 B4 description 必填候选 |
| `powershell` | deferred | worker 按需 | 763 | 按需 | 每平台明确默认 shell，另一个按需（audit 裁定） |
| `wait_tasks` | 未注册 | — | 240 | 不注册 | 617 A4 已决（2026-10-31 核对）：实现是 legacy 非阻塞别名（execute 转调 `get_task_output`、`timeout_ms` 被忽略，capabilities background-task-tool.ts:267-298），binding 未 import 进 builtin.ts；后台任务由 harness `<task-notification>` 自动唤醒，wait 工具只诱导死轮询（agent BackgroundTaskTool/index.ts:4-7 注释即此决策）。可选加固：执行层别名把模型残留 `wait_tasks` 映射到 `get_task_output`（streaming-tool-executor.ts resolveToolKey） |

### 任务与模式（Harness 控制）

| 工具 | 注册 | worker/bot | 字节 | 裁定 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `task` | eager | 双见 | 2874 | 保留 | 子 agent 活控制；`Agent` 别名解析缺口见 617 A2 |
| `get_task_output` / `kill_task` | eager | 双见 | 177 / 131 | 保留 | |
| `todo` | eager | 双见 | 642 | 保留 | 与产品 `plan` 的重复提示词 W9 去重 |
| `AskUserQuestion` | eager | 双见 | 1048 | 保留 | bot 当前也见——死 bot 注册表曾打算 hidden，W4 需裁决 bot 是否应隐藏交互工具 |
| `EnterPlanMode` / `ExitPlanMode` | deferred | 按需 | 47 / 47 | 按需 | |
| `SwitchMode` | deferred | 按需 | 245 | 按需 | |
| `Skill` | eager | 双见 | 216 | 保留 | skill 只是指引，不是权限来源 |
| `enter_worktree` / `exit_worktree` / `sync_worktree` | eager | 双见 | 167/118/113 | W4 候选：bot 隐藏 | bot 可见来源是 base profile `full` 的 `'*'` 通配 allowlist（config-agents.ts:25,35 → tool-filter.ts:122-126），非 BOT_TOOLSET（bot-toolset.ts:44-56 不含三者）；无人值守角色自主切换 cwd 无意义且无确认环节（worktree.ts:23-27 直接切换）；subagent 已把三者列入禁止集（worker-subagents/tool-utils.ts:25-28），bot 隔离应走 spawn 参数（session 工具 `use_worktree`）。worker 侧保留 eager |

### 产品能力（616 收敛候选）

| 工具 | 注册 | worker/bot | 字节 | 裁定 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `send_message` | deferred | worker 无 / bot 见（F24 修复已合并 [PR #557](https://github.com/lava-chen/duya/pull/557)，`b79e3521`） | 5062 | 产品 MCP | 616 T610d bot 簇 |
| `send_to_agent` | deferred | bot 见 | 1236 | 产品 MCP | 477 |
| `post_to_room` | deferred | bot 见 | 318 | 产品 MCP | 478 |
| `ReactToMessage` | deferred | 均无 | 359 | 维持 deferred | 490 承诺 always-exposed（对标 grok SAND_FORCED_STATIC）且执行日志宣称已交付，但代码自引入即 deferred（8f7f5032，builtin.ts:117）——承诺未落地；UI pill 归 491 P2 也未落地；无消费方依赖首轮可见。490 计划的 `[x]` 记录需其 owner 更正（对无人值守 bot，emoji 反应属社交手势，deferred 更稳） |
| `create_agent` / `update_agent` | deferred | bot 见 | 354 / 348 | 产品 MCP | 492 P4 |
| `manage_routine` | deferred | bot 见 | 2428 | 产品 MCP | 476 |
| `list_app_connectors` / `connect_app` | deferred | bot 见 | 47 / 180 | 产品 MCP | 503 elicitation；bot 不能完成授权 |
| `session` | deferred | bot 见（BOT_TOOLSET） | 1793 | 逐 action 裁定 | action 全集（session-tool.ts:69-75）：`spawn`/`reply`/`cancel` 生命周期保持 typed；`list`/`get`/`rename` 只读管理是 W6 CLI 候选。管自己 spawn 的子会话（异步），与 `MessageSession` 非重复 |
| `MessageSession` | deferred | 均无 | 667 | 保持 typed | 更正（2026-10-31 核对）：无 action 枚举——单发同步问答（targetSessionId+message+mode+timeout，唤醒目标跑 turn，非只读，message-session-tool.ts:44-68）；与 `session`（异步管自spawn子会话）语义不同非重叠；活跃有测试，subagent 显式禁用 |
| `SessionSearch` | deferred | 均无 | 460 | CLI | W6 先补 CLI scope/排除当前会话/FTS 再撤入口；底层检索保留 |
| `duya_cli` | deferred | 均无 | 33 | CLI | W6 单一解析器（F12）；新会话先撤暴露 |
| `plan` | eager | 双见 | 1333 | 维持现状 | 与 `todo` 非同源（2026-10-31 核对）：plan=项目级持久文件工件（`~/.duya/projects/<id>/plans/`，PlanTool 只读+归档+搬文件），todo=会话级 `tasks` 表 + todoGateHook loop 控制；消费者互不重叠、无重复存储，收敛无收益；W9 仅在两者 description 澄清分工 |
| `update_state` | deferred | bot 见 | 1951 | 保留 | bot 记忆 shard（479/481） |
| `memory_write` | deferred | 均无 | 261 | 保留 | 主 agent 持久记忆文件端口（写会话 cwd 相对路径 markdown，MemoryWriteTool.ts:46-49）；读取方=prompt 注入链 memoryPreBuildHook（读 `~/.duya/memory/` 固定根）；与 bot `update_state`（tier store，独立读写路径）并行不重叠。坑：写入跟 cwd、读取方固定根，未强制对齐（W9 关注） |
| `write_stage1_policy` | deferred | 均无 | 128 | 保留（按需） | stage1 记忆抽取器政策热更新开关（写 `memory-config/stage1_policy.md`+version sidecar）；唯一读者=桌面 memory-worker Stage1Extractor（memory-worker.ts:403-407）。坑：写 `<cwd>/memory-config/` 与实际 configRoot 未被代码对齐（W9 关注） |
| `Brief` | deferred | 均无 | 47 | 按需 | 低频；保留实现 |
| `vision_analyze` | eager | 双见 | 436 | W4 候选：降 deferred | schema 仅 ~0.7KB 两字段，无常驻 schema 压力；真实成本在调用时（独立 Vision provider 按次计费）。工具暴露层现无按模型多模态能力过滤机制（多模态探测只用于附件策略）；最小按需化=builtin.ts:90 翻 deferred 走 mention/catalog 提升，「仅按主模型能力门控」需新机制（W4 裁决） |
| `image_generate` | deferred | bot 见 | 837 | 按需 | bot 需要（481 成员决策） |
| `read_module` | deferred | 均无 | 374 | 按需 | 读内置设计规范模块（diagram/mockup/chart/interactive 四份 inline 文案，无外部索引）；唯一联动=`show_widget` 描述引导先加载；与 `read`/`Skill`/duya_cli 无重叠；模型自觉调用、无 hook 强制，低频符合按需定位 |
| `show_widget` | deferred | 均无 | 377 | 产品 MCP | widget/artifact 面（616）；bot 不可见符合死注册表意图 |
| `send_artifact` | deferred | 均无 | 244 | 产品 MCP | 同上 |

### 路由元工具与私有控制

| 工具 | 注册 | worker/bot | 字节 | 裁定 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `tool_catalog` / `tool_invoke` | eager | 双见 | 571 / 314 | 保留 | 通用 fallback；已知 ID 直接 invoke（F05/F06）；W3 减往返 |
| `progress_update` | 不进 registry | 双见（装配注入） | — | 保留 | 私有控制工具：`tool-group-progress.ts` 定义，`worker-run-composition.ts:153` / `worker-session-runtime.ts:499` 注入；W9 诊断须能解释 registry 外注入 |

### 外部能力（类别登记）

| 类别 | 暴露策略 | 裁定 | 备注 |
| --- | --- | --- | --- |
| config MCP | 由 `[tools] exposure` 决定：full/hint→eager、search→deferred（F02） | W4 灰度默认 search；显式配置不动 | 大 schema 撞 8KB 静默降级（F08，W2 修） |
| App Connector | 恒 deferred + mention 提升（F03） | 保留 | mention 只提升被提及 provider（census worker-mention 证实）；hint/search 并发悬崖见 F26 |
| Browser / Computer Use / 已外置 Canvas | 既有外置方向 | 不逆转 | 只核验发现/调用兼容 |

## 与计划的接口

- F10 已修订、F18 已复现、F24–F26 新增——见计划 §2。
- 2026-10-31 二轮：待决 7 项（9 行）全部核对完毕回写裁定，仅 `AskUserQuestion` bot 可见性仍留 W4（死 bot 注册表曾拟 hidden）；490 计划记录漂移交其 owner 更正。
- W4 决策输入：`AskUserQuestion` bot 可见性；worktree 三工具 bot 隐藏候选（`'*'` 通配来源已核）；`vision_analyze` 降 deferred 候选（按能力门控机制不存在）；bot `send_message` 修复已合并（#557，`b79e3521`）。
- W6 决策输入：`duya_cli`/`SessionSearch`/`session` 只读面（`list`/`get`/`rename`）的 CLI 能力清单。
- W9 决策输入：`progress_update` 注入的解释；`todo`/`plan` description 分工澄清（状态源维持现状）；`memory_write`/`write_stage1_policy` 写入路径与读取根未对齐两处坑。
