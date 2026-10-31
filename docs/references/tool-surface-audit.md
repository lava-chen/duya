# 工具面精简评估

2026-10-31：建议先把 `duya_cli` 改成 CLI skill、在 CLI 补齐检索后撤掉 `SessionSearch` 专用入口，再收敛产品 MCP。保留专用文件编辑能力；`apply_patch` 是否常驻按模型评测决定。本次是设计评估，没有删除运行时工具。

关联：[616 产品能力 MCP](../exec-plans/active/616-duya-app-mcp-layer.md)、[617 基础工具接口](../exec-plans/active/617-basic-tool-interface-v2.md)。本评估修订的是迁移建议，不宣称旧计划全部落地。

## 证据范围

- Duya：`a33bbb0542f5effeb8484a64f8ca2cf217272e87`，生产注册表及实现由 CodeGraph 返回当前源代码。
- Codex：本地只读克隆 `c7234c1174b27d9c55199fba0d546dc27d1b0415`，提交日期 2026-10-21；没有 fetch，不代表上游最新版本。
- 本机 Claude 2.1.309 样本：`api-request-shape` 保存 system 与工具 schema；一个样本有 115 个工具，其中 90 个以 `mcp__` 开头。样本标明 Claude Agent SDK，不能把这组数量当成所有 Claude Code 会话默认值。
- 本机 Codex 0.166.0-alpha.5.1 样本：`session_meta.base_instructions`、工具 namespace、custom call/output 都能读取。日志能证明接口和调用，不能证明整个执行器实现。
- 已安装 `duya --version` 为 0.1.0，`duya session search --help` 仍描述标题 substring；它不是当前检出构建产物，只用于揭示迁移必须处理版本一致性。
- 未进行模型成功率、耗时或 token 的 A/B 测量；以下收益均为待验证假设。

## 从 Codex 借鉴什么

| 已读源码（相对 Codex 根） | 事实与含义 |
| --- | --- |
| `codex-rs/core/src/tools/handlers/apply_patch_spec.rs:9` | `apply_patch` 是带 Lark grammar 的 freeform 工具；删除它不是对齐 Codex。Duya 当前是 JSON `{patch}`，两者输入形态不同。 |
| `codex-rs/core/src/tools/handlers/tool_search_spec.rs:94` | BM25 搜索 deferred 元数据，并为下一次模型请求暴露匹配工具；可借鉴按需加载，不能据此断言所有 provider 都支持相同动态接口。 |
| `codex-rs/core/src/tools/spec_plan.rs:374` | Direct/deferred/code-mode 暴露与执行注册分开处理；协议归属不等于模型可见性。 |
| `codex-rs/core/src/tools/code_mode/execute_spec.rs:5` | code mode 的入口是 freeform 代码工具。适合组合调用，但复制它需要额外执行环境、取消和权限设计，不能视为零成本包装。 |
| `codex-rs/codex-mcp/src/tool_catalog_cache.rs:33` | MCP 工具目录有进程级缓存与 revision 状态；可借鉴稳定目录和失效机制，不能只追求更少工具名。 |

## 工具去留

| 能力 | 建议 | 条件与理由 |
| --- | --- | --- |
| `read` / `write` / `edit` / `apply_patch` | 保留执行能力，评测不同模型的默认暴露组合 | 专用写工具拥有路径检查、快照和明确变更反馈。候选：支持 patch 的模型优先 patch；其他模型优先 edit。profile 按模型能力选择，不用厂商品牌硬编码。 |
| `glob` / `grep` | 暂留 | 尚无失败率或上下文成本证据支持删除。先保持独立清晰 schema，再测搜索工具合并是否减少选择错误。 |
| `bash` / `powershell` | 每个平台给出明确默认 shell，另一个按需 | 不把两种语法混为一个无约束 command 参数；保留 shell 身份、cwd、timeout、取消和后台任务 ID。 |
| `duya_cli` | 推荐由真实 CLI + skill 替代 | 当前 wrapper 重复解析 argv，未知长参数会跳过；维护两套解析逻辑容易漂移。先保证 worker 内 CLI 可定位、与 Host 兼容。 |
| `SessionSearch` | 推荐补齐 CLI 后撤掉独立工具 | 保留底层全文检索能力。返回可追溯的 session/message ID、片段、分页与 scope；不默认再调辅助模型摘要。 |
| `session` / `MessageSession` | 只读管理优先 CLI；有运行控制语义的动作保留 typed 接口直到逐项验收 | 不能只因工具名像 CLI 就删掉。跨会话发送、唤醒、取消仍须保留权限、身份、投递语义。 |
| bot、routine、connector、消息、记忆和计划等产品能力 | 同一产品领域内收敛为 `duya_app` deferred 工具 | 优先复用 616 基础设施；避免每个产品操作增加一个常驻 builtin。Browser / Computer Use 继续既有外置迁移，不重新塞回内置 server。 |
| `AskUserQuestion`、子 agent、后台任务、模式切换 | 保留结构化控制工具 | 依赖活上下文、审批 UI、取消或运行生命周期。skill 提供使用方法，不能替代这些协议。 |
| `tool_catalog` / `tool_invoke` | 保留通用 fallback，改善首次发现成本 | 不再造第三套同义入口。可试验搜索返回少量完整 schema，或 provider 支持时动态暴露直接工具。两者都须限制 schema 总量。 |

