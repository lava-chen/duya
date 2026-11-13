# Pi TUI 与 Duya 当前实现对照

2026-11-10/11（Asia/Shanghai）查阅公开源码与 `pi-ui-extension` 1.20.2 文档；Duya 基线为
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
| 会话 | 项目内近期会话、搜索、切换、分支、重命名；扩展还有置顶/批量清理 | Host 会话与 CLI session 命令已有；本轮列表点击可复用，常驻近期会话侧栏复用当前项目 Host 列表，仍保留既有运行中切换保护 |
| 执行中输入 | steering 与 follow-up 区分 | CLI 队列与 Host 接口已有；不在 legacy Agent 重做 |
| 上下文 | 窗口来源、用量、估算构成、缓存/TTFT/TPS | 当前 `/context`、`/usage` 和 footer 已有来源/估算区分；侧栏显示已有用量快照并标注估算，提供详细面板入口；分项构成和 TTFT 仍未补齐 |
| 资源与 MCP | instructions / skills / extensions / MCP 只读浏览；注册不等于连接 | 当前 CLI rich panels 已有；新增 tabs/行点击，Host 仍负责事实 |
| 插件 | 扩展可设状态栏文字、工作指示器、编辑区上下 widget、header/footer、自定义交互组件、editor、theme；工具可提供 call/result renderer 或 renderer resolver | Duya 有插件资源管理、显示设置和工具专用 renderer；尚无面向插件的 TUI 组件注册合同 |
| 侧栏布局 | Pi 核心扩展提供 editor 周围 widget 和 header/footer/custom UI；更完整的右侧工作台由 `pi-ui-extension` 插件实现 | 当前 `WorkbenchSidebar` 收敛为单面板，包含两个会话入口、精简 context、三档 transcript 显示；宽度存在 Host 设置，低于 120 列自动收起 |
| 会话批量清理 | 默认取消、保护当前/置顶/其他活跃实例、确认后重读 | 不直接复制文件删除逻辑；Duya 多客户端 lease 与 Host 会话删除约束必须先核对 |
| 文本选择 | 正文不触发 disclosure；终端能力决定选择手势 | inline 原生选择；fullscreen 鼠标报告需终端 override（通常 Shift）或 `DUYA_TUI_MOUSE=off` |

## 显示模式的兼容处理

显示菜单只保留 Minimal、Default、Detailed 三档，仍由共享的四项设置向量映射。
旧 `/display compact|focus|folded|running|hidden|normal` 命令保留为对应新档位的别名；
`/display normal` 映射 Detailed。显示档位不新增独立设置键。

| 命令 | 工具 | 思考 |
| --- | --- | --- |
| `/display minimal` | 工具调用只显示紧凑标题 | 隐藏思考正文 |
| `/display standard` | 保留工具摘要，详情按需展开 | 标题保留 |
| `/display detailed` | 展开调用与结果 | 显示完整思考正文 |

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

## 侧栏实现边界

1. 布局组件分配 transcript 与 sidebar，输入 dock 仍独立；窄屏退回现有窗口。
2. sidebar 使用 Host 读取投影；会话操作仍走现有 session command/actions，避免从 UI 直接改 Data。
3. 异步读取带 session/workspace identity，切换后丢弃旧结果；使用已有 Host lease 判断活跃状态。
4. CTX 将 provider usage 与估算构成分别展示；未知记为未知，不用缺失字段填零。
5. 会话、context 与显示档位位于一个可滚动面板；资源入口由 `/plugin`、`/skills` 等既有命令打开，不塞入默认面板。
6. 分隔条需要 pointer capture、范围限制、退出取消；偏好宽度和当前可显示宽度分开保存。

侧栏已改为一个面板：顶部提供新建/全部会话两个入口，中段显示简要 context，
末段选择 Minimal / Default / Detailed；路径显示在输入框下方。分隔线只在明确命中时捕获拖动。
释放后将偏好宽度写入 `cli.tui.sidebarWidth`，缩窄终端不改写偏好；Esc/键盘、
滚轮、resize、弹层接管和退出取消未完成的拖动。F8 临时显示/隐藏；
`DUYA_TUI_SIDEBAR=0` 禁用侧栏。侧栏只在支持命令回调的 Host-backed fullscreen
启用，inline 与通用无宿主 TUI 不获得一个无法执行的工作台。

## Pi 插件的 TUI 扩展合同

以 Pi `packages/coding-agent/src/core/extensions/types.ts` 的 `ExtensionUIContext`
为核心，扩展可以向编辑区上下放字符串行或 `Component` widget、自定义 header/footer、
注册聚焦的自定义交互 UI、替换 editor、设置 theme 与 status、改变 working indicator。
`ToolDefinition.renderCall/renderResult` 和 `registerToolRenderer` 则只负责工具调用/结果
的组件呈现。它们能组合或替换明确的 UI 槽位，不代表扩展可以任意改写整个会话布局。
Pi 的 UI RPC 模式还把 widget/status/对话框请求编码成扩展 UI 消息，因此扩展运行方式
不同也能把交互请求路由到前端。

Duya 若补这类能力，建议先暴露受限的注册槽位（transcript message/tool renderer、
composer 上下 widget、status/footer、主题 token、自定义 modal），并规定生命周期清理、
命名空间、尺寸预算、错误隔离和能力权限。不要一开始开放直接操作 `TUIApp` 或屏幕坐标；
这样插件可扩展呈现，同时保留 transcript、输入和命令路由的所有权。该合同是后续设计项，
本轮没有加入可执行插件 UI API。

仍未实施会话置顶/批量清理、CTX 分项构成与 TTFT、MCP/嵌套调用来源统计、
通用 UI 插件合同。这些不是当前静态通过就能声称已经具备的能力。
