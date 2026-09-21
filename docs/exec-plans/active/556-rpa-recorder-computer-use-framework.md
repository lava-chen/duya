# Plan 556 — RPA 事件级录制 + Computer-Use 统一框架

> **Status**: Phase 0–1 代码+单测落地（2026-09-21，86/86 单测）；Phase 1 真机冒烟待人工；Phase 2 起待开工
> **Priority**: P0
> **设计文档**: [docs/design-docs/2026-09-20-rpa-recorder-design.md](../../design-docs/2026-09-20-rpa-recorder-design.md)（技术决策 D1-D6、组件图、失败模式表均以设计文档为准，本 plan 是任务拆解）
> **定位**: plan 552 workflow 体系的定义生产第三通道。与 454（computer-use mode）、519（harness gaps）、551（Jev decide）、415/552（workflow RPA）共同构成完整的 computer-use 五腿框架（capture / plan / record / execute / verify）。
> **范围红线**: MVP 仅 Windows。macOS 需 CGEventTap + AXUIElement 全套重写，明确 out of scope。

## 1. 背景与动机

duya 已有 workflow 体系（552 Phase 0-7 落地），但定义只能由 LLM 生成（planner.ts：goal → YAML）。
用户明确要求：**事件级 RPA 录制** —— 精确捕获「点了哪个按钮、在哪个输入框输了什么、浏览器 URL、打开了哪个 app」，
而非录屏回看（Grok Bot teach-recording 方案，已调研并否决作为主路线，见设计文档 §2）。

事件级录制的产物直接映射 gui 节点（capture/click/type_text/set_value/key/scroll），
精度远高于 LLM 猜测，且与 552 六类节点体系天然对齐。

## 2. 统一框架总览

```
┌─────────────────────────────────────────────────────────────────┐
│                  duya Computer-Use 统一框架                       │
├─────────────────────────────────────────────────────────────────┤
│  capture   SOM 截图 + AX 树第二通道        ✅ 454/519 已有        │
│  plan      LLM goal → WorkflowDef YAML    ✅ 415/552 planner     │
│  record    人类演示 → 事件流 → YAML 草稿   🆕 556 本 plan         │
│  execute   gui-runner → DesktopBackend    ✅ 552 Phase 3         │
│  verify    verdict 三态 + 审批门          ✅ 519/551/498         │
└─────────────────────────────────────────────────────────────────┘
```

**两条定义生产通道**（plan 与 record）汇入同一 `validateWorkflow`（schema.ts），
**record 与 execute 之间**由新组件 `element-matcher` 桥接（录制描述符 → 回放时 fresh SOM 索引）。
匹配失败走 gui 节点已有的 `on_stuck: 'agent'` 降级 —— AI 兜底是框架既有能力，不新增。

## 3. 技术决策摘要（详见设计文档 §2 D1-D6）

| # | 决策 |
|---|------|
| D1 | 事件级捕获，不做录屏 |
| D2 | **钩子跑独立 Node 子进程**（hook-worker）—— uiohook-napi 原生 prebuild 按 Node ABI 分发，Electron ABI 119 下大概率需 electron-rebuild（引入 MSVC 工具链）；子进程方案零重编 + 崩溃隔离 + 干净停止 + 复用仓库 daemon 子进程模式 |
| D3 | 钩子库 `uiohook-napi`（`uIOhook.on('mousedown'/'keydown'/'wheel')`，事件只带 keycode 无 char） |
| D4 | UIA 点探测 = 常驻 PowerShell 5.1 子进程 + `System.Windows.Automation`（仓库已有 PowerShell 惯例） |
| D5 | 浏览器 URL 自采（active-win 的 url 字段仅 macOS），并入 uia-probe `readUrl` |
| D6 | 键盘文本还原：keycode+shift → 字符映射表；非美式布局降级 `<key:N>` 占位符 |

## 4. Phases

### Phase 0 — 契约与地基（不动行为）

- [x] `packages/computer-use/src/recorder/events.ts`：RecorderEvent zod schema + AppRef/ElementDescriptor
      （ElementDescriptor.rect 复用 backend/types.ts 的 Bbox；`source: 'uia-probe' | 'none'`）
- [x] 隐私策略常量：`recorder.blockedApps` 默认值（密码管理器进程名）、自窗口过滤规则、脱敏规则
      （IsPassword → text 置 `"<redacted>"` + keycode buffer 丢弃）
- [x] `session.json` / `events.jsonl` 文件格式契约 + `session-store.ts`
      （串行 append 写；读取器丢弃末尾残缺行；路径 `~/.duya/recorder/sessions/<id>/`）
- [x] Gate：schema 单测（含脱敏 case）+ session-store 单测（残行容错）绿
      （commit 6f53e8a3，34/34 单测）

### Phase 1 — 捕获层（hook-worker 子进程 + main 聚合）

