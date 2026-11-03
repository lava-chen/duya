# UI Mock

真实组件 + 假数据，用来快速验证 UI 的**大结构**调整。

## 跑起来

```bash
npm run build:packages -- --target @duya/ui   # 首次：构建 workspace 依赖
npm run mock:ui                               # http://127.0.0.1:3001
```

打开 <http://127.0.0.1:3001/packages/ui/src/mock/index.html>。

## 它是什么

| 部分 | 来源 |
| --- | --- |
| 组件、样式、布局 | **产品本体**（`packages/ui`），一行没改 |
| 数据（会话、记录、run 事件、审批） | mock（`fixtures.ts`） |
| Host 通道 | `createMockHostBridge()` —— 假桥接层，接真实共享工厂 `createUiServices` |
| 侧栏会话列表、用户消息 | 直接写 conversation store（浏览器没有 Electron IPC） |

没有 worker、没有模型、没有数据库、没有真时钟。

## URL 参数

- `?shell=<id>` 结构变体，见下表
- `?session=<id>` 首屏打开哪个会话

## 结构变体

变体是**针对产品自身 DOM 的 CSS 覆盖**（`variants/variants.css`），不改任何组件：

| id | 效果 |
| --- | --- |
| `baseline` | 现状 |
| `schematic` | 把大结构画成色块（不看细节，只谈骨架） |
| `sidebar-top` | 侧栏移到顶部，变成横向条 |
| `panel-bottom` | 右侧面板停到对话区下方 |
| `rail-only` | 侧栏收成图标窄条 |

右下角有切换器，`F2` 也能循环切换。

**加一个新变体**：在 `variants.css` 写一条 `[data-shell-variant="<id>"]` 规则，
再到 `variants/index.ts` 的 `SHELL_VARIANTS` 里加一条。

## 两条渲染契约（改 fixture 前必读）

这两条是产品渲染层的既有行为，mock 必须照做，否则看到的界面是错的：

1. **回复正文必须排在工具调用之后。**
   `MessageItem` 只把「最后一个 tool/thinking 动作之后」的文本当作正文；
   排在工具之前的文本会被当成中间叙述折进折叠的「Worked for …」组里。
   `buildRunScript()` 的顺序因此固定为：工具调用 → 工具完成 → 正文 deltas → `message_finalized`。

2. **审批解决必须发布 `permission.resolved` 事件。**
   审批卡读的是 run 投影（`awaitingAnswer`），不是 ledger 行。
   只改 ledger 不会让卡片消失；真实 Host 是在 run 事件流上发 `permission.resolved`，
   mock 的 `publishPermissionResolution()` 做的同一件事。

## 测试

| 文件 | 覆盖 |
| --- | --- |
| `mock-host-bridge.test.ts` | bridge 的会话/run/审批行为 |
| `projection.test.ts` | 投影结果，含「正文在工具之后」的回归用例 |
| `host-chain.test.ts` | bridge → 共享工厂 → `listBySession` → `mergeRunSessionRows` 全链路 |
| `render-chain.test.ts` | 全链路再走 `projectMessageTranscript`，正文每层都存活 |

```bash
npx vitest run packages/ui/src/mock/
```

## mock 里能验证什么

- 侧栏：分组、折叠、窄条、项目/时间两种分组维度
- 主区：对话区、输入框、消息卡、工具卡
- 右侧面板：Code Review / Terminal / Preview 的停靠方式
- 状态：流式回复、工具调用、审批卡片（`mock-session-approval` 会留一张未决审批）

## 不能验证什么

- 真实数据量下的性能
- Electron 专属行为（窗口拖拽区、Mica 背景、路径选择器）
- 持久化、崩溃恢复、多端同步

这些要在桌面端看；mock 只回答"结构长什么样、点下去顺不顺"。
