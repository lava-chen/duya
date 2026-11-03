# MiniApp UI Contributions — 绑定身份、保活、placement 协议与生命周期

- 状态：active
- 分支：`codex/miniapp-ui-contrib`
- 基线：`master` @ `4f0738ba`

## 1. 问题陈述

MiniApp（Plugin App）的运行机制（iframe 沙箱、document token、launch nonce、capability grant、
Instance Store）已经完整，缺的是**宿主契约**：

1. **绑定身份是环境推导，不是捕获。** `PluginUiSurfacePanel` 直接读全局
   `activeThreadId` 当 `chatSessionId`，而 system tab params 里没有任何 session 身份。
   于是同一个 App 在「停靠」和「脱窗」两种形态下绑定不同来源：停靠跟随当前选择，
   脱窗走 localStorage 水合的 `activeThreadId`。主窗切会话后返回，App 会静默改绑到另一个
   会话，工具授权随之改绑。
2. **面板收起即销毁。** `PanelZone` 对 `plugin-app` 额外加了 `panelOpen` 条件，
   收起面板会卸载 iframe → host session 关闭 → 下次打开重新读 MCP resource、
   重新铸 nonce 与 document token。App 的持久 state 保留，界面状态丢失。
3. **每次打开都完整冷启动。** `handleOpen` 每次都走 agent server → worker 读取
   surface HTML（失败再降级 standalone client），即使内容没变。
4. **没有位置声明协议。** 插件只能把 App 塞进固定的 `plugin-app` 页；
   想出现在侧栏、只能靠 `PAGE_REGISTRY` 的闭集。
5. **生命周期只有"开心路径"。** host session 无回收（renderer 崩溃即泄漏）、
   `close` 立刻 revoke 文档 URL（脱窗窗口还在加载就是 404）、
   插件禁用/重装对已保活实例的清理依赖 renderer 活着、隐藏与关闭没有区分。

## 2. 非目标

- **不做运行时造 UI**（模型写插件并即时上屏）。它与 opaque-origin iframe + document
  token + nonce 的整套信任模型互斥，要做得先换信任模型。
- **不做跨会话保活**。iframe 不能移动 DOM，一移就重载；真做需要持久层 + 矩形同步，
  复杂度远超收益。
- **不动 `#584` Project Workspace**。它 base 是 `codex/coordinator-seam` 的 Draft 栈，
  placement 落地后由它读目录投影，不在本计划里改它。

## 3. 切片

### S0 — 关窗语义：首次隐藏确认 + 退出前运行态检查

落点：`core/window-state.ts`、`core/window-manager.ts`、`core/quit-guard.ts`、`index.ts`

- `window-state.json` 增加 `hideNoticeAcknowledged`；`saveWindowState` 改为与已有文件合并写入，
  避免每次保存 bounds 时抹掉标记。
- 首次点关闭：模态框说明「窗口会隐藏到后台，任务继续运行」，按钮 `Hide to tray` / `Quit`，
  勾选 `Don't ask again` 后不再提示。选择 `Quit` 直接走正常退出流程。
- 退出前检查：有 streaming 会话时弹确认，`Quit anyway` / `Cancel`；2 秒超时按「有任务」处理。

验收：无标记时首次关窗弹框且选择生效；标记后不再弹；有 streaming 会话时退出被拦。

### S1 — 绑定捕获（P0）

落点：`plugin-apps/open-plugin-app.ts`（新）、`PluginUiSurfacePanel.tsx`、
`PluginAppLauncher.tsx`、`MiniAppsView.tsx`、`PanelMoreMenu.tsx`

- tab params 增加 `binding: { sessionId }`，由**打开动作发生那一刻**的上下文写入。
  三个打开点收敛到一个 helper，避免再次漂移。
- 面板只读 `tab.params.binding.sessionId`；仅当 params 里没有 binding（旧持久化 tab）时，
  才回退到全局 `activeThreadId`，保持旧行为不破。
- `dedupKey` 把 binding 纳入 tab 身份：绑定不同会话的同一个 App 是两个 tab，
  否则在 B 会话点开 App 会聚焦 A 会话的 tab 并静默作用在错的会话上。
- 脱窗快照直接沿用 params，因此绑定随窗口走。

验收：脱窗 → 主窗切会话 → 返回主窗口，App 仍绑原会话（`chatSessionId` 不变、不重新 open）。

### S3 — surface 文档缓存

落点：`plugins/plugin-app-host.ts`、`plugins/plugin-app-surface-cache.ts`（新）

- 以 `pluginId / appId / surfaceId / server / resourceUri` 为键缓存已通过校验的 surface HTML，
  总字节上限 + LRU 淘汰（单份上限就是 `PLUGIN_UI_RESOURCE_MAX_BYTES`）。
- 条目带 TTL（60s）：插件变更按 pluginId 失效，但插件的 MCP server 自身重启后也可能换文档，
  没有保质期会把第一次读到的 HTML 钉死在整个进程生命周期里。
- `invalidatePluginAppSessions(pluginId)` 同时清该插件的缓存条目；插件重装即失效。
- 命中缓存时跳过 agent server → worker 读取路径，其余（instance / session / token）不变。

验收：二次打开不再发起 worker 读取；插件变更后重新读取；超过 TTL 后重新读取。

### S2 — 面板收起保活

落点：`layout/PanelZone.tsx`

- 去掉 `plugin-app` 的 `panelOpen` 卸载条件：面板收起时继续挂载，只是不可见
  （`.panel-zone-closed` 是 `opacity:0` + 零宽容器，iframe 仍在原宽度布局，不会因为收起而回流）。
