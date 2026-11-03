# R2：每 Run 能力与上下文装配

状态：backlog · 负责人：待认领 · 更新：2026-11-01
规划环境见[总入口](../2026-11-01-bot-session-coordination.md)；实施时登记 branch / base / owner / 独占路径。
前置：[R1.0 合同](01-session-runtime.md)；生产接入依赖 R1 Session 服务。边界以 [00](00-package-and-protocol-contracts.md) 为准。

## 目标与边界

同一 Runtime 可为不同任务运行不同的模型、提示、Skill、Plugin、MCP/App 工具和上下文。Bot-created Run 显式组装，TUI standalone 保留兼容默认配置；每次运行的实际来源和授权可审计。

扩展既有 StartAgentRunInput、RunManifest、ConnectorBinding、AgentProfile、provenance、fingerprint 和 RunStore，不新增 invocation manifest、Profile registry 或插件注册系统。

## 现状与 Package 改动

| 当前事实 | 本模块处理 |
| --- | --- |
| Manifest 已有 model/profile/modes/tools、permission、budget、provenance | 保持原语义；补 typed capability/context references 和来源，区分库存快照与授权 |
| requiredCapabilities 已表达不可缺的能力 | 继续用于启动前拒绝，明确可选能力的降级回执 |
| connectorBindings 当前为空，store 缺 scope | 先补最小 scoped binding 的来源，再填真实快照；不把 scope 塞回 options |
| Session row 有 model/provider/profile/permission/cwd 默认值 | TUI 使用显式 interactive baseline；Bot Run 使用项目基线 + 任务覆盖 |
| attachments 已有 typed input/reference | 继续复用，逐步迁移 mentions/display/context 中需要稳定合同的字段 |
| Host WorkerSession 直接组合 Bot prompt、memory 与全局 registry | Bot 准备长期上下文；Host 解析资源；Runtime assembly 组合已准入的内容与工具 |

主要路径为 agent-protocol/src/manifest.ts、run-api.ts；agent-runtime/src/assembly；Host manifest/Worker prompt/Skill/connector 装配；data 的 scoped binding；ai/capabilities/plugin-core 的既有适配。底层工具实现只在确有作用域缺口时修改。

## PR 切片与进度

### R2.1：字段、默认与兼容样例

- [ ] 建立 capability/context 字段清单：请求、required、解析结果、来源版本、有效权限各有明确位置。
- [ ] 为 prompt layers、Skill、Plugin/MCP/App connector 和 ContextEnvelope source refs/budget 提出最小 typed field set。
- [ ] 定义默认、显式空、继承 Project baseline 和任务覆盖的组合次序，保留旧客户端行为；任务配置不能扩大用户/Host/Project 授权。
- [ ] 提交旧 manifest v1、新字段、恢复与 canonical hash 的兼容样例；必要时设计版本 reader，不重算历史 fingerprint。
- [ ] 确认任务配置能在同一 Session 后续 Run 更新，变更有来源；当前 Run 的初始 manifest 保持不可变。

### R2.2：Host 解析与 Runtime assembly

- [ ] 复用现有 AgentProfile、Skill discovery、tool catalog、plugin trust 和 connector resolver，增加按任务选择/作用域过滤。
- [ ] Host 检查 requested ∩ installed ∩ authorized ∩ project policy，保管凭据并生成 canonical manifest。
- [ ] Runtime assembly 使用解析结果与引用解析端口组合本轮内容；不从 Host 全局 registry 再补未准入能力。
- [ ] 必需引用缺失、版本/digest 不匹配或越权时明确拒绝；可选能力降级记录具体原因。
- [ ] 为每个 Run 建立独立的可变装配上下文；共享 MCP 连接/插件池仍按 Session/Run scope 绑定与清理。

### R2.3：Bot 上下文与调用者接入

- [ ] 将 Bot 身份提示、Project 摘要、记忆检索与长期目标准备移到 Bot 服务/Host 适配，Runtime 只接受本轮 ContextEnvelope。
- [ ] Envelope 记录 source/scope/revision/digest、相关 Task、预算与截断/检索结果；附件和引用解析不越过授权 Host。
- [ ] 需要恢复的引用指向不可变内容或已保存快照；历史版本不可用时明确报告，不能改读最新内容却继续声称匹配原 digest。
- [ ] 项目 AGENTS.md、目录规则与 Session 历史按执行工作区和显式策略加载；无关 Bot/Project 私有记忆不自动共享。
- [ ] TUI interactive 默认能力作为有来源的 baseline；Bot 调用显式声明 Project/Task 配置；Attach 展示实际配置所需的查询投影。
- [ ] 能力扩张通过后续 Run 准入；已有 live permission 控制沿其授权路径记录 revision/event，不能伪称初始 manifest 已变化。

## 验收

| 场景 | 预期 |
| --- | --- |
| 两任务能力不同 | A 的 Skill/Plugin/MCP/context 不出现在 B 的模型工具与上下文中 |
| 显式空与省略 | 空集合确实禁用对应扩展；旧 TUI 省略字段得到原有兼容默认 |
| 必需/可选能力缺失 | 必需项拒绝；可选项按合同降级并显示原因，无更宽默认回退 |
| 全局 registry 后续变化 | 已接纳 Run 的冻结配置不静默漂移；后续 Run 根据新版本重新准入 |
| 未授权插件已安装 | 不能因为同机存在就进入模型工具列表或成功调用 |
| Scoped connector / shared MCP | 引用映射到正确连接作用域，凭据不进入 manifest/transcript；跨 Session 不混用上下文 |
| 上下文预算与来源 | 能解释输入来自哪个项目/任务/版本，超预算按既定策略截断或拒绝 |
| 历史恢复 | 旧 fingerprint 可验证；新 capability/context 字段加入现有 hash/provenance |

## 验证、迁移与回退

验证从 manifest factory、manifest binding、tool visibility、connector/Skill 装配和真实 Worker payload 入手，检查模型实际看到的工具与内容，不能只证明 DTO 含字段。执行相关测试与类型/架构门禁；只有新故障或新变更才重复扩大测试。

当前已有的起始回归可用以下命令；新作用域/manifest 兼容场景随实施补充：

    npx vitest run packages/agent-protocol/test/12-no-secret-in-manifest.test.ts packages/agent-protocol/test/21-payload-field-manifest.test.ts
    npx vitest run packages/host/tests/worker-product-runtime/worker-input-binding.test.ts packages/host/tests/connector-services/worker-session-binding.test.ts packages/host/tests/authorization/session-permission-profile.test.ts

逐调用者迁移。旧 API defaults 保持兼容，Bot 显式配置只在新 Task 路径启用；回退停止新派发，保留 manifest/input/refs 用于重放与审计，不改写已运行快照。

## 验证记录与接续

本模块未实施，未运行产品测试。最终表名、字段与 schema version 待 R2.1 的调用者/兼容样例确认。

下一步：在 R1.0 合同明确后提交 typed field diff 与旧/新调用示例；涉及 protocol/manifest/Host bootstrap 的共享路径由一个切片 owner 管理。