> 2026-09-21 落地注记：D2 修订——uiohook-napi 实为 `prebuildify --napi`（ABI 无关），
> 无需 electron-rebuild；worker 复用 `computer-use-daemon.ts` 的 spawn/心跳/重启管线
> （`ELECTRON_RUN_AS_NODE=1` + 90s dead-man），经 `createComputerUseDaemon` 工厂 +
> `onStdoutLine`/`env` 扩展点接入。自过滤落在 recorder-service（主进程 pid 判定），
> 因纯 Node 子进程无法访问 `BrowserWindow`。

- [x] 依赖：`uiohook-napi` 加入 `@duya/computer-use`（N-API prebuild 直接可用，无需 electron-rebuild —— D2 修订）
- [x] `packages/computer-use/src/recorder/hook-worker-entry.ts`：
      mousedown/keydown(+keyup)/wheel 事件 → 单行 JSON 到 stdout（**mousemove 不出子进程**）；
      30s 心跳行（`type:'heartbeat'`，对齐 daemon dead-man）；`--self-test` 冒烟模式；
      keycode→char 映射在 keymap.ts（映射不出由聚合器记 `<key:${keycode}>`）
- [x] `electron/services/recorder/hook-worker.ts`：复用 daemon spawn 生命周期 + 心跳超时（90s）
      + 崩溃重启一次（watcher 按 restartCount 增量判定，第二次失败即 stop + onFailed）
- [x] `electron/services/recorder/service.ts`：start/stop 单飞状态机
      （starting/recording/stopping/idle + degraded 标记）；
      10 分钟默认上限 + 到时自动停；append 串行链保证事件落盘顺序
- [x] `packages/computer-use/src/recorder/aggregators.ts`（纯函数）：
  - [x] 键盘聚合状态机：idle→typing→flush；截断条件 = 焦点变化 / click / 2s 静默 / 组合键
  - [x] 组合键判定直接读 uiohook 事件 flags（ctrl/alt/meta 按住 = key 事件不混入文本；
        修饰键本身不产生占位符，无独立 keyup 状态机）
  - [x] Enter/Tab 等命名键 → 独立 `key` 事件 + 截断
  - [x] 滚轮 500ms 同向 debounce 合并（rotation>0=down，libuiohook 已反转 Windows 增量）；
        mousedown/up 对 → `click`（OS clicks 计数合并 count=2；4/5 侧键丢弃）
- [x] 前台追踪：`getForegroundWindowInfo()`（computer-use-backend.ts，PowerShell 单窗查询）+
      `recorder/focus-tracker.ts` 500ms 轮询（变化才上报：hwnd/pid/title）
- [x] 自过滤：主进程 pid 命中 → 丢事件 + 不记 app_focus（badge 操作不录）；
      `shouldDropEventForApp` 密码管理器黑名单过滤
- [x] 打包接线：extraResources `resources/computer-use/`（worker entry + keymap + type:module
      标记 + node_modules/uiohook-napi）
- [x] Gate（单测部分）：keymap/worker-protocol/aggregators/hook-worker/focus-tracker/service
      共 52 个新单测全绿（累计 86/86 含 Phase 0）；daemon 既有 11 测回归绿
- [ ] Gate（真机部分）：electron:dev 真机冒烟（记事本录制出事件流）——待人工验证

### Phase 2 — UIA 点探测（uia-probe）

- [ ] `packages/computer-use/src/recorder/uia-probe-client.ts`（main 侧）+
      `resources/recorder/uia-probe.ps1`（常驻 PowerShell 5.1，stdin/stdout JSON 行协议）：
  - [ ] `probe(x,y)` → ElementDescriptor（Name/ControlType/AutomationId/ClassName/BoundingRectangle/IsPassword，
        `AutomationElement.FromPoint()`）
  - [ ] `readUrl(hwnd)` → 地址栏元素值（Chrome/Edge/Firefox；中英文资源名各匹配一次 + 文档树首个 Edit fallback）
- [ ] 超时 200ms（probe 内 Task + main Promise.race 双保险）；失败/超时 → `source:'none'`，**永不阻塞录制主链路**
- [ ] 点击事件异步附着（30-80ms 预算）；probe 崩溃重启一次，再失败降级无元素录制
- [ ] 空闲 5min 回收 probe 进程（下次录制重新 spawn）
- [ ] Gate：probe 协议单测（mock 子进程）+ 真机手动验证（记事本/Chrome/微信三目标：
      元素名/控件类型/密码框脱敏/URL 读取）

### Phase 3 — 事件 → WorkflowDef 转换器

- [ ] `packages/agent/src/modes/workflow/converter.ts`（与 planner.ts 并列的定义生产者）：
  - [ ] `app_focus` app 变化切 phase（≤8 由 schema 约束，超出 warning + 合并尾部）
  - [ ] 每 phase 首个交互前注入 `{ do: 'capture' }`
  - [ ] click → `{ do: 'click', element: 'som:<n>' }` + 节点 annotation 携带 ElementDescriptor
  - [ ] type → `type_text`（密码脱敏文本照录 + `paramHint: true` 标注）；组合键 → `key`；scroll → `scroll`
  - [ ] 不可逆检测：元素名/文本命中 planner 同款 `RULE_RISK_RE` 或 controlType ∈ {MenuItem} 命中 → 前插
        `human` 审批节点（timeout.on_timeout 必填）
