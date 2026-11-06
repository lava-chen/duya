# Codex 提示词写法与上下文装配参考

查阅：2026-11-06。源码为本地 `E:/cloned-projects/codex`，remote `https://github.com/openai/codex.git`，固定 SHA `fbf5f0d3a716d08c254d3e4941d5b12eaff5afe7`（2026-11-03）；检出干净，本轮未更新或修改。以下是该版本观察，不证明 Codex Desktop 的全部私有行为。

本参考为 [Project Coordinator 提示词设计](../design-docs/project-coordinator-prompts.md) 提供依据。Claude 新版 Projects 的来源和产品分工沿用 [既有参考](claude-projects-coordinator.md)。

## 官方写作方法与本次采用范围

| 来源 | 提炼后的方法 | 本次用途 |
| --- | --- | --- |
| [OpenAI Prompt engineering](https://developers.openai.com/api/docs/guides/prompt-engineering) | 区分指令与输入角色；按身份、规则、例子和上下文组织；稳定内容前置；用评估控制迭代 | 指令正文与项目数据分离，代码管理版本，固定场景对照 |
| [OpenAI Reasoning best practices](https://developers.openai.com/api/docs/guides/reasoning-best-practices) | 用直接的目标和成功条件；明确分隔内容；先零样本；不要求输出思维链 | 少写重复命令，只为已测行为缺口加入短例子 |
| [Anthropic Effective context engineering](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents) | 用少量高信号上下文；指令在泛泛愿景与脆弱步骤脚本之间取得平衡；历史和引用按需取用 | 常驻行为准则、短项目快照、按需读取原文 |
| [Claude Prompt engineering overview](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/overview) | 先定义成功标准和可执行评估，再调整提示词 | 把装配正确性与真实模型行为分开验收 |

这些方法不直接决定 Duya 的数据库、审批或工具授权。此类约束由 Host 实现，提示词负责描述已存在的边界和选择可行下一步。

## 源码证据

下表链接均固定到上述 SHA。路径/符号来自实际检出，不沿用旧版 `core/prompt.md` 或 `core/src/codex.rs` 的目录印象。

| 关注点 | 固定源码 | 实际观察 |
| --- | --- | --- |
| 基础提示词的实际来源 | [models-manager/models.json](https://github.com/openai/codex/blob/fbf5f0d3a716d08c254d3e4941d5b12eaff5afe7/codex-rs/models-manager/models.json)、[model_instructions.rs](https://github.com/openai/codex/blob/fbf5f0d3a716d08c254d3e4941d5b12eaff5afe7/codex-rs/prompts/src/model_instructions.rs) | `render_model_instructions` 读取捕获的模型元数据 `model_messages.instructions_template`；不是简单读取某份通用 Markdown。缺失模板告警并返回空文本；显式空模板被保留 |
| 写法 | 同上 `instructions_template` | 先说明角色与共同目标，再分授权、自主推进、交流、工具、技能等标题；在条件和动作上写具体约束，使用短段落。模板含宿主约定，不能整体复制成 Duya 的产品默认值 |
| Session 初始选择 | [session/mod.rs](https://github.com/openai/codex/blob/fbf5f0d3a716d08c254d3e4941d5b12eaff5afe7/codex-rs/core/src/session/mod.rs)，基础指令选择段 | 优先 `config.base_instructions`，其次历史 `session_meta.base_instructions`，最后当前模型模板。恢复语义在代码中定义 |
| Provider 投递 | [client.rs](https://github.com/openai/codex/blob/fbf5f0d3a716d08c254d3e4941d5b12eaff5afe7/codex-rs/core/src/client.rs)，基础指令 prefix 段 | `BaseInstructionsFragment` 转成响应输入 prefix，按正文生成稳定 item id；不能把本版本描述成永远仅使用 Responses 的 `instructions` 字段 |
| 首次上下文与扩展 | [session/mod.rs](https://github.com/openai/codex/blob/fbf5f0d3a716d08c254d3e4941d5b12eaff5afe7/codex-rs/core/src/session/mod.rs)，`build_initial_context_with_world_state` | 汇集 developer 段、contextual user 段和单独消息；扩展按 thread/turn 贡献带 slot 的 fragment；部分策略独立成 developer 消息 |
| 目录指令角色 | [user_instructions.rs](https://github.com/openai/codex/blob/fbf5f0d3a716d08c254d3e4941d5b12eaff5afe7/codex-rs/core/src/context/user_instructions.rs) | `UserInstructions` 的 role 为 `user`，携带目录和内容分类，包裹在 AGENTS 指令标记中；标签本身不会把它升成 system |
| 更新与移除 | [world_state/agents_md.rs](https://github.com/openai/codex/blob/fbf5f0d3a716d08c254d3e4941d5b12eaff5afe7/codex-rs/core/src/context/world_state/agents_md.rs) | `render_diff` 比较 snapshot；相同不生成更新，变化明确替代旧指令，消失明确撤销旧指令 |
| 管理策略独立性 | [managed_developer_instructions.rs](https://github.com/openai/codex/blob/fbf5f0d3a716d08c254d3e4941d5b12eaff5afe7/codex-rs/core/src/context/world_state/managed_developer_instructions.rs) | role 为 `developer`，有独立 kind/metadata；超限拒绝而非悄悄截掉策略尾部 |
| 稳态与缺失基线 | [session/mod.rs](https://github.com/openai/codex/blob/fbf5f0d3a716d08c254d3e4941d5b12eaff5afe7/codex-rs/core/src/session/mod.rs)，`record_context_updates_and_set_reference_context_item` | 无 reference 注入完整上下文；有 reference 计算世界状态差异并更新基线；模型切换也有显式处理 |
| 压缩恢复 | [core/src/compact.rs](https://github.com/openai/codex/blob/fbf5f0d3a716d08c254d3e4941d5b12eaff5afe7/codex-rs/core/src/compact.rs)、[compact/prompt.md](https://github.com/openai/codex/blob/fbf5f0d3a716d08c254d3e4941d5b12eaff5afe7/codex-rs/prompts/templates/compact/prompt.md) | `build_compaction_replacement_history` 重建上下文及 baseline，再组合压缩历史；摘要要求保存进度、决定、约束、下一步和关键引用 |
| 模型文案与运行时事实 | [model_messages.rs](https://github.com/openai/codex/blob/fbf5f0d3a716d08c254d3e4941d5b12eaff5afe7/codex-rs/prompts/src/model_messages.rs)、[multi_agent_instructions.rs](https://github.com/openai/codex/blob/fbf5f0d3a716d08c254d3e4941d5b12eaff5afe7/codex-rs/prompts/src/multi_agent_instructions.rs) | 文案可来自 catalog 或 bundled，来源保留；并发槽、可用工具、模型覆盖等事实由消费者捕获后渲染，不由自然语言自行宣布能力 |
| 工具目录变化 | [incremental_tools.rs](https://github.com/openai/codex/blob/fbf5f0d3a716d08c254d3e4941d5b12eaff5afe7/codex-rs/prompts/src/model_messages/incremental_tools.rs) | 分别说明新增/重定义/不可用工具及 namespace 指令清除；文案与实际更新时机分离 |
| Skill 渐进披露 | [catalog_prompt.rs](https://github.com/openai/codex/blob/fbf5f0d3a716d08c254d3e4941d5b12eaff5afe7/codex-rs/ext/skills/src/catalog_prompt.rs) | 目录先给名称/描述/来源定位；选中后再读正文和必要引用。不能把“按需选资料”误解成选中的强制指令可只读一部分 |

## 迁移到 Duya 的取舍

采用：模块化文案、单一装配入口、显式来源、指令/事实分开、变更语义、压缩后重建和行为评估。

适配：Codex 的世界状态有可重放历史基线；Duya 624 的 rail 每次由 timeline 重投影，rail 本身不落 timeline。因此当前必须每次带上全部有效 rail 块，相同 hash 只影响诊断，不允许省略正文。未来想只发差异，先设计持久基线与 fork/resume/compaction 合同。

不移植：Codex 的具体 shell、审批、`functions` namespace、技能安装和 Desktop 私有工具说明；Claude 的云端双层拓扑及 `post_message` 投递要求。Duya 的 Coordinator 继续走现有 assistant 可见消息与三个管理工具，不因学习提示词而获得执行工具。

## 未证明的部分

- 未调用模型做质量/成本实验；本文不声称上述结构已改善 Duya 模型行为。
- 模型 catalog 是本地快照，不能证明在线最新模型服务使用完全相同文案。
- 标签、nonce 和自然语言来源声明只帮助模型解释内容；授权必须依赖真实消息来源和 Host 校验。
- 本轮只读第三方源码，未复制整份外部系统提示词到产品。
