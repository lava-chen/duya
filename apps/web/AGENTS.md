# @duya/web

> 本地浏览器传输：同源 Node BFF（loopback）+ 挂载 `@duya/ui` 的浏览器端。浏览器**从不**直连 Host，bearer token 不出 BFF 进程。

## 负责 / 不负责

- **负责**：`src/server/**`（loopback BFF、Host 连接发现、静态托管）、`src/client/**`（浏览器 API 客户端、SSE、run 流、宿主适配器）、`src/main.tsx`（浏览器入口，挂 `@duya/ui` 的 `App`）。
- **不负责**：Host 与 worker → `@duya/host`；任何 Electron 代码 → `@duya/desktop`；渲染器组件 → `@duya/ui`；本地文件系统访问 → 无（web 无此能力）。

## 关键文件

| 文件 | 作用 |
| --- | --- |
| `apps/web/src/server/web-bff.ts:53` | `createWebBff()` —— 全部 BFF 路由与安全闸门（786 行） |
| `apps/web/src/server/main.ts:13` | `resolveHostConnection()` —— 找 Host；`:53` 指 `staticRoot` → 构建产物 `apps/web/dist/client` |
| `apps/web/src/client/api.ts:147` | `ApiClient` —— 浏览器侧 REST 客户端 |
| `apps/web/src/client/ui-services-adapter.ts:19` | `createWebUiServices()` —— 把 BFF 适配成 `UiServices` |
| `apps/web/src/main.tsx:11` | 浏览器入口：先 `configureUiServices(createWebUiServices())` 再挂载 `App` |

公共面：无 `exports` map（workspace app）。

## 排障入口

| 症状 | 先看这里 |
| --- | --- |
| 浏览器连不上 Host | `apps/web/src/server/web-bff.ts:53` → `apps/web/src/server/main.ts:13` → `apps/web/src/client/api.ts:147` |
| 页面显示「此功能暂不可用」 | `apps/web/src/client/ui-services-adapter.ts:24`（7 个能力全是 `false`）+ `packages/ui/src/App.tsx:1092`（`capabilityByView`） |
| web 上某操作直接报错 | `packages/ui/src/lib/ipc-client.ts:601`（`workspace_binding_required`）、`:656`、`:734`、`:739`、`:823` |
| SSE 中断 / 事件丢失 | `apps/web/src/server/web-bff.ts:347`（心跳 15 s）、`:25`（256 KB 缓冲上限） |
| 浏览器侧 403 / CSRF 失败 | `apps/web/src/server/web-bff.ts:607`（`isExpectedHost`）、`:612`（`isAllowedFetchSite`）、`:701`（`isAllowedOrigin`）、`:708`（`x-duya-csrf`） |

## 边界

- `architecture-policy.yaml:296` — 模块 `web-server`（`apps/web/src/server`，`managed: true`）；`:304` — 模块 `web-client`（`apps/web/src/main.tsx` + `apps/web/src/client`，`managed: true`）。两个模块都零容忍。
- BFF 硬约束：只绑 `127.0.0.1`（`apps/web/src/server/web-bff.ts:22`）、`MAX_JSON_BODY_BYTES = 64 KB`（`:23`）、CSP `connect-src 'self'`（`:32`）、无任意代理、无 CORS 放行。
- 唯一的 gotcha：**所有 web 能力都是 `false`**（`apps/web/src/client/ui-services-adapter.ts:24-32`），画布 / bot / 自动化 / 工作流 / 扩展 / 设置在 web 端一律不可用，这是设计而非缺陷。
