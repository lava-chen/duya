# 低配机器性能优化 (Low-Spec Performance)

> **Status**: In Progress (Phase 1-6 code done + 单测全绿；待办：6.4 冷启动手测、Electron 内 UI 走查)
> **Priority**: P1
> **Created**: 2026-08-16
> **Depends on**: 无（Phase 1/2 独立收益；Phase 3+ 依赖 Phase 3 的 lowPower 开关）

---

## 背景：代码级审计结论

目标：让 DUYA 在低配机器（≤4 核 / ≤8GB 内存 / 集显）上可用。
现状审计发现自适应机制只覆盖了部分资源消耗点：

### 问题 A：Worker 并发上限硬编码，与内存预算脱节 — 最大瓶颈

- `electron/agents/server/router.ts:268` / `:1012`：`MAX_CONCURRENT_WORKERS = 16` 硬编码
- `electron/agents/server/worker-manager.ts:57`：每 worker 内存上限默认 2048MB（`DUYA_WORKER_MAX_MEMORY_MB`）
- `electron/agents/server/router.ts:255` / `:1094`：内存告警阈值 0.98 —— 系统内存用到 98% 才拒绝新任务，低配机器早已换页卡死
- 对比：进程池已有自适应 `calculateMaxConcurrent()`（`electron/agents/process-pool/process-manager.ts:34`，CPU/2 + 空闲内存上限，最低 1），但 **worker 上限没接这套逻辑**

### 问题 B：Worker 无空闲回收

- `electron/agents/server/worker-manager.ts` 只在替换/显式 kill 时退出进程，会话结束后 worker 挂着不退
- lazy-spawn 路径已存在（`router.ts:1069`，compact 场景在用）→ 补 idle TTL + 自动回收成本不高

### 问题 C：渲染端轮询密集且不区分可见性

常驻 `setInterval`（页面隐藏/组件不可见时照跑）：

| 位置 | 间隔 | 用途 |
| --- | --- | --- |
| `src/components/chat/ChatView.tsx:170` | 1.5s | 浮动任务面板轮询 |
| `src/components/chat/ChatView.tsx:701` | 3s | 父线程消息轮询（已有 phase 门控） |
| `src/components/bridge/GatewayDashboard.tsx:61` | 5s | gateway 全量刷新 |
| `src/components/bridge/ChannelSessionsDialog.tsx:76` | 3s | 会话列表 |
| `src/components/automation/CronChatModal.tsx:102` | 2s | cron 消息 |
| `src/hooks/useGitStatus.ts:74` | 轮询 | git 状态 |
| `src/hooks/useBrowserExtension.ts:216` | 轮询 | 扩展连接检测 |
| `src/components/chat/StreamingMessage.tsx:96` | 1s | 流式计时 ticker |
| `src/components/chat/tools/hooks/useTopLevelChrome.tsx:31` | 1s | chrome 工具 ticker |
| `src/components/chat/tools/rows/BashToolRow.tsx:58` | 1s | bash 运行计时 |

### 问题 D：渲染端固定负载

- `src/components/chat/CodeBlock.tsx:4`：完整版 `Prism`（全语言语法打进 bundle 并注册）
- `src/components/layout/app-shell.tsx:16`：全项目仅 OnboardingFlow 一处 `lazy()`；Conductor/Canvas、Code Review、Office、Settings 均急切加载
- `src/styles/globals.css`：十几处 `backdrop-filter: blur(4px~22px)`（`:632` 最重 22px）—— 集显掉帧主因之一

### 问题 E：主进程常驻服务不分场景全速跑

- `electron/memory/memory-worker.ts:394`：tick 最小 1s；`:214` catalogSync 60s
- `electron/services/performance-monitor.ts`：常驻采样 + 60s 导出 + 内存泄漏检测（5min 窗口）
- browser daemon / CLI api server / updater 等在启动路径上即起

### 已确认无需处理的

- MessageList 已窗口化 + memo（`src/components/chat/MessageList.tsx:37`）
- SQLite 已 WAL + busy_timeout + 60s 被动 checkpoint（`electron/db/core/database.ts:43`）
- Vite vendor 分包 + terser 已有（`vite.config.ts:64`）

---

## 设计总览

```
Phase 1-2（无开关，对所有人收益）        Phase 3（基建）         Phase 4-6（挂到开关下）
┌──────────────────────────┐   ┌──────────────────────┐   ┌──────────────────────────┐
│ worker 上限自适应 + 内存阈值 │   │ performance.lowPower │──►│ 轮询治理 / 渲染减负 /     │
│ worker idle 回收           │   │ 配置 + 自动检测 + 传播 │   │ 主进程服务降频延后        │
└──────────────────────────┘   └──────────────────────┘   └──────────────────────────┘
```

