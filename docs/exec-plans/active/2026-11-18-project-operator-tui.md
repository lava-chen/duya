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

## 试用反馈修复

负责人：Codex 当前会话 · 分支：`codex/project-coordinator-tool-picker` · base：`c016600d2cf32576fbc398cb97b669c6a99bbe11` · managed worktree：`project-coordinator-tool-picker/duya`。返工 PR 以用户试用的 `codex/project-operator-tui` 为基线。

- [x] 只读核对实际 Coordinator 的日志和持久会话。54 次派发均未启动子会话，51 次目录不匹配，3 次输入无效。模型在被要求提供工作目录后反复猜测路径。日志另有已注册工具降级到 SYSTEM 时的误报，以及独立 Host 未响应 Desktop 连接器描述请求的 10 秒超时。
- [x] 调整 Session 工具、Host 派发、Coordinator 提示词与运行时分类。Host 继承已绑定的工作区，默认给项目任务分配隔离 Git worktree。显式目录仍由 Host 校验。独立 Host 立即回答连接器请求。
- [x] 项目、项目操作和 Discord 设置菜单统一使用方向键、回车、Esc/q。参考本机 Hermes 的 `hermes_cli/curses_ui.py`，保留 Duya 现有文本输入和 `TERM=dumb` 下的数字选择。
- [x] 用真实 CLI bundle、Host 和 Worker 验证菜单与子会话派发，用本地确定性 Provider 验证工具参数和结果。

设计复核见[工作区归属与跨 Host 派发](../../design-docs/project-coordinator-contract.md#工作区归属与跨-host-派发)。

### 试用反馈验证

环境为 Fedora Linux x86_64、Node 26.13.0、npm 11.20.0。基线 `c016600d2`。改动验证于该基线加本计划的 CLI、Host、运行时、工具、测试与文档改动。菜单提交为 `ad055099c`。

| 命令或操作 | 退出码与证据 |
| --- | --- |
| 基线相关 Vitest | 1。基线 `project-task-worker.test.ts` 已完成派发和子 Run，PTY 阶段等候界面上不存在的 `duya tui` 文本超时。 |
| 改动后 Vitest | 0。8 个测试文件、48 个用例。真实 Worker 验证模型工具 schema、无路径参数的 Project Task 派发、不同目录的 worktree 与分支、子 Run 结果和 TUI 用户验收。Coordinator 日志确认描述符请求已应答，且没有 `project`、`session` 未知工具告警。 |
| Node CLI bundle + PTY | 0。方向键、Enter、Esc/q、Ctrl+C、项目创建、Discord 文本输入与凭据无回显，以及 `TERM=dumb` 数字回退。使用临时数据目录，中止于提交凭据前。 |
| `npm run typecheck:all`、`npm run architecture:check`、`npm run architecture:worker-module-state` | 0。 |
| `npm run build:cli-dev`、`npm run electron:build` | 0。Electron 构建通过。 |
| `npm run check:packaged-artifacts:bundle` | 1。基线提交的 bundle 和用户试用检出的 bundle 同样报 `ajv-formats/dist/formats` 及 4 处动态 `require`。问题留在原基线，PR 保持草稿等待评估。 |

用户的数据库与原试用检出用于只读诊断。验证使用独立的临时项目、Host、测试 Provider 和 PTY。真实 Discord 与用户模型尚待验收。远端 Host 调度为设计接续，当前派发限本地。

### 交付与接续

菜单 `ad055099c`，派发和 Worker bundle `bf809bbd7`。在 `bf809bbd7` 上运行 `npm run bundle:verify` 返回 0，1132 个一方输入全部匹配。已发布任务分支并创建 [Draft PR #642](https://github.com/lava-chen/duya/pull/642)，base 为试用分支 `codex/project-operator-tui`。独立 worktree 保留，未合并且没有集成授权。接下来在该检出的 CLI 复测用户模型和真实 Discord，评估基线打包检查，再按 PR 门禁集成。
