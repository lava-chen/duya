# Plan 453: Wake Agent — 全局快捷键唤起 + OS 上下文注入

> **Status**: 草案(Draft) — 待评审
> **Priority**: P0
> **Created**: 2026-08-28
> **Spec**: [`docs/product-specs/wake-agent-and-computer-use-mode.md` §3](../../product-specs/wake-agent-and-computer-use-mode.md)
> **相关 plan**: [454-computer-use-mode](./454-computer-use-mode.md)(共享 OSContextBridge + 后续 mode 注册)、[224-mode-architecture-unification](../completed/224-mode-architecture-unification.md)(ModeModifier 基座)、[426-hook-loop-bus](../completed/426-hook-loop-bus.md)(hook runtime-context 通道)、[328-core-db-electron-wiring](./328-core-db-electron-wiring.md)(IPC/Worker 转发模式)、[335-config-consumer-unification](../completed/335-config-consumer-unification.md)(config.toml 单一权威源)

---

## 1. Problem & Goal

产品 spec `wake-agent-and-computer-use-mode.md` §3 提出 **Wake Agent** 能力:

> 用户在不打开 DUYA 主窗口的情况下,从任意桌面位置召唤 Agent。Agent 唤醒瞬间自动加载 OSContextBridge 当前快照。

**核心功能**:
1. **不打开主窗口** — 全局快捷键(`Ctrl+Shift+Space`)让**常驻悬浮球(Orb)变身**为输入框
2. **首轮注入 OS 上下文** — user message 携带 `<external_os_context>...</external_os_context>`,LLM 据此预填响应(如"你在 Chrome 看 GitHub")
3. **临时会话** — Wake 不创建持久 session,关闭时自动 end,不留尾巴
4. **平台兼容** — Phase 1 仅 Win32(P1 加 macOS/Linux)

**与 Computer Use Mode 的关系**:
- Wake 是**感知通道**(读 OS 上下文)
- Computer Use Mode 是**动作执行器**(写 OS 桌面)
- 两者**共享 OSContextBridge**(`packages/agent/src/context/os-context/`)
- Wake 先落地,Computer Use Mode(plan 454)在 Wake 之后注册 `computer-use-mode`

**依赖**:
- `E:\Projects\computer-use-demo` v0.4.0(独立 daemon,Node.js+TS,koffi+nut.js+sharp)— 输出 `~/.duya/context/<sessionId>.json`
- duya 主进程负责 spawn + 看护 daemon
- 不修改 daemon 代码(保持独立仓库)

---

## 2. 与 spec §3 的差异 / 具体化决策

| # | spec §3 提的方案 | 本 plan 明确 | 依据 |
|---|---|---|---|
| 1 | "系统 Prompt 注入" — `<OSContextSection>` XML 块 | **Codex 式 ContextualUserFragment** — 每轮 user message 里以 `<external_os_context>...</external_os_context>` 包裹,token 预算 1800 | codex `codex-rs/context-fragments/src/additional_context.rs`;spec 原方案会让 OS 上下文影响 system prompt 缓存命中 |
| 2 | "mini-input 浮窗(300x80 px)" | **常驻悬浮球(Orb)+ 单 BrowserWindow 多状态切换** — 任何时刻只有一个 UI 元素:DORMANT 显示 50x50 球 / INPUT 球**变身**为 280x100 输入框(球消失)/ LOADING 球**回归**并显示右上小气泡(展示思考/工具进度)/ RESULT 球**变身**为 350x350 结果卡片 | spec §3.6 + 用户 2026-08-28 截图参考 + macOS Live Caption 风格;`alwaysOnTop: true` / `frame: false` / `transparent: true` / `skipTaskbar: true`;尺寸动态 `setBounds()` |
| 3 | "60 秒无操作 → fade-out" | **球不 fade,只折叠输入/结果** — 球是常驻元素永远可见;输入框/结果卡片 60s 无键盘/鼠标输入 → fade-out(300ms);30s 后开始 fade | 用户决策(2026-08-28):球不应消失,否则失去"任意桌面位置召唤"的能力 |
| 4 | "`Ctrl+Shift+Space`(中文输入法不抢)" | **沿用**;暴露设置项 `[wake.shortcut]`,允许用户覆盖(沿用 cc-haha `~/.duya/config.toml` 格式) | spec §5 决策 3 |
| 5 | "三态转换 DORMANT → INPUT → THINKING" | **改成 4 态:DORMANT → INPUT → LOADING → RESULT**;任何状态 Esc 都回 DORMANT;**LOADING 状态**球回归,右上小气泡显示"思考中/正在用 xxx 工具" | spec §3.3 + 用户决策(2026-08-28);LOADING 不能直接继承 INPUT,要让用户看到"在做什么" |
| 6 | "系统托盘图标添加 Wake Agent 右键菜单" | **不做**(Phase 1)+ 留接口;Phase 2 评估(tray icon 在 plan 330 electron-cleanup-repair 范围内未统一) | spec §3.5;Phase 1 不引入 tray |
| 7 | "daemon 生命周期管理缺失" | **`electron/services/computer-use-daemon.ts`** — spawn + `stdio:'pipe'` + 指数退避(1s → 60s)+ 心跳解析 + UI `automation:computer-use:health` 状态 | 沿用 `electron/agents/agent-run.ts` 看护模式 |
| 8 | "操作审计日志位置 `~/.duya/logs/computer-use/`" | **Wake Agent 不写操作审计**(它不执行操作);Computer Use Mode(plan 454)写审计,落 `%APPDATA%/DUYA/logs/computer-use/<date>.log` + `LogComponent.ComputerUse`;**例外**:Insert Tab(本 plan 内)走 `LogComponent.Orb` | Logging 规范 + 职责分离 |

---

## 3. Non-Goals

- **Computer Use Mode**(plan 454)— Wake Agent 只**读** OS 上下文,不**写** OS 桌面
- **Wake-word 语音唤醒**(spec §3.2 WAKE-P2)— Phase 1 不做,留 P1 阶段
- **Hold-to-Talk**(spec §3.2 WAKE-P1)— Phase 1 不做,留 P1 阶段
- **macOS / Linux 平台**:Phase 1 仅 Windows;跨平台由 plan 454 + Wake-P2 阶段合并处理
- **系统托盘**(tray icon)— 不在 Phase 1 范围
- **Self-Operating 自主监控**:Wake Agent 不主动唤醒,只在用户按快捷键时响应
- **OCR 集成**(v0.4 不带截图)— Wake Agent 只读 `computer-use-demo` 的 ContextPayload JSON,不读像素