- [ ] 产物走 `validateWorkflow`（与 planner 产物同权、同校验）
- [ ] Gate：converter 单测（fixture 事件流 → YAML 结构断言 + schema 校验通过 + human 节点插入 case）

### Phase 4 — 回放匹配 element-matcher

- [ ] `packages/agent/src/modes/workflow/element-matcher.ts`：
  - [ ] L1：ElementDescriptor.name ↔ fresh SOM label 精确匹配（axSource='uia'/'msaa' 优先；
        多命中取 rect 中心距录制坐标最近）→ confidence 'exact'
  - [ ] L2：窗口归一化比例位置最近邻 → 'approx'
  - [ ] L3：失败 → `on_stuck: 'agent'` 路由 + 'agent-fallback'
- [ ] gui-runner 接入：phase 首个 capture 后，后续 `som:<n>` 引用先过 matcher 解析
- [ ] matcher 结果进 evidence（confidence 映射 552 的 verified/unconfirmed 标注）
- [ ] Gate：matcher 命中矩阵单测（三层全路径）；gui-runner 回归测试绿

### Phase 5 — IPC + UI 接线

- [ ] `electron/ipc/recorder.ts`：`recorder:start/stop/status/get-session/list-sessions/delete-session`
      （跟随 `workflow:*` 风格；preload / `src/lib` renderer 类型三处同步 —— CodeReviewPanel 的教训）
- [ ] 录制 badge：独立置顶 overlay（时长 + 事件计数 + 停止/取消），非对话框
- [ ] 落点接 workflow 管理界面（552 WorkflowPanel 重设计方向，独立管理界面而非侧栏 tab）：
  - [ ] 会话列表 + 事件时间线（渐进披露：行 → 元素详情，交互范式与 run 详情一致）
  - [ ] 「转换为 workflow 定义」→ converter → YAML 预览 → 确认入库
- [ ] Gate：handler 单测（`electron/ipc/__tests__/`，mock 模式对齐 logger-handlers.test.ts）
      + Playwright MCP UI 冒烟 + Electron 真机全链路手动验证
      （录 → 转 → 存 → 执行 → ≥1 步 verified + 1 步人为改名后 agent 兜底 unconfirmed）

## 5. 依赖与风险

| 风险 | 缓解 |
|------|------|
| 管理员权限窗口收不到钩子（UIPI） | MVP 不支持，文档声明；未来可选 uiAccess manifest |
| uiohook-napi Node prebuild 缺失 | hook-worker 跑系统 Node ABI（D2 规避 Electron ABI）；`npm install` 后 node 侧冒烟在 Phase 1 Gate 前置验证 |
| PowerShell UIA 探测延迟毛刺 | 异步附着 + `source:'none'` 降级，永不阻塞录制主链路；后期可换 C++ N-API addon（接口不变） |
| 回放跨分辨率/主题失效 | L2 相对位置 + L3 agent 兜底；confidence 进 evidence 标注体系 |
| 隐私（键盘全文捕获） | 显式开启 + badge 常显可停 + IsPassword 脱敏 + 自窗口/黑名单过滤 + 内容不进 app.log |
| 非 CJK/EN 应用资源名差异 | readUrl fallback 链（资源名两语言 → 首个 Edit）；失败省略 browserUrl |
| daemon（v0.4）生命周期耦合 | recorder 不依赖 daemon —— UIA 走自建 probe，前台走自建轮询；daemon 未来可做增强源 |

## 6. 明确不做（out of scope）

- macOS / Linux 捕获层（框架接口留 `platform` 字段）
- 可视化流程编辑器（定义只读，编辑走对话 —— 552 原则）
- 录屏视频流（Grok Bot 路线，非事件级）
- 参数模板化（常量文本自动抽 params）→ MVP 只标注 `paramHint`
- Excel 单元格级等深层数据读取（UIA 只能拿到点中元素）

## 7. 验收标准（MVP Definition of Done）

1. 用户点「开始录制」→ 在 Chrome 打开网页、点按钮、输入文字、切到记事本输入 → 停止。
2. workflow 管理界面出现会话：事件时间线含两个 phase（Chrome/记事本）、浏览器 URL、按钮点击的元素名、输入文本；含一个密码框脱敏 case（text=`<redacted>`）。
3. 一键转换生成合法 WorkflowDef（validateWorkflow 通过，含 capture/click/type_text/key 步骤 + 不可逆动作触发 human 节点 case）。
4. 执行该定义：gui-runner 全链路跑通，≥1 步 matcher L1 命中（verified），1 步人为改名后走 agent 兜底（unconfirmed）。
5. 全程 app.log 无任何输入内容泄漏（只有计数与状态迁移）。