## 三个关键判断

### 1. `apply_patch` 不是第一优先级删除对象

[注册表](../../packages/host/src/worker-tools/builtin.ts) 同时 eager 注册 edit、write、apply_patch。减少同类工具同时常驻有价值，但先测模型实际选择与修复成本。

[实现](../../packages/capabilities/src/ApplyPatchTool/ApplyPatchTool.ts) 具有逐路径写权限检查、文件变更队列、修改前快照、CRLF/BOM 保留和歧义位置反馈。换成 shell 文本编辑，不能假设这些行为自动保留。

比删除更值得修的是结果契约：当前部分文件成功、部分失败时，`error` 只在全部失败时为 true（约 558–573 行）。建议显式返回 `status: success|partial|failed` 和逐文件结果，避免模型漏掉部分失败；这不表示当前多文件操作具备事务原子性。

另一个文案问题：description 同时称 unified diff 和 Codex patch，宜统一为实际支持的 Codex patch 格式。freeform 支持应在 provider adapter 层试验，不能仅修改 JSON schema 就宣称完成。

### 2. CLI 替代要补能力，不只写 SKILL.md

[duya_cli wrapper](../../packages/capabilities/src/DuyaCliTool/DuyaCliTool.ts) 的 `parseArgv` 约 294–297 行会跳过未知长参数。其结果又同时携带 stdout 和解析后的 data，存在重复上下文。真实 CLI 应成为单一解析权威。

[SessionSearch](../../packages/capabilities/src/session-search-tool.ts) 支持最近会话、same_project/other_projects/all、排除当前会话、FTS5 查询和并行摘要；[CLI search](../../packages/cli/src/commands/session.ts) 当前仅传 q/limit/offset。后者不能直接作为等价替换。

CLI skill 应只包含触发条件、帮助入口、JSON 输出、错误恢复和少量范例。命令/flag 文档由 descriptors 或 `--help` 提供，不复制整套手写命令表。由 skill 教 agent 读取原始片段并自行总结。

迁移验收包括：打包 worker 的 CLI 路径、版本协商、Host 不可用、鉴权刷新、cwd、会话/agent 来源、取消、非零退出码。保留 Host 动作权限和审计；不能把 `--yes` 当作业务授权，也不能依赖 skill 文本充当权限门。无 shell 的 profile 可保留受控 typed adapter，不能为减少工具数而强行开放任意 shell。

### 3. MCP 集合不等于万能 action 工具

[catalog](../../packages/agent-runtime/src/tools/discovery/ToolCatalogTool.ts) 已支持搜索、按 ID 读取 schema、namespace 分页；[invoke](../../packages/agent-runtime/src/tools/discovery/ToolInvokeTool.ts) 已可直接使用已知 stable ID，没必要强制每次先读 catalog。

把 20 个 eager 工具搬到同一个 MCP server、再全部 eager 暴露，仍然有 20 份定义。收益来自按需暴露与清晰领域，而不是 server 数。建议一个产品 server 下保留小而明确的 typed 操作；不要变成 `duya_app({action:any,payload:any})`，也不要把现有 MCP 再套进另一个通用 invoke。

首次使用当前可能需要 search → detail → invoke。建议试验 search 在预算内携带 top-k 完整 schema，以减少 detail 往返；保持权限过滤、live schema 验证、稳定 ID、schema revision、取消和原工具身份，不能把授权迁移到外层 wrapper。

## 落地顺序与验收

1. **基线**：按 provider/profile 记录实际 tools[]、描述/schema 字节、首工具成功率、发现往返、重复调用和上下文开销。注册条目数不能代替最终请求测量。
2. **CLI skill 与 SessionSearch 迁移**：补 CLI 查询 scope/排除当前会话/片段/分页及版本与上下文传递，执行真实打包 worker 验收；确认无需 wrapper 后从新会话暴露面移除。保留旧历史解析需要的映射，避免恢复会话出现未知工具。
3. **产品 MCP 收敛**：复用 616，不迁移已经外置的能力。Desktop/TUI/Web、普通 worker/bot worker、profile 和工具设置逐项核对；连接器改动跑 conformance L1–L9。
4. **基础编辑工具 A/B**：比较 edit 优先、patch 优先与同时暴露，覆盖多文件、CRLF、BOM、重复上下文、部分失败。测首轮成功率、修改正确性、修复往返和 token；不能只以工具数量判定胜负。
5. **发现优化**：比较现有 catalog/detail/invoke 与预算内一次返回 schema；provider 原生动态工具加载独立验收，保留通用 fallback。code mode 留待前述基线证明有组合调用瓶颈后再做。

本轮验证仅为只读源代码审计与文档检查；未证明迁移已实现、运行测试通过或模型效果改善。
