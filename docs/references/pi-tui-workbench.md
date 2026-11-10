# Pi TUI 与 Duya 当前实现对照

2026-11-10 查阅公开源码与 `pi-ui-extension` 1.20.2 文档；Duya 基线为
`96b98221a`。本文给出组件职责和产品差距；实现与验收进度见
[执行计划](../exec-plans/active/2026-11-10-cli-pi-workbench.md)。

## 来源

- [Pi chat-viewport.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/interactive/chat-viewport.ts)：查阅时文件 blob 为 `eff762a046893d0d885d8bb03c9c05bdbc0cf444`。
- [pi-ui-extension README](https://github.com/1993yihuan/pi-ui-extension/blob/main/README.md)：查阅时最新说明为 1.20.2；要求 Pi >= 1.5.0、Node >= 22.19.0、fullscreen。
- Duya 当前入口：[chat.ts](../../packages/cli/src/chat.ts)、[TUIApp.ts](../../packages/cli/src/tui/TUIApp.ts)。

Pi 核心与 UI extension 是两个层次。固定输入区属于核心，右侧 SESSIONS / CTX /
VIEW、资源快捷入口和显示策略属于扩展。不能把扩展特性都归因于底层渲染器。
Claude Code 的公开交互可以作为产品参考；未公开内核的实现细节不作为本设计前提。

## 输入区为什么不随历史移动

Pi `createChatViewport` 用一个 `ScrollView(document, { follow: 'end' })`
承载历史，再与独立的输入 dock 一起放进 `VStack`。历史占剩余高度，dock
按内容占高：滚动修改历史的绝对偏移，输入不属于被滚动的文档。

Duya 当前已实现相同职责划分：`TranscriptPane` / `visibleWindow` 管历史，
`paintInput` / composer layout 管输入；inline 将稳定历史交还终端 scrollback。
本轮补 fullscreen 的点击回底，不重做这套布局。全文全屏滚动和原生 scrollback
是两种呈现方式，不能靠同时捕获滚轮来混用。

## 全面对照

| 领域 | Pi / 扩展的做法 | 当前 Duya 归属与处理 |
| --- | --- | --- |
| 组件与绘制 | ScrollView、VStack、独立 dock、增量绘制 | `core/component`、`screen/own`、`TranscriptPane` 已有；沿用 |
| 流式状态 | 流式内容、运行/完成/错误更新同一组件 | blocks、DeltaBuffer、Pacer、组件 revision 已有；沿用 |
| 滚动与跟随 | 历史绝对偏移与 follow 状态独立；回底恢复跟随 | `visibleWindow` 已有；新增状态栏 `[↓ Latest]` 点击 |
| 鼠标 | 标题 disclosure、选项、弹窗；正文拖动不折叠 | 新增提交帧命中区域、释放激活、拖动/连续点击取消、弹层优先 |
| 编辑器 | 固定输入、多行、粘贴、候选、撤销、外部编辑 | 当前已有大部分；新增源位置映射和点击定位，不重写草稿 |
| 工具呈现 | 每调用摘要、错误/运行状态、单块展开，支持专用工具 renderer | `tool-render` / transcript 专用呈现已有；新增标题点击，保留批次摘要与调用标题区别 |
| 思考呈现 | Focus 默认展开；Compact 标题折叠；Hidden 只读状态与耗时 | 新增 Focus、Compact thoughts、Hidden；复用四项设置与每块 override |
| 权限和问题 | 模态优先、选项点击、无回答二次确认 | 当前 overlay 状态机已有；新增点击入口，沿用提交和破坏性授权二次确认 |
| 会话 | 项目内近期会话、搜索、切换、分支、重命名；扩展还有置顶/批量清理 | Host 会话与 CLI session 命令已有；本轮列表点击可复用，常驻近期会话侧栏待实现 |
| 执行中输入 | steering 与 follow-up 区分 | CLI 队列与 Host 接口已有；不在 legacy Agent 重做 |
| 上下文 | 窗口来源、用量、估算构成、缓存/TTFT/TPS | 当前 `/context`、`/usage` 和 footer 已有来源/估算区分；常驻分项 CTX 与采样策略待实现 |
| 资源与 MCP | instructions / skills / extensions / MCP 只读浏览；注册不等于连接 | 当前 CLI rich panels 已有；新增 tabs/行点击，Host 仍负责事实 |
| 插件 | 渲染、widget、editor、footer 等扩展接口 | 当前插件资源管理已有；通用 TUI UI 扩展合同尚需独立设计，不能等同于插件列表 |
| 侧栏布局 | fullscreen 常驻、约 22% 宽度、18–72 列；保存偏好宽度，窄屏只限显示值 | 待实现；需纳入组件布局及 pointer capture，不能在 `TUIApp` 中硬拼终端坐标 |
| 会话批量清理 | 默认取消、保护当前/置顶/其他活跃实例、确认后重读 | 不直接复制文件删除逻辑；Duya 多客户端 lease 与 Host 会话删除约束必须先核对 |
| 文本选择 | 正文不触发 disclosure；终端能力决定选择手势 | inline 原生选择；fullscreen 鼠标报告需终端 override（通常 Shift）或 `DUYA_TUI_MOUSE=off` |

## 显示模式的兼容处理

已有 Detailed / Standard / Compact / Live only 保留原设置向量。
Pi Normal 可用 `/display normal`，映射 Detailed。新增：

| 命令 | 工具 | 思考 |
| --- | --- | --- |
| `/display focus` | 紧凑摘要，单块可展开 | 默认展开，标题可折叠 |
| `/display folded` | 紧凑摘要，单块可展开 | 只留可展开标题 |
| `/display hidden` | 不绘制工具调用 | 只读状态和已测得耗时，不绘制正文 |

`folded` 的菜单名为 Compact thoughts，以免改变既有 Compact 隐藏思考的偏好。
模式仍由 `showThinking / expandBlocks / showToolResults / toolGroupMode` 推导，
不新增 `displayProfile` 存储项。显示变化不改推理预算、模型上下文或工具执行。

## 交互合同

组件报告实际绘制的局部命中区域；屏幕布局转换为全局坐标，输入分发器只接收
已提交帧。窗口行点击走原 `return` 路径，思考和工具共用键盘折叠动作。
弹层开启时不注册背景目标。键盘、粘贴、滚动、resize、退出取消待激活手势；
延迟回调重验目标 identity/revision，异步行更新不得激活旧内容。

本轮不实现终端原生文字选择。鼠标报告会占用按钮事件，忽略点击并不意味着
终端会自行恢复拖选。保留 inline 默认；fullscreen 支持终端 Shift override，
并提供 `DUYA_TUI_MOUSE=off|wheel|all`。`wheel` 仍启用终端鼠标报告，只关闭
组件点击，不声称恢复原生拖选。

fullscreen 可使用 `DUYA_TUI_INLINE=0 duya tui`；也可在现有 `/settings`
选择显示方式后重新启动。默认 inline 的历史与候选不捕获鼠标；权限进入临时
alternate screen 时启用点击，关闭时恢复原生鼠标行为。

## 后续侧栏的实现边界

1. 布局组件分配 transcript 与 sidebar，输入 dock 仍独立；窄屏退回现有窗口。
2. sidebar 使用 Host 读取投影；会话操作仍走现有 session command/actions，避免从 UI 直接改 Data。
3. 异步读取带 session/workspace identity，切换后丢弃旧结果；使用已有 Host lease 判断活跃状态。
4. CTX 将 provider usage 与估算构成分别展示；未知记为未知，不用缺失字段填零。
5. VIEW 调用同一显示设置操作，资源入口打开同一 rich panel。
6. 分隔条需要 pointer capture、范围限制、退出取消；偏好宽度和当前可显示宽度分开保存。

以上侧栏和扩展合同仍是待实施项；当前鼠标与显示改动不构成全部 Pi 功能完成。
