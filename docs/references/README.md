# 技术参考

外部实现与调研依据；每份记录注明来源、版本或 commit、查阅日期及适用范围。

- [Claude Projects Coordinator](claude-projects-coordinator.md)：2026-11-02 直接查阅官方与逆向原文，区分证据等级；20 个已点名工具、长期状态/记忆与 Duya 映射。

- [Codex thread / worktree](codex-thread-and-worktree-management.md)：2026-09-30 的源码调查，使用前核对版本。
- [个人智能体产品](personal-agent-products.md)：2026-10-25 四产品官方机制、未公开范围与 DUYA 源码核实入口。
- [多 Agent 协作工具能力实测](multi-agent-tool-capability.md)：2026-10-31 对 `task` 子代理派发面与跨会话协作面的 12 项实测结论，含 3 项失效的根因、复现步骤与代码锚点。
- [Codex TUI 表面与斜杠命令体系对照](codex-tui-alignment-survey.md)：2026-11-03 以 codex @ `fbf5f0d3a7` 对照 duya @ `203d7d51`；斜杠命令（codex 65 / duya 53）、TUI 表面九轴对照、22 条差距清单与 7 个候选切片。
- [多 Session Agent 协调架构](agent-coordination-models.md)：Claude Code Projects、Claude Managed Agents 与 DeepSeek 原型的公开机制，以及 Duya Bot / Session 接缝，核对至 2026-11-01。

只把任务所需的结论提升为设计或计划；原始摘录、下载资料和未核实笔记留在 `docs-local/`。
