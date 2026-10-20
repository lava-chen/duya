# @duya/ui

> 共享 React 渲染层：拥有全部组件 / store / hook / i18n / CSS 与 `UiServices` 宿主契约；不拥有任何传输实现。

## 负责 / 不负责

- **负责**：整个渲染器（23 个组件目录、19 个 zustand store、44 个 hook）、主题与 i18n、工具卡片行、面板注册表、命令注册表；orb 是独立 React 应用（`packages/ui/src/orb/main.tsx:1`），不是组件。
- **不负责**：Electron IPC 处理器与 preload 桥 → `@duya/desktop`（`apps/desktop/src/preload/index.ts`）；Host / worker → `@duya/host`；斜杠命令元数据 → `@duya/command-catalog`；补全规则 → `@duya/input-completion`；画布 → `@duya/conductor`。

## 关键文件

| 文件 | 作用 |
| --- | --- |
| `packages/ui/src/index.ts:1` | 公共面只有 `export { App }`；`exports["."]` 指向 `./src/index.ts`，发的是**源码**不是产物 |
| `packages/ui/src/App.tsx:97` | 渲染器根组件；视图切换在 `packages/ui/src/App.tsx:1122-1188`（store 里的 `currentView` 字符串，**不是路由**） |
| `packages/ui/src/services/ui-services.ts:65` | `UiServices` 契约：sessions / runs / approvals / capabilities |
| `packages/ui/src/services/registry.ts:6` | `configureUiServices()`；未配置时 `getUiServices()` 抛错 |
| `packages/ui/src/components/layout/app-shell.tsx:299` | 应用外壳与面板布局 |
| `packages/ui/src/stores/conversation-store.ts:610` | 主 store（zustand `persist`） |
| `packages/ui/src/lib/ipc-client.ts:1` | 旧 HTTP+SSE 通道 + `window.electronAPI` 直调 |

公共面：`@duya/ui`（仅 `App`）、`@duya/ui/styles.css`、`@duya/ui/services`、`@duya/ui/lib/*`、`@duya/ui/types/*`、`@duya/ui/contracts/*`。

## 排障入口

| 症状 | 先看这里 |
| --- | --- |
| 白屏 | `apps/desktop/src/renderer/main.tsx:10` → `packages/ui/src/App.tsx:97`；启动闪屏在仓库根 `index.html:146`，看门狗在 `packages/ui/src/App.tsx:435` |
| 组件渲染但视图不对 | `packages/ui/src/App.tsx:1122-1188`（`currentView` 是 store 字符串，不是路由器） |
| 状态不刷新 | `packages/ui/src/stores/conversation-store.ts:611`（`persist` 水合） |
| `window.electronAPI` undefined | `apps/desktop/src/preload/index.ts` → `apps/desktop/src/main/ipc/index.ts:43` → `apps/desktop/src/main/ipc/lazy-ipc-registry.ts:1` |
| 深色模式错 | `packages/ui/src/hooks/useTheme.ts:19` + 启动脚本（仓库根 `index.html:12-22`，`data-theme` 是唯一真源） |

## 边界

- `architecture-policy.yaml:456` — 模块 `ui`，`managed: false`（带基线债务），`requires` 8 项。
- **两套流式架构并存**：`apps/web/src/main.tsx:11` 配了宿主 → 走 `UiServices` + `RunSession`；`apps/desktop` 没配 → `packages/ui/src/App.tsx:143-154` 捕获 `getUiServices()` 抛错、`uiServices === null` → 回落到旧的 `packages/ui/src/lib/stream-session-manager.ts:3`（HTTP+SSE）。这是过渡态，别当 bug 猜。
- 耦合泄漏到桌面端：`packages/ui/tsconfig.json:2` 继承 `apps/desktop/tsconfig.renderer.json`；`packages/ui/src/stores/conversation-store.ts:311` 直接摸 `window.electronAPI`。
