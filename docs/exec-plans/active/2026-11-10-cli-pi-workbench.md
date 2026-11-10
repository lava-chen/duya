# CLI TUI — Pi 交互与工作台

状态：实施中。owner：本会话。工作树：`.claude/worktrees/cli-pi-workbench`。
分支：`codex/cli-pi-workbench`。base：`96b98221a`（最新 master，2026-11-10 同步）。
独占路径：`packages/cli/src/tui/**`；必要的命令定义只改 `packages/command-catalog`。

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
- [ ] 工作台面板：基于现有 Host 投影与 UI 窗口扩展，先审计常驻侧栏所需的数据快照；窄屏回退现有面板。
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

环境 Linux / Node 24.19；base `96b98221a`，dirty 范围仅本计划、reference 与 `packages/cli/src/tui/**`。

| 命令 | 结果 |
| --- | --- |
| `node scripts/build-cli-bundle.mjs` | exit 0，当前 CLI 4.51 MB |
| `npm run -w @duya/cli typecheck` | exit 0 |
| `npm run architecture:check` | exit 0，无新增违规；未写 baseline |
| `npm run typecheck:all` | 首次依赖构建停于缺失 `@types/picomatch`；独立 `/tmp/duya-cli-pi-deps` 安装 lock 中的 4.0.3，再在本检出 overlay 链接，未修改共享依赖或 lock |
| 重跑聚合门禁 | build:packages 的 22 包构建完成；protocol/client-core/core/workflow/runtime/web/electron/cli/web-app/voice 类型环节完成；在尾部 `node --test` 前停止组合命令，不把它报告为整体 exit 0 |
| `npm run typecheck:evals` | 单独 exit 0，既有 Electron 类型 baseline 未增加 |
| `git diff --check` | exit 0 |

没有添加或运行测试，也未进行真实终端验收。自动化类型与构建结果不证明 Windows/ConPTY、终端选择手势、权限实际提交和流式交互已经验收。
`DUYA_TUI_MOUSE=wheel` 仍打开终端鼠标报告，只禁止组件点击；要恢复终端鼠标处理用 `off`。

尚未实施：常驻 SESSIONS/CTX/VIEW 侧栏、拖动调宽与宽度持久化、会话置顶/批量清理、通用 UI 扩展合同。
这些仍属于本任务后续，不能声称 Pi 工作台已经全部完成。

下一动作：先完成本切片 draft PR 的终端验收；随后按 reference 中 Host 投影/布局合同实现侧栏，不迁移旧 terminal-app 或 legacy Agent 代码。