- 保留 `hidden`（别的 pane 最大化）卸载：那是"让位"而不是"收起"。
- 暖实例预算：最多 3 个 plugin-app pane 在**收起态**保持挂载，按最近激活排序。
  面板展开时一律挂载——预算只决定谁能在收起后活下来，不能让可见的第 4 个 pane 空白。

验收：收起面板再展开不重新加载；同时开 4 个 App 时最久未激活的那个回到冷启动。

### S4 — placement 声明协议

落点：`plugin-core/src/apps/declarations.ts`、`plugins/plugin-ui-surface-directory.ts`、
`ipc/plugin-handlers.ts`、`plugin-apps/useMiniAppPlacements.ts`（新）、
`layout/app-sidebar.tsx`、`layout/panels/PanelMoreMenu.tsx`

- `PluginAppDefinition.ui` 增加 `placements: [{ slot, scope }]`；
  slot 闭集先给 `sidebar.item` / `session.panel`，scope 给 `session | global`，cardinality 一律 list。
- `ui.surfaces` 由必填改为「与 placements 至少一个」；placement-only App 合法
  （`requiredCapabilities: []` 本来就允许无工具权限的 UI App）。
- `project.tab` **暂不入闭集**：渲染侧还没有宿主，接受一个不会生效的值比拒绝更糟。
- 目录投影新增 `placements`（含 pluginId / pluginName / appId / title / icon / availability）。
- 侧栏 rail 渲染 `sidebar.item`；面板 more menu 渲染 `session.panel`。
- 点击仍然 `openOrActivatePage("plugin-app", …)`，即仍是 iframe，不把第三方组件放进 React 树。

验收：装一个只声明 `sidebar.item` 的插件，入口出现在侧栏，点开是沙箱 iframe；
未知 slot 在安装期被 schema 拒绝。

### S5 — 生命周期契约

落点：`plugins/plugin-app-host.ts`、`plugins/plugin-app-sessions.ts`

- session 记录 `webContentsId`；定期清扫「webContents 已销毁」的会话（renderer 崩溃回收），
  另加硬上限。
- 会话移除用 `take()` 一次取出「会话 + binding」：`close()` 先删 binding 再让调用方去读，
  会让 invocation revoke 静默跳过。
- `close` 立即移除会话，但 document URL 延迟 revoke（宽限期），避免脱窗窗口在加载中被 404。
- 插件变更时先关会话再清缓存，保活的暖实例同样收到 `plugin-app:changed`。
- 明确"隐藏"与"关闭"：隐藏不清会话（S2），关闭清会话。

验收：每条一个用例，不需要 UI。

## 4. 顺序与理由

`S0 → S1 → S3 → S2 → S4 → S5`

- S0 / S1 / S3 互不依赖且各自可测，先做不碰布局模型。
- S2 改 `PanelZone` 的渲染契约，放在缓存之后做，否则保活会放大冷启动成本。
- S4 是协议改动（`.strict()` 会拒绝未知字段，属于强制协同），等 S1 把 binding 形状定下来再做，
  否则 placement 的 `scope` 会和 binding 语义打架。

## 5. Gate

```bash
npm run typecheck:all
node node_modules/vitest/vitest.mjs run packages/plugin-core packages/ui apps/desktop
```

基线：`typecheck:all` 在沙箱内需 `env -u CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR CODEBUDDY_SAFE_DELETE_ENABLED=0`
（safe-delete shim 在 `clean` 阶段会 ETIMEDOUT）。

## 6. 进展与验证记录

已实现并提交（分支 `codex/miniapp-ui-contrib`，base `4f0738ba`）：

| 切片 | 提交 | 状态 |
| --- | --- | --- |
| S0 | `feat(desktop): explain close-to-hide once and guard quitting with running work` | 已实现，单元测试通过；未真机验证 |
| S1 | `fix(ui): bind a mini app tab to the chat it was opened in` | 已实现，单元测试通过；脱窗链路待真机 |
| S2 | `feat(ui): keep mini app frames warm while the panel is collapsed` | 已实现，PanelZone 用例覆盖收起保活与预算；未真机验证 |
| S3 | 与 S5 同提交 | 已实现，缓存/TTL 用例通过 |
| S4 | `feat(plugin-core): let apps declare where the host should place them` | 已实现，schema 与目录投影用例通过；侧栏渲染未真机验证 |
| S5 | `feat(desktop): cache surface documents and reap plugin app sessions` | 已实现，会话回收/驱逐用例通过 |

验证命令与结果：

- `tsc --noEmit`（根，覆盖 `packages/ui`）：通过。
- `node scripts/typecheck-electron-gate.mjs`：`OK — no new type errors`（178 known）。
- `npm run architecture:check`：`OK — no new boundary violations`。
- `node node_modules/vitest/vitest.mjs run packages/ui/src/components/layout packages/ui/src/components/plugin-apps packages/plugin-core/tests apps/desktop/src/main/{plugins,core,ipc}`：
  1571 passed / 1 failed，失败为 `PanelMoreMenu > lists the mini apps in a second level` 在并行负载下
  超出 30s 超时；该文件单独跑 7/7 通过。基线观察：该文件每个用例本就 15s 左右（摘掉本次改动同样如此），
  属于既有慢用例在满载下的抖动，不是本次回归。

未做：

- `npm run typecheck:all` 的完整链路（`check:test-coverage` 等前置）未全跑；分项 `tsc` + electron 门禁已过。
- 真机验证：关窗提示、退出拦截、收起保活、脱窗返回绑定、侧栏 placement 入口。需要 Electron 实跑，
  当前沙箱内 `electron:dev` 必崩（GPU 子进程无法初始化），留给有图形会话的终端。