---

## 4. Architecture Overview

```
                ┌─────────────────────────────────────────────────┐
                │ DUYA Electron main                                │
                │  ┌──────────────────────────────────────────┐    │
                │  │ computer-use-demo daemon (child proc)    │    │
                │  │  spawn via stdio:pipe + auto-restart      │    │
                │  │  writes ~/.duya/context/<sid>.json        │    │
                │  └────────────────┬─────────────────────────┘    │
                │                   │ every ~500ms                   │
                │                   ▼                                │
                │  ┌──────────────────────────────────────────┐    │
                │  │ OSContextBridge (NEW)                     │    │
                │  │  packages/agent/src/context/os-context/   │    │
                │  │  - watcher.ts (chokidar)                  │    │
                │  │  - payload.ts (schemaVersion 校验)        │    │
                │  │  - bridge.ts (subscribe + token 预算)    │    │
                │  │  - fragment.ts (ContextualUserFragment)   │    │
                │  └────────────────┬─────────────────────────┘    │
                └──────────────────┬─┴──────────────────────────────┘
                                   │ ContextualUserFragment 拼装到 user message
                                   ▼
                ┌─────────────────────────────────────────────────┐
                │ DuyaAgent.streamChat                              │
                │  - applyModes 之后、第一次 LLM call 之前          │
                │  - 追加 OSContextUserFragment(若 enabled)        │
                │  - 若 wakeless=true → 不创建主 session           │
                └──────────────────┬──────────────────────────────┘
                                   │ SSE chunk + 进度状态
                                   ▼
                ┌─────────────────────────────────────────────────┐
                │ Orb BrowserWindow (single, dynamic bounds)       │
                │  状态机:DORMANT → INPUT → LOADING → RESULT      │
                │  任何状态 Esc → DORMANT                          │
                │                                                  │
                │  ┌──────────────────────────────────────────┐    │
                │  │ DORMANT  : 50x50 球(duya logo)            │    │
                │  │   - 可拖拽(用户决定位置)                  │    │
                │  │   - Ctrl+Shift+Space → 变身 INPUT        │    │
                │  │ INPUT    : 280x100 输入框(球消失)         │    │
                │  │   - Enter 提交 → LOADING                │    │
                │  │ LOADING  : 50x50 球 + 右上小气泡(思考/工具)│    │
                │  │   - 小气泡内容由 main 推送               │    │
                │  │   - 完成 → 变身 RESULT                   │    │
                │  │ RESULT   : 350x350 结果卡片(球消失)      │    │
                │  │   - Esc 关闭 / Insert Tab → 输文本        │    │
                │  └──────────────────────────────────────────┘    │
                │  IPC: automation:orb:* (show-input / submit /     │
                │       show-loading / update-progress / show-      │
                │       result / insert-tab / hide)                │
                │                                                  │
                │  ┌──────────────────────────────────────────┐    │
                │  │ Insert Tab: nut.js keyboard.type()         │    │
                │  │  - 复用 OSContextBridge.focusedEntity      │    │
                │  │  - redacted=true → 拒绝 + WARN           │    │
                │  └──────────────────────────────────────────┘    │
                └─────────────────────────────────────────────────┘
```

**关键抽象复用**:
- **ContextualUserFragment**(codex 设计,plan 内新建)— 与 conductor-mode `prompt.prefix` / `toolUseContextPatch` 是独立通道,三条通道可叠加
- **automation:*** IPC 命名 — 沿用 `electron/ipc/automation/` 目录(若不存在则新建);**Wake Agent 用 `automation:orb:*` 子命名空间**
- **structured logger**(`electron/logging/logger.ts`) — daemon panic / 健康状态日志;**新增 `LogComponent.Orb`** 用于 orb 状态变化 + Insert Tab 审计
- **chokidar** fs.watch — 现有依赖(无需新增)
- **nut.js**(@nut-tree-fork/nut-js ^4.2.6) — Insert Tab 用,跨平台 keyboard 自动化
- **config.toml** 单一权威源(plan 334)— `[wake.shortcut]` / `[wake.orb]`(球位置)

---

## 5. Phase 拆解

### Phase 1 — Wake Agent + OSContextBridge(P0,约 1.5 周)

> **目标**:不打开主窗口,通过 `Ctrl+Shift+Space` 让 Orb 球变身输入框,首轮 user message 看到 OS 上下文。

#### Task A:computer-use-demo symlink + 共享类型(约 2h)

- [ ] `packages/computer-use/` 创建 symlink/junction → `E:\Projects\computer-use-demo`
  - Windows: `cmd //c mklink /J packages\computer-use E:\Projects\computer-use-demo`
  - `.gitignore` 加 `packages/computer-use/`(避免误提交 symlink)
- [ ] `packages/agent/src/context/os-context/types.ts`(新建):从 symlink 目标 re-export 关键类型:
  ```typescript
  export type { FocusedEntity, InteractionEvent, IntentCandidate, ContextPayload } from '@duya/computer-use-demo';
  export interface OSContext {
    schemaVersion: string;
    capturedAt: string;
    focusedEntity: FocusedEntity | null;
    interactionTrail: InteractionEvent[];  // 滑动窗口,默认 30 条
    intentCandidate: IntentCandidate | null;
    foreground: { pid: number; exeName: string; title: string };
  }
  export const ACCEPTED_SCHEMA_VERSIONS = ['0.4.0'] as const;
  export const MAX_TRAIL_EVENTS = 30;
  ```
- [ ] `packages/agent/package.json`(修改)— workspace 依赖加 `@duya/computer-use-demo`(symlink 引用)

#### Task B:OSContextBridge watcher + bridge(约 1 天)

