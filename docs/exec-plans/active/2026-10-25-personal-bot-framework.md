# 个人长期 Bot：统一领域边界与可靠迁移

状态：active，设计与本次验证完成、待 review；生产迁移未开始 · 负责人：Codex / root · 更新：2026-10-25
分支：`plan/bot-framework-foundation` · worktree：`.claude/worktrees/bot-framework-plan` · base：`270ba52869b6414094e553dd7f9abde5a1e429f7` · owner：本会话 root

## 目标与边界

本次交付是可评审的设计与迁移计划：定义长期个人智能体，明确 Bot 领域包、Host 运行装配、数据与记忆的唯一归属；以真实源码和四产品官方资料约束决策。后续按本计划切片逐步实现。

本次独占：本文件、`docs/design-docs/personal-bot-framework.md`、`docs/references/personal-agent-products.md` 及各自导航入口；仅文档。没有创建空 package、改 prompt、运行用户数据迁移或切换生产执行。

设计合同见[个人 Bot 框架](../../design-docs/personal-bot-framework.md)，依据与现有入口见[产品核实](../../references/personal-agent-products.md)。这两份文件维护合同和证据，本文件只维护排期、验收与接续。

前置与避让：610 保有通用 Run / Session / worker；622 保有层门禁与依赖测量；619 保有 prompt 双通道；620 保有会话记录合同；621 保有 managed workspace。Bot 切片调用这些服务，不接管其状态表，不重建 DAG、Run 引擎或审批系统。

## 本次设计验收与进度

