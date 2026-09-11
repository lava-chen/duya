# Plan 521: 内存占用治理与生命周期主动回收

> **Status**: Phase 0 已完成;Phase 1-5 待评审
> **Priority**: P1
> **Created**: 2026-09-11
> **Companion**: [426-low-spec-performance](./426-low-spec-performance.md)(worker 并发自适应 + 空闲回收 + 内存门限,已落地)、[453-wake-agent](./453-wake-agent.md)(OSContextBridge / wake-agent daemon)、[330-electron-cleanup-repair](../completed/330-electron-cleanup-repair.md)
> **Source evidence**: 2026-09-11 进程级实测(`Get-CimInstance` + `app.getAppMetrics`)、dev core DB 直读、`webview-bridge.test.ts` / `webview-memory.test.ts`

---

## 1. Problem & Goal

一次 `npm run electron:dev` 会话(2h)的**进程级实测**:

| 进程 | 角色 | 内存 | 判据 |
|---|---|---|---|
| 104696 | Main | 231 MB | 持有 `DUYA` 窗口 |
| 113864 | GPU | 318 MB | `--type=gpu-process` |
| **96176** | **`<webview>` guest(内置浏览器)** | **2428→2911 MB(仍在涨)** | 无 `--duya-backdrop`;`Partitions/duya-local-browser` 于 14:43 写入 |
| 122060 | Renderer(主窗口) | 891→991 MB | 有 `--duya-backdrop=mica` |
| ×5 | agent worker | 568 MB | agent-server(80468)子进程,~110 MB/会话 |
| 112176 | Vite dev server | 623 MB | `vite --port 3000` |
| — | npm/concurrently/electron-cli | ~100 MB | |

**另有 ~5.9 GB 僵尸开发进程**(与本次栈无关):14 个 vitest 进程对(3154 MB,今早 11:57–13:47 启动、父进程已死)、3 个过期 Vite dev server(2253 MB,含昨日 22:27 的 1609 MB)。

### 三个根因

1. **内置浏览器 guest 无生命周期回收** —— 关闭标签不丢缓存;存活期无内存预算;`PanelZone` 用 `aria-hidden` **保活所有 panel**([PanelZone.tsx:205](../../../src/components/layout/PanelZone.tsx)),隐藏标签的 guest 一直驻留。这是 2.9 GB 的来源。
2. **渲染进程消息列表无窗口化** —— 全量 transcript 进 JS 且每行一个包裹 `<div>`;分页脚手架是死代码;store 保留**每个打开过的线程**的全部消息。
3. **迁移 id 撞号导致两个 schema 对象永久缺失** —— `message_search` 表 + `session_runtime_locks.origin` 列(已在 Phase 0 修复)。

### Goal

- 单次 dev 会话的内存占用可归因、可度量、可回收;内置浏览器不再出现 GB 级 guest。
- 消息列表的内存随**视口**而非**会话长度**增长。
- 建立"生命周期主动回收"的既有范式,而不是靠 GC 自觉。

---

## 2. 设计原则(对齐业界共识:进程隔离 + 生命周期主动回收)

Electron 应用的成熟做法是**"进程隔离 + 生命周期主动回收"**,不靠 GC。本 plan 把五条原则映射到 duya 的具体落点:

| 原则 | 业界做法 | duya 落点 |
|---|---|---|
| **P-a 多进程即杠杆** | 每个 window/webview 独立渲染进程,关闭即整进程回收 | 不保留僵尸 `<webview>`;关闭/隐藏即 dispose 或 reload |
| **P-b session 显式清理** | `clearCache` / `clearCodeCaches` / `clearStorageData` 三件套 | `releaseBrowserMemory()`(Phase 0 已落地) |
| **P-c 预算 + watchdog** | `app.getAppMetrics()` 监控,超预算 reload/重建;worker 设 `--max-old-space-size` | webview watchdog(Phase 0)+ worker 门限(plan 426 已有) |
| **P-d 显式降级** | 监听 `memory-pressure` / `render-process-gone` 降级 | Phase 1 增加降级钩子 |
| **P-e 只保活跃视图** | `backgroundThrottling` + 隐藏页 DOM 裁剪 | Phase 2 窗口化;Phase 3 真虚拟化 |

> 注:worker 侧的 `--max-old-space-size` + idle reaper **已存在**(`electron/agents/server/worker-limits.ts`,plan 426),本 plan 不重复建设。

---

## 3. 关键约束(必须尊重的既有决策)

