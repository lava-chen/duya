# Session CLI 发布收尾与 Bot / Host 边界

状态：执行中（A、B 待认领）· 更新：2026-11-02 · 交付：[PR #562](https://github.com/lava-chen/duya/pull/562)

本轮只交付一个可独立安装、使用和恢复的 CLI/TUI Session 产品，按下面两个任务收尾后发布 CLI Release。用户负责产品测试；Agent 负责实现、构建、打包、交付测试包和修复反馈。本页替代原先“R1 → R2 → R3 → R4 全完成才交付”的排期。

沿用当前文件路径以保留 #562 及模块入链；任务是否在执行以本页和计划索引为准。原 [R1–R5 细分](bot-session-runtime/00-package-and-protocol-contracts.md)保留为后续设计参考，未完成项不自动成为本次发布前置。

## 产品边界

- **Session = CLI/TUI 的独立产品能力。** 安装 CLI 后，本机 Host 提供 Session 接口；TUI、非交互 CLI 和获授权调用者复用它。不依赖先启动 Desktop 或创建 Bot。
- **Host = 可信资源与平台能力。** 管模型、存储、进程、插件部署、凭据、授权和 Run 准入；Runtime 组合 Session 行为并复用既有引擎。
- **Bot = 长期 Agent 与 Session 协调者。** Desktop 必须接 Bot；用户与 Bot 最终访问同一个工作 Session。Bot 工具集另由后续 Agent 讨论，本轮不设计。
- 保留现有 apps/desktop、packages/cli、agent-runtime、host 与 plugin-core；不改目录名、不新增 Session 包或第二套引擎/状态账本。

## 已核对事实与痛点

快照：2026-11-02，主干 `74c3e3b0`；PR 状态是当时观测，接手时重读。未在本轮重跑产品测试。

| 事实 / 证据 | 对本轮的影响 |
| --- | --- |
| [#573](https://github.com/lava-chen/duya/pull/573)、[#574](https://github.com/lava-chen/duya/pull/574) 已合并输入/租约协议和 Runtime Session 服务；[#577](https://github.com/lava-chen/duya/pull/577) 已合并统一启动入口与细分拒绝结果 | 复用已落地入口；忙碌、重复请求、创建失败必须分别处理，不重新设计 Session API |
| [#578](https://github.com/lava-chen/duya/pull/578) 已实现引擎核心迁移、未合并；driver/composition 仍在 Host | 与 owner 核对集成范围；剩余消息类型迁移和纯文件搬迁不阻塞 CLI 发布 |
| [#579](https://github.com/lava-chen/duya/pull/579) Draft 已实现 duya_app Session 工具及异步 receipt；双 Worker、恢复、取消及权限差分待验收 | 接续现有 PR，不另造工具入口；工具发现成功不能代表真实执行闭环 |
| #579 的 session-input-service 目前由 Worker 调用，actor 派生为 bot；lease 校验与 mailbox apply 跨 API | 不宣称 Desktop/TUI 用户接管已完成；本轮实际发布的输入路径必须处理过期 Run/turn、重复请求和控制权变化，修复影响它的竞态 |
| worker-subagents/service 仍有绕过统一控制面的子会话路径（#577 的已知剩余项） | 若此次 CLI 暴露该路径，在 A 内收口；不把所有 Bot/多 Agent 改造一并纳入 |
| [#521](https://github.com/lava-chen/duya/pull/521) 已合并 Bot 身份、Inbox/Outbox、幂等派发及常驻相关基础；Bot dispatcher 默认仍按 bot:<id> 串行 | Bot 不是从零开始；多任务绑定、用户接管和反馈闭环后续独立推进 |
| CLI 安装器、独立发布和 Windows 安装器已随 [#541](https://github.com/lava-chen/duya/pull/541)、[#552](https://github.com/lava-chen/duya/pull/552)、[#559](https://github.com/lava-chen/duya/pull/559) 合并 | 缺口是最终实包及 Release 交付，不再新建发布系统；旧发布计划的“四平台”已落后于当前五项矩阵 |

## 任务 A：收尾独立 Session（先派这一项）

**交付：一个可打包的集成提交、实际支持的 CLI/TUI 命令表、用户可操作的测试步骤。**

- [ ] 从最新 master 开独立 worktree；核对 #578/#579 的最新 head、CI 和 owner，沿已有 PR 接续。#577 已合并，不重复迁移。
- [ ] 接通：配置 Provider → 选择目录 → 创建/恢复 Session → 发任务 → 工具执行/审批 → steer/排队/取消 → 终态与历史保存；非交互 CLI 同用 Host。
- [ ] 收口本次暴露的 Session 工具：创建、查询/读取、异步发送/回执、取消与恢复。按既有 requestId/Run 账本对账，忙碌不误报成功，旧指令不落入新 Run；修复这条路径的 lease/mailbox 竞态。
- [ ] 保持 TUI 自动启动/附着同机 Host；既有 Session 可恢复。Desktop/Bot 未运行时，本轮声明支持的模型、基础工具及本机插件能力仍可用；缺插件/依赖时明确诊断。
- [ ] 只修阻断上述流程的问题；记录最终 commit、相关 PR、未交付能力和测试步骤，交给用户测试。用户反馈在本任务收尾，不再启动新一轮架构计划。

独占路径：Session 相关的 agent-protocol、agent-runtime、host、CLI 调用及 worker bundle；先与 #578/#579 owner 对齐，避免覆盖在途修改。

**完成标志：**上述流程已实现并可构建，用户获得可运行候选与测试清单；“用户测试通过”单独记录，不由工具目录、单测数字或计划勾选代替。

## 任务 B：打包并发布 CLI（A 冻结后收尾）

**交付：自包含测试包 → 用户测试反馈修复 → CLI Release 与可用安装入口。** 打包准备可与 A 同期进行，最终版本基于同一个集成 SHA。

- [ ] 复用当前构建与打包入口：`npm run build:cli-dev`、`scripts/package-cli-release.mjs`、`.github/workflows/release-cli.yml`；附带 Node、Host worker、prompt/assets 及实际运行依赖，不要求用户预装 Node 或 Desktop。
- [ ] 按现有矩阵准备 macOS x64/arm64、Linux x64/arm64、Windows x64 包与 SHA-256；核对原生模块和入口路径，提供安装/更新方式。构建成功与用户实测结果分别记录。
- [ ] 核对最近 CLI tag 决定候选版本；同步 `packages/cli/package.json`、必要锁文件及 `docs/release-notes/cli-v<V>.md`。测试未完成时交付候选包，不能标成正式验收通过。
- [ ] 用户测试反馈收尾后，按本次 CLI 发布目标和[发布指南](../../development/release.md)集成版本 PR；`cli/v<V>` 指向版本匹配的集成提交。核验 Release、五项产物、SHA256SUMS 和安装器版本解析，记录 tag/SHA/下载链接。

独占路径：CLI 版本、release notes、安装器、打包脚本和 CLI workflow；A 的源码与 bundle 以冻结 SHA 为准。Agent 运行必要类型/架构/构建检查；产品和真机测试由用户负责，不另扩建测试项目。CI 的必需检查继续遵循仓库规则。

用户测试清单：安装并启动；配置 Provider 与首轮工具调用；TUI steer/排队/审批/取消；退出重开恢复；已启用插件的 Skill/MCP 调用及缺失诊断；更新与版本显示。Session 间调用若随本版交付，补测异步回执、重复发送和重启恢复。

**完成标志：**用户测试结果已记入本页；Release 的版本、提交、平台资产、校验和与安装入口对应一致。

## Plugin：平台能力，由 Host 管理

Plugin 不属于 Session 引擎底层，也不为 Bot/Session 各建一套。它是两者共用的平台能力：**Bot/CLI/Desktop 发管理请求 → Host 安装、授权与注册 → Session 使用获准能力。** Bot 需要使用插件时也沿同一 Host 机制，不垄断管理入口。

| 概念 | 权威与边界 |
| --- | --- |
| Installation | Host/设备级：文件、版本、依赖、安装健康、凭据；共享格式/解析规则继续放 plugin-core，具体 IO 与部署放 Host |
| Binding | Project/Session/Run 使用范围：Host 解析 requested ∩ installed ∩ authorized ∩ policy；扩展既有 manifest/binding，不复制 registry |
| Session 消费 | 使用 Host 提供的 Skill/MCP/工具与本轮上下文；不实现安装器，凭据不进入 transcript/manifest |
| 部署形态 | 同 Host 复用安装；HTTP MCP 可只配置连接；stdio/CLI/Skill/Hook 在执行 Host 部署；Mini App 界面由客户端承载，不自动下发每台执行机器 |

现状证据：`packages/host/src/plugin-install-paths.ts` 只解析安装目录，`local-plugin-registry-api.ts` 提供目录投影；安装管理仍有 `apps/desktop/src/main/plugins/PluginManager.ts` 依赖。CLI 存在安装命令不证明 standalone Host 已承接完整安装服务。

本次只修独立 CLI 的发现、加载、缺失诊断和必要打包缺口。完整 PluginManager 下沉、Bot 驱动安装、逐任务 binding 与跨 Host 分发留作后续 Plugin Lifecycle & Distribution；不要求它们全部完成才发布。后续先做同机“请求安装 → Host 安装/授权 → 新 Run 实际调用”，成功以真实调用与健康状态为准。

## 后续范围与 Agent 发现追加区

Bot 工具集、项目/任务调度、Desktop 任务 Attach、跨机执行和自动 PR/merge 不列入此次 CLI 发布验收。旧模块保留：[R1](bot-session-runtime/01-session-runtime.md) · [R2](bot-session-runtime/02-capability-context.md) · [R3](bot-session-runtime/03-bot-coordination.md) · [R4](bot-session-runtime/04-delivery-and-attach.md) · [R5](bot-session-runtime/05-resident-and-remote.md)。

后续 Agent 在本节末尾追加：**日期/owner；发现与源码或 PR；最小行动；是否阻断本次 CLI（给具体原因）；接手任务/PR。** Bot 工具集由后续讨论决定，不在本轮预定。只有能指出本次 CLI 用户流程失败的事项才提升为 A/B 阻断项。

## 本次文档交付与接续

文档 owner：Codex root；独立 worktree：`/workspace/work/session-release-plan`；本地分支：`codex/session-cli-release-plan`；基于 #562 head `f7e760d2`，通过同一 PR 分支交付。独占本页、计划入口和 catalog。managed worktree/context 工具未提供，使用 Git linked worktree 与版本化计划对账。

本轮只更新文档与路由：UTF-8、173 条链接的目标与 Git 可见性、diff 检查通过；未新增断链，原索引 1 条缺失目标保留。未运行产品测试，未合并代码 PR，未创建 tag/Release。原设计与审计证据保留在模块文件和 Git 历史。下一动作：认领任务 A；任务 B 可先准备打包，等待 A 的集成 SHA 和用户测试。
