# Project CLI 与 Coordinator 工作台

状态：active · 更新：2026-11-18
分支：`codex/project-operator-tui` · base：`8e40942b` · owner：当前会话

## 目标

CLI 菜单创建、选择项目和引导绑定 Discord。Coordinator TUI 显示项目状态与工作 Session，可只读查看子 Session。
复用现有 Host API 和终端组件。Hermes 公开文档中的平台选择、逐项输入、验证及结果反馈作为交互参考。

## 验收

用独立 Host 验证项目创建、选择、频道向导入口、项目工作台状态和子 Session 查看。真实 Discord 由用户验收。

## 结果与验证

- `duya project` 提供项目选择与创建入口。项目菜单打开 Coordinator 或启动 Discord 向导。脚本入口保留。Hermes 参考为 [Discord 公开设置流程](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/discord)。
- Coordinator 侧栏按项目列出任务和工作 Session。任意宽度可通过 `/status` 和 `/sessions` 打开概况或只读检查。最近或执行中的 24 个工作 Session 优先读取 Run，未读取的较旧记录标为 Unknown。
- CLI 类型检查、CLI bundle、架构与 Worker bundle 校验通过。真实 Host 的 PTY 演练验证了创建并打开项目、查看概况和查看关联的只读工作 Session。Discord 向导的 PTY 演练使用本地替身 Host 验证链接解析、允许成员、凭据无回显和绑定请求。
- 需在常驻 `duya serve` 上连接真实 Discord。真实连接及终端观感等待用户试用。分支本地保存。