- [ ] `packages/agent/src/context/os-context/watcher.ts`:
  - `chokidar.watch(path.join(os.homedir(), '.duya/context/*.json'), { awaitWriteFinish: true, ignoreInitial: false })`
  - debounce 200ms 合并短时更新
  - emit `OSContext` 给 listener(已 schemaVersion 校验 + 字段裁剪)
- [ ] `packages/agent/src/context/os-context/payload.ts`:
  - JSON.parse + `schemaVersion` 白名单校验(默认 `["0.4.0"]`,不符直接 drop + WARN)
  - 字段裁剪:`focusedEntity` / `interactionTrail`(截取最近 MAX_TRAIL_EVENTS=30)/ `intentCandidate` / `foreground`
  - 损坏文件 → WARN 日志 + skip(不抛)
- [ ] `packages/agent/src/context/os-context/bridge.ts`:
  ```typescript
  export interface OSContextBridge {
    start(): Promise<void>;
    stop(): Promise<void>;
    enable(): void;             // 开始累积并通知 listener
    disable(): void;            // listener 静默但 watcher 持续
    isEnabled(): boolean;
    getCurrent(): OSContext | null;
    subscribe(listener: (ctx: OSContext) => void): () => void;
  }
  export function getOSContextBridge(): OSContextBridge;
  ```
- [ ] `packages/agent/src/context/os-context/index.ts` — barrel
- [ ] 单测:`watcher.test.ts`(payload 校验 / 字段裁剪 / schemaVersion 拒绝)、`payload.test.ts`(损坏文件容错)、`bridge.test.ts`(subscribe / enable-disable / getCurrent)

#### Task C:ContextualUserFragment 注入通道(约 1.5 天)

- [ ] **C1:基座模块(新建,⚠️ duya 不存在的新概念)**
  - `packages/agent/src/context/contextual-user-fragment.ts`(新建):
    ```typescript
    export interface ContextualUserFragment {
      role(): 'user' | 'developer';
      contentKind(): string;
      markers(): readonly [open: string, close: string];
      body(): string;
      matchesText?(text: string): boolean;
    }
    export const CONTEXTUAL_USER_FRAGMENT_MATCHERS: Array<(text: string) => boolean> = [];
    export function renderFragment(frag: ContextualUserFragment): string;
    export function isContextualFragment(contentItem: ContentItem): boolean;
    ```
  - 与 conductor-mode `prompt.prefix`(字符串注入 system prompt)+ `toolUseContextPatch`(字段注入)是两个独立通道;三条通道可叠加
  - 单测:`contextual-user-fragment.test.ts`(接口 / matcher 互斥 / 多 fragment 拼接顺序)

- [ ] **C2:OSContextUserFragment 协议适配(协议 ↔ 现有 contextInjector 的桥接)**
  - `packages/agent/src/context/os-context/fragment.ts`:
    - `role(): 'user'`(表示用户当前在桌面看到的)
    - `contentKind(): 'external_context.os_context'`
    - `markers(): '<external_os_context>' / '</external_os_context>'`
    - `body()`:token 预算 1800,超长时 truncate_middle(保留 `focusedEntity` + `intentCandidate`,截断 `interactionTrail`),参考 codex `truncate_middle_with_token_budget`
  - `packages/agent/src/agent/DuyaAgent.ts`(修改)— `streamChat` 在 `applyModes` 之后、第一次 LLM call 之前:
    ```typescript
    const fragments: ContextualUserFragment[] = [];
    if (osContextBridge.isEnabled()) {
      const current = osContextBridge.getCurrent();
      if (current) fragments.push(new OSContextUserFragment(current));
    }
    const ctxContentItems = fragments.map(f => ({
      role: f.role(),
      kind: f.contentKind(),
      text: renderFragment(f),
    }));
    userMessage.content.push(...ctxContentItems);
    ```
  - **不动 `applyModes.ts`** — 现有 prompt 通道继续工作,本通道是并行新增
  - 单测:`fragment.test.ts`(marker 包裹 / token 预算 / truncation 保留关键字段)+ DuyaAgent.streamChat mock 验证注入位置与时机

#### Task D:computer-use-demo daemon 生命周期(约 4h)

- [ ] `electron/services/computer-use-daemon.ts`(新建):
  ```typescript
  export interface ComputerUseDaemon {
    start(): Promise<void>;
    stop(): Promise<void>;
    ensureRunning(): Promise<void>;
    onHealth(callback: (health: { running: boolean; schemaVersion?: string; lastError?: string }) => void): () => void;
  }
  export function getComputerUseDaemon(): ComputerUseDaemon;
  ```
  - `start()`: `child_process.spawn(process.execPath, [daemonEntry], { stdio: 'pipe', env: { ...process.env, DUYA_COMPUTER_USE_CONTEXT_DIR: path.join(os.homedir(), '.duya/context') } })`
  - 解析 `stdout` 心跳(daemon 每 30s 输出 `{ "type": "heartbeat", "schemaVersion": "0.4.0" }`)
  - `stderr` → `logger.error(..., LogComponent.ComputerUseDaemon)`
  - `exit` 事件:非预期退出按指数退避重启(1s → 2s → ... → 60s 上限),UI 状态广播 `automation:computer-use:health`
  - `stop()` — SIGTERM,5s 内未退 SIGKILL
- [ ] `electron/main.ts`(修改)— 在 `app.whenReady()` 后调 `getComputerUseDaemon().start()`;`app.on('before-quit')` 调 `stop()`
- [ ] `electron/preload.ts`(修改)— 暴露 `automationComputerUse.onHealth(callback)` 给 renderer
- [ ] 单测:`computer-use-daemon.test.ts`(spawn / exit 重启指数退避 / stdio 捕获)

#### Task E:Wake Agent 快捷键 + Orb 触发(约 6h)

