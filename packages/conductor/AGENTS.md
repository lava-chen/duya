# @duya/conductor

> 画布（Canvas）子系统：拥有画布契约、整个画布渲染器、conductor store、元素/组件注册表与 refine 子系统；不拥有 agent 执行。

## 负责 / 不负责

- **负责**：画布 DB 类型与 zod schema、116 个画布渲染源文件、画布状态 store、元素与 widget 注册表、refine 流程。
- **不负责**：agent 执行 —— 编排用的 agent 工具在 `packages/agent/src/tool/CanvasConductor`，**禁止**从这里 import（`packages/conductor/src/index.ts:10`）；宿主运行时 → `@duya/host`；桌面侧服务实现 → `@duya/desktop`。

## 关键文件

| 文件 | 作用 |
| --- | --- |
| `packages/conductor/src/index.ts:1` | 主入口：只有 DB 类型 + zod schema（42 行），无渲染代码 |
| `packages/conductor/src/renderer/index.ts:20` | 渲染器公共面：`ConductorHostContext` / `useConductorHost` / `getConductorHostOrNull` / `setConductorHostScope` |
| `packages/conductor/src/renderer/stores/conductor-store.ts:269` | `useConductorStore` —— 画布状态（1202 行） |
| `packages/conductor/src/renderer/elements/ElementRegistry.ts:22` | `elementRegistry` + `registerElement()` —— 画布元素注册表 |
| `packages/conductor/src/renderer/elements/widget-sanitizer.ts:1` | widget 清洗（不可信内容进画布前的闸门） |
| `packages/conductor/src/renderer/host.ts:1` | `ConductorHost` 契约 —— 渲染器向宿主要 provider / agent 的地方 |

公共面：`@duya/conductor`（DB 契约）、`@duya/conductor/renderer`（React 侧）、`@duya/conductor/renderer/*`（深路径，便于 tree-shake）。

## 排障入口

| 症状 | 先看这里 |
| --- | --- |
| 画布空白 / 不出元素 | `packages/conductor/src/renderer/stores/conductor-store.ts:269` → `packages/ui/src/conductor-host-provider.tsx:37`（宿主必须挂在画布之上） |
| 某种元素渲染不出来 | `packages/conductor/src/renderer/elements/ElementRegistry.ts:22` — 该 kind 是否注册过 |
| widget 显示异常 | `packages/conductor/src/renderer/elements/widget-sanitizer.ts:1` + `packages/conductor/src/renderer/elements/workbench-runtime.ts:1` |
| provider 列表为空 | `packages/conductor/src/renderer/host.ts:1` — 宿主是否实现了 `ConductorHost` |
| 桌面正常、网页打不开画布 | `apps/web/src/client/ui-services-adapter.ts:24` — web 的 `capabilities.conductor` 是 `false` |

## 边界

- `architecture-policy.yaml:820` — 模块 `legacy-conductor`，`managed: false`（带基线债务），`requires: []`。
- 画布只做**表面**：`packages/ui/src/App.tsx:29` 引入 `ConductorView`，`:130` 在非 web 平台挂 `ConductorHostProvider`；`apps/web/src/client/ui-services-adapter.ts:28` 把 `conductor` 置为 `false`，所以 web 端没有画布。
- 唯一的 gotcha：编排 agent 的工具**不能**从本包引入（`packages/conductor/src/index.ts:10`），本包只渲染被驱动的画布。