1. **不改 core DB 迁移 runner 语义** —— `runMigrations` 的 `id <= current` 是既有契约;修复只能"给事后插入的迁移分配 > 当前 max 的新 id",不能让 runner 改成 name-based 账本(会有非幂等迁移被重跑,例如 `CREATE TABLE session_runtime_locks` 无 `IF NOT EXISTS`)。
2. **不改 `browser:close-agent-browser` 契约** —— Phase 1 只在其副作用链路追加回收,不改 IPC 形状。
3. **不改 `PanelZone` 的保活语义** —— 保活是刻意设计(避免切换 tab 重建空白 webview);Phase 1/3 只增加"隐藏超时后释放",不改"保持挂载"。
4. **P1 不动渲染管线** —— 窗口化只改数据装载与 store 淘汰,不动 `LazyMessageRow` 的 content-visibility 机制。
5. **不改 `clearPartitionData()` 语义** —— 它是显式全清(cookies 也在内),与 `releaseBrowserMemory()`(保 cookies)分工不混。
6. **`partition` 名固定** —— `persist:duya-local-browser`([BrowserPanel.tsx:514](../../../src/components/layout/panels/BrowserPanel.tsx));不得改名(会丢既有登录态)。

---

## 4. 方案分项

### 4.0 ✅ 已完成(本会话)

**A. 迁移 id 撞号修复**([message-log.ts:280](../../../electron/db/core/message-log.ts)、[stores.ts:449](../../../electron/db/core/stores.ts))

| 对象 | 原 id | 新 id | 后果 |
|---|---|---|---|
| `create_message_search` | 15(撞 Mailbox id 15) | **16** | 否则每次 append 刷 `no such table: message_search` |
| `add_lock_origin` | 8(撞 GoalStore id 8) | **17** | 否则 `LockStore.acquire()` 必抛 `no such column: origin` |

+ [database.ts:116](../../../electron/db/core/database.ts) 新增**重复 id 检测**(再撞号即 `logger.error`,不再静默)。

验证:dev 库 `schema_version=15` 实测两对象缺失 → 迁移日志现按 15→16→17 执行;**326 个 core DB 测试通过**;对真实库副本套用迁移 SQL 后表/列建成、`acquire` 式 INSERT 成功。

**B. 内置浏览器内存回收**([webview-memory.ts](../../../electron/services/browser/webview-memory.ts) 新增)

- `releaseBrowserMemory(reason)` —— `clearCache` + `clearCodeCaches({urls:[]})` + `clearHostResolverCache` + `clearAuthCache` + 清 `shadercache/cachestorage/serviceworkers`;**保** cookies/localStorage/indexdb。
- `checkWebviewMemory()` + watchdog —— 每 60s 采样(`app.getAppMetrics()` 按 `getOSProcessId()` 匹配),超预算(默认 800 MB,`DUYA_WEBVIEW_MEMORY_MB` 可调)`reload()`。
- 接线:[webview-bridge.ts:181](../../../electron/services/browser/webview-bridge.ts)(最后标签注销触发回收;`setWebviewIdProvider` 于 :22 注册)、[daemon.ts:727](../../../electron/services/browser/daemon.ts)(随 daemon 启停 watchdog);单向依赖,无 import cycle。
- 验证:**13 个浏览器测试通过**(测试路径解析 bug 一并修正)。

### 4.1 内置浏览器生命周期收口(Phase 1)

- **1a. 非 agent 标签也回收** —— `BrowserPanel` 卸载/关闭时也走一次 `releaseBrowserMemory`。当前只有 agent 标签注册到 bridge,普通标签漏回收。
- **1b. 隐藏标签 dispose/reload** —— `AgentBrowserTab` 隐藏超时(如 5 min,`PanelZone` 已知 active 态)后:优先 `reload()` 到 `about:blank` 释放页面内存,重建时恢复 URL;若仍超预算则整 guest dispose。
- **1c. 降级钩子(P-d)** —— 监听 `app` 的 `render-process-gone` / `child-process-gone`,记录并以 toast 暴露;`memory-pressure` 时主动 `releaseBrowserMemory`。
- **1d. 可观测** —— 把 `getWebviewMemoryTotalMb()` 暴露到设置页/诊断面板,让"当前 webview 占用"可见。

### 4.2 消息列表窗口化 P1(Phase 2)

现状([ChatView.tsx:406](../../../src/components/chat/ChatView.tsx)):`visibleMessages = projectMessageTranscript(messages).messages` 不截断;`hasMore`/`onLoadMore` 只在 `MessageList` 自身测试里出现,`ChatView` 从不传(`<MessageList>` 仅传 messages/isStreaming/sessionId 等)→ 分页 UI 是死代码。

