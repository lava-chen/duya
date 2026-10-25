# Mini App 以面板打开

状态：active · 负责人：zcode 会话（mini-app-panel-open） · 更新：2026-10-25
分支：codex/mini-app-panel-open · worktree：E:/Projects/duya/.claude/worktrees/mini-app-panel-open · base：270ba52869b6414094e553dd7f9abde5a1e429f7 · owner：本会话

## 目标与边界

用户观察到的变化：安装带 Mini App 的插件（如 conductor-canvas）后，点击 App 不再把整个 duya
窗口变成全屏 overlay（视觉上像弹出独立窗口），也不再用无父窗口的原生弹框承载授权；App 作为
侧面板 `plugin-app` 页打开——有聊天会话时落在该会话的面板，standalone App 无会话也可打开。

允许修改：`packages/ui`（launcher、panel 页、panel hook、CSS、i18n 相关调用）、
`apps/desktop/src/main/plugins`（授权弹窗父窗口）。
本次不处理：授权流程从原生弹框改为渲染层卡片的信任边界调整（保持原生弹框语义，
仅挂到主窗口）；Mini App 面板的脱窗（detach）联动；TUI 侧。

## 验收

- `npx vitest run packages/ui/src/components/plugin-apps/MiniAppsView.test.tsx packages/ui/src/hooks/__tests__/usePanel.test.ts`
  通过：entry App 打开 `plugin-app` 面板页（agent-run 需要 activeThreadId，standalone 不需要）；
  同 appId 重复打开折叠为一个 tab。
- `npm run typecheck:all`、`npm run architecture:check` 退出码 0。
- 真机冒烟（未跑）：`npm run electron:dev` 后在「应用」页点击 conductor-canvas 的 canvas，
  App 在侧面板打开；首次授权弹框应吸附在主窗口上。

## 进度

- [x] 定位现状：launcher 全屏 overlay（`plugin-app-overlay`）+ 主进程 `dialog.showMessageBox` 无父窗口
- [x] `PluginAppLauncher` 改为 `openOrActivatePage("plugin-app", …)`，去 overlay 与 Escape 处理
- [x] `PluginUiSurfacePanel` 支持无 surface 的 entry App（surfaceId/server 可选）
- [x] `usePanel` dedupKey：surface 缺省时以 appId 收口
- [x] standalone 授权弹窗挂主窗口（无主窗口时保留原行为）
- [x] 测试与门禁（见验证记录）
- [ ] 真机冒烟（需重启 electron:dev 实测）
- [ ] PR review / CI / 授权集成

## 发现与决策

- 截图里的「独立窗口」实际是 launcher 的全屏 overlay（`position:fixed; inset:0`）盖掉整个界面；
  授权弹框是 `dialog.showMessageBox` 无 parent 形成的第二个原生窗口，且阻塞在
  「正在加载插件视图…」上。
- 面板系统早已具备 `plugin-app` 页（registry/PanelZone/`PluginUiSurfacePanel`），但只服务
  MCP surfaces；entry 型 App（无 ui.surfaces，如 canvas）此前只能走 overlay。
- `PanelZone` 非 session 视图会强关面板、`availability:"session"` 的页在无会话时被关闭——
  因此 launcher 以 runtime 映射 availability：standalone → always，agent-run → session；
  agent-run 无会话时在 launcher 内拒绝并提示，不产生立即被关掉的 tab。
- `openOrActivatePage` 在同一 act 内连调会读到未刷新的 `tabsRef`（既有行为），测试须分两次 act。
- 附带：会话开始时 C 盘仅剩 7.5MB，已清理 %TEMP% 下 VS 安装器解包残留约 3.8GB
  （v1l2qkqv / uemxm1vb.f4v / eajalp4g.kd1），无安装进程在跑；其余缓存未动，建议用户自行扩容。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| 270ba528（基线，改动前） | win32 / node v24.16.0 | `npx vitest run MiniAppsView.test.tsx usePanel.test.ts` | 0，24 tests 绿 | 基线 |
| 改动后（8 文件 dirty） | 同上 | `npx vitest run`（同上 + PanelZone.test.tsx） | 0，36 tests 绿 | 本次 |
| 改动后 | 同上 | `npx vitest run packages/ui` | 0，230 文件 2352 passed / 2 skipped | 回归 |
| 改动后 | 同上 | `npx vitest run apps/desktop/src/main/plugins` | 0，166 tests 绿 | 回归 |
| 改动后 | 同上 | `npm run typecheck:all`（含 electron gate） | 0 | 门禁 |
| 改动后 | 同上 | `npm run architecture:check` | 0，无新增违规（2 条旧指纹不再触发，未动 baseline） | 门禁 |

## 接续 / 结果

已实现并验证：面板打开 + 授权弹窗挂主窗口；未跑真机冒烟（Electron 无法在本环境用 Playwright 驱动，
按记忆约定以 typecheck + Vitest 代替，冒烟留给用户）。
PR：https://github.com/lava-chen/duya/pull/485（base master，head c34e9624 链）。
下一步：等 review / CI 与集成授权；合并后由用户在真机复核「应用」页与插件设置页两条入口。