- [ ] `electron/main.ts`(修改)— `globalShortcut.register('CommandOrControl+Shift+Space', wakeHandler)`,注册失败时 `logger.warn` + 设置页提示"快捷键被占用"
- [ ] `electron/services/wake.ts`(新建)— `wakeHandler()` 流程:
  1. 调 `getOSContextBridge().enable()`(临时 enable,任何状态 Esc/close → disable)
  2. 检查 Orb BrowserWindow 是否已开:
     - 已开 + 状态 INPUT/LOADING/RESULT → focus 当前状态(不重新变身)
     - 已开 + 状态 DORMANT → 触发 `automation:orb:show-input`(球变输入框)
     - 未开 → 创建 `new BrowserWindow({ width: 50, height: 50, x: orbX, y: orbY, alwaysOnTop: true, frame: false, transparent: true, focusable: true, skipTaskbar: true, resizable: false })`,加载 orb 入口 URL
  3. 持久化 Orb 位置到 `~/.duya/config.toml [wake.orb] { x, y, displayId }`(用户拖动后更新)
- [ ] `electron/ipc/orb.ts`(新建)— Orb 全状态 IPC handlers:
  - `automation:orb:show-input`(main → orb: DORMANT → INPUT)
  - `automation:orb:submit`(orb → main: 触发 ChatStartCommand.wakeless)
  - `automation:orb:show-loading`(main → orb: INPUT → LOADING,球回归 + 气泡显示)
  - `automation:orb:update-progress`(main → orb: 推送思考/工具状态到气泡)
  - `automation:orb:show-result`(main → orb: LOADING → RESULT)
  - `automation:orb:insert-tab`(orb → main: Insert Tab action,触发 nut.js)
  - `automation:orb:hide`(orb → main: 任何状态 → DORMANT,仅折叠输入/结果,球保留)
  - `automation:orb:chunk`(main → orb: SSE 流式响应片段,RESULT 状态渲染)
- [ ] `electron/ipc/index.ts`(修改)— export `registerOrbHandlers`(原 `registerWakeHandlers` 改名)
- [ ] `electron/preload.ts`(修改)— 暴露 orb IPC 客户端:`window.electronAPI.orb = { showInput, submit, showLoading, updateProgress, showResult, insertTab, hide, onChunk }`
- [ ] 设置项 `[wake.shortcut]` 读取(沿用 `ConfigStore` 模式,plan 334)— 默认 `CommandOrControl+Shift+Space`,允许用户覆盖
- [ ] 单测:`electron/ipc/__tests__/orb.test.ts`(状态机过渡 / Esc 回 DORMANT / Insert Tab 路由)

#### Task F:Orb React 入口 — 常驻悬浮球 + 4 态切换(约 2.5 天)

> **核心设计原则**:单 BrowserWindow,任何时刻只渲染一个 UI 元素(球 / 输入框 / 结果);状态切换是 `setBounds()` + 元素身份切换,**不是叠加**。

- [ ] `src/orb/`(新建独立 vite entry)— `index.html` + `main.tsx` + `OrbApp.tsx`
- [ ] **样式自包含**:`src/orb/orb.css`(515 行,2026-08-28 已落地)— 不依赖 `src/styles/globals.css`(避免 css monolith 污染);包含:
  - **Tokens**:CSS variables(主题色 / 尺寸 / 动画时长 / 字体)
  - **Reset**:独立 bundle reset(不影响外部)
  - **Components**:`.orb-ball` / `.orb-ball-loading` / `.orb-input` / `.orb-result` / `.orb-progress-bubble`
  - **Animations**:`orb-fade-in` / `orb-fade-out` / `orb-pulse` / `orb-spinner` / `orb-bubble-in`(4 态切换 ≤ 200ms)
  - **Utilities**:`.orb-drag` / `.orb-no-drag`(-webkit-app-region)+ 焦点环 + scrollbar
  - **主题切换**:`:root[data-theme='dark']` 覆盖 CSS variables,跟随主窗口
- [ ] 组件:
  - `OrbBall.tsx`(DORMANT 状态,50x50,duya logo)
  - `OrbBallLoading.tsx`(LOADING 状态,50x50 球 + 右上小气泡)
  - `OrbInput.tsx`(INPUT 状态,280x100 输入框)
  - `OrbResult.tsx`(RESULT 状态,350x350 结果卡片)
  - `OrbProgressBubble.tsx`(小气泡内容,展示思考/工具进度)
- [ ] hooks:
  - `useOrbState.ts`(4 态机 + 状态过渡,依据 IPC 事件)
  - `useOrbDraggable.ts`(球可拖拽,仅 DORMANT/LOADING 状态;INPUT/RESULT 禁用拖拽)
  - `useOSContext.ts`(订阅 OSContextBridge 快照)
  - `useAutoCollapse.ts`(60s 无键盘/鼠标输入 → 折叠输入/结果;**球不折叠**)
  - `useInsertTab.ts`(RESULT 状态下调用 `window.electronAPI.orb.insertTab`)
- [ ] 状态过渡动画:
  - 球 → 输入框:球 fade-out + 渐变到输入框位置(opacity + scale,200ms)
  - 输入框 → 球(LOADING):输入框 fade-out + 球 fade-in(200ms)
  - 球 → 结果卡片:球 fade-out + 结果卡片 fade-in(200ms)
  - 结果 → 球:结果卡片 fade-out + 球 fade-in(200ms)
- [ ] 键盘绑定(依赖状态):
  - DORMANT:`Ctrl+Shift+Space` 外部触发;鼠标拖拽
  - INPUT:`Esc` → DORMANT / `Enter` submit / `Shift+Enter` 换行 / `↑↓` 翻历史
  - LOADING:`Esc` → cancel + DORMANT
  - RESULT:`Esc` → DORMANT / `Insert Tab` → insertTab action / `Tab` 在 action 间切换
- [ ] Orb 位置持久化:
  - 用户拖动球 → 实时调 `window.electronAPI.orb.setPosition(x, y, displayId)`
  - main 进程存到 `~/.duya/config.toml [wake.orb] { x, y, displayId }`
  - 下次启动恢复位置
- [ ] 提交逻辑: INPUT submit → 触发 `automation:orb:submit` → main 走 `ChatStartCommand { wakeless: true }` → 流式响应推 `automation:orb:chunk` + `automation:orb:update-progress` → orb 收到 show-result 后变身
- [ ] `vite.config.ts`(修改)— 加 `orb` entry,build 输出 `dist-orb/`,electron-builder 资源打包到 `resources/orb/`
- [ ] `electron-builder.yml`(修改)— `extraResources` 加 `resources/orb/**`
- [ ] 样式沿用 `src/styles/globals.css` CSS variables;`data-theme` 切换跟随主窗口;**背景透明**(transparent: true)
- [ ] 单测:`OrbApp.test.tsx` / `OrbBall.test.tsx` / `OrbInput.test.tsx` / `OrbResult.test.tsx`(状态过渡 / 键盘绑定 / 拖拽 / Insert Tab)

