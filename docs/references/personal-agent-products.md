# 个人智能体产品依据

查阅日期：2026-10-25。用途：为[Bot 设计](../design-docs/personal-bot-framework.md)提供产品层约束，不推测闭源系统的包结构、数据库或调度实现。

用户已确认四个产品与官方链接：Grok Bot、Meta Muse、OpenAI dots、Claude Duet。引用会话预览只含两次问题，助手正文是内容引用占位符。当前工具未提供 ChatGPT `read_thread`，因此没有取得完整旧回答，不能声称沿用其中的具体结论。

## 一手资料与设计推导

| 产品与官方依据 | 核实的产品行为 | 对 DUYA 的推导 |
| --- | --- | --- |
| [Grok Bot overview](https://docs.x.ai/grok-bot/overview) | 命名 Bot、长期上下文、技能与例行任务；同账户 Bot 共享电脑，Bot 对话与记忆分开 | 身份、执行环境、记忆作用域分别建模；共享环境不代表无条件共享知识 |
| [Meta Muse 发布](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/) | 个人目标、持续学习、独立 VM；凭据隔离、行动审计、用户可要求遗忘 | 长期责任与记忆分离；凭据只在适配器；遗忘是领域用例 |
| [OpenAI dots 发布](https://openai.com/index/introducing-dots/) | 跨渠道连续上下文、独立电脑、持续工作；后台主动研究使用只读工具；有规则与动作审查 | 区分后台发现和受托执行；消息连续性不依赖单一 UI；政策在执行边界生效 |
| [Claude Duet 发布](https://claude.com/resources/articles/claude-duet) | 每日简报、持续关注连接应用、按需提醒、行动检查；发布时是 research preview | 注意力、预算和执行相互独立；把“何时打扰用户”作为明确策略 |

“成熟”不能作为已验证的技术前提。官方材料描述的是公开能力与产品承诺，Duet 明确仍是研究预览；没有四种产品的内部源码与相同条件下的实测证据。本设计借鉴可观察的需求形态，以本仓合同测试决定实现是否可靠。

## 八个维度的公开机制

下表只写文档能支持的行为。“未公开”表示本次资料未提供内部合同，不表示产品没有该能力。Session / Run 是 DUYA 的术语，不能据相似 UI 推定厂商也有相同实体或表。

| 维度 | Grok Bot | Muse | dots | Claude Duet |
| --- | --- | --- | --- | --- |
| Persistent Agent 生命周期 | Bot 超出一次聊天，持续承担角色 | 个人 VM 中运行并处理后台工作 | 会话间继续推进，可暂停 | 关闭客户端后继续工作 |
| Bot / Session / Run | 明确 Bot 与 chat 有别；Run 合同未公开 | harness 与 subagent 存在；实体映射未公开 | 同一 dot 可派生后台任务与新 thread；Run 实体未公开 | 主线程与主题 channel 共享记忆；Run 实体未公开 |
| 记忆 | 角色记忆独立；能力可共享 | 从交互学习，支持要求遗忘 | ChatGPT memory 与自有 notes | 继承 Claude memory；断开 app 不抹去既有记忆 |
| 主动唤醒 | schedule、event 或其他 Bot 触发 | 支持后台与 cron；唤醒队列细节未公开 | 自主暂停与再唤醒、定时任务、只读研究 | 定期检查账户；检查间隔会漏过即时变化 |
| Goal / Task 调度 | routine 表达持续责任；DAG / retry 未公开 | 并发 subagents 与 cron；调度合同未公开 | 委派 Work / Codex，父 dot 持续交互 | Tasks 展示工作；用户确认完成，内部调度未公开 |
| 消息路由 | 角色 Bot 与共享群聊协作 | 客户端直接连接个人 VM | 保留各渠道消息边界，跨渠道用相关上下文 | 主线程较安静，主题 channel，共享记忆 |
| 权限隔离 | 角色 context 和账户 capability 分离 | runtime cell、外置授权与凭据服务 | 既有 app 权限、动作审查与 custom rules | 凭据私密输入、行动确认与 app 权限 |
| 崩溃恢复 | 未公开 journal / replay / fence 合同 | 公开 durable state 在 cell 外；恢复算法未公开 | 未公开持久 dispatch 与副作用重放合同 | 未公开 checkpoint / retry / 副作用重放合同 |

Grok 的 Bot / chat、账户工具与角色记忆分离、routine 触发依据是[产品设计文章](https://x.ai/news/designing-grok-bot)；[发布说明](https://x.ai/news/introducing-grok-bot)说明其 beta 定位。它们不是公开源码，也没有给出调度与崩溃恢复算法。

Muse 的[安全架构](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse)公开了更具体的机制：harness 在隔离 runtime cell，凭据与授权服务在 cell 外，Sentinel 审查 connector / egress，durable application state 单独存 PostgreSQL。授权绑定具体目标与用途，模型无法自行批准。DUYA 借鉴的是执行与授权分权；不据此引入 PostgreSQL、复制 Sentinel，也不声称现有 Shell 已具备全流量 egress 隔离。

dots 的跨渠道、后台委派、自主再唤醒与 notes 依据是[产品文档](https://learn.chatgpt.com/docs/dots)，暂停 / 重置等用户控制补见[使用指南](https://help.openai.com/en/articles/20001530-getting-started-with-your-dot)。产品文档特别区分主任务、委派任务与 recurring task 的停止操作；DUYA 应明确各取消范围，不能把暂停一个 Run 等同暂停所有长期工作。

Duet 的轮询、主题 channel、任务确认与断连后记忆保留依据是[使用文档](https://support.claude.com/en/articles/17631495-get-started-with-claude-duet)。[官网](https://claude.com/product/claude-duet)仍标 research preview。DUYA 的 completion policy 应显式区分“执行成功”和“用户认可责任完成”。

Meta 的[官网](https://ai.meta.com/muse/)本次没有返回可读正文，未据此新增事实；Meta 发布与安全文档已成功读取。dots Markdown 端点被读取工具拒绝，已使用成功读取的 HTML 正文。

## 适用限制

- Grok Bot 的共享电脑形态与 Muse / dots 的隔离形态不同，不能统一推导为“每个 Bot 必须一个 VM”。DUYA 首版保留本地工作区边界，执行环境通过授权绑定。
- 官方“持续工作”依赖实际存活的服务。DUYA 的本地 Host 无法在机器断电时运行；resident 与 client-scoped 要在产品里明确区分。
- 公布的记忆能力不证明召回无泄漏、遗忘无残留或工具可安全重放；这些都列入 DUYA 自身验收。
- 第三方 open-muse / open-duet / OpenMausBot 没有作为上述厂商官方架构证据，也没有把搜索摘要当成源码事实。

## 本仓核实入口

以下路径均以设计记录的 base SHA 为准；状态与行为要重新跑测试，不能仅凭注释判断。

| 当前入口 | 直接可见事实与限制 |
| --- | --- |
| `packages/agent-protocol/src/wake.ts` | Wake 来源、lane 与 payload 已有统一线上词汇；不需另造同义协议 |
| `packages/agent-core/src/wake/queue.ts` | 纯队列可复用；文件注释仍含旧 Agent 路径，归属以实际 import 为准 |
| `apps/desktop/src/main/wake/wake-dispatcher.ts` | 调度依赖 Desktop lock / routine / UI claim；不能把已有 Host pending-wake CRUD 视为调度已迁出 |
| `apps/desktop/src/main/ipc/bot-handlers.ts` | idle 分支返回 start 交 renderer 执行，busy 分支入 wake；迁移需取消客户端执行认领 |
| `packages/data/src/pending-wakes.ts` | 主键 `(kind, work_id)`，48h stale horizon；不是完整 dispatch / terminal / delivery 账本 |
| `packages/host/src/local-pending-wakes-api.ts` | 现有 pending-wake store 的 CRUD 投影；没有独立的 Bot dispatch loop |
| `packages/host/src/config-agents/` | config 写侧与 profile 文件规则已下沉；Desktop 与 standalone writer 仍需并发对账 |
| `packages/data/src/agent-profile-store.ts` | SQLite 执行 profile 另有 store；不可把它和 config Bot 身份直接视为同一实体 |
| `packages/host/src/worker-prompts/bot/loader.ts` | worker 直接读配置、profile、memory tier 和 group；目标是改为有作用域的 typed snapshot |
| `packages/host/src/worker-prompts/bot/framework.ts` | renderSections 使用 includeBasic:false；迁移不能顺手恢复基础人格 |
| `packages/host/src/run-orchestrator.ts` | openRun 在 Host 铸造 Run ID 并启动；尚不能从该接口假定 dispatchKey 幂等受理 |
| `packages/data/src/core-stores.ts` | createCoreDataStores 将 RunStore、GoalStore、PendingWakeStore 放在同一个 core DB；为新 inbox 与 Run receipt 原子关联提供候选接缝，实际 Host dispatch 仍须单独验证 |
| `packages/agent-protocol/src/goals.ts` | 现有 Goal 是 session-scoped；不能只挂 botId 就声称已经支持跨 Session 的长期责任 |
| `packages/host/src/client-lease.ts` | client-scoped Host 可在无客户端时退出；后台 Bot 需 resident 生命周期 |
| `apps/desktop/src/main/channels/` | 现有绑定、平台 SDK、凭据与出站实现；迁移保留行为但将平台 I/O 从 Bot 规则中隔离 |

与既有工作的关系：[610 执行队列](../exec-plans/active/610-architecture-series/19-fast-track-queue.md)拥有通用 Host / Run / Session 工作，[622](../exec-plans/active/622-agent-platform-convergence/README.md)拥有依赖测量与层门禁，[619](../exec-plans/active/619-prompt-assembly-context-channel.md)拥有 prompt 双通道。Bot 计划只对其提出具体接缝，不重复建设。

## master 审计的改进优先级

代码事实均核对于 `270ba528`，以下“风险”是从调用结构推导的失败窗口，尚未以本次故障注入证明为线上缺陷。后续切片必须先写能暴露该窗口的测试，再决定修法。

| 优先级 | 已验证的源码事实 | 风险推导与具体改进 |
| --- | --- | --- |
| P0 | `apps/desktop/src/main/ipc/bot-handlers.ts:81` idle 返回 start，由 renderer 启动；busy 另入队 | 两种执行受理入口难统一；S3 改为 Host 始终受理，客户端只消费 receipt 与流 |
| P0 | `apps/desktop/src/main/wake/wake-dispatcher.ts:485` 持久化为 best-effort；`:549` 起定义离队清理 | accepted 与 durable 恢复证据不等价；S3 改 durable inbox，结算点与 Run receipt 关联 |
| P0 | `packages/host/src/run-orchestrator.ts:637` openRun，`:638` 每次分配 randomUUID | 响应丢失时重试入口不能保证同 Run；S3 在现有 Host 控制面补 dispatchKey receipt，不建第二 executor |
| P0 | `packages/host/src/worker-prompts/bot/loader.ts:220` 读取全局 user tier，调用未携带 channel audience | 该 loader 本身不足以证明受众级隔离；S5 先追踪完整调用链与策略，再改 scope-aware MemoryPort，不能仅靠 prompt 限制 |
| P1 | `packages/agent-protocol/src/goals.ts:30` Goal API 按 Session 查询 | 跨 Session 责任不能直接等同该 Goal；S6 加 responsibility binding，复用已有执行状态 |
| P1 | `packages/host/src/local-host.ts:787` 仅 clientScoped 时注入 idle 退出逻辑 | 自动拉起的 client-scoped Host 不等于常驻服务；S3 显式 resident 生命周期和分项 pause receipt |
| P1 | `packages/data/src/core-stores.ts:1228` / `:1232` / `:1235` 在同 core DB 装配 Goal / wake / Run store | 可在既有事务域内设计 inbox→Run receipt 关联，避免引入第二 DB；同库不是派发已原子的证明 |

`@duya/bot` 的收益应由这些用例的依赖闭包与测试体现。若只是为把所有带 bot 的文件放一起而拆包，应继续使用 Host 内模块；当纯规则形成稳定接口后，再按设计提取窄包。
