# CLI TUI — Pi 交互与工作台

状态：实施中。owner：本会话。工作树：`.claude/worktrees/cli-pi-workbench`。
分支：`codex/cli-pi-workbench`。base：`96b98221a`（最新 master，2026-11-10 同步）。
独占路径：`packages/cli/src/tui/**`、`packages/cli/src/chat.ts`；必要的命令定义只改 `packages/command-catalog`。

## 纠正与事实基线

先前 `feat/tui-workbench` / `a23405d1` / `e6b3751a` 基于 10 月 8 日
`2baa95df`，遗漏后续迁移，错误地在 legacy agent 下实现了宿主，并另建
terminal-app。旧分支保留作调查资料，**不 cherry-pick、不合入**。本轮刚加的
DuyaAgent 输入队列已撤回，补丁只留本地；新工作树从最新 master 起步。

现在的真实归属：TUI 在 `@duya/cli`，执行、会话、资源在 `@duya/host`，
存储在 `@duya/data`，公共 slash 描述在 `@duya/command-catalog`。
`@duya/agent` 只剩退役 shim，不新增实现，不把 UI 变成第二个执行器。

当前已经有：自研 renderer、retained 组件树、固定输入 dock、窗口控制器、
steering/后续队列、后台 Host、附件、undo/kill ring、模型与权限选择、
上下文 usage、工具专用渲染、显示 profile、插件与资源面板。不能照旧调研
把这些写成缺失能力。Pi 的参考是产品交互与组件合同，不是替换底层框架。

## 实施队列

- [x] 同步最新 master、核对 CLI/Host/Data/命令边界，隔离旧实现。
- [x] 读取 615、636、630 系列及当前 CLI 组件/输入/显示源码。
- [x] 组件点击基础（已实现，待终端验收）：已绘制坐标命中、释放激活、拖动/滚轮/resize 取消、弹层优先。
- [x] 直接操作（已实现，待终端验收）：窗口条目与 tabs、命令候选、授权与问题、工具/思考 disclosure、编辑器定位。
- [x] 阅读导航（已实现，待终端验收）：点击回底、正确视口坐标与选中块、原生滚动/选择兼容。
- [x] 显示策略（已实现，静态检查通过）：复用现有共享设置，支持思考和工具的独立展开默认值；不创建第二份 profile 真值。
- [x] 工作台面板（已实现，待终端验收）：基于现有 Host 投影与 UI 窗口扩展，常驻 Sess/CTX/View 使用现有投影与命令；窄屏回退现有面板，拖动调宽通过 Host 设置保存。
- [x] 全面对照 Pi：逐项记录已存在/复用/新增/宿主缺口，不再基于过时项目状态排期。
- [x] CLI bundle、CLI 类型检查与架构门禁；全仓聚合命令的类型环节分别记录。
- [ ] 新增交互的实机验收与跨平台证据。

## 验收与限制

inline 保留终端 scrollback 与原生选择；可点击历史发生在 fullscreen。
同一操作复用既有键盘业务路径。拖动不能触发菜单或折叠，resize 和窗口
切换后旧坐标失效。Hidden/显示折叠不改变工具执行、权限或上下文内容。

本轮不新增或运行测试套件（会话级指令限制）；类型、构建、源码检查与
交互实机结果必须分开写。没有运行的行为检查不得引用旧分支结果。

## 证据

| SHA / dirty | 环境 | 命令 | 结果 |
| --- | --- | --- | --- |
| `96b98221a` clean | Linux / Node 24.19 | `node scripts/build-cli-bundle.mjs` | exit 0；当前 CLI 4.49 MB，无 agent 改动 |

## 本轮实现

- `core/pointer.ts` 管理提交帧命中区域、按下/释放、拖动取消、280ms 连续点击抑制与回调重验。
- own SGR parser 区分运动和按下，保留修饰键；无修饰键事件保持原对象形状。
- 列表/窗口/tabs/候选/权限/问题复用键盘动作；异步列表刷新使旧坐标失效；背景弹层不接收点击。
- `TranscriptPane` 从实际 block plan 给出标题区域，跳过批次摘要与 Hidden 只读状态；正文不注册折叠动作。
- composer 保留换行源位置，`InputEditor.moveTo` 不修改正文、粘贴载荷或 undo。
- fullscreen 状态栏提供 `[↓ Latest]`。inline 不捕获普通历史/候选鼠标；权限临时 alternate screen 只在弹层期间捕获。
- `/display normal|focus|folded|hidden` 补齐 Pi 对应显示行为，原四个 profile 保持兼容；仍只写四项既有设置。
- [Pi 全面对照](../../references/pi-tui-workbench.md)记录已存在能力、新增和后续缺口。

## 静态证据与接续

环境 Linux / Node 24.19；base `96b98221a`，改动范围为本计划、reference、`packages/cli/src/tui/**` 与 CLI `chat.ts` 接线。

| 命令 | 结果 |
| --- | --- |
| `node scripts/build-cli-bundle.mjs` | exit 0，当前 CLI 4.51 MB |
| `npm run -w @duya/cli typecheck` | exit 0 |
| `npm run architecture:check` | exit 0，无新增违规；未写 baseline |
| `npm run typecheck:all` | 首次依赖构建停于缺失 `@types/picomatch`；独立 `/tmp/duya-cli-pi-deps` 安装 lock 中的 4.0.3，再在本检出 overlay 链接，未修改共享依赖或 lock |
| 重跑聚合门禁 | build:packages 的 22 包构建完成；protocol/client-core/core/workflow/runtime/web/electron/cli/web-app/voice 类型环节完成；在尾部 `node --test` 前停止组合命令，组合进程 exit 143，不把它报告为整体 exit 0 |
| `npm run typecheck:evals` | 单独 exit 0，既有 Electron 类型 baseline 未增加 |
| `git diff --check` | exit 0 |