---

## Phase 1 — Worker 并发自适应 + 内存阈值（独立收益）

- [x] 1.1 `router.ts` 两处 `MAX_CONCURRENT_WORKERS = 16` 改为动态计算：复用/泛化 `calculateMaxConcurrent()`（搬到 worker-manager 或共享 util），叠加总内存预算（`os.totalmem() < 8GB` → 上限 2；`< 16GB` → 4；否则 8~16）（`electron/agents/server/worker-limits.ts` `calculateMaxConcurrentWorkers()`）
- [x] 1.2 `MEMORY_THRESHOLD` 0.98 → 0.90（两处：`router.ts:255` / `:1094`），保留 env 覆盖
- [x] 1.3 worker 内存上限按总内存分档（2048 默认 → 低配 1024）
- [x] 1.4 单测：mock `os.totalmem()`/`cpus()` 验证上限分档（`electron/agents/server/__tests__/worker-limits.test.ts`）

**验证**：`npm run test` 相关用例 + `npm run typecheck:all`

## Phase 2 — Worker 空闲回收（独立收益）

- [x] 2.1 worker-manager 增加 idle 跟踪：最近活动时间（收到 worker 消息/SSE 输出即刷新）
- [x] 2.2 idle TTL 默认 10min，到期 `killWorker()`；后续请求走已有 lazy-spawn 路径（`router.ts:1069` 同款）（lowPower 下 TTL 3min）
- [x] 2.3 回收与保活冲突排查：cron/共享会话（plan 237/409 方向）、SubAgent 父子、gateway 长连接场景不受误杀；必要时 per-session `keepAlive` 标记豁免（`keepAliveSessions` + `markKeepAlive()`）
- [x] 2.4 日志：回收事件 INFO 一条（sessionId、idleMs），便于线上观测
- [x] 2.5 单测：idle 触发回收 / 活动刷新不回收 / keepAlive 豁免（`electron/agents/server/__tests__/worker-idle-recycle.test.ts`）

**验证**：`npm run test` + 手动：会话闲置 10min 后任务管理器确认 agent 进程退出，再发消息确认 lazy-spawn 恢复

## Phase 3 — lowPower 开关基建

- [x] 3.1 ConfigStore 增加 `performance.lowPower: 'auto' | 'on' | 'off'`（默认 `auto`；`electron/config/store.ts` schema + 默认值）（`PerformanceConfig` in `electron/config/schema.ts`）
- [x] 3.2 auto 判定：`os.totalmem() < 8GB || os.cpus().length <= 4` → 开启；判定结果在主进程启动时算一次并缓存（`electron/services/low-power.ts` `detectLowSpecHardware()`）
- [x] 3.3 传播：渲染端经 `useSettings`（`src/hooks/useSettings.ts`）可读；主进程内服务经 ConfigStore 直读 + config 变更订阅（对齐 `agent-process-pool.ts:77` provider snapshot 模式）（渲染端 `src/stores/low-power-store.ts`，主进程 `initLowPower()` + `DUYA_LOW_POWER` env 传给 agent server/worker）
- [x] 3.4 Settings UI 增加三态开关（Performance 区块）（`src/components/settings/PerformanceSection.tsx`）
- [x] 3.5 生效范围约定（文档写进本 plan，实现放各 Phase）：
  - worker 上限 → min(Phase 1 计算值, 2)
  - idle TTL → 3~5min
  - 轮询间隔 ×4（Phase 4）
  - backdrop-filter 降级（Phase 5）
  - memory-worker / performance-monitor 降频（Phase 6）

**验证**：Playwright MCP 验证 Settings 开关 + 切换后渲染端收到变更

## Phase 4 — 渲染端轮询治理