- **2a. 接上窗口化** —— 初始只装载最后 ~200 条;`hasMore = messages.length < totalCount`;实现 `onLoadMore` 向上翻页(预取上一页并 prepend)。
- **2b. 滚动锚定** —— 复用既有高度缓存(`cachedHeight`/`measuredHeight`)与 `containIntrinsicSize` 占位,prepend 后维持视觉位置不变。
- **2c. store 淘汰** —— `messages: Record<threadId, Message[]>`([conversation-store.ts:134](../../../src/stores/conversation-store.ts))加 LRU:只保活跃线程 ± 少数最近线程的消息数组,其余释放(切回时按 `?since=` 增量重取)。
- **2d. 首屏加载边界** —— core DB 侧给 thread 消息查询加 `LIMIT`/offset,避免一次性把全量读进内存。

### 4.3 真虚拟化 P2(Phase 3)

- 用 `@tanstack/react-virtual` 替换 `content-visibility` 方案,让 **DOM 节点数随视口而非 transcript** 增长(现方案每行仍有包裹 `<div>`,节点数线性于会话长度)。
- 难点:变高行 + 流式自动滚动。放 P1 之后,先有窗口化再换渲染器。
- 保留 `ALWAYS_RENDER_TRAILING_ROWS=8` 与 `MESSAGE_ROW_OVERSCAN_PX=600` 的语义。

### 4.4 增量投影/分组 P3(Phase 4)

- `projectMessageTranscript` + sort + group + `buildNavigatorItems`(定义 [:582](../../../src/components/chat/MessageList.tsx)、memo 调用 [:888](../../../src/components/chat/MessageList.tsx))每次 `messages` 变化全量重算(已 memo,仍是 O(n))。改为按 append 增量更新,或移入 worker。

### 4.5 进程级卫生(Phase 5)

- **5a. dev 孤儿守卫** —— 提供 `scripts/kill-dev-orphans.mjs`(按 profile 识别孤儿 vitest/vite,`--dry-run` 先列清单),避免 14 个 vitest 尸体累积。
- **5b. 打包版基线** —— 用 `npm run electron:build` 后的打包版测一次基线(无 Vite/sourcemap),与 dev 数字分开记录,避免误读。

---

## 5. Non-Goals

- **不改 core DB 迁移 runner 语义**(§3.1)
- **不重写 `LazyMessageRow` 的 content-visibility 机制**(P1 前提;P2 才替换)
- **不动 worker 生命周期**(plan 426 已覆盖;本 plan 只消费)
- **不改 `PanelZone` 保活语义**(只增隐藏超时释放)
- **不引入新 IPC 通道**(回收/释放复用既有 `browser:*` 链路)
- **不改 `persist:duya-local-browser` 名**
- **不追求 macOS/Linux 对齐**(Windows 优先)

---

## 6. Architecture Overview

```
   ┌───────────────────────────────────────────────────────────────┐
   │ Renderer                                                       │
   │  PanelZone (aria-hidden 保活, 不变)                            │
   │   ├── AgentBrowserTab  ──unmount──► browser:close-agent-browser │
   │   │        └── Phase1b: 隐藏超时 → reload/dispose             │
   │   └── BrowserPanel     ──unmount──► Phase1a: release           │
   │  ChatView → MessageList                                        │
   │   ├── Phase2: 装载末 200 条 + onLoadMore 翻页 + 锚定             │
   │   ├── Phase3: @tanstack/react-virtual 行虚拟化                 │
   │   └── Phase4: 增量 projectMessageTranscript / grouping         │
   │  conversation-store: messages Record + Phase2c LRU 淘汰        │
   └───────────────┬───────────────────────────────────────────────┘
                   │ IPC (既有 browser:* / db:*)
                   ▼
   ┌───────────────────────────────────────────────────────────────┐
   │ Main Process                                                   │
   │  webview-bridge: sessionMap ──► releaseBrowserMemory (Phase0)  │
   │  webview-memory: watchdog + budget (Phase0)                    │
   │    └── Phase1c: render-process-gone / memory-pressure 降级     │
   │    └── Phase1d: getWebviewMemoryTotalMb → 诊断面板             │
   │  browser daemon: start/stop watchdog (Phase0)                  │
   │  core-db: 迁移 id 唯一 + 重复检测 (Phase0)                     │
   └───────────────────────────────────────────────────────────────┘
```

---

## 7. Phase 拆解

### Phase 0 — 地基(✅ 2026-09-11 完成)

