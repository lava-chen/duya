# Plan 556 — RPA 事件级录制 + Computer-Use 统一框架

> **Status**: Phase 0–5 代码+单测全部落地（2026-09-21：recorder 簇 118/118、workflow 簇含
> element-matcher 全绿、IPC 簇 494/494）。**plan 内的 phase 已无待开工项**，剩余只有三处
> 「真机 Gate」待人工：Phase 1 真机冒烟、Phase 2 Chrome/记事本/微信三目标验证、
> Phase 4/5 Playwright MCP UI 冒烟 + Electron 全链路（录 → 转 → 存 → 执行 → 命中/兜底）。
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

> 2026-09-21 修复注记（无头冒烟发现）：上面「前台追踪」这条**实际从未生效**。
> `getForegroundWindowInfo()` 的 `Add-Type -MemberDefinition` 把 C# 的 DLL 名写成了
> 单引号 `[DllImport('user32.dll')]`，而 C# 里 `'user32.dll'` 是字符字面量 → Add-Type
> 报 "too many characters in character literal"，函数被自己的 catch 吞掉后恒返回 null。
> 连带 `focusWindowViaPowerShell` / `showWindowWithoutFocus` 同款写法一起失效（三处同因）。
> 后果：`currentApp` 恒为 null → `feedContext()` 回落到空 AppRef → **app_focus 事件永不产生**
> （转换出的 phase 名为空），且自窗口过滤拿不到 pid 可比对。已改为 PS 单引号串 + C# 双引号
> 并逐处加注防回归；`scripts/recorder-smoke.cjs` 现在能解析出真实前台进程名。
> 教训：focus-tracker 的 52 个单测全部走注入 query，**真实 PowerShell 从未被任何测试覆盖**。

### Phase 2 — UIA 点探测（uia-probe）

> 2026-09-21 落地注记：Mimosa 门禁对新文件任何变量路径 spawn 拦截 → probe 进程同样
> 复用 daemon 管线（daemon 补 `args`/`stdio`/`writeStdin` 扩展点）。"probe 内 Task 超时"
> 落在 ps1 的 C# Add-Type helper（Task.Run + Wait(200ms)，覆盖 FromPoint 与属性读取），
> 非 PowerShell 脚本层。客户端策略：连续 3 次请求超时视为挂死 → 回收一次，再发生即
> degraded；崩溃路径沿用 daemon 重启一次 + watcher 封顶。

- [x] `packages/computer-use/src/recorder/uia-probe-protocol.ts`（纯协议）+
      `electron/services/recorder/uia-probe.ts`（main 侧客户端）+
      `resources/recorder/uia-probe.ps1`（常驻 PowerShell 5.1，stdin/stdout JSON 行协议）：
  - [x] `probe(x,y)` → ElementDescriptor（Name/ControlType/AutomationId/ClassName/BoundingRectangle/IsPassword，
        `AutomationElement.FromPoint()`；C# helper 内 Task 超时 200ms）
  - [x] `readUrl(hwnd)` → 地址栏元素值（AutomationId 优先 + 中英文资源名各匹配 + 值形/首个 Edit fallback；
        ValuePattern 读值）
- [x] 超时 200ms（probe 内 C# Task + main Promise.race(300ms) 双保险）；失败/超时 → `source:'none'`，
      **永不阻塞录制主链路**
- [x] 点击事件异步附着（service enrich 竞速 300ms，典型 30-80ms）；probe 崩溃重启一次，再失败降级无元素录制
- [x] 空闲 5min 回收 probe 进程（下次使用重新 spawn；recycledOnce 预算随回收重置）
- [x] Gate（单测部分）：protocol/客户端（FakeProcess+stdin 捕获）/service probe 接线（element 附着、
      密码脱敏 hint、browserUrl 附着）共 12 个新单测，累计 118/118 recorder 簇全绿；
      **真机协议冒烟已过**（ping/probe 真实 UIA 元素/readUrl 优雅失败）
- [ ] Gate（真机部分）：Chrome/记事本/微信三目标人工验证（元素名/控件类型/密码框脱敏/URL 读取）——待人工

### Phase 3 — 事件 → WorkflowDef 转换器

> 2026-09-21 落地注记：schema.ts 节点新增可选 `annotation` 字段（producer 溯源载荷；
> validate.ts 刻意不扫描它——录制文本是字面量，不是模板）。`RULE_RISK_RE` 从 planner
> 导出共享（两个定义生产者同一风险分类）。som ref 为 converter 发的全局计数器
> （som:1, som:2 …），ElementDescriptor 按注 `annotation.som['som:<n>']`（Phase 4
> matcher 的输入）。附带两处超出映射表的防御：(1) 录入文本含 `${...}` 模板语法时
> validateWorkflow 会放行 `params.*` 形态（白名单 root）但回放时被静默插值损坏——
> converter 自带 guard 显式 fail（def 仍返回供预览）；(2) 同 app 焦点往返（alt-tab
> 瞬游）合并回同一段，无交互的 transit 段丢弃（warning 计数）。17 个新单测，
> workflow 簇累计 135/135。

- [x] `packages/agent/src/modes/workflow/converter.ts`（与 planner.ts 并列的定义生产者）：
  - [x] `app_focus` app 变化切 phase（≤8 由 schema 约束，超出 warning + 合并尾部）
  - [x] 每 phase 首个交互前注入 `{ do: 'capture' }`（browserUrl 变化同样注入，去重防背靠背）
  - [x] click → `{ do: 'click', element: 'som:<n>' }` + 节点 annotation 携带 ElementDescriptor
  - [x] type → `type_text`（密码脱敏文本照录 + `paramHint: true` 标注）；组合键 → `key`；scroll → `scroll`
  - [x] 不可逆检测：元素名/文本命中 planner 同款 `RULE_RISK_RE` 或 controlType ∈ {MenuItem} 命中 → 前插
        `human` 审批节点（timeout.on_timeout 必填，`fail`）