#### Task G:ChatStartCommand 接入 wakeless 路径(约 4h)

- [ ] `packages/agent/src/chat/ChatStartCommand.ts`(修改)— 新增 `options: { wakeless?: boolean }`:
  - `wakeless=true` 时:
    - 不创建主聊天 session,使用临时 session(`sessionId: 'wakeless-' + randomUUID()`,落临时 rollout 目录)
    - 第一轮 user message 注入 OSContextUserFragment(已在 Task C 完成)
    - 流式响应通过 `IPC:automation:orb:chunk` 推到 Orb
- [ ] Orb 关闭(`IPC:automation:orb:hide`)时自动 `session.end()` + 删临时目录(不持久化)
- [ ] 单测:`ChatStartCommand.wakeless.test.ts`(临时 session 创建/销毁 + OSContext 注入)

#### Task H:配置 + 设置项(约 2h)

- [ ] `~/.duya/config.toml` 加 section:
  ```toml
  [wake]
  enabled = true                              # 总开关(默认 false,隐私优先)
  shortcut = "CommandOrControl+Shift+Space"   # 可自定义
  inject_os_context = true                    # 是否注入 OSContext(默认 true)
  auto_collapse_ms = 60_000                   # 60s 无操作折叠输入/结果(球不折叠)

  [wake.orb]
  x = 100                                     # 球初始 X(默认屏幕左上角)
  y = 100                                     # 球初始 Y
  displayId = 0                               # 多屏环境:球所在屏
  ```
- [ ] `src/components/settings/WakeAgentSection.tsx`(新建)— 设置页加 "Wake Agent" 卡片:`enabled` 总开关 + 快捷键自定义 + `inject_os_context` 开关 + 球位置重置按钮 + Insert Tab 开关(默认 true)
- [ ] `electron-builder.yml` 验证配置项打包正确

#### Task I:Insert Tab 工具 — 简化版 Computer Use(约 1.5 天)

> **本质**:`nut.js` keyboard.type() 输入到当前焦点输入框(简化版 `os_type`,plan 454 完整版 Computer Use Mode 会复用此基座)。
> **依赖**:`@nut-tree-fork/nut-js ^4.2.6`(`packages/computer-use-demo` 已在用),跨平台 Mac/Win/Linux。

- [ ] `package.json` 新增依赖:`@nut-tree-fork/nut-js: ^4.2.6`
- [ ] `electron/services/orb-insert-tab.ts`(新建):
  ```typescript
  export async function insertTabToFocusedField(text: string): Promise<InsertTabResult> {
    const ctx = getOSContextBridge().getCurrent();
    // 1. redacted 校验
    if (ctx?.focusedEntity?.redaction?.redacted) {
      logger.warn('Insert Tab refused: password field', { exeName: ctx.foreground?.exeName }, LogComponent.Orb);
      throw new Error('Cannot insert to password field');
    }
    // 2. 推断字段类型
    if (!ctx?.focusedEntity || ctx.focusedEntity.kind === 'Text') {
      // nut.js 类型文本
      await nutJsKeyboard.type(text, { delayMs: 10 });
      logger.info('Insert Tab success', { length: text.length }, LogComponent.Orb);
      return { ok: true, method: 'nut.type' };
    }
    throw new Error(`Unsupported focused entity: ${ctx.focusedEntity.kind}`);
  }
  ```
- [ ] `electron/ipc/orb.ts`(修改)— `automation:orb:insert-tab` handler 调用 `insertTabToFocusedField(text)`
- [ ] **不依赖 plan 454 的 DesktopBackend** — 本 Task 是独立的 `nut.js` 包装,plan 454 复用时只需迁移到 `packages/computer-use/`
- [ ] 单测:`orb-insert-tab.test.ts`(redacted 拒绝 / 成功路径 / nut.js mock)

**Phase 1 验收**:
- [ ] `packages/computer-use/` symlink 落地,`@duya/computer-use-demo` workspace 引用打通
- [ ] `OSContextBridge` 单例 + watcher + payload 校验 + bridge 订阅模式
- [ ] `ContextualUserFragment` 基座接口定义,`OSContextUserFragment` 实现 + 注入 turn 边界
- [ ] `computer-use-demo` daemon spawn + 指数退避 + panic 日志捕获 + heartbeat 解析
- [ ] `Ctrl+Shift+Space` globalShortcut 注册 + Wake Agent 触发
- [ ] Orb 4 态机切换:DORMANT → INPUT → LOADING(球回归 + 气泡)→ RESULT,任何状态 Esc → DORMANT
- [ ] Orb 拖拽 + 位置持久化(多屏换屏恢复)
- [ ] 60s 无操作折叠输入/结果(**球不折叠**)
- [ ] `ChatStartCommand.wakeless=true` 路径打通(临时 session 创建/销毁)
- [ ] **Insert Tab**:`nut.js` type 文本到当前焦点输入框;password field → 拒绝 + WARN 日志
- [ ] **Orb 加载动画**:球 → 输入框 → 球回归(带思考/工具气泡)→ 结果卡片,4 个过渡动画 ≤ 200ms
- [ ] **Dual-monitor 实测**:
  - 球在主屏 → 按快捷键 → 球变身输入框在主屏;拖到副屏 → 之后唤起在副屏
  - Windows `alwaysOnTop` 在多屏行为有 quirk,需要手动跑 5+ 场景验证
- [ ] **24h soak test**:daemon 连续运行 24h,记录内存峰值(MVP 标准:< 200MB for daemon + DUYA 主进程合计)+ handle 泄漏 + fs.watch 卡死检测
- [ ] vitest 单元测试 ≥ 90% 覆盖
- [ ] `npm run typecheck:all` 0 错
- [ ] Playwright smoke:`Ctrl+Shift+Space` → 球 → 输入框 → "现在在做什么?" → 球带气泡 → 结果卡片(带 Insert Tab 按钮)