- [x] 迁移 id 修复:`create_message_search` 15→16、`add_lock_origin` 8→17
- [x] `runMigrations` 重复 id 检测
- [x] `webview-memory.ts`:`releaseBrowserMemory` + `checkWebviewMemory` + watchdog
- [x] 接线:bridge 最后标签回收、daemon 启停 watchdog
- [x] 单测:webview-memory 5 例 + bridge 回归 8 例;core DB 326 例
- [x] electron tsc:新增 0 错误(867→865,余为既有)

### Phase 1 — 内置浏览器生命周期收口

> 依赖:Phase 0;**预计**: 2–3 天

- [ ] 1a `BrowserPanel` 卸载触发 `releaseBrowserMemory`
- [ ] 1b `AgentBrowserTab` 隐藏超时 → reload(`about:blank`)或 dispose
- [ ] 1c `render-process-gone` / `child-process-gone` / `memory-pressure` 降级钩子
- [ ] 1d `getWebviewMemoryTotalMb()` 暴露到诊断面板/设置页

### Phase 2 — 消息列表窗口化 P1

> 依赖:无(与 Phase 1 可并行);**预计**: 3–4 天

- [ ] 2a 初始末 ~200 条 + `hasMore` + `onLoadMore` 翻页
- [ ] 2b prepend 滚动锚定(复用高度缓存)
- [ ] 2c `conversation-store` LRU 淘汰非活跃线程消息
- [ ] 2d core DB thread 消息查询分页(LIMIT/offset)

### Phase 3 — 真虚拟化 P2

> 依赖:Phase 2;**预计**: 3–4 天

- [ ] 3a `@tanstack/react-virtual` 替换 content-visibility(变高 + 流式滚动)
- [ ] 3b 保留 trailing-always 8 / overscan 600 语义
- [ ] 3c 回归:`MessageList` 既有测试 + 手动长会话

### Phase 4 — 增量投影/分组 P3

> 依赖:Phase 2;**预计**: 2 天

- [ ] 4a `projectMessageTranscript` 增量更新(或 worker 化)
- [ ] 4b `buildNavigatorItems` 同步增量

### Phase 5 — 进程级卫生 + 收口

> 依赖:Phase 1-4;**预计**: 1–2 天

- [ ] 5a `scripts/kill-dev-orphans.mjs`(`--dry-run` 先列清单)
- [ ] 5b 打包版基线测量并记录
- [ ] 5c ARCHITECTURE.md / README.md 更新;plan 移 `completed/`

---

## 8. 测试策略

### 8.1 单元测试(Vitest)

| 文件 | 覆盖 | 状态 |
|---|---|---|
| `electron/services/browser/__tests__/webview-memory.test.ts` | release 保 cookies / 超预算 reload / 无 metric / destroyed / 求和 | ✅ 5 例 |
| `electron/services/browser/__tests__/webview-bridge.test.ts` | 最后标签注销触发 release + 既有回归 | ✅ 8 例 |
| `src/components/chat/MessageList.test.tsx` | 窗口化 `hasMore` / `onLoadMore` / 锚定 | Phase 2 新增 |
| `src/stores/conversation-store.test.ts` | LRU 淘汰边界(活跃线程不淘汰) | Phase 2 新增 |
| `electron/db/core/__tests__/database.test.ts` | 迁移 id 唯一性 + 顺序 | ✅ 326 例已含 |

### 8.2 手动验证清单

- [ ] 内置浏览器开重页(如长信息流)→ 关闭 → `app.getAppMetrics()` 中 guest 消失、缓存清空
- [ ] 隐藏浏览器标签 5 min → guest 内存回落(不整进程泄漏)
- [ ] 打开 5000+ 条会话 → DOM 节点数受控、滚动顺滑、向上翻页锚定不跳
- [ ] 访问 10 个不同线程后回第一个 → 消息按需重取,内存不随线程数累积
- [ ] `kill-dev-orphans --dry-run` 正确列出本次会话的 vitest/vite

### 8.3 指标

- [ ] 单 webview guest 稳态 **< 800 MB**(watchdog 门限)
- [ ] 隐藏标签 5 min 后 guest **< 300 MB**
- [ ] 长会话滚动 **≥ 55 FPS**;首屏装载 **< 300 ms**
- [ ] dev 会话总内存较当前 **下降 ≥ 40%**(基线 ~5.2 GB 且 guest 2.9 GB)

---

## 9. 关键决策点(提交前确认)

