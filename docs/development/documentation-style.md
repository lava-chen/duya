# 规则与计划的写法

一条规则回答“何时、做什么”，再链接到必要细节。每段只保留会影响下一步操作的信息。

## 按加载范围放内容

- 根 `AGENTS.md`：跨任务必须遵守的动作，以及“做什么之前读哪篇”的触发条件。
- 子树 `AGENTS.md`：局部边界与例外；根会话不能假定所有子目录规则均已自动加载。
- development 专题：按触发条件读取的步骤、排障和验收方法。普通 Markdown 链接不等于内容已加载。
- 任务计划：当前范围、进度、证据和接续点；不写入常驻规则。

根规则建议约 100 行；篇幅预算不能成为省略关键约束的理由。避免同时自动导入全部专题抵消分层收益。
根规则给出约束后，专题解释如何执行，不再复制一份相同清单。文档修改也必须独立 worktree、验证与 PR 交付。

## 精简示例

| 冗余或模糊 | 可执行写法 |
| --- | --- |
| 开发时一定要小心验证 | UI 改动用 Playwright MCP 运行受影响流程 |
| 下次继续完善 worktree | 下一步：复现 dirty worktree 回收，记录退出码 |
| 允许和上次相同数量的失败 | 按同一环境比较文件、用例和错误签名 |

## 官方依据

- [Claude Code 最佳实践](https://code.claude.com/docs/en/best-practices#write-an-effective-claudemd)：常驻说明简洁、具体，按需内容移出。
- [Claude Code 加载说明](https://code.claude.com/docs/en/memory)：作用域与显式导入决定读取范围；导入内容仍占上下文。
- [Codex AGENTS 指南](https://developers.openai.com/codex/guides/agents-md/)：按项目根到工作目录构建规则链。
- [OpenAI ExecPlan](https://developers.openai.com/cookbook/articles/codex_exec_plans)：用持续更新的验收、决策和进度支持新会话接续。

这是本仓库的分工选择；规则文档不能替代锁、CI 或恢复机制。