没有添加或运行测试，也未进行真实终端验收。自动化类型与构建结果不证明 Windows/ConPTY、终端选择手势、权限实际提交和流式交互已经验收。
`DUYA_TUI_MOUSE=wheel` 仍打开终端鼠标报告，只禁止组件点击；要恢复终端鼠标处理用 `off`。

尚未实施：会话置顶/批量清理、CTX 分项构成与 TTFT、MCP/嵌套来源统计、通用 UI 扩展合同。
这些仍属于本任务后续，不能声称 Pi 工作台已经全部完成。

## 远程交付授权记录

首个代码提交：`ce04b8c83`（`feat(cli): add pointer interactions and transcript view modes`）。
首个切片源码已提交；随后继续本地侧栏实现，代码提交与静态证据在下节记录。依赖链接不进入提交。

尝试 `git push -u origin codex/cli-pi-workbench` 被自动审批拒绝，未执行推送。
理由：用户尚未明确授权将该具体代码发送到 `lava-chen/duya` 并创建远程分支。
已向用户说明私有代码外发风险；用户于 2026-11-11（Asia/Shanghai）明确回复
“允许推送并创建草稿 PR”。允许推送本任务分支与创建 draft PR；未用其他工具
绕过拒绝，未合并。仓库规则要求通过 PR 交付，故本地
实现和静态结果不等于已经交付/合入。

下一动作：跟进 draft PR 的 review/CI 与终端实机验收；不迁移旧 terminal-app 或 legacy Agent 代码。

## 侧栏切片（推送等待授权期间继续本地实现）

- 新增 `components/workbench-sidebar.ts`：Sess/CTX/View、各页滚动、会话切换/新建/重命名/分叉、资源快捷入口、显示 profile 与工具状态。
- HStack 将 transcript 与 sidebar 并排，composer 与 footer 继续独立；折叠和滚动使用分配后的实际 transcript 宽度。
- Sess 读取已有 completion/session 缓存，操作回到 `chat.ts` 的同一 `handleLine`，保留运行中切换保护，不提交或清空编辑器草稿。
- CTX 明确标注 context 估算，缺失读数为 unknown；Detailed context/usage 使用既有命令，不发明 provider 账单字段。
- PointerDispatcher 新增分隔线 drag capture；释放才保存 Host 设置 `cli.tui.sidebarWidth`，取消恢复拖动前偏好。
- 低于 120 列或历史空间不足 6 行时收起，不覆写宽度；F7 换页，F8 临时显示/隐藏，`DUYA_TUI_SIDEBAR=0` 禁用。
- 仅同步现有菜单/快捷键断言的数据清单，未新增用例或执行测试。
- CLI 单包类型检查与 4.52 MB bundle 构建通过；全仓静态环节按原顺序重跑，明确不执行聚合尾部 `node --test`。退出码 0；原始聚合尾部测试仍未运行。架构复核 exit 0，无新增违规。

## 远程交付结果（2026-11-11，Asia/Shanghai）

- source head：`4582c595e`；此前提交 `ce04b8c83`、`48c13d303` 均在同一任务分支。
- 在用户明确授权后，`git push -u origin codex/cli-pi-workbench` exit 0。
- draft PR：[github.com/lava-chen/duya/pull/624](https://github.com/lava-chen/duya/pull/624)，base `master`；未合并。
- 全仓静态阶段按 `typecheck:all` 的原始顺序执行并 exit 0，仅明确跳过末尾 `node --test`；未新增测试用例、未运行测试套件。
- 最后 CLI 类型检查、CLI 4.52 MB bundle、架构审计、TS 抑制指令静态检查均 exit 0；架构 baseline 未修改。
- tracked 源码和文档已保存；未跟踪项为本检出的依赖链接，未提交。保留工作树与分支等待验收和 review/CI。
- 终端实机、Windows/ConPTY、文字选择与真实权限提交仍未验收，PR 保持 draft。高级差距仍按本计划上列清单记录。

## CI 修复接续（2026-11-11，Asia/Shanghai）

- 独立 linked worktree：`.claude/worktrees/cli-pi-workbench-fix`；分支 `codex/cli-pi-workbench`，base/head `10b049af681abe6d92b71a46b0bb8aaff74fa56a`（PR #624 当前 head）。
- CI `Test` run `42857681975` 的两个失败均在 `tui-settings-panel.test.ts`：profile 选择仍按旧列表按下 3 次，switch 选择仍按旧列表按下 7 次；#624 新增三个 profile 后目标行分别下移 2 / 3 行。
- 已将导航次数更新为 5 / 10，并说明目标行偏移；断言的四键向量与 switch 写入值保持不变。
- 环境：Linux x64 / Node 24.19；在独立 worktree `npm ci` exit 0（锁文件未改）。`npx vitest run packages/cli/src/tui/__tests__/tui-settings-panel.test.ts` exit 0（14/14）；`npx vitest run packages/cli/src/tui/__tests__/` exit 0（87 files / 1147 passed / 1 expected fail / 0 failed）。
- 下一步：检查 diff 与格式、提交并推送 PR #624 的 CI 修复；再刷新 CI 状态。
