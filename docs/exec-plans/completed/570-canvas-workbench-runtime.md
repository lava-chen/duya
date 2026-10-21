# Plan 570: Canvas Workbench Runtime（画布工作台运行时）

> **目标**：把画布从「静态看板」升级为「可持续运行的工作台」。用户描述一个场景
> （股票监测控制台 / 个人学习工作台 / 项目管理工作台），agent 通过对话完成：
> ① 注册**数据来源**（外部 HTTP 如股价、项目数据库、计算派生）；
> ② 搭建动态 widget 看板并**绑定数据源**；
> ③ 写入**后台逻辑**（策略 handler，主进程沙箱执行，随 app 常驻生效）；
> ④ widget 内放置**策略按钮**，点击触发刷新 / 后台逻辑 / 数据更新；
> ⑤ 数据周期刷新后**实时推送**进 widget（无需重建元素）。
>
> 核心问题的答案：**后台不在前端代码里，而在 Electron 主进程**——
> agent 写的 handler 与数据源配置持久化进 SQLite（conductor 库），由主进程的
> WorkbenchService 调度执行（fetch 走主进程，无 CORS/CSP 限制），结果经
> 既有的 conductor MessagePort 通道实时推送进渲染端的 widget iframe。
> 打包版无需任何额外安装步骤（全部代码已在主进程 bundle 内）。

## Status

- [x] Phase 0: 架构探索与设计（本文件）
- [x] Phase 1: 数据层 — schema 表 + WorkbenchService + 单测
- [x] Phase 2: 执行器/调度 — executor-proxy 新 action + 刷新调度器 + widget action IPC + preload
- [x] Phase 3: 渲染端 — workbench-runtime srcdoc + WidgetShell 数据推送/动作路由 + store slice
- [x] Phase 4: Agent 工具 — canvas_data_source + 注册 + 提示词（canvas_backend 推迟，见决策 5）
- [x] Phase 5: 验证与文档 — typecheck + vitest + ARCHITECTURE.md
- [ ] 手工冒烟（用户侧）

## 背景与现状（探索结论）

- 画布元素模型 `CanvasElement`（`packages/conductor/src/renderer/types/conductor.ts`），
  `widget/dynamic` = agent 生成的 HTML，经 `sanitizeForIframe`（**剥掉全部 script**）
  放进 `sandbox="allow-scripts"` iframe —— 当前是纯静态快照。
- chat 侧 `WidgetRenderer` 有带 JS 的接收器协议（`buildReceiverSrcdoc`）：
  `widget:resize/link/previewImage/sendMessage/theme/update/ready`，CDN 白名单
  （cdnjs/jsdelivr/unpkg/esm.sh）——证明「iframe 与宿主 postMessage 协作」模式已获安全认可。
- Agent 画布工具经 `conductor:executor:rpc`（`ConductorExecutorProxy`，
  `electron/conductor/executor-proxy.ts`）落库；写操作经
  `broadcastPatch → channelManager.sendToChannel('conductor')` → MessagePort →
  `ConductorBridge.onStatePatch` 实时更新渲染端 store。**实时通道已存在，只差数据消息。**
- `DEFAULT_CSP`（iframe-protocol.ts）`connect-src 'none'`：widget iframe 一律无网络，
  取数必须走主进程 —— 这正是「后台」的落点。
- 项目数据库（plan 236）经 `getProjectDatabaseService().invoke({projectPath, command})`
  （参数化查询）可作数据源之一。
- 表在 `electron/db/schema.ts`（CREATE TABLE IF NOT EXISTS 幂等 + ALTER self-repair 模式）。

## 设计

### 数据流