---

### Phase 2 — Wake-P1 Hold-to-Talk + Wake-P2 Wake-Word(P1,约 1 周,可选)

#### Task A:PTT 触发器(约 2 天)

- [ ] `packages/voice/src/wake-trigger.ts`(新建)— PTT 全局监听:
  - `globalShortcut.register('F12', () => voiceState = 'recording')`(用户可设置)
  - 鼠标侧键通过 `koffi` 调用 `RegisterHotKey`(若 Electron 支持;否则用户可选)
- [ ] Orb 加按住说话模式:`onMouseDown` → VAD start → `onMouseUp` → STT → 自动提交
- [ ] Voice worker 与 OSContextBridge 并行启动

#### Task B:Wake-Word 检测(约 3 天)

- [ ] `packages/voice/src/wake-word/index.ts`(新建)— openWakeWord 本地模型:
  - 模型文件下载/管理(沿用 voice 配置 `~/.duya/models/`)
  - 持续监听麦克风,VAD 检测到人声后唤醒检测
  - 命中 "Hey Duya" / "嗨 Duya" 后调 `wakeHandler()`
- [ ] 设置项 `[wake.word]` 开关,默认关闭(避免误唤醒)

---

## 6. 测试策略

### 6.1 单元测试(Vitest)

| 文件 | 覆盖 |
|---|---|
| `packages/agent/src/context/os-context/watcher.test.ts` | chokidar 触发 / payload 校验 / schemaVersion 拒绝 |
| `packages/agent/src/context/os-context/payload.test.ts` | 字段裁剪 / interactionTrail 滑动窗口 / 损坏文件容错 |
| `packages/agent/src/context/os-context/bridge.test.ts` | subscribe / enable-disable / getCurrent |
| `packages/agent/src/context/os-context/fragment.test.ts` | marker 包裹 / token 预算 / truncate_middle 保留关键字段 |
| `packages/agent/src/context/contextual-user-fragment.test.ts` | 接口 / matcher 互斥 / 多 fragment 拼接顺序 |
| `electron/services/computer-use-daemon.test.ts` | spawn / exit 重启指数退避 / stdio 捕获 / heartbeat 解析 |
| `electron/ipc/__tests__/orb.test.ts` | 4 态机过渡 / Esc 回 DORMANT / Insert Tab 路由 |
| `electron/services/orb-insert-tab.test.ts` | redacted 拒绝 / 成功路径 / nut.js mock |
| `src/orb/__tests__/OrbApp.test.tsx` | 状态过渡 / 4 态切换动画 / Esc 回 DORMANT |
| `src/orb/__tests__/OrbBall.test.tsx` | 拖拽 / 位置持久化 |
| `src/orb/__tests__/OrbInput.test.tsx` | 键盘绑定 / Enter submit / Shift+Enter 换行 / 历史翻页 |
| `src/orb/__tests__/OrbResult.test.tsx` | Insert Tab 按钮 / Esc 关闭 |

### 6.2 集成测试(Playwright + Electron)

- [ ] `e2e/smoke/wake-agent.spec.ts` — 启动 DUYA → 模拟 `Ctrl+Shift+Space` → 球变身输入框 → 输入 → 球回归带气泡 → 结果卡片(带 Insert Tab 按钮)(需真实 daemon,先 `npm run electron:build`)
- [ ] `e2e/orb/insert-tab.spec.ts` — 启用 Wake → 输入"你好" → 等结果 → 点 Insert Tab → 在 Notes 的输入框验证文本被输入

### 6.3 手动验证清单

- [ ] 按 `Ctrl+Shift+Space` 在 5 个不同 App(Chrome / VSCode / Explorer / Slack / Outlook)→ 球变身输入框
- [ ] 输入文件拖拽(PDF / 图片)→ 识别为 attachment
- [ ] Wake Agent 第一轮响应包含 OSContext 摘要(`focusedEntity` + `intentCandidate` + `foreground`)
- [ ] daemon 崩溃 → 自动重启 + 球状态显示"Context Source Offline"提示
- [ ] Orb 4 态机:球 → 输入框 → 球回归(气泡显示思考/工具)→ 结果卡片
- [ ] **Insert Tab 手动验收**:Chrome 地址栏输入"hello world" → Enter → 在 Notes 输入框按快捷键 → 输入"说个故事" → 结果卡片点 Insert Tab → 文本出现在 Notes 输入框
- [ ] **password field 拒绝**:浏览器密码框聚焦 → Insert Tab → 拒绝 + WARN 日志
- [ ] **Orb 拖拽**:拖球到任意位置 → 关闭 → 重启 → 球在原位置
- [ ] Dual-monitor:主屏拖球到副屏 → 唤醒 → 球在副屏
- [ ] 60s 无操作:输入框/结果 fade-out,**球保留**
- [ ] Esc:任何状态 → DORMANT(球保留)

### 6.4 性能指标

- [ ] OS Context Bridge 端到端延迟 **< 300ms**
- [ ] Wake Agent → 首 token **< 800ms**
- [ ] `Ctrl+Shift+Space` → 球变身输入框 **< 200ms**
- [ ] Insert Tab 响应 **< 100ms**(nut.js type)

---

## 7. 关键决策点(本 plan 提交前必须确认)

