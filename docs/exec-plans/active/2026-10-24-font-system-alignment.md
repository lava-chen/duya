# 字体系统对齐 Claude Code 三栈

状态：active · 负责人：ZCode 会话（font-three-stacks） · 更新：2026-10-24
分支：codex/font-three-stacks · worktree：E:\Projects\duya\.claude\worktrees\font-three-stacks · base：f6120e04（origin/master） · owner：本会话

## 目标与边界

用户可观察变化：welcome/splash 标题 Windsor → Copernicus；消息正文由 Copernicus serif 默认改为 Styrene sans（对齐 Claude Code 聊天正文）。设置页保留并继续对齐 CC：字体预设行（Duya/System，同构 CC 的 Interface font）与字号三档（同构 CC 的 Transcript text size）都保留；只拆除 CC 没有的「消息正文 serif/sans 切换」（FontContext）。内部变化：全仓字体收敛为三条栈（sans/mono/serif），单点定义（globals.css `@theme`），CSS/TSX 一律 `var()` 消费；终端与 widget 沙箱等独立 document 用同值字面量。

允许修改：`packages/ui/src/styles/**`、`packages/ui/src/**`（组件内联字体）、`packages/capabilities/src/widget-renderer/**`、`packages/host/src/worker-widget/**`、`packages/ui/src/contexts/FontContext.tsx`、settings 类型与 hook、根 `index.html`、i18n 文案、`public/fonts/`。
本次不处理：apps/desktop 主进程离屏 UI 栈、orb 尺寸变量、messageFontSize/终端字号机制、TUI。

三栈（brand 字头 + Claude Code 栈尾，中文由雅黑兜底，与 CC 一致）：

```css
--font-sans: 'Styrene', ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "PingFang TC", "Hiragino Sans", "Microsoft YaHei", sans-serif;
--font-mono: 'Fira Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
--font-serif: 'Copernicus', ui-serif, Georgia, Cambria, "Times New Roman", "Noto Serif CJK SC", "Source Han Serif SC", "PingFang SC", serif;
```

依据：CC asar 实测（2026-10-24，`--font-anthropic-sans/serif` 与 `--font-mono` 完整值）；Windows 无 CJK 命名时雅黑兜底已用 Chrome 同栈对照验证。决策：保留品牌字头（同构 CC）；Windsor 并入 serif（凑齐恰好三种）；正文默认 sans（CC 聊天正文为 sans；duya 现默认 serif 来自无 UI 开关的 FontContext 默认值）。

## 验收

- `npx vitest run packages/ui/src/components/chat/RichTextInput.test.tsx packages/ui/src/components/chat/PluginMentionText.test.tsx packages/ui/src/stores/terminal-appearance-store.test.ts`（基线先行，改动后同条件比较）
- `npm run typecheck:all`、`npm run architecture:check` 退出码 0
- grep 断言：主 UI 源码中 `'Fira Mono'`/`'Styrene'`/`'Copernicus'`/`'Windsor'` 字面量仅存在于 @font-face、三 token 定义、CODE_FONT_FAMILY、终端与 widget 字面量、splash；`var(--font-mono,` 带非空 fallback 的引用清零；`data-font`/`data-message-font`/`FontContext`/`normalizeFont` 清零
- 视觉真验：用户 dev 重启后确认（本环境 Electron 无 Playwright）

## 进度

- [x] 基线：相关 vitest 记录（3 文件 14 用例全绿）
- [x] globals.css `@theme` 三 token；base.css 改写（body/.message-content → var，删 data-message-font 块，mono 处收口；data-font 覆盖块保留为 Interface font 消费端）
- [x] 域 CSS 收口（preview/skills/office-browser/composer-panels/bot/code-review/preview-drawer/diff-styles/settings/welcome/workspace/git-graph/workspace-lifecycle/file-workspace/orb）
- [x] TSX 收口（WorkflowGraph/WorkflowDetailView/FilePreviewPanel/code-review-code-viewer/CodeBlock/markdownComponents/FileEditToolRow/SessionToolRow/rich-text-canonical）
- [x] 拆机制：FontContext 删除与 App.tsx 两处挂载移除、types/useSettings 删 messageFont（font 字段与 AppearanceSection 预设保留）
- [x] 字面量对齐：widget-theme/widget-css-bridge/TerminalPanel；splash 标题 Copernicus
- [x] 资产：删 public/fonts/windsor/、fira-mono-v16-latin-regular.woff2
- [ ] 门禁 + 计划记录 + commit（①token/收口 ②机制拆除/资产）+ PR

## 发现与决策

- 现状四条管理线（见调查）：settings 双预设（AppearanceSection FONT_KEYS+normalizeFont）、半废弃 FontContext（useFont 零消费者、默认把正文打成 serif）、index.html boot data-font、mono 栈 6+ 种写法分散 30+ 处；`--font-mono` 主文档从未定义，全靠 fallback。
- **用户更正（2026-10-24 CUA 实测 CC 3.6556.2.0 设置界面）**：CC Settings → Appearance 含 Interface font（radio：Anthropic Sans / System / OpenDyslexic，"Font for the whole interface"）、Transcript text size（S/M/L）、Code font（自定义等宽 textfield，作用于 code+terminal）、Font licenses。据此修正方案：duya/system 双预设与字号三档保留（已同构），仅拆 FontContext serif 线；Code font 自定义输入为差距项，本次不做（范围外）。
- `'Fira Mono'` @font-face 的 src 实为 google-sans-code-v17 文件；`fira-mono-v16-*.woff2` 未被引用。保留族名不动（改名将波及 2 个测试断言，收益低）。
- `--font-ui`（SessionToolRow 引用未定义）随收口删除；`--diffs-font-family` 经验证**非死变量**——@pierre/diffs 的 Shadow DOM（node_modules/@pierre/diffs/dist/style.js）消费它，保留注入、值收敛为 `var(--font-mono)`。
- 测试断言迁移：RichTextInput/PluginMentionText 断言 `fontFamily` 含 'Fira Mono' → 改断言 `toBe(CODE_FONT_FAMILY)`（CODE_FONT_FAMILY 现为 `var(--font-mono)`；jsdom 不解析 var，断言字符串本身即契约）。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| f6120e04（base）+ 本切片全部 dirty | Windows 11 / Node v24.16.0 | `npx vitest run`（RichTextInput / PluginMentionText / terminal-appearance-store / TerminalPanel，基线先行 3 文件 14 绿） | 0，4 文件 23 用例全绿 | 本文件 |
| 同上 | 同上 | `npm run typecheck:all` | 0 | 同上 |
| 同上 | 同上 | `npm run architecture:check` | 0，无新增违规（2 条旧基线指纹失效为预存债务缩减，未动 baseline） | 同上 |
| 同上 | 同上 | grep 审计：非 token 字体栈仅剩 @font-face / 三 token / 终端与 splash 字面量 / inherit；FontContext/data-message-font/messageFont 清零 | 通过 | 会话记录 |

## 接续 / 结果

进行中：worktree 已建（f6120e04）、junction 已建。
下一步：跑基线 vitest，然后按进度清单实施。
回收：PR 集成并重验后走管理工具；ignored 文件（.vite 缓存等）不依赖快照。