```
[主进程 WorkbenchService]
  data sources (SQLite conductor_data_sources)
    ├─ http        → 主进程 fetch（无 CORS）→ JSON/点路径提取
    ├─ project_db  → getProjectDatabaseService().invoke(...)
    └─ computed    → HandlerRunner vm 沙箱: (sources) => snapshot
  schedule: 每 canvas 一 tick（min interval 15s），刷新后
    broadcastPatch({type:'conductor:data:update', canvasId, sourceId, snapshot, refreshedAt})
        │ (既有 conductor MessagePort)
        ▼
[渲染端] conductor-store: dataSources slice ← onStatePatch
  WidgetShell: 把 {sourceId→snapshot} postMessage 进 iframe（'workbench:data'）
        ▼
[widget iframe] workbench-runtime 注入 window.duya
  duya.onData(cb) / duya.action(kind,name,payload) / duya.data
  按钮: data-duya-action='{"kind":"handler","name":"..."}' 或 data-duya-refresh
        │ postMessage('workbench:action')
        ▼
[渲染端 WidgetShell] → IPC conductor:widget:action → 主进程
  kind=refresh  → WorkbenchService.refresh(sourceId) → 再广播
  kind=handler  → HandlerRunner.run(handler, input, sources) → 结果广播/回填
  （agent prompt 类动作留后续，v1 不做）
```

### 后台逻辑（HandlerRunner，主进程 `node:vm`）

- 表 `conductor_handlers`: id, canvas_id, name, code, description, enabled,
  created_at, updated_at。
- 执行契约：vm Script，sandbox = `{ sources, input }`（无 require/process/fetch），
  timeout 250ms CPU + 整体 2s 墙钟 Promise.race。
- 输出：`{ data?: unknown, error?: string }`；data 广播为
  `conductor:data:update {sourceId: 'handler:<name>'}`，widget 按 sourceId 订阅。
- 安全：无网络、无 fs；代码体积上限 32KB；同名 handler 每 canvas 唯一；动作触发频率
  限流（每 element 10 次/分钟）。

### 数据源 schema（conductor_data_sources）

- id, canvas_id, name, type('http'|'project_db'|'computed'), config JSON:
  - http: `{ url, method?, headers?, path?, intervalSec? }`（headers 值支持
    `"$env:NAME"` 引用，避免凭据字面量入库；日志永不打印 headers）
  - project_db: `{ command }`（透传给 ProjectDatabaseService，参数化）
  - computed: `{ code }`（同 handler 沙箱，签名 `(sources) => snapshot`）
- refresh_interval_sec（最小 15，0=手动）, last_snapshot JSON, last_refreshed_at,
  last_error, enabled, created_at, updated_at。
- agent 工具 `canvas_data_source`（register/list/update/delete/refresh），
  `canvas_backend`（register/list/delete/test handler）。

### Widget 运行时（渲染端）

- `workbench-runtime.ts`：`buildWorkbenchSrcdoc(sourceCode, opts)` —— 保留
  sanitizeForIframe 的静态产出作为初始 HTML，注入 runtime script：
  - `window.duya = { data, onData(fn), action(kind,name,payload), theme }`
  - 点击委托：`[data-duya-action]` / `[data-duya-refresh]`
  - 尺寸上报复用既有 `widget:resize` 协议。
- `WidgetShell`：iframe onLoad 推当前快照；store 数据更新时推送 `workbench:data`；
  `workbench:action` 监听 → IPC。

### 兼容与降级

- 旧 widget 不受影响：runtime 为增量注入；`window.duya` 不存在时按钮无行为。
- 无 canvas 绑定的会话不注册新工具（跟随 registerCanvasConductorTools 条件注册）。
- 调度器仅刷新 enabled 且 intervalSec>0 的源；app 退出即停（主进程生命周期内）。

## Phase 1 — 数据层

- [ ] `electron/db/schema.ts`: conductor_data_sources / conductor_handlers 两表 + 索引
- [ ] `electron/conductor/data-source-service.ts`: CRUD + refreshSource（三种类型）+ snapshot 提取
- [ ] `electron/conductor/handler-runner.ts`: vm 沙箱执行器（timeout/体积/全局白名单）
- [ ] 单测: `electron/conductor/__tests__/`（http mock fetch；project_db mock service；
  computed 真跑 vm；runner 超时/体积/全局逃逸）