- [x] 产物走 `validateWorkflow`（与 planner 产物同权、同校验）
- [x] Gate：converter 单测（fixture 事件流 → YAML 结构断言 + schema 校验通过 + human 节点插入 case）

### Phase 4 — 回放匹配 element-matcher

> 2026-09-21 落地注记：matcher 是纯函数（无 IO），三层按 L1→L2→L3 短路，命中即停。
> 关键语义：converter 发的 `som:<n>` 是**录制会话内**的全局计数器，而 fresh capture 的
> SOM 索引只在本次 capture 内有效（`backend/types.ts`：新 capture 让旧索引失效）——
> 所以 matcher 的职责是把「录制期 ref」重新解析为「本次 capture 的索引」，逐 capture
> 重解析，不跨 capture 复用。L1 只用大小写/空白归一（不做模糊/同义词，"一键" ≠ "一 键"
> 之外的猜测交给 L3 agent，避免假精确）；L2 用帧对角线比例做预算（两帧都已知才投影，
> 未知则退化为绝对 120px 阈值）。L3 不自行兜底，而是把节点送回既有的 `on_stuck` 阶梯，
> 复用 552 的 agent 接管路径。

- [x] `packages/agent/src/modes/workflow/element-matcher.ts`：
  - [x] L1：ElementDescriptor.name ↔ fresh SOM label 精确匹配（axSource='uia'/'msaa' 优先；
        多命中取 rect 中心距录制坐标最近）→ confidence 'exact'
  - [x] L2：窗口归一化比例位置最近邻 → 'approx'
  - [x] L3：失败 → `on_stuck: 'agent'` 路由 + 'agent-fallback'
- [x] gui-runner 接入：phase 首个 capture 后，后续 `som:<n>` 引用先过 matcher 解析
- [x] matcher 结果进 evidence（confidence 映射 552 的 verified/unconfirmed 标注）
- [x] Gate：matcher 命中矩阵单测（三层全路径）；gui-runner 回归测试绿

实现要点（超出原 plan 的部分）：
- `GuiBackendPort.capture` 返回值从纯 base64 扩成 `GuiCaptureResult { base64, width?, height?, elements? }`
  —— matcher 需要同帧的元素表与帧尺寸才能做 L1/L2；这是接口形状变更，已同步
  `GuiStepResult.frame` 与 gui-runner 的 `readFrame`。
- `GuiRunOptions.annotation` 承载 recorder 注入的 `som` 映射（由 `node-runner` 从
  `ctx.node.annotation` 透传）；`RecorderNodeAnnotationSchema.safeParse` 校验，脏 annotation
  当「无录制溯源」处理而不是抛错——旧 workflow 定义（无 annotation）走原有历史路径不变。
- L3 与 `degraded`（后端降级）都不会静默通过：L3 走 `enterLadder(on_stuck)`，
  degraded 把 verification 强制降为 unconfirmed，两者都写 `match` evidence 行留痕。

### Phase 5 — IPC + UI 接线

> 2026-09-21 落地注记：文件名按既有约定落在 `electron/ipc/recorder-handlers.ts`
> （plan 写的是 `recorder.ts`，与 `workflow-handlers.ts` / `logger-handlers.ts` 的
> `-handlers` 后缀对齐，避免同一目录两套命名）。UI 没有新开独立管理窗口，而是把
> `AutomationPage` 改成 tab 外壳（定义库 | 录制会话），复用 `PageFrame/PageHeader/
> PageTabs/PageCard/EmptyState` —— 与「主窗口统一 UI 框架」的既定方向一致，
> 也符合 552「定义只读、编辑走对话」的原则（转换产物经 YAML 预览确认后才经
> `workflow:defs:create` 入库，recorder handler 自己不写盘）。

- [x] `electron/ipc/recorder-handlers.ts`：`recorder:start/stop/status/get-session/list-sessions/delete-session`
      （跟随 `workflow:*` 风格；preload / `src/lib` renderer 类型三处同步 —— CodeReviewPanel 的教训）
- [x] 录制 badge：独立置顶 overlay（时长 + 事件计数 + 停止/取消），非对话框
- [x] 落点接 workflow 管理界面（552 WorkflowPanel 重设计方向，独立管理界面而非侧栏 tab）：
  - [x] 会话列表 + 事件时间线（渐进披露：行 → 元素详情，交互范式与 run 详情一致）
  - [x] 「转换为 workflow 定义」→ converter → YAML 预览 → 确认入库
- [ ] Gate：handler 单测（`electron/ipc/__tests__/`，mock 模式对齐 logger-handlers.test.ts）
      + Playwright MCP UI 冒烟 + Electron 真机全链路手动验证
      （录 → 转 → 存 → 执行 → ≥1 步 verified + 1 步人为改名后 agent 兜底 unconfirmed）

Gate 明细：handler 单测 `recorder-handlers.test.ts`（12 测，mock 对齐 logger-handlers 模式，
含 `vi.hoisted` 共享 mock 与 `importOriginal` 局部 mock 以保留真实 schema）、
UI 测试 `src/components/recorder/RecorderView.test.tsx`（6 测）均绿；
**Playwright MCP UI 冒烟与 Electron 真机全链路验证待人工执行**（需真实桌面与
uiohook 钩子，无法在无头环境自动化）。

额外接线：`recorder:cancel`（plan 未列，但 badge 的「取消」按钮需要——语义是
stop 后连会话一起丢弃）、`recorder:convert`（转 YAML 预览，不落盘）、
`electron/services/recorder/badge.ts`、graceful-shutdown 释放 recorder 服务与 badge。

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