| # | 决策 | 默认推荐 | 替代 |
|---|---|---|---|
| 1 | OSContext 注入通道 | **ContextualUserFragment**(codex 式,user message) | per-turn system prompt prefix(plan 224 conductor 模式) |
| 2 | Wake UI 架构 | **常驻悬浮球(Orb)+ 单 BrowserWindow 4 态切换** | 独立 mini-input BrowserWindow(原计划,已废弃) |
| 3 | Wake 快捷键默认 | `Ctrl+Shift+Space`(中文输入法不抢) | `Alt+Space` / 用户自定义 |
| 4 | 状态机 | **4 态:DORMANT / INPUT / LOADING(球回归)/ RESULT** | 3 态:INPUT / THINKING / DONE |
| 5 | auto-collapse 时机 | 60s 无键盘/鼠标折叠输入/结果;**球不折叠** | 全窗口 fade-out |
| 6 | daemon 物理位置 | **symlink**(`packages/computer-use/` → `E:\Projects\computer-use-demo`) | 物理 fork |
| 7 | daemon 崩溃策略 | **指数退避 1s→60s + UI 健康广播** | 不重启 / 仅首次失败提示 |
| 8 | 临时 session 存储 | **临时 rollout 目录,关闭时删** | 持久化(违背 Wake Agent 设计意图) |
| 9 | 设置项位置 | `~/.duya/config.toml [wake]` + `[wake.orb]` section | 单独 settings.json |
| 10 | Phase 2 Wake-Word 库 | openWakeWord(本地,免费) | Picovoice(云端) |
| 11 | Insert Tab 实现 | **`@nut-tree-fork/nut-js ^4.2.6` type 文本到当前焦点输入框**;redacted → 拒绝 | plan 454 Computer Use Mode 完整版 |
| 12 | Wake Agent 总开关 | **`[wake.enabled]` 默认 true**;但尊重用户隐私可禁用 | 始终启用 |

> 决策 #1/#2/#11 已在 2026-08-28 与用户确认;其余按 spec §3 + 经验默认,**待评审时确认**。

---

## 8. 依赖与既有工作关系

| 既有 | 复用方式 |
|---|---|
| `ModeModifier` 基座(plan 224) | Wake Agent 不注册 mode(mini-input 不算 mode);但 OSContext 注入通道可被任何 mode 复用 |
| `apply-modes.ts`(plan 224) | 不修改;ContextualUserFragment 是第三条独立通道 |
| `ConfigStore`(plan 334) | `[wake.shortcut]` 等配置项走 ConfigStore |
| `electron/services/automation/`(若存在) | spawn / IPC handler 模板 |
| `electron/logging/logger.ts` | daemon panic + heartbeat 日志 |
| `electron-builder.yml` | `extraResources` 加 `resources/orb/**` |
| `packages/voice/`(plan 410) | Phase 2 PTT 复用 voice runtime |
| `E:\Projects\computer-use-demo` | **唯一外部依赖**,通过 symlink 消费其 daemon 输出 |

---

## 9. 风险与缓解

| 风险 | 影响 | 缓解 | 触发阶段 |
|---|---|---|---|
| Chinese IME 抢全局快捷键 | Wake 失效 | `Ctrl+Shift+Space`(已验证)+ 设置入口可覆盖 | Phase 1 |
| computer-use-demo daemon 崩溃 | OSContextBridge 断流 | spawn `stdio:'pipe'` + 指数退避重启 + UI `automation:computer-use:health` 状态 + 降级提示 | Phase 1 |
| Orb 与主窗口 IPC 冲突 | Orb 提交消息被主窗口消费 | Orb 用独立 sessionId(`'wakeless-' + uuid`),不与主窗口 session 共享 store | Phase 1 |
| Orb 拖拽跨屏 | 用户拖球到副屏后丢位置 | 位置持久化含 displayId,启动时恢复;Playwright 跨屏验证 | Phase 1 |
| Orb 状态过渡动画错位 | 球/输入框/结果变形卡顿 | 过渡动画 ≤ 200ms,使用 CSS transition + setBounds,实测各状态切换帧率 | Phase 1 |
| Insert Tab 误输入到敏感字段 | 密码字段被 type | OSContextBridge 读 `focusedEntity.redaction.redacted` → 拒绝 + WARN 日志 | Phase 1 |
| nut.js 在 macOS / Linux 平台不支持 | Insert Tab 跨平台失败 | nut.js ^4.2.6 官方支持三平台;若失败降级到 napi-rs 方案 | Phase 1 |
| symlink 在打包后丢失 | 生产环境 daemon 无法 spawn | `afterPack` hook 复制 `packages/computer-use/` → `resources/computer-use/`(参照 `better-sqlite3` 模式,plan 242 经验) | Phase 1 |
| Dual-monitor alwaysOnTop quirk | Orb 只在一屏置顶 | Phase 1 验收包含 5+ 跨屏场景手动验证;失败则降级到"主屏置顶 + 跟随焦点窗口" | Phase 1 |
| daemon 24h 长稳未知(之前只跑 ~10s polling) | Phase 1 上线后内存/句柄泄漏 | Phase 1 验收必须 24h soak test,失败标准:OOM / handle 泄漏 / fs.watch 卡死 / ContextPayload JSON 损坏 → Phase 1 不算完成 | Phase 1 |
| ContextualUserFragment 与 system prompt 缓存冲突 | OSContext 每轮变 → 缓存命中率下降 | ContextualUserFragment 走 user message 通道,不污染 system cache;token 预算 1800 限制每次成本 | Phase 1 |
| MacOS / Linux 平台支持滞后 | 仅 Win32 可用 | Phase 1 仅 Win32;macOS / Linux 留 plan 454 阶段评估(platform-gateway) | 跨 Phase |
| **`src/styles/globals.css` css monolith**(14004 行,1830 个 selectors) | Orb 复用 globals 会带入不需样式 / 打包体积 | **本 plan 已拆分**:Orb 用独立 `src/orb/orb.css`;**后续 tech debt**:拆分 globals 为 `tokens.css / typography.css / chat.css / sidebar.css / settings.css / automation.css`(独立 plan `455-frontend-css-decomposition`) | 跨 Phase |

---

## 10. 验收 checklist(Master)

### Phase 1 — Wake Agent + OSContextBridge