## Phase 2 — 执行器与调度

- [ ] executor-proxy 新 action: `data_source.manage` / `data_source.refresh` /
  `backend.manage` / `handler.run`
- [ ] `electron/conductor/workbench-scheduler.ts`: 每 canvas tick（读 enabled 源，
  刷新→broadcastPatch）；main.ts 装配 + setBroadcastPatch 复用
- [ ] 新 IPC `conductor:widget:action`（校验 element 归属 canvas、限流）
- [ ] preload 暴露 `conductor.widgetAction`
- [ ] 单测: executor action 路由 / widget action 限流与归属校验

## Phase 3 — 渲染端运行时

- [ ] `packages/conductor/src/renderer/elements/workbench-runtime.ts` + 单测
- [ ] `WidgetShell.tsx`: 动态 widget 走 workbench srcdoc；数据推送；动作路由 →
  `conductor-ipc.widgetAction(...)`
- [ ] `conductor-store.ts`: `dataSources` slice + onStatePatch 处理
  `conductor:data:update` / `conductor:data:sources`
- [ ] 单测: srcdoc 生成（sanitizer 语义保留、runtime 注入、动作属性不被剥）、
  store patch 应用

## Phase 4 — Agent 工具与提示词

- [ ] `CanvasDataSourceTool.ts`（canvas_data_source）、`CanvasBackendTool.ts`（canvas_backend）
- [ ] `CanvasConductor/index.ts` 注册（17 工具）
- [ ] `CanvasCreateElementTool` 描述补「工作台 widget 编写指南」（bindings/按钮/
  duya API/自动刷新声明）
- [ ] knowledge 增 `workbench` section（canvas_get_knowledge）
- [ ] prompt 单测更新

## Phase 5 — 验证与文档

- [ ] worktree 内 typecheck（agent/web/conductor）+ 相关 vitest 全绿
- [ ] ARCHITECTURE.md 增「Canvas Workbench Runtime」小节
- [ ] 本 plan 勾选 → 合入后移 completed/
- [ ] Electron 手工冒烟（用户侧）：新建股票工作台对话 → 注册数据源 → 生成看板 →
  策略按钮 → 修改策略 → 数据自动刷新

## 决策记录

- **后台落点 = 主进程而非前端**：widget CSP connect-src 'none' 是刻意的安全边界，
  打破它（给 iframe 开网）会放大供应链/数据外泄面；主进程集中 fetch 可审计、可限流、
  可复用 token。打包即生效，无额外安装。
- **v1 策略逻辑放 widget iframe 内，主进程只取数**：chat 侧 `buildReceiverSrcdoc`
  已有「agent 内联 script 在 allow-scripts iframe 内执行」的先例；workbench runtime
  复用同一信任模型，把 agent 写的 `<script>` 提取后注入 runtime 之后执行。
  「改策略」= agent 重写 widget sourceCode（既有链路，实时生效）；主进程零动态执行。
- **服务器端 handler（canvas_backend / conductor_handlers / vm 沙箱）推迟**：
  ① Mimosa PreToolUse 钩子将 `vm.Script/runInContext` 写入判为代码注入高危（可复核
  sealed scan 对该文件 0 命中，属误报，但硬拦截使实现无法落盘）；
  ② 同步 vm 执行的忙循环风险需要 worker 隔离才能真正关闭。
  `conductor_handlers` 表已建（schema 前瞻承诺），后续 plan 以 worker_threads +
  墙钟 terminate 的形态接上，并同步扫描基线。
- **数据源 v1 = http / project_db 两类**：覆盖「股价（http）/已有数据库（project_db）」
  主诉求；computed 派生随 handler 执行一并推迟（widget 内 script 可即时覆盖大部分
  派生场景）；MCP/连接器接入留后续 plan。
- **v1 不做 widget→agent 对话动作**：chat 侧 `widget:sendMessage` 模式已有先例，
  画布侧涉及会话路由与审批，单独立项避免半成品安全面。