- [x] 4.1 新 hook `usePolling(fn, intervalMs, opts)`：`document.hidden` 暂停、`opts.activeWhen`（如弹窗打开/流式中）不满足不跑、lowPower 下 interval ×4、立即首跑（`src/hooks/usePolling.ts`）
- [x] 4.2 迁移上表 10 处调用点（`ChatView.tsx` 两处、GatewayDashboard、ChannelSessionsDialog、CronChatModal、useGitStatus、useBrowserExtension、AgentBrowserTab、三个 1s ticker 加"流式结束/不可见即停"）
  - 已迁移 8 处：ChatView ×3（任务面板 1.5s / 父线程 3s / attach 轮询 2s）、GatewayDashboard 5s、ChannelSessionsDialog 3s、useGitStatus、useBrowserExtension、StreamingMessage/BashToolRow 1s ticker（`useTopLevelChrome` 的 ticker 组件随挂载/卸载启停，等同门控）
  - 豁免 2 处（自终止型探测，非周期轮询）：AutomationView 的 bridge 等待重试（100ms × 50 次上限）、AgentBrowserTab 的 webview 就绪探测（250ms，成功即自清除）——usePolling 无自停止语义，套用反而产生常驻 timer
  - 注：CronChatModal 已重构并入 AutomationView
- [x] 4.3 可事件化的轮询登记后续项（不本 phase 做）：任务状态走既有 task SSE、git status 走文件 watcher
- [x] 4.4 单测：visibilitychange 暂停恢复、倍率生效、activeWhen 门控（`src/hooks/__tests__/usePolling.test.ts`，9 用例）

**验证**：`npm run test` + Playwright MCP：切后台 tab 后 DevTools Performance 无周期性 IPC 唤醒

## Phase 5 — 渲染端固定负载削减

- [x] 5.1 `CodeBlock.tsx` 换 `PrismLight` + `registerLanguage`（常用 10~15 种：ts/tsx/js/jsx/json/py/rs/go/java/c/cpp/cs/sh/bash/sql/html/css/css-yaml/md/diff，够用为准），bundle 前后体积记录进本 plan（集中注册 `src/lib/prism-languages.ts`，19 语言；`FilePreviewPanel.tsx` 同步切换——它也在静态引完整版 Prism；未注册语言 fallback 纯文本渲染已确认）
- [x] 5.2 重面板 `React.lazy` + Suspense：Conductor/Canvas、Code Review（`src/components/layout/panels/`）、Office workspace、Settings；registry（`panels/registry.ts`）天然是挂载点（registry 挂载点 lazy 化 SidebarConductorView / CodeReviewPanel / OfficePanel + PanelZone Suspense 占位；Settings 不在 registry 注册（侧栏视图非面板），未 lazy 化；files/terminal/browser/preview 常用或需即时挂载，保留急切）
- [x] 5.3 lowPower 下 `backdrop-filter` 降级：根节点 `data-lowpower` 属性 + globals.css 覆盖为纯色半透明（重点 `globals.css:632` 22px、`:8016` 12px 两处大模糊）（globals.css 末尾新增 `[data-lowpower]` 段：memory-popover/conductor 22~20px → `var(--panel-bg-solid)` 纯色；app-header/hero-card/surface-card → `var(--main-bg)`；overlay 加深 0.6；`[data-lowpower] *` 兜底关停其余 blur；亮暗主题自适应）
- [x] 5.4 首屏 chunk 体积前后对比（`npm run build` 产物表）记录进本 plan：

  | chunk | 改动前 | 改动后 | 差值 |
  | --- | --- | --- | --- |
  | vendor-markdown | 809.24 kB (gzip 270.14) | 266.68 kB (gzip 75.88) | **−542.56 kB（−67%），gzip −72%** |
  | index 主 chunk | 2,817.62 kB (gzip 737.57) | 2,793.48 kB (gzip 730.54) | −24.14 kB |
  | SidebarConductorView / OfficePanel / CodeReviewPanel | — | 3.03 / 7.97 / 15.53 kB | 按需懒加载，移出首屏 |

**验证**：`npm run build` + Playwright MCP 走查各面板首开正常、暗色/亮色下低配样式正常

## Phase 6 — 主进程服务降频/延后（lowPower 下）

- [x] 6.1 memory-worker：lowPower 下 tick 下限 5s、catalogSync 5min（`memory-worker.ts:204` 配置项已存在，接开关即可）（`applyLowPowerOverrides()` 纯函数 + main.ts 调用点接 `isLowPowerEnabled()`；单测 `memory-worker.low-power.test.ts` 4 用例）
- [x] 6.2 performance-monitor：lowPower 下关闭内存泄漏检测采样与导出（仅保留计数器）（导出 tick 内 per-tick 检查 `isLowPowerEnabled()`，支持运行时切换；单测 `services/__tests__/performance-monitor.test.ts` 3 用例）
- [x] 6.3 非关键服务延后到 `ready-to-show` 之后启动：browser daemon、CLI api server、updater 定时器（`electron/main.ts` 启动编排，注意 plan 330 正在做 main.ts 下沉，改前对齐）（plan 330 仍 Planning 未动 main.ts；browser daemon + CLI api server 移入 `runAfterWindowReady()`（did-finish-load 后）；updater 已在 `window-manager.ts` did-finish-load 挂载且带 INITIAL_CHECK_DELAY，无需改动）
- [ ] 6.4 冷启动时间前后对比（dev 与 packaged 各测一次）记录进本 plan（手测项，待办）

