# 插件 App 主题通道：宿主把 data-theme 推给 iframe

状态：active · 负责人：mavis 会话 · 更新：2026-10-27
分支：codex/canvas-theme-channel · worktree：`.claude/worktrees/canvas-theme-channel` · base：`d80ca3c6` · owner：mavis

## 目标与边界

插件 App 跑在**不透明源沙箱 iframe** 里（`packages/ui/src/components/plugin-apps/PluginAppHost.tsx`：
`sandbox="allow-scripts allow-forms allow-downloads allow-popups"`，无 `allow-same-origin`），
父 renderer 的 `:root` 变量与 `html[data-theme]` 都进不去。宿主与 App 之间的消息通道原本只有
`bind` / `invoke` / `revoke` 请求和 `select` / `highlight` / `refresh` 事件，**没有主题通道**，
所以自带 token 层的插件无法知道 duya 当前用的是浅色还是深色。

本次在宿主→App 方向补一条 `type: "theme"` 消息：宿主读自己的 `data-theme`（渲染真值），
在 iframe 载入后推送一次，并在 duya 切换主题时再推。

允许修改：`packages/ui/src/components/plugin-apps/PluginAppHost.tsx`、
`packages/ui/src/lib/plugin-app-ipc.ts`、同目录测试、本计划与计划入口。

本次不处理：插件侧 token 层（在 marketplace 仓库 `plugins/conductor-canvas` 单独 PR）、
App 内部如何消费主题（插件自己的事）、`system` 主题的解析（duya 侧已解析成 light/dark）。

关联：marketplace PR（插件侧 token 层 + 主题订阅）先于本 PR 生效；本 PR 只加协议与推送，
插件未订阅时不影响现有行为。

## 验收

- `npx vitest run packages/ui/src/components/plugin-apps/MiniAppsView.test.tsx`：新增用例断言
  宿主把当前主题推给 iframe，且 duya 切换主题后再次推送；既有事件中继用例不回归。
- `npm run typecheck:all` 与 `npm run architecture:check` 通过。
- 协议文档与类型定义同步（`plugin-app-ipc.ts` 的头注释与 `PluginAppHostThemeMessage`）。
- 真机：duya 切浅色/深色时，插件 App 的 `document.documentElement[data-theme]` 跟随变化。

## 进度

- [x] 协议：定义宿主→App 的 `theme` 消息（channel / type / documentToken / theme）。
- [x] 宿主：读 `data-theme` 并在 iframe 载入后推送，主题变化时经 MutationObserver 再推。
- [x] 测试：新增主题推送用例；既有事件用例改为只统计 `type: "event"` 的消息。
- [x] 门禁：UI 包类型检查、插件 App 测试、`architecture:check`。
- [ ] 全量 `typecheck:all` 与真机 Electron 验收。
- [ ] commit 与 PR。

## 发现与决策

- 宿主与 App 处在同一份文档树里，宿主直接读 `document.documentElement[data-theme]` 即可，
  **不需要任何 IPC**：主题真值在 renderer（settings DB → 启动脚本 → `data-theme`）。
- 推送时机要两次：React effect（iframe 挂载后）与 iframe `onLoad`。App 的 `data-theme`
  监听器在模块脚本里安装，而 module script 先于 `load` 事件执行，所以 `onLoad` 那次推送
  一定被听到。
- 宿主原有事件消息用 `type: "event"`，新消息用 `type: "theme"`，插件 App 的请求/响应过滤
  (`data.id !== id`) 不会误吞主题消息。
- 既有测试对 `guest.postMessage` 的调用次数有断言，新增推送会让它变红；改法是按
  `type === "event"` 过滤，而不是放宽断言。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `d80ca3c6` + 未提交 | Windows 11 / Node 24 | `node node_modules/vitest/vitest.mjs run packages/ui/src/components/plugin-apps/MiniAppsView.test.tsx` | 0 / 9 passed | 新增主题推送用例 + 8 条既有用例 |
| `d80ca3c6` + 未提交 | 同上 | `node node_modules/typescript/bin/tsc -p packages/ui/tsconfig.json --noEmit` | 0 / 通过 | 无新增类型错误 |
| `d80ca3c6` + 未提交 | 同上 | `npm run architecture:check` | 0 / 通过 | `OK — no new boundary violations`（3 条基线指纹不再触发，未重录） |

## 接续 / 结果

已实现：协议类型与文档、宿主主题推送（载入后 + 变化时）、测试。
已验证：UI 包类型检查、插件 App 测试 9/9、架构门禁。
已合并：未合并。

回收：PR 合并并复核后再按 `scripts/remove-worktree.sh` 回收。
下一步：跑完 `npm run typecheck:all`，随后开 PR 到 master；真机 Electron 验收需在插件侧
PR 合并后、安装新版插件再做。