- [x] 检查起始工作区无用户修改，fetch origin 并 pull 最新 master。
- [x] 从 `origin/master @ 270ba528` 建立独立 linked worktree；没有可用 managed worktree / workspace_get_context / CodeGraph 工具，以 Git 和版本化计划对账。
- [x] 核实当前 Host、Desktop wake、profile、memory、渠道与 Run 接缝；旧会话助手正文无法读取，已在依据中标明。
- [x] 按用户确认的四产品补读架构 / 安全 / 使用文档；完成八维对照，区分公开机制、源码事实和推导。
- [x] 写出领域合同、唯一 owner、失败窗口、迁移 / 删除标准与后续切片。
- [x] 完成导航、相对链接、Git 可见性、编码和 diff 检查；记录根门禁实际结果。
- [x] 提交文档切片并创建 [draft PR #483](https://github.com/lava-chen/duya/pull/483)，保存 review / 实施接续。
- [ ] S0–S7 生产迁移逐片验收；本次不勾选。

## 迁移切片

切片按顺序推进；同一数据根 / Bot 同时只有一个调度 owner。S1 建立端口后才开始 S2 提包。S3 的 durable 启动受理补齐前，S1 的 facade 只能委托旧调度器，不能伪装已可 headless 执行。

| 切片 | 交付与独占路径建议 | 依赖 | 完成标准 / 预计评审粒度 |
| --- | --- | --- | --- |
| **S0 边界与行为基线** | Bot 实际消费者清单、导入闭包探针、现有行为夹具；`scripts/architecture` 中 Bot 专属门禁与测试，计划证据 | 当前可开始；核对 622 01–04 真实 head | Bot→Host / UI→Host 反向边变异红→绿；现有身份、prompt、wake、投递行为具名基线。1 个门禁 PR |
| **S1 Host Bot 接口** | `host/src/bot` facade / ports，protocol 最小 DTO，Host 启动装配及 profile 写入接缝；旧 Desktop 调度作为过渡 adapter | S0 | Desktop/TUI 查询同一 Bot；create/update revision 冲突拒绝，错误不吞；不新增第二 scheduler。身份 journal 与跨文件修复测试。1–2 个窄 PR |
| **S2 提取 Bot 领域包** | `packages/bot` 的 domain/application/ports，host adapter，workspace/build/gates 必要接线 | S1；622 Host / 相关包层归属已落地或等价门禁实证 | 新包 managed、下向依赖受测、零 Electron/SQLite/fs/provider；至少一个真实 Host 用例消费，行为夹具不变。纯移动与行为修改分开 |
| **S3 持久唤醒与 resident** | data additive inbox / dispatch receipt；Host Run 幂等启动接缝、Bot dispatcher、lease 与恢复；Desktop bot handler 转发 | S2；Run receipt / fence 前置实证 | 无 UI 也能执行；Run 已受理响应丢失后不重复启动；旧 claim 无效；关闭最后客户端不误停 resident。先存储合同、再 Host 接线、最后切流，约 3 个 PR |
| **S4 投递与渠道** | data outbox；Host channel adapters；先 Telegram、再 Feishu 证明扩展接口；Desktop bridge / UI cards | S3；610 T22 范围对账 | 重复 inbound 一个 receipt；跨 binding 身份拒绝；发后崩溃进入 receipt reconciliation / unknown；无凭据泄漏。每平台独立 PR |
| **S5 记忆与 prompt 快照** | memory 范围过滤 / 遗忘 API，host BotContextSnapshot adapter，替换 worker 直接扫描；619/620 合同对齐 | S3；相关 memory owner 接缝 | own/user/project 授权隔离；撤权立即生效；prompt / 工具暴露对照不变；摘要不会复活已遗忘条目。人格变更另立切片 |
| **S6 持续责任与自主性** | Bot responsibility / attention 纯策略，现有 Goal / routine 端口，Host 预算与通知装配 | S3–S5；现有审批执行链 | 日程摘要闭环、离线 catch-up、预算 CAS、安静时段、暂停与授权撤销、审批准入；不重建 Task / DAG。按用户可见闭环拆 PR |
| **S7 旧路径退役** | Desktop wake / channel 业务退为 adapter 或删除，旧导出 / pending-wake bridge 清理，架构事实文档 | 所需 S3–S6 路径与各客户端已验收 | 消费者归零；新旧不能同时执行；fixture 迁移 / 回退 / 打包验收齐备，旧表最后 contract。独立删除 PR |

不以包数量、代码行数或搬了多少文件验收。每个 PR 都应说明一个用户行为、旧调用→新调用、失败时的结果与旧 adapter 退出条件。生产路径修改需相应 runtime / UI / 打包检查。

## 现有模块 → 目标归属

| 现有模块 / 旧任务 | 目标与退出条件 |
| --- | --- |
| `host/config-agents`、Desktop `config/bot-*`、485 | S1：Host 单写入口、规范 Bot view；保留 TOML / profile 兼容，旧 writer 消费者为零后删除 |
| protocol wake + core wake queue | 复用；S2 只迁 Bot 特有规则，不复制来源类型或通用队列 |
| Desktop `wake/*`、473 调度部分 | S3：Host Bot dispatcher；Desktop 只发送命令 / 展示状态，移除 renderer claim 执行权 |
| data `pending-wakes`、484、610 T22 | S3/S4：统一 delivery reconciliation 合同；T22 通用子会话完成事件仍由 610 owner 提供，Bot 只消费，不能两边实现同一唤醒 |
| Desktop `automation/*`、475、478 | S6：复用 Scheduler 与 routine 定义，触发适配器调 Bot acceptInput；通用非 Bot automation 保留原所有者 |
| Desktop `channels/*`、488、503 | S4：Host adapter + vault / connector 端口；不把 channel transport 和 AppConnector 视为同一概念 |
| `host/worker-prompts/bot`、474、479、536 | S5：有类型且受授权的 context；模板仍经既有 prompt 管线，memory 状态由 memory owner 维护 |
| `host/worker-tools/bot-builtin`、490 | 继续用现有 capability 工具，通过 Host Bot service 端口调领域；不在 bot 包实现 Shell / MCP |
| ui Bot chat / store、489、491 | S4 / S7：卡片和状态使用统一 query/event 投影；不以 SSE done 冒充对外投递完成 |
| DM / room、492、478 | 复用 Session / message envelope；S4 / S6 保持授权、hops 与防循环预算，不重做编排器 |

473–503 的历史 checkbox 不在本次批量改写。上述表只记录新合同覆盖关系；每个执行切片进入旧任务代码前，核实其剩余行为并在原计划加具名后继，确认完成或转交后再归档，避免两套调度工作队列。

## 风险、回退与数据窗口

| 风险 | 切流前证据 | 回退动作 |
| --- | --- | --- |
| 新旧调度同时执行 | 持久 owner epoch + 旧入口拒绝 + 双启动故障测试 | drain/暂停输入 → 交接 owner epoch → 切 adapter；禁止两者同时消费 |
| Run 受理后响应丢失 | 同 dispatchKey 查回 canonical runId；重启故障测试 | 保留 journal 对账；未可恢复 Run 标为 recovery_required，不盲目重跑 |
| 新 inbox 不能被旧版本理解 | 旧 marker 导入 dry-run、旧 reader 兼容夹具、记录新版本最低要求 | 先 drain 新队列或用有损项显式报告的 back-export；不能只 git revert |
| 身份文件与配置不一致 | 每个写入步骤 crash fixture，revision 冲突与修复 | durable create/update intent 驱动补齐，保留原始文件副本 |
| 远端动作已完成但 receipt 丢失 | provider 幂等 / 查询能力合同，unknown 路径演练 | 暂停 outbox，人工或 provider receipt 对账，不自动补发 |
| prompt 变动与目录迁移混杂 | 相同输入快照和工具 manifest 对照 | 保留旧组装 adapter；人格 / policy 变更分开开关与评审 |
| 机器离线被误报为持续服务 | resident 健康、租约与 catch-up 测试 | UI 明示离线与待处理，不承诺断电运行 |

迁移开关是设计要求，当前尚无这些开关：按 Bot ID 选择调度 owner，初始默认 legacy。shadow 只做只读比较，不调模型、不写 memory、不发工具与消息。切换步骤与 owner epoch 必须作为同一迁移命令校验；schema contract 只在回退窗口关闭后进行。

## 实施验收矩阵

每条由对应切片新增或复用具名测试；下表是待实现的测试要求，不能读作本次已通过。

| 场景 | 必须观察到的结果 | 所属 |
| --- | --- | --- |
| 同一 owner 由 Desktop 与 TUI 并发创建 / 更新 | 一份身份，requestId 去重，revision conflict 明确返回 | S1 |
| 同输入重投、两个 Bot 同 workId | 同 Bot 重投同 receipt；不同 Bot 相互隔离 | S3 |
| 在 inbox commit 后、dispatch 后、Run terminal 后杀 Host | 逐点重启对账，无丢失义务、无第二 executor | S3/S4 |
| user 抢占 background、旧 worker 延迟回报 | 绑定具体 runId/attempt；fence 拒绝旧写入；后台义务保留 | S3 |
| 最后客户端离开 / 重连 | resident 继续；client-scoped 行为不变；重连只读 replay | S3 |
| 发送已成功但未记 receipt | 幂等 provider 对账；不支持的进入 unknown，不能假成功 | S4 |
| 外部群成员 / DM 冒用 owner | 无权改 policy 或批准动作；记忆按受众过滤 | S4/S5 |
| 项目 membership 撤销、记忆遗忘后再压缩 | 立即禁止召回；旧摘要不复活记忆；审计保留边界明确 | S5 |
| 用户时区、DST 跳时 / 重复时、机器错过三天 | nextFire 与 fireKey 确定；按 misfire 策略限量补偿 | S6 |
| 预算并发预留、安静时段、暂停在途 / 排队责任 | 无超额派发；不重复打扰；审批与撤权照常生效 | S6 |
| 新增第二渠道 / 插件 | 改 adapter 不改领域与 Run loop；conformance 与真实接线通过 | S4/S7 |
| 旧版本 fixture 升级后回退 | 保留身份、历史、未投递义务与已完成动作；冲突可报告 | S7 |

每片执行根门禁；变更 main/preload 需 Electron 构建与真实桥；UI 用 Playwright；worker 或依赖 / 打包边界需重新构建并验证真实 Host→worker→provider 夹具→ledger。已有单测通过不替代后台 resident 和恢复链路。

## 关键决策

- 本次 master 从 `2baa95df` fetch 到 `270ba528`，master pull --ff-only 成功；原 `work` 分支保留。最新 tree 与旧会话时间点明显不同，全部迁移定位以最新源码为准。
- 目标一个 `@duya/bot` 领域包；Host 保留 I/O、工具和执行装配，data / memory 保持原所有权。先接缝、再门禁与提包、最后增强。
- Bot lifetime、Session、Run、AgentProfile、Responsibility 分别建模；不新增第二套任务 / Run 状态机。
- 现有 pending_wakes / Host CRUD 不足以证明可靠后台服务；Run dispatchKey 幂等 receipt 是生产切流硬前置。
- 四产品映射与官方链接已由用户确认。Muse 公开了部分安全架构，但四产品都没有提供本次所需的完整崩溃恢复 / 副作用重放合同；不能视为完整开源实现。旧助手正文仍无法读取。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| 起始 `2baa95df` | Linux / Git | status、fetch、master pull --ff-only | 0；到 `270ba528`，master 与远端一致 | Git log / origin/master |
| 干净源码 `270ba528`，仅依赖链接 | Linux / Node 24.19.0 | junction-worktree dry-run / setup | 0；独立 workspace overlay | 54 links；不穿链接 install |
| 同上 | 默认 sandbox | architecture:check / typecheck:all | 2 / 1；child process spawn EPERM，尚非代码失败 | 已申请正常子进程权限重跑 |
| `270ba528`，文档新增；无代码修改 | Linux / Node 24.19.0，允许子进程 | `npm run architecture:check` | 0；2841 findings 全为既有 tolerated，新增违规 0 | 未改 baseline；不能据此声称历史债已清 |
| 同上；构建依赖为共享第三方目录 | 同上 | `npm run typecheck:all` 首次有效运行 | 2；capabilities build 的 TS7016：缺少 @types/picomatch | manifest / lock 已声明，当前共享安装未提供；只在独立 work 目录补齐后重试 |
| `270ba528` + 本次 7 文档 | Linux / Node 24.19.0 / TypeScript 5.9.3 | `npm run typecheck:all` 完整重跑 | 0；含全部 workspace 构建与类型 / ratchet / recorder checks | 同一 @types/picomatch 4.0.3 在独立 work deps 安装，仅为 capabilities / host 建本检出私有 overlay；共享依赖未写入。不是 clean install / 跨平台 CI 结论 |
| `270ba528` + 仅本次文档 | Linux / Node 24.19.0 / Vitest 3.2.4 | `node node_modules/vitest/vitest.mjs run packages/agent-core/test/profiles/bot-toolset.test.ts packages/host/tests/config-agents-write.test.ts packages/host/tests/agent-profile-config.test.ts` | 0；3 文件 / 25 用例通过 | 真实已有测试；复用当前安装，非 clean npm ci / CI 证明 |
| 同上 | 同上，Electron binary 缺失 | 先前 4 文件运行另含 Desktop wake-dispatcher、channel-ack-redrive 两 suite | 1；Host 14 用例通过，2 wake suite 在加载期失败：Electron failed to install correctly / fetch failed | 没有执行到 wake 断言；不下载或删除共享 Electron 安装，不将其写成回归通过 |
| 同上 | Python 3 / Git | 7 文档 UTF-8、相对链接、tracked/planned visibility 对照 base | 新断链 0；138 条本地链接中 1 条 base 已失效 | 原有 README→2026-10-24-dynamic-workflow-package.md 不在 base tree，本次未修改 |
| 同上 | Git | `git diff --check` / 三个新增文件 check-ignore | 0 / 未被忽略 | 本次只暂存 7 个具名文档 |

## 接续 / 结果

已完成源码调查、设计与文档验证，生产实现未开始。设计交付 commit：`eaf9d86d`；后续仅补本节的 PR 接续记录。只提交 7 个具名文档；依赖 symlink、私有 work deps / 日志不入 Git，构建未产生需提交的源码差异。外部副作用：任务分支已推送并创建 draft PR；未改用户 DB、未合并或发布产品。

PR：[draft #483](https://github.com/lava-chen/duya/pull/483)，待 review / CI；没有申请或执行合并。当前工具无法读取原 ChatGPT 完整线程；必要时由后续对话补全文，不阻塞有源码支撑的方案。
回收：保留 worktree 与分支，等待设计 review / PR 集成，不执行删除。
下一步：review [draft #483](https://github.com/lava-chen/duya/pull/483) 的边界与迁移合同；实施接手从 **S0** 开始，先对齐 622 的层门禁实际 head，提交能证明反向依赖被拒的变异用例与现有行为基线。