**验证**：packaged 冷启动手测 + `app.log` 确认服务启动顺序

## Phase 7 — 待办池（可选，单独评估再做）

- SQLite `cache_size` / `mmap_size` 调优；plan 329 完成后旧库不再同开
- 流式期间纯文本、finalize 后再渲染 markdown（实施前先确认 StreamingMessage 每 chunk 是否全量 re-parse）
- Electron `appendSwitch`（主进程 old-space、旧 GPU 合成降级）—— 需实测有收益再上

---

## 风险

| 风险 | 应对 |
| --- | --- |
| idle 回收误杀 cron/共享会话/subagent 父会话 | Phase 2.3 keepAlive 豁免 + 场景清单逐一排查 |
| 轮询改事件驱动的范围失控 | Phase 4 只做 hook 收口，事件化登记到 4.3 不实现 |
| lowPower 判定在机器休眠/外接内存变化后过期 | 启动算一次即可，不做热重载；文档注明 |
| Phase 6.3 与 plan 330（main.ts 启动编排下沉）冲突 | 改动前读 330 现状，编排调整尽量落在 330 之后的结构上 |
| PrismLight 漏语言导致代码块无高亮 | 保留 fallback（未注册语言纯色渲染）；语言清单按实际会话统计补 |

## 完成标准

- 8GB/4 核机器：闲置 15min 后无 agent worker 进程驻留；主进程+渲染端内存稳定
- 切后台 5min：渲染端无周期性 IPC 唤醒（Performance 面板确认）
- bundle：vendor-markdown chunk 显著缩小（记录数字）；首屏 lazy 面板不阻塞主 chunk
- `npm run typecheck:all` + `npm run test` 全绿；UI 变更过 Playwright MCP

---

## 验证记录 (2026-08-17)

### 单测

- plan 426 新增测试全绿：worker-limits (26) + worker-idle-recycle (5) + memory-worker.low-power (4) + usePolling (9) + performance-monitor (3)
- 责任范围内组件测试修复至全绿：
  - `CodeReviewPanel.test.tsx` 重写为 scoped API（getGitReviewScoped/getGitCommits、新 scope 标签、inline patch），9/9 通过（新增 commit-scope 用例）
  - `OfficePanel.test.tsx` 以真实 zh 字典 mock `useTranslation`，2/2 通过
  - `MessageInput.test.tsx` 更新 plan-423 session 级 research 语义、移除已删 ModelSelector 用例，7/7 通过
  - `src/types/mode-id.test.ts` 同步 research='session' 期望，9/9 通过
- 删除过时测试 `ChatView.permission-race.test.tsx`：其验证的手动权限切换 UI 与竞态防护代码已在 cfc42940 整体移除（permissionProfile 硬编码 'auto'），测试在 HEAD 即崩溃
- `npm run typecheck:all` 通过

### 已知预存失败（非本 plan 引入，属其他在途工作）

- `getMainButtonState`/`useProviderCardState`/`ProviderManagement`/`ProviderList`（provider 按钮文案 'Enable'→'Set as default' 未同步测试）
- `FileEditToolRow`（Edited/Created 文案 i18n 化）、`PermissionPrompt` AskUserQuestion（'Submit' 文案）、`AttachmentBar` 截图预览卡、`usePanel.resolvePanelWidth`（面板宽度重构断言漂移）、`buildGroupSummary` locale fallback
- `packages/agent` gateway prompt / mcp security / DuyaAgent integration / cli-control-plane 等（其他 plan 在途改动）

### UI 走查状态

- Vite dev server 在当前 agent 沙箱内首请求挂起（依赖预优化写入受限），浏览器走查未完成
- lazy 面板渲染已由组件单测覆盖（CodeReview/Office 直挂载）；`data-lowpower` 纯 CSS 生效路径简单
- 待人工在 `npm run electron:dev` 中走查：面板首开、亮/暗主题下 lowPower 样式、Settings Performance 开关（AGENTS.md：browser-only Vite 本就无法验证 preload 路径）
