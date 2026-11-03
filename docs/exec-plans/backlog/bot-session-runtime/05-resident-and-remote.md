# R5：后台常驻与多机 Session 执行

状态：backlog / 后续阶段 · 负责人：待认领 · 更新：2026-11-01
规划环境见[总入口](../2026-11-01-bot-session-coordination.md)；实施时登记 branch / base / owner / 独占路径。
前置：R1–R4 的本机 G1–G5 已完成。部署包、发布和多机验收独立记录。

## 目标与边界

Desktop 是可关闭的 Bot 客户端。Bot 的长期工作由本机或云端 Host 中的 Bot 服务持有；该服务通过相同协议调用不同机器的 Session Runtime。一个 Bot 可使用多台 Host，一台 Host 可在授权范围内执行多个 Bot 的任务。

先将 UI 与服务生命周期解耦，再增加远程适配。单写者 Bot 权威、Session 执行 owner 和本地 workspace ownership 保持明确；首版不迁移活动 Session、不做多主协调或透明故障转移。

## Package 与部署边界

| 位置 | 工作 |
| --- | --- |
| host | 后台启动/停止、数据根锁、连接认证、服务进程、远程 Session API 适配 |
| agent-protocol | host/endpoint 身份、版本与 feature negotiation、远程执行/事件恢复 DTO |
| agent-runtime | 复用本地 Session 服务与输入/Run 语义；通过原端口连接执行环境 |
| bot + host/bot | 单写者 Bot 状态、调度与远端 claim/receipt 对账 |
| data | 设备绑定/撤销、endpoint 与持久游标/receipt；编号按实际 schema 分配 |
| desktop/ui/client-core | 连接 Bot、节点状态、离线/未知态、任务 Attach 的远端适配 |
| cli / release scripts | standalone 本地执行仍可用；需要时增加 headless Bot 部署入口与兼容验证 |

## PR 切片与进度

### R5.1：后台服务生命周期

- [ ] 对照现有 clientScoped Host、client lease、数据根锁和 Desktop Worker ownership，明确关闭窗口与退出服务的不同操作。
- [ ] 已接纳的 durable Bot 工作保持运行或持久等待；不因最后一个 UI 离开销毁 scheduler/Worker。
- [ ] 本地 standalone TUI 与 Bot 服务共享/连接同一受管理 Host，避免重复打开同一数据根和创建第二个 execution owner。
- [ ] 定义启动、单实例、优雅关闭、升级与崩溃恢复；升级前 drain/fence，在途未知事实通过 receipt 对账。

### R5.2：设备身份与远程 Session API

- [ ] endpoint 显式关联 hostId、可用协议/features、能力目录、机器本地 repository/cwd，client 用 host/session 组合定位目标。
- [ ] 一次性短时配对换发可撤销设备身份；使用经过认证的加密连接。网络可达性可先借助 Tailscale/WireGuard，应用授权仍独立验证。
- [ ] 远程 adapter 映射既有 Session/Run/input/Attach 合同，能力请求在执行 Host 再验证；source scopes 与凭据留在正确 Host。
- [ ] 定义 heartbeat、execution fence、durable event cursor、输入/Run 幂等、断线重连和协议不兼容返回。
- [ ] Bot 保持 Project/Task 权威，执行 Host 保持 Session/transcript/workspace 权威；不同连接视图不能复制出新 Bot 身份。

### R5.3：多机与发布评估

- [ ] 一台 Bot 服务连接两台 Session Host，在不同目录运行任务并汇报到同一 Project Activity。
- [ ] 远端断连/重启/凭据撤销时保留 running/unknown/rejected 的真实区别；不因断线立即重派有副作用的任务。
- [ ] 用户可 Attach 到正确远端 Session；权限、输入租约与事件游标恢复不依赖 Desktop 进程。
- [ ] 在服务合同和升级兼容验证后，再决定是否新增 duya-bot 部署入口/bot/v*；Desktop/CLI 既有 release 继续独立。
- [ ] 发布提案列出 OS、安装/升级/回滚、协议兼容窗口、数据备份与恢复证据；未授权时停在可审查 PR。

## 验收

| 场景 | 预期 |
| --- | --- |
| 关闭 Desktop | Bot 继续运行或持久等待，重新打开可看到同一任务/Session/Run |
| TUI 与常驻服务同机 | 连接正确 Host，单一数据/Worker owner，standalone 能力可用 |
| 重启 Bot 服务 | botId/Project/Task 保留，claim/Run/Outbox 对账，不重复派发 |
| 两台执行 Host | 不同目录/Session 的事件回到同一 Bot；配置与权限分别校验 |
| 网络断开后重连 | 从游标恢复事件/输入回执，不双执行，不把 unknown 写成成功 |
| 撤销设备或版本不兼容 | 新请求明确拒绝，在途结果按 fence/receipt 处理 |
| 活动 Session 被请求换机 | 明确不支持或要求单独转移流程，不仅复制 sessionId |

## 迁移与回退

先启用本机常驻模式，验证单实例后再接远程 endpoint。可撤销远程新调度并保留本地可用入口；撤销前后对账在途 Run。数据格式 additive，UI 关闭策略变更须覆盖既有 CLI client lease 回归。

本机现有租约回归起点：

    npx vitest run packages/host/tests/client-lease.test.ts

两机断连、重启、撤销与升级验收在 R5.2 冻结真实环境与操作脚本，记录两端 SHA、OS、协议/features 和结果；上述本机用例不代表远程场景已覆盖。

## 验证记录与接续

本模块未实施，未运行产品测试或发布任务。本机交付不等待本模块。

下一步：G1–G5 通过后核对进程/锁/租约调用闭包，先交 R5.1，再冻结 remote feature negotiation 和最小两机测试环境。