| # | 决策 | 默认推荐 | 替代 |
|---|---|---|---|
| 1 | 初始装载条数 | **200** | 100 / 500 |
| 2 | 隐藏标签处置 | **先 reload 到 about:blank,仍超预算才 dispose** | 直接 dispose |
| 3 | 隐藏阈值 | **5 min** | 2 min / 10 min |
| 4 | webview 预算 | **800 MB**(`DUYA_WEBVIEW_MEMORY_MB` 可调) | 512 MB |
| 5 | store 淘汰策略 | **只保活跃线程 ± LRU 少量** | 只保活跃线程 |
| 6 | P2 虚拟化库 | **@tanstack/react-virtual**(体积小、支持变高) | react-virtuoso |
| 7 | 是否 worker 化投影 | **先增量;仍卡再 worker** | 直接 worker |

---

## 10. 依赖与既有工作关系

| 既有 | 复用方式 |
|---|---|
| `webview-bridge` sessionMap | Phase 0 已挂 `setWebviewIdProvider` |
| `cookie-writer.ts` `clearPartitionData()` | 与 `releaseBrowserMemory` 分工;不动 |
| `PanelZone` active 态 | Phase 1b 隐藏判定输入 |
| `LazyMessageRow` 高度缓存 | Phase 2b 锚定复用;Phase 3 被替换 |
| `?since=` 增量历史(fetchSessionHistory) | Phase 2c LRU 回收后重取 |
| `app.getAppMetrics()` | Phase 0 watchdog;Phase 1d 可观测 |
| plan 426 `worker-limits.ts` | 不重复建设 |
| plan 330 electron 清理 | Phase 5a 脚本落点 |

---

## 11. 风险与缓解

| 风险 | 影响 | 缓解 | 阶段 |
|---|---|---|---|
| prepend 翻页导致滚动跳动 | 体验回退 | 复用高度缓存 + `containIntrinsicSize` 锚定;先 e2e 验证 | Phase 2 |
| reload 隐藏标签丢页面状态 | 用户重登录/丢表单 | 只在隐藏超时后 reload;激活时恢复 URL;可配置 | Phase 1b |
| LRU 淘汰活跃流式播放的线程 | 消息丢失 | 活跃线程 + 流式中线程**强制钉住** | Phase 2c |
| 虚拟化与流式自动滚动冲突 | 卡顿/跳动 | P2 放 P1 之后;保留 trailing-always | Phase 3 |
| 清理孤儿进程误杀 | 打断其他 agent | `--dry-run` 默认;按 profile 白名单;显式确认 | Phase 5a |
| 迁移再撞号 | 静默丢 schema | Phase 0 已加重复 id 检测(不静默) | — |

---

## 12. 验收 checklist(Master)

### Phase 0(✅)

- [x] 迁移 id 16/17 + 重复检测
- [x] `webview-memory.ts` + 接线
- [x] 13 浏览器测试 + 326 core DB 测试通过
- [x] electron tsc 新增 0 错误

### Phase 1

- [ ] 普通标签关闭也回收
- [ ] 隐藏标签超时释放生效且不丢状态
- [ ] `render-process-gone` / `memory-pressure` 有降级与日志
- [ ] webview 占用可在诊断面板看到

### Phase 2

- [ ] 初始末 200 条 + `onLoadMore` 可用(死代码复活)
- [ ] prepend 锚定不跳
- [ ] store LRU 生效;流式线程钉住
- [ ] core DB 分页查询

### Phase 3

- [ ] DOM 节点数不随会话长度增长
- [ ] 流式滚动顺滑;回归测试全绿

### Phase 4

- [ ] 投影/分组增量,append 不再 O(n) 全量

### Phase 5

- [ ] `kill-dev-orphans.mjs` 落地
- [ ] 打包版基线记录
- [ ] ARCHITECTURE.md / README 更新;plan 移 `completed/`

---

## 13. 进度记录

### 2026-09-11 — Phase 0 落地 + 草案

**已完成(实测驱动)**:

- 进程实测定位到 2.9 GB 的 `<webview>` guest(`--duya-backdrop` 缺失 + partition mtime 双证据)与消息列表无窗口化;发现 ~5.9 GB 僵尸 dev 进程。
- 直读 dev core DB 确认两处迁移被 `id <= current` 跳过:`message_search`(撞 15)、`session_runtime_locks.origin`(撞 8)。
- 修复 + `webview-memory.ts` + 接线;**326 + 13 测试全绿**,electron tsc 新增 0 错误。
- **更正早先误判**:agent 堆上限(`--max-old-space-size`)与 worker idle reaper **早已存在**(plan 426),本 plan 不重复建设。

**待评审**:§9 决策 #1–#7;Phase 1-5 时间盒(2–3 + 3–4 + 3–4 + 2 + 1–2 天 ≈ 2.5 周)是否可接受。
