# Session CLI 发布收尾与 Bot / Host 边界

状态：CLI 集成提交与 Linux x64 候选已完成；产品测试与正式发布待用户反馈 · 更新：2026-11-02 · 交付：[PR #562](https://github.com/lava-chen/duya/pull/562)

当前总体方向已改为 [Project Coordinator 优先（#581）](https://github.com/lava-chen/duya/pull/581)：Project 是独立项目 Agent，Personal Bot 暂缓增强；先补 Coordinator 必需的 Session 基础，Project 首个闭环之后再排 Session 增强和独立 CLI Release。下面 A/B 保留为 CLI 交付任务，不是 Project 开工前置。用户负责产品测试；本计划不再承担总体架构排期。

沿用当前文件路径以保留 #562 及模块入链；任务是否在执行以本页和计划索引为准。原 [R1–R5 细分](bot-session-runtime/00-package-and-protocol-contracts.md)保留为后续设计参考，未完成项不自动成为本次发布前置。

## 产品边界

- **Session = CLI/TUI 的独立产品能力。** 安装 CLI 后，本机 Host 提供 Session 接口；TUI、非交互 CLI 和获授权调用者复用它。不依赖先启动 Desktop 或创建 Bot。
- **Host = 可信资源与平台能力。** 管模型、存储、进程、插件部署、凭据、授权和 Run 准入；Runtime 组合 Session 行为并复用既有引擎。
- **Project Coordinator = 项目协调者。** Desktop 首要入口是项目对话；用户与 Coordinator 访问同一个工作 Session。Personal Bot 是独立的个人事务产品，暂缓增强；不再要求项目创建或调度先经过 Bot。完整新边界以 #581 为准。
- 保留现有 apps/desktop、packages/cli、agent-runtime、host 与 plugin-core；不改目录名、不新增 Session 包或第二套引擎/状态账本。

## 已核对事实与痛点

快照：2026-11-02，最新主干 `af4aaede`。PR 状态于本轮重读；用户负责产品测试。

| 事实 / 证据 | 对本轮的影响 |
| --- | --- |
| [#573](https://github.com/lava-chen/duya/pull/573)、[#574](https://github.com/lava-chen/duya/pull/574) 已合并输入/租约协议和 Runtime Session 服务；[#577](https://github.com/lava-chen/duya/pull/577) 已合并统一启动入口与细分拒绝结果 | 复用已落地入口；忙碌、重复请求、创建失败必须分别处理，不重新设计 Session API |
| [#578](https://github.com/lava-chen/duya/pull/578) 已合并引擎核心迁移（master 后续至 af4aaede）；driver/composition 仍在 Host | 不重复迁移；剩余消息类型迁移和纯文件搬迁不阻塞产品闭环 |
| [#579](https://github.com/lava-chen/duya/pull/579) Draft 已实现 duya_app Session 工具及异步 receipt；双 Worker、恢复、取消及权限差分待验收 | 接续现有 PR，不另造工具入口；工具发现成功不能代表真实执行闭环 |
| #579 的 session-input-service 目前由 Worker 调用，actor 派生为 bot；lease 校验与 mailbox apply 跨 API | 不宣称 Desktop/TUI 用户接管已完成；本轮实际发布的输入路径必须处理过期 Run/turn、重复请求和控制权变化，修复影响它的竞态 |
| worker-subagents/service 仍有绕过统一控制面的子会话路径（#577 的已知剩余项） | 若此次 CLI 暴露该路径，在 A 内收口；不把所有 Bot/多 Agent 改造一并纳入 |
| [#521](https://github.com/lava-chen/duya/pull/521) 已合并 Bot 身份、Inbox/Outbox、幂等派发及常驻相关基础；Bot dispatcher 默认仍按 bot:<id> 串行 | Bot 不是从零开始；多任务绑定、用户接管和反馈闭环后续独立推进 |
| CLI 安装器、独立发布和 Windows 安装器已随 [#541](https://github.com/lava-chen/duya/pull/541)、[#552](https://github.com/lava-chen/duya/pull/552)、[#559](https://github.com/lava-chen/duya/pull/559) 合并 | 缺口是最终实包及 Release 交付，不再新建发布系统；旧发布计划的“四平台”已落后于当前五项矩阵 |

## 任务 A：收尾独立 Session（先派这一项）

**交付：一个可打包的集成提交、实际支持的 CLI/TUI 命令表、用户可操作的测试步骤。**

- [x] 从最新 master 建立独立 worktree，复核 #578/#579。#578 已合并；#579 保持独立 Draft。#577 已在主干。
- [x] 补齐 Provider 配置入口：`duya config provider` 与 TUI `/login` 走 Host 本机 Provider API，CLI 可启动/复用 Host，不再要求 Desktop；密钥由 Host 写入 secrets 文件且不回显。
- [x] 补齐工作目录与 Session 恢复：`duya tui` / `duya chat` 接受 `--workspace`；通过 `--session` 恢复时采用 Session 记录目录，显式目录不匹配则拒绝。
- [x] 复用现有 TUI Host 自动启动/附着、Session 历史恢复、工具审批、steer/排队/取消、持久 Run 终态和 transcript 路径；`npm run build:cli-dev` 已在合并后的主干上通过。
- [ ] 用户产品测试：安装后配置 Provider、首轮工具调用、TUI 交互控制、退出重开恢复及已授权插件调用。测试结果待用户反馈。
- [x] Session 间调用工具集不列入此次 CLI：#579 的 `duya_app` 工具迁移属 Bot 工具集范围，当前 PR 状态未绿，不纳入 CLI 候选。

独占路径：Session 相关的 agent-protocol、agent-runtime、host、CLI 调用及 worker bundle；先与 #578/#579 owner 对齐，避免覆盖在途修改。

**完成标志：**上述流程已实现并可构建，用户获得可运行候选与测试清单；“用户测试通过”单独记录，不由工具目录、单测数字或计划勾选代替。

## 任务 B：打包并发布 CLI（A 冻结后收尾）

**交付：自包含测试包 → 用户测试反馈修复 → CLI Release 与可用安装入口。** 打包准备可与 A 同期进行，正式版本基于同一个集成 SHA。

- [x] 复用当前构建与打包入口：`npm run build:cli-dev`、`scripts/package-cli-release.mjs`、`.github/workflows/release-cli.yml`；Linux x64 候选包已包含 Node、Host worker、prompt/assets 和运行依赖。托管 Node 缺少随附许可证时，新增 `DUYA_NODE_LICENSE` 显式输入路径。
- [ ] 按现有矩阵准备 macOS x64/arm64、Linux x64/arm64、Windows x64 包与 SHA-256；核对原生模块和入口路径，提供安装/更新方式。构建成功与用户实测结果分别记录。
- [ ] 核对最近 CLI tag 决定候选版本；同步 `packages/cli/package.json`、必要锁文件及 `docs/release-notes/cli-v<V>.md`。测试未完成时交付候选包，不能标成正式验收通过。
- [ ] 用户测试反馈收尾后，按本次 CLI 发布目标和[发布指南](../../development/release.md)集成版本 PR；`cli/v<V>` 指向版本匹配的集成提交。核验 Release、五项产物、SHA256SUMS 和安装器版本解析，记录 tag/SHA/下载链接。

独占路径：CLI 版本、release notes、安装器、打包脚本和 CLI workflow；A 的源码与 bundle 以冻结 SHA 为准。Agent 运行必要类型/架构/构建检查；产品和真机测试由用户负责，不另扩建测试项目。CI 的必需检查继续遵循仓库规则。

候选包：版本 `0.1.0`（当前无 `cli/v*` 标签）；集成 SHA 与本轮代码提交完成后回填。Linux x64 包及 SHA-256 已生成，文件路径和摘要在本节末尾补记。其余四个平台由现有 CI 矩阵产出；本轮不创建 tag/Release。Release notes、正式安装入口和用户反馈待测试通过后处理。

用户测试清单：安装并启动；配置 Provider 与首轮工具调用；`duya tui --workspace <dir>`；TUI steer/排队/审批/取消；退出后用 `duya tui --session <id>` 恢复；`duya chat --print <prompt>` 走同一 Host；已启用插件的 Skill/MCP 调用及缺失诊断；更新与版本显示。

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

Project 调度、记忆与 Desktop 协作进入独立主线 #581；个人 Bot 工具集、跨机执行和自动 PR/merge 暂缓。旧模块保留：[R1](bot-session-runtime/01-session-runtime.md) · [R2](bot-session-runtime/02-capability-context.md) · [R3](bot-session-runtime/03-bot-coordination.md) · [R4](bot-session-runtime/04-delivery-and-attach.md) · [R5](bot-session-runtime/05-resident-and-remote.md)，其中 Bot 统管 Project 的假设已由 #581 替代。

后续 Agent 在本节末尾追加：**日期/owner；发现与源码或 PR；最小行动；是否阻断本次 CLI（给具体原因）；接手任务/PR。** Bot 工具集由后续讨论决定，不在本轮预定。只有能指出本次 CLI 用户流程失败的事项才提升为 A/B 阻断项。

## 本次文档交付与接续

文档 owner：Codex root；独立 worktree：`/workspace/work/session-release-plan`；本地分支：`codex/session-cli-release-plan`；基于 #562 head `f7e760d2`，通过同一 PR 分支交付。独占本页、计划入口和 catalog。managed worktree/context 工具未提供，使用 Git linked worktree 与版本化计划对账。

PR #562 最初只交付计划与路由文档，UTF-8、173 条链接目标与 Git 可见性检查通过。当前总体优先级按 #581 执行；本轮用户明确要求完成 CLI 收尾，故 A/B 已推进到可测试候选。原设计与审计证据保留在模块文件和 Git 历史。

### CLI/TUI 收尾实现（2026-11-02）

- 分支：`codex/session-cli-closeout`，从 #562 计划分支合并最新主干 `af4aaede` 后实现；代码与计划通过同一 PR #562 交付。
- `packages/cli/src/providers.ts` 将 provider 列表/新增/默认/删除改接 Host `/v1/local/providers*`。无活动 Host 时 CLI 启动本机 Host；错误只回显状态码和安全错误码。TUI `/login` 复用同一 API。
- `duya tui`、`duya chat` 支持 `--workspace`。恢复已有 Session 时从 Host 的 Session 记录恢复原目录，并拒绝显式传入的不同目录，避免执行目录漂移。
- 构建：`npm run build:cli-dev` 通过；`npm run typecheck:all` 通过（其内置 `eval:agent:core:check` 运行了 4 个 recorder 断言，全部通过；未运行产品测试）。`git diff --check` 在生成 bundle 归位后复核。
- Host Provider 写 API 接受经过边界校验的 `extraEnv`（仅非密钥环境覆盖）；CLI 未传 `--api-key` 时省略该字段，由 Host 保留已有密钥，避免无意清空。
- 全仓类型门禁在上述 Provider 修复后再次通过；其中仓库要求的 `typecheck:all` 末尾运行 4 条 recorder 断言，全部通过。未运行产品测试，留给用户执行。
- 最终候选包：`/workspace/duya-cli-0.1.0-linux-x64.tar.gz`；SHA-256：`64ec26c11b9a75c12b157dc13e7f2ebc8b068f97df41e132a32d7d5c889ab197`。解包目录：`/workspace/duya-session-cli-candidate`。该包用于 Linux x64 用户测试，尚未发布。
- 待完成：用户产品测试并反馈；据此修复；由 CI 产出其余四个平台并在用户验收后发布。未创建 tag/Release。