- [ ] `packages/computer-use/` symlink 落地,`@duya/computer-use-demo` workspace 引用打通
- [ ] `OSContextBridge` 单例 + watcher + payload 校验 + bridge 订阅模式
- [ ] `ContextualUserFragment` 基座接口定义,`OSContextUserFragment` 实现 + 注入 turn 边界
- [ ] `computer-use-demo` daemon spawn + 指数退避 + panic 日志捕获 + heartbeat 解析
- [ ] `Ctrl+Shift+Space` globalShortcut 注册 + Wake Agent 触发
- [ ] **Orb 4 态机**:`OrbBall / OrbInput / OrbBallLoading / OrbResult` 四个组件切换,状态过渡动画 ≤ 200ms
- [ ] Orb 可拖拽 + 位置持久化到 `[wake.orb]` config
- [ ] 60s 无操作折叠输入/结果(球不折叠)
- [ ] `ChatStartCommand.wakeless=true` 路径打通
- [ ] **Insert Tab**:`nut.js` type 到当前焦点输入框;password field 拒绝 + WARN
- [ ] 设置项 `[wake.enabled]` / `[wake.shortcut]` / `[wake.inject_os_context]` / `[wake.orb.{x,y,displayId}]` 读取
- [ ] Dual-monitor 实测(球在主/副屏都能变身)
- [ ] 24h soak test(daemon + watcher 长稳)
- [ ] vitest 单元测试 ≥ 90% 覆盖
- [ ] `npm run typecheck:all` 0 错
- [ ] Playwright smoke:`Ctrl+Shift+Space` → 球 → 输入框 → 输入 → 球回归(气泡)→ 结果卡片(Insert Tab 按钮可见)

### Phase 2 — Wake-P1/P2

- [ ] PTT 触发器(F12 / 鼠标侧键)+ Orb 按住说话模式
- [ ] openWakeWord 集成 + 设置开关
- [ ] 误唤醒率 < 5% / 小时(本地噪声环境手动验证)

---

## 11. 进度记录

> 实施时按 Phase 推进,每完成一个 Task 在对应 `- [ ]` 改为 `- [x]`,并在下方记录决策与偏差。

### 2026-08-28 — 草案

- 与用户确认 4 项决策:ContextualUserFragment 注入通道 / 与所有 mode 互斥(wake 不注册 mode)/ 新建 `packages/computer-use/` 子包(后续由 plan 454 实施)/ **Orb 常驻悬浮球 + 4 态切换**(原 mini-input 独立 BrowserWindow 计划于 2026-08-28 被截图否决)
- **关键拆分**:从原 plan 452(混合方案)拆出:
  - 本 plan 453(Wake Agent)负责 OSContextBridge + Orb + daemon 生命周期
  - plan 454(Computer Use Mode)负责 `computer-use-mode` ModeModifier + `packages/computer-use/` 包 + 6 个 OS-side tools + SOM overlay
- 决策 **wake 优先**(OSContextBridge 必须先就绪,plan 454 才能注册 computer-use-mode 并复用)
- 引入"OSContext 走 turn 边界 user message 注入"决策(避免 system prompt cache 失效)
- 引入"Orb 临时 session,关闭即删"决策(Wake 不持久化对话历史)

### 2026-08-28 — mini-input 设计重写(用户截图澄清)

**原始设计**:独立 mini-input BrowserWindow(300x100 px,屏幕底部居中,按快捷键唤起)—— **错误**,这是 Spotlight 启动器模式。

**重写设计**(基于用户三张截图):
- **常驻悬浮球(Orb)** + 单 BrowserWindow 多状态切换 —— 类似 macOS Live Caption 风格
- **4 态机**:DORMANT(50x50 球)/ INPUT(280x100 输入框,球消失)/ LOADING(球回归 + 右上小气泡)/ RESULT(350x350 结果卡片)
- **核心约束**:任何时刻只有一个 UI 元素,状态切换是 `setBounds()` + 元素身份切换,不叠加
- **LOADING 状态**:球**回归**(不保持输入框),右上小气泡显示思考/工具进度——让用户看到 Agent "在做什么"
- **球不 fade**(违背"任意桌面位置召唤"的能力)
- **Insert Tab**(用户截图核心 action):把结果文本输入到当前 App 输入框,本质是 `nut.js keyboard.type()` 简化版
- **球可拖拽 + 位置持久化**:用户决定唤醒位置,`~/.duya/config.toml [wake.orb]` 存 `{x, y, displayId}`
- **多屏支持**:Orb 跟随 displayId 跨屏恢复

**代码改动**:
- Task E:`automation:wake:*` IPC 改成 `automation:orb:*`,加 show-input / show-loading / update-progress / show-result / insert-tab / hide 六个 handler
- Task F:`src/orb/`(新建独立 vite entry),组件改成 `OrbBall / OrbBallLoading / OrbInput / OrbResult`,hooks 加 `useOrbState / useOrbDraggable / useAutoCollapse`
- Task H(新增):Task I Insert Tab 工具,用 `@nut-tree-fork/nut-js ^4.2.6`(为 plan 454 铺垫)
- §10 / §6 验收清单与测试策略相应重写

**不变**:Task A(symlink)/ Task B(OSContextBridge)/ Task C(ContextualUserFragment)/ Task D(daemon)/ Task G(ChatStartCommand.wakeless) + Phase 2(PTT/Wake-word)

### 2026-08-28 — UI 骨架已落地(开始 Task F)

- **目录创建**:`src/orb/`(15 个文件,1300 行)
  - `orb.css`(515 行,自包含,含 tokens / reset / 4 态组件 / 动画 / utilities)
  - `index.html` + `main.tsx`(独立 vite entry)
  - `OrbApp.tsx`(根,4 态机路由)
  - `components/OrbBall.tsx` + `OrbBallLoading.tsx` + `OrbInput.tsx` + `OrbResult.tsx`
  - `hooks/useOrbState.ts`(状态机 + IPC 订阅)+ `useOrbDraggable.ts` + `useAutoCollapse.ts` + `useOSContext.ts` + `useInsertTab.ts`
  - `types.ts`(OrbState / ProgressInfo / ResultContent / OSContextSnapshot / OrbAPI)
  - `__tests__/OrbApp.test.tsx`(smoke test)
- **样式架构决定**:`src/styles/globals.css` 14004 行 css monolith 严重,**本 plan 拆出独立 `orb.css`**,不依赖 globals;**后续 tech debt**:拆分 globals.css 为 `tokens.css / typography.css / chat.css / sidebar.css / settings.css / automation.css`(独立 plan `455-frontend-css-decomposition`)
- **未完成**:业务逻辑细节(IPC handlers / Streaming 渲染 / Drag 跨屏持久化 / Vitest 覆盖 / Playwright e2e)— 需要 Task B/D/E/G/I 完成后才能跑通
- **待评审**:Plan 草稿完成后,需用户确认 §7 决策 #3–#10 + Phase 1 时间盒 1.5 周可接受