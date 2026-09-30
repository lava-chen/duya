# Plan 454: Computer Use Mode — 截图 + 鼠标驱动的 OS 桌面 Mode

> **Status**: 草案(Draft) — 待评审
> **Priority**: P0
> **Created**: 2026-08-28
> **Spec**: [`docs/product-specs/wake-agent-and-computer-use-mode.md` §4](../../product-specs/wake-agent-and-computer-use-mode.md)
> **依赖**: [453-wake-agent](./453-wake-agent.md)(**必须先完成** — 提供 OSContextBridge)
> **参考设计**: [`E:\cloned-projects\claude-quickstarts\duya-computer-use-plan.md`](../../../cloned-projects/claude-quickstarts/duya-computer-use-plan.md)(2834 行完整 Task-by-Task,从未在 duya 实施)
> **相关 plan**: [224-mode-architecture-unification](../completed/224-mode-architecture-unification.md)(ModeModifier 基座)、[413-mode-state-machine-framework](./413-mode-state-machine-framework.md)、[426-hook-loop-bus](../completed/426-hook-loop-bus.md)

---

## 1. Problem & Goal

产品 spec `wake-agent-and-computer-use-mode.md` §4 提出 **Computer Use Mode(CUM)** 能力:

> Agent 不仅能对话,还能**直接驱动 OS 桌面** —— 点击、键入、滚动、切窗口 —— 配合 computer-use-demo 的 OSContextBridge,完成"用户看着屏幕,Agent 在旁边动手"。

**核心功能**:
1. **截图驱动** — 通过截屏(带 SOM 编号 overlay)理解当前桌面状态,按 element 索引点击,而非裸坐标
2. **跨平台自动化** — 用 `nut.js`(Node.js 跨平台桌面自动化)替代裸 Win32 API,统一 Mac/Win/Linux 接口
3. **以 ModeModifier 形式注册** — 用户决策(2026-08-28):`computer-use-mode` 是 session-level mode,与现有 mode 互斥
4. **应用布局记忆** — `~/.duya/computer-use/memory.md` 持久化每个 App 的 UI 规律,sub-agent 复用
5. **安全闸门** — blocked key combos / blocked text patterns + destructive action 审批回调

**与 Wake Agent 的关系**(共享基础):
- **Wake Agent(plan 453)** 提供 OSContextBridge(读 `computer-use-demo` daemon 写入的 OS 上下文)→ 本 plan 复用,获取 `focusedEntity` / `intentCandidate` 推断用户意图
- 本 plan **不修改** `E:\Projects\computer-use-demo`,只消费其输出
- 新建 `packages/computer-use/` 子包,实现 DesktopBackend(主动控制 OS)—— 与 `E:\Projects\computer-use-demo`(被动读上下文)职责**互补**

**关键参考**: [`E:\cloned-projects\claude-quickstarts\duya-computer-use-plan.md`](../../../cloned-projects/claude-quickstarts/duya-computer-use-plan.md) 是 2834 行完整 Task-by-Task plan,**从未实施**。本 plan 在其基础上:
- ✅ 沿用 19 个 Task 的设计骨架(SOM overlay / sub-agent / memory / safety)
- 🔄 **改造点**:把"主 agent 单一 tool"改为"ModeModifier 注册",与 duya 的 mode 系统对齐
- ➕ 新增 `packages/computer-use/` 子包(原 plan 假设 tool 直接在 `packages/agent/src/tool/ComputerUseTool/`,但用户决策要求独立子包)
- ➕ 复用 wake-agent 的 OSContextBridge(原 plan 未涉及 OS 上下文注入)

---

## 2. 与 spec §4 的差异 / 具体化决策

| # | spec §4 提的方案 | 本 plan 明确 | 依据 |
|---|---|---|---|
| 1 | "新建 packages/computer-use/(作为 duya 包)" | **同 spec**;但**不物理迁** `E:\Projects\computer-use-demo`,而是**新建独立 Node.js 子包**,职责:主动控制 OS(DesktopBackend + SOM overlay) | 用户决策(2026-08-28);与 `E:\Projects\computer-use-demo`(被动读 OS 上下文)职责分离 |
| 2 | "6 个 OS-side tools(capture_screen / click_at / type / key_combo / scroll / window_switch)" | **沿用 6 个 action enum**(capture / click / type / key / scroll / drag)+ list_apps / focus_app / set_value / wait(共 10 个 action),**单 tool + action enum 模式**(hermes-agent 风格) | claude-quickstarts design;compact schema + 低 per-turn token cost |
| 3 | "OS-side click 实现:UIA InvokePattern(优先)+ Win32 SendInput 兜底" | **改为 SOM overlay + 全局鼠标点击(nut.js)** — 截图上画编号框,model 按 element index 点击(~10× 更可靠) | claude-quickstarts design;UIA InvokePattern 在 WPF/WinUI/Office 命中率低(实测 ~30% 不命中) |
| 4 | "mode 注册:kind='message'"(spec §4.3 隐含) | **`kind: 'session'`**,与所有现有 mode 互斥(`exclusiveWith: ['plan-task', 'research', 'conductor', 'goal']`) | 用户决策(2026-08-28);CUM 是 OS 桌面级独占操作 |
| 5 | "沙箱弹窗 UI(确认气泡 + 3 秒自动 cancel)" | **沿用**,但接入 duya 现有 `tools/approval.py` 风格的 approval 回调;destructive action 走 IPC 推 renderer → 用户确认 → 返回 | spec §4.6 + claude-quickstarts design |
| 6 | "操作历史写入 ~/.duya/logs/computer-use/" | **沿用** + 主日志管道(`electron/logging/logger.ts` + `LogComponent.ComputerUse`),落 `%APPDATA%/DUYA/logs/computer-use/<date>.log` | spec §4.6 + Logging 规范 |
| 7 | "computer-use-mode 注册为 message 模式" | **`kind: 'session'` + persist**(用户在 mode 间切换不丢状态) | 用户决策;SOM overlay 是连续过程,不应被打断 |
| 8 | spec §4.4 "koffi 调用 GDI BitBlt 截屏" | **改用 Electron `desktopCapturer`** + `sharp` 渲染 SOM overlay | Electron 原生 API,跨平台;claude-quickstarts design |
| 9 | spec §4.4 "UIA VerifyPattern + SendInput 兜底" | **统一走 nut.js**(Node.js 跨平台桌面自动化);Win32 UIA 不直接调用 | nut.js 抽象了 Win32 UIA + macOS AXAPI + Linux xdotool |

---

## 3. Non-Goals

- **Wake Agent**(plan 453)— 不在本 plan 范围;依赖其提供的 OSContextBridge
- **OCR 集成**(v0.4 不带截图)— 留 v0.5+(spec §11)
- **远程 Agent / 跨设备操控** — 等 A2A 协议成熟
- **Self-Operating 自主决策** — 不在用户明确请求时不主动监控+行动(spec §0)
- **OS 特权**(SYSTEM/root)— 只走用户态 API(macOS Accessibility / Windows uiAccess / Linux X11)
- **Wake-word / PTT 唤醒**(plan 453 Phase 2)
- **物理迁移 `E:\Projects\computer-use-demo` 到 `packages/`** — Phase 1 用 symlink(wake-agent plan Task A),后续评估
- **computer-use-demo MCP server 化**(原 plan 452 Phase 4)— 留 v0.5+ 技术债评估

---

## 4. Architecture Overview

```
                ┌──────────────────────────────────────────────────┐
                │ DUYA Electron main + Renderer                     │
                │  ┌──────────────────────────────────────────┐    │
                │  │ computer-use-demo daemon (wake-agent)    │    │
                │  │  writes ~/.duya/context/<sid>.json       │    │
                │  └────────────────┬─────────────────────────┘    │
                │                   │ chokidar                       │
                │                   ▼                                │
                │  ┌──────────────────────────────────────────┐    │
                │  │ OSContextBridge (wake-agent plan 453)    │    │
                │  │  → focusedEntity / intentCandidate       │    │
                │  └────────────────┬─────────────────────────┘    │
                └──────────────────┬─┴──────────────────────────────┘
                                   │ reuse
                                   ▼
                ┌──────────────────────────────────────────────────┐
                │ computer-use-mode (ModeModifier, kind=session)   │
                │  ┌──────────────────────────────────────────┐    │
                │  │ tools: 6 OS-side tools (single tool)     │    │
                │  │  - os_capture_screen (screenshot + SOM)  │    │
                │  │  - os_click_at (element index → nut.js)  │    │
                │  │  - os_type / os_key_combo (nut.js)       │    │
                │  │  - os_scroll (nut.js mouse wheel)        │    │
                │  │  - os_window_switch (focus_app)           │    │
                │  │  - os_drag (SendInput drag)               │    │
                │  │  + os_list_apps / os_set_value / os_wait  │    │
                │  │  + recall_layout (memory read)            │    │
                │  │  + refresh_memory (memory write)          │    │
                │  └──────────────────────────────────────────┘    │
                │  onEnter:                                          │
                │   - osContextBridge.enable()                       │
                │   - computerUseDaemon.ensureRunning()              │
                │  onExit:                                           │
                │   - osContextBridge.disable()                      │
                │   - logComputerUseAction 审计落盘                   │
                └──────────────────┬───────────────────────────────┘
                                   │ tool_use
                                   ▼
                ┌──────────────────────────────────────────────────┐
                │ packages/computer-use/ (NEW 子包)                │
                │  ┌──────────────────────────────────────────┐    │
                │  │ DesktopBackend interface (platform-agnostic)│ │
                │  │  capture / click / drag / scroll / type_text│ │
                │  │  key / list_apps / focus_app / set_value / wait│
                │  └────────────────┬─────────────────────────┘    │
                │  ┌────────────────┴─────────────────────────┐    │
                │  │ ElectronDesktopBackend impl              │    │
                │  │  desktopCapturer + nut.js + sharp         │    │
                │  │  + SOM overlay 渲染                       │    │
                │  └──────────────────────────────────────────┘    │
                │  Memory: ~/.duya/computer-use/memory.md           │
                │  Safety: blocked key combos + text patterns       │
                │  Approval: destructive → IPC → renderer 确认       │
                └──────────────────────────────────────────────────┘
```

**关键抽象复用**:
- **ModeModifier**(plan 224)— computer-use-mode 注册为 declarative modifier,沿用 `conductor-mode.ts` 模板
- **`wikiAgentEnabled` 模式**(claude-quickstarts design)— 主 mode 看到 `computer_use` 为单个高层 tool;后续若需要 sub-agent 委托,可参考但 Phase 1 简化为 single tool
- **OSContextBridge**(plan 453)— 复用 wake-agent 的实现,本 plan 不再实现
- **ContextualUserFragment**(plan 453)— computer-use-mode 期间,继续把 OSContext 注入 user message(可见用户在桌面看什么)
- **nut.js** + **sharp** + **Electron desktopCapturer** — Node.js 跨平台桌面自动化栈
- **approval infra**(`packages/agent/src/tools/approval.py` 风格)— destructive action 走 duya 现有 approval 管线

---

## 5. Phase 拆解

### Phase 1 — `packages/computer-use/` 子包骨架 + DesktopBackend(Win32 优先,约 1 周)

> **目标**:独立 Node.js 子包,实现 `DesktopBackend` 接口(capture / click / drag / scroll / type_text / key / list_apps / focus_app / set_value / wait),用 `desktopCapturer` + `nut.js` + `sharp`,SOM overlay 渲染。
> **依赖**: wake-agent plan 453 Phase 1(OSContextBridge)完成。

#### Task A:子包骨架(约 4h)

- [ ] `packages/computer-use/`(新建,**不是 symlink,不是物理迁移**,而是独立 Node.js 包):
  ```json
  {
    "name": "@duya/computer-use",
    "version": "0.0.1",
    "main": "dist/index.js",
    "types": "dist/index.d.ts",
    "scripts": {
      "build": "tsc",
      "build:watch": "tsc --watch"
    },
    "dependencies": {
      "@nut-tree-fork/nut-js": "^4.2.6",
      "sharp": "^0.33.0",
      "electron": "*"  // 仅类型,运行时由主进程注入
    },
    "devDependencies": {
      "@duya/agent": "workspace:*"
    }
  }
  ```
- [ ] `packages/computer-use/tsconfig.json` — extends root,outDir `dist/`
- [ ] `packages/computer-use/src/index.ts` — barrel
- [ ] `pnpm-workspace.yaml` 确认包含 `packages/computer-use`(若用 pnpm)

#### Task B:DesktopBackend 接口(约 1 天)

- [ ] `packages/computer-use/src/backend/types.ts`:
  ```typescript
  export interface DesktopBackend {
    /** 截屏 + 可选 SOM overlay;返回 base64 PNG */
    capture(opts?: { somMode?: boolean; displayId?: number }): Promise<CaptureResult>;
    /** 按 element 索引点击(SOM 模式下)或坐标点击 */
    click(opts: ClickOptions): Promise<ClickResult>;
    drag(opts: DragOptions): Promise<DragResult>;
    scroll(opts: ScrollOptions): Promise<ScrollResult>;
    typeText(opts: TypeTextOptions): Promise<void>;
    key(opts: KeyOptions): Promise<void>;
    listApps(): Promise<AppInfo[]>;
    focusApp(opts: FocusAppOptions): Promise<void>;
    setValue(opts: SetValueOptions): Promise<void>;
    wait(opts: { ms: number }): Promise<void>;
  }
  export interface CaptureResult {
    base64: string;
    width: number;
    height: number;
    /** SOM 模式下:元素索引 → 元素边界框 */
    elements?: SomElement[];
  }
  export interface SomElement { index: number; bbox: { x: number; y: number; w: number; h: number }; label: string; }
  // ... ClickOptions / DragOptions / ScrollOptions / TypeTextOptions / KeyOptions / AppInfo / FocusAppOptions / SetValueOptions
  ```
- [ ] **平台无关**(no `xdotool`, no `osascript`, no PowerShell in interface)— 参考 claude-quickstarts Task 3
- [ ] `packages/computer-use/src/backend/stub.ts` — `NoopDesktopBackend` for tests
- [ ] 单测:`backend.test.ts`(stub 行为 / 接口契约)

#### Task C:ElectronDesktopBackend impl(Win32 优先,约 3 天)

- [ ] `packages/computer-use/src/backend/electron/win32.ts`:
  - `capture()`: `Electron desktopCapturer.getSources({ types: ['screen'] })` → `nativeImage.createFromBuffer()` → base64 PNG
  - `click()`: `nut.js.mouse.setPosition()` + `nut.js.mouse.click()`(SOM index → bbox 中心 → 点击)
  - `drag()`: `nut.js.mouse.drag()`(from → to,带 steps)
  - `scroll()`: `nut.js.mouse.wheel()`(direction + amount)
  - `typeText()`: `nut.js.keyboard.type()`(每字符 delayMs)
  - `key()`: `nut.js.keyboard.pressKey()` + `nut-js` 不支持 modifier 时回退到 `keyTap`
  - `listApps()`: 调 wake-agent plan 453 的 OSContextBridge 拿 `windowList`,或用 `ps` 命令列出可见窗口
  - `focusApp()`: `nut.js` 不支持 → 调 wake-agent plan 453 的 OSContextBridge daemon IPC
  - `setValue()`: 通过 `os_type` 实现(键盘输入)
  - `wait()`: `await new Promise(r => setTimeout(r, ms))`
- [ ] 跨平台骨架:`packages/computer-use/src/backend/electron/index.ts` — 平台检测,选 win32/macos/linux 实现
- [ ] 单测:`electronBackend.test.ts`(mock nut.js + mock desktopCapturer,验证调用序列)

#### Task D:SOM overlay 渲染(约 1.5 天)

- [ ] `packages/computer-use/src/som/overlay.ts` — `drawSomOverlay(image: Buffer, elements: SomElement[]): Promise<Buffer>`:
  - 用 `sharp` 在原图上绘制编号框 + 中心十字
  - 元素边界框 → 红色矩形 + 中心红点 + 顶部编号文字
  - 字体:系统字体(Win32 `Arial` / macOS `Helvetica` / Linux `DejaVu Sans`)
- [ ] `packages/computer-use/src/som/element-detector.ts` — 启发式元素检测:
  - 输入:截屏 + OSContext(从 wake-agent OSContextBridge 拿 `focusedEntity` / `interactionTrail`)
  - 输出:SomElement[]
  - Phase 1 简化:**只标 focusedEntity 的边界**(从 UIA TextPattern 拿)+ 主按钮启发式检测(颜色对比度 + 矩形形状)
  - Phase 2 评估:接入 ML 元素检测(YOLO / DETR)
- [ ] 单测:`overlay.test.ts`(sharp 渲染产物 + 元素编号唯一性)

---

### Phase 2 — `computer-use-mode` ModeModifier + 6 个 OS-side tools(约 1 周)

> **目标**:把 DesktopBackend 包成 6 个 OS-side tools,以 `computer-use-mode` ModeModifier 注册;沙箱 UI + 审计。

#### Task A:computer-use-mode.ts 注册(约 4h)

- [ ] `packages/agent/src/modes/computer-use-mode.ts`(新建,模板 `conductor-mode.ts`):
  ```typescript
  export const computerUseMode: ModeModifier = {
    id: 'computer-use',
    kind: 'session',
    exclusiveWith: ['plan-task', 'research', 'conductor', 'goal'],
    display: { label: 'Computer Use', icon: 'MousePointerClick', description: 'agent 可直接操作桌面与浏览器' },
    tools: {
      inject: () => getComputerUseTools(),  // 6 个 OS-side tools
      overrideFilter: true,                // 与 conductor 一致
    },
    hooks: {
      onEnter: async (ctx) => {
        await getOSContextBridge().enable();
        await getComputerUseDaemon().ensureRunning();
        ctx.toolUseContextPatch = { computerUseMode: true, ...ctx.toolUseContextPatch };
      },
      onExit: async () => {
        getOSContextBridge().disable();
      },
    },
    persist: {
      serialize: (ctx) => ({}),
      deserialize: () => ({}),
    },
  };
  ```
- [ ] `packages/agent/src/modes/index.ts`(修改)— `modeModifierRegistry.register(computerUseMode)`
- [ ] 单测:`computer-use-mode.test.ts`(注册 / exclusiveWith 仲裁 / onEnter-onExit 触发)

#### Task B:6 个 OS-side tools 实施(约 3 天)

- [ ] `packages/agent/src/tool/OSTool/os-capture-screen.ts`:
  - zod schema:`{ somMode?: boolean; displayId?: number }`
  - 执行:调 `packages/computer-use` 的 `desktopBackend.capture({ somMode: true })`
  - 返回:`{ base64, width, height, elements?: SomElement[] }`(若 SOM mode)
- [ ] `packages/agent/src/tool/OSTool/os-click-at.ts`:
  - zod schema:`{ element?: number; x?: number; y?: number; button?: 'left' | 'right' | 'middle' }`
  - 优先按 element 索引(SOM 模式)+ bbox 中心;若 element 缺失,fallback 到 (x, y) 坐标
  - 执行:调 `desktopBackend.click({ x, y, button })`
  - approval:`requireUserConfirm` ✓
- [ ] `packages/agent/src/tool/OSTool/os-type.ts`:
  - zod schema:`{ text: string; delayMs?: number }`
  - **入口校验**:从 OSContextBridge 读 `focusedEntity.redaction.redacted=true` → 拒绝
  - 执行:调 `desktopBackend.typeText({ text, delayMs })`
  - 静默(不需 confirm)
- [ ] `packages/agent/src/tool/OSTool/os-key-combo.ts`:
  - zod schema:`{ key: string; modifiers: ('ctrl' | 'alt' | 'shift' | 'meta')[] }`
  - 安全:safety.ts 校验 blocked combos(`cmd+shift+backspace` / `cmd+ctrl+q` 等)
  - 静默
- [ ] `packages/agent/src/tool/OSTool/os-scroll.ts`:
  - zod schema:`{ direction: 'up' | 'down' | 'left' | 'right'; amount: number }`
  - 执行:调 `desktopBackend.scroll()`
  - 静默
- [ ] `packages/agent/src/tool/OSTool/os-window-switch.ts`:
  - zod schema:`{ title: string; processName?: string }`
  - 执行:调 `desktopBackend.focusApp({ title, processName })`
  - approval:`requireUserConfirm` ✓
- [ ] `packages/agent/src/tool/OSTool/os-drag.ts`:
  - zod schema:`{ fromElement?: number; toElement?: number; fromX?: number; fromY?: number; toX?: number; toY?: number; steps?: number }`
  - 执行:调 `desktopBackend.drag()`
  - approval:`requireUserConfirm` ✓
- [ ] `packages/agent/src/tool/OSTool/os-list-apps.ts`:
  - 调 `desktopBackend.listApps()`,返回可见 App 列表
  - 静默
- [ ] `packages/agent/src/tool/OSTool/os-set-value.ts`:
  - zod schema:`{ value: string }`(假设焦点在 input/textarea 上)
  - 安全校验:focusedEntity.redacted 拒绝
  - 静默
- [ ] `packages/agent/src/tool/OSTool/os-wait.ts`:
  - zod schema:`{ ms: number }`
  - 执行:调 `desktopBackend.wait()`
  - 静默
- [ ] `packages/agent/src/tool/OSTool/index.ts` — barrel,导出 `getComputerUseTools(): ToolRegistration[]`
- [ ] 单测:每个 tool 的 schema / safety / approval mock

#### Task C:沙箱 UI + 权限审批(约 1.5 天)

- [ ] `src/components/automation/ComputerUseConfirm.tsx`(新建) — 确认气泡:
  - 触发:`os_click_at` / `os_window_switch` / `os_drag` tool 调用 → IPC 推 renderer
  - UI:material-style 卡片(tool 名称 + 参数可视化 + 倒计时 3s)
  - 3s 无操作自动 cancel;用户点确认/取消返回
- [ ] `src/lib/computer-use-ipc.ts`(新建) — renderer 端薄包装
- [ ] `electron/ipc/computer-use.ts`(新建):
  - `registerComputerUseExecHandler` — agent → desktopBackend 转发
  - `registerComputerUsePermissionHandler` — agent → renderer 推送权限请求
  - `registerComputerUseCancelHandler` — 撤销 pending 操作
- [ ] `electron/services/computer-use-audit.ts`(新建) — `logComputerUseAction(action, result, userConfirmed)` 调 `logger.info(..., LogComponent.ComputerUse)`,落 `%APPDATA%/DUYA/logs/computer-use/<date>.log`

#### Task D:首次启用权限请求(约 4h)

- [ ] `electron/services/computer-use-permission.ts`(新建):
  - Win32:`uiAccess` manifest 检查(WMI 或 `GetProcessWindowStation`)
  - macOS:Accessibility / Screen Recording 授权(系统对话框引导)
  - Linux:X11 display 检查
  - 缺失:弹窗引导,失败不阻塞 mode 但 tool 降级
- [ ] `src/components/settings/ComputerUseSettings.tsx`(新建)— 设置页加 "Computer Use" 卡片,显示权限状态 + 重试按钮

---

### Phase 3 — Memory + Sub-Agent + Safety + Approval(可选 P1,约 1.5 周)

> **目标**:持久化应用布局记忆(类似 claude-quickstarts design);sub-agent 委托 + safety gates + approval 回调。

#### Task A:Memory module(约 1.5 天)

- [ ] `packages/computer-use/src/memory/index.ts` — `ComputerUseMemory` 类:
  - 读/写 `~/.duya/computer-use/memory.md`
  - 文件格式:按 app 分 section(`## <AppName>` + bullet list)
  - 例:`## VS Code\n- Cmd+K Cmd+S opens keyboard shortcuts\n- File > Open Recent > (Empty) clears history`
- [ ] `packages/computer-use/src/memory/slice.ts` — 按 app 切片 + token 预算(注入 sub-agent prompt)
- [ ] 单测:`memory.test.ts`(读/写/切片)

#### Task B:Sub-Agent 委托(可选,约 2 天)

- [ ] `packages/agent/src/tool/OSTool/os-recall-layout.ts`:
  - zod schema:`{ app: string }`
  - 执行:读 `~/.duya/computer-use/memory.md` 切片 → 注入 sub-agent system prompt
- [ ] `packages/agent/src/tool/OSTool/os-refresh-memory.ts`:
  - zod schema:`{ app: string; note: string }`
  - 执行:追加到 memory.md,带时间戳 + 来源(sub-agent post-turn summary)
- [ ] 单测:`recall-layout.test.ts` / `refresh-memory.test.ts`

#### Task C:Safety gates(约 4h)

- [ ] `packages/computer-use/src/safety/blocked-patterns.ts`:
  - **Blocked key combos**:`cmd+shift+backspace`、`cmd+ctrl+q`、`alt+f4`(Windows)、`ctrl+alt+delete`(**永不触发**)
  - **Blocked text patterns**:`curl | bash`、`rm -rf /`、`mkfs`、`dd if=`、`format c:`(Windows)
  - **Blocked actions**:任何试图运行 shell 命令的组合(`type text` 含 `\n` 后跟 `bash` / `cmd` / `powershell`)
- [ ] `packages/computer-use/src/safety/validator.ts` — 校验函数,任何 safety 违规 → 拒绝 + WARN 日志
- [ ] 单测:`safety.test.ts`(所有 blocked 模式 + 边界)

#### Task D:Approval 回调(约 1 天)

- [ ] `packages/computer-use/src/approval/index.ts` — 复用 duya 现有 approval infra(IPC 推 renderer + 3s cancel + session-level "always allow")
- [ ] destructive actions 列表:`os_click_at` (任何)/ `os_window_switch`(切到 system tools)/ `os_drag`(系统目录之间)/ `os_set_value`(替换大文本)
- [ ] 单测:`approval.test.ts`(用户确认 / 取消 / 超时)

#### Task E:操作历史 UI 回放(可选 P2,约 2 天)

- [ ] `src/components/automation/ComputerUseHistory.tsx`(新建)— 主窗口侧栏:
  - 读取 `%APPDATA%/DUYA/logs/computer-use/<date>.log`
  - 渲染 timeline(每个 action 一张缩略图 + 参数)
  - 点击 action → 新 BrowserWindow 打开前后截图对比

---

## 6. 测试策略

### 6.1 单元测试(Vitest)

| 文件 | 覆盖 |
|---|---|
| `packages/computer-use/src/backend/types.test.ts` | 接口契约 |
| `packages/computer-use/src/backend/electron/win32.test.ts` | nut.js / desktopCapturer mock 验证调用序列 |
| `packages/computer-use/src/som/overlay.test.ts` | sharp 渲染产物 + 元素编号唯一性 |
| `packages/agent/src/tool/OSTool/*.test.ts` | 每个 tool 的 schema / safety / approval mock |
| `packages/agent/src/modes/computer-use-mode.test.ts` | 注册 / exclusiveWith 仲裁 / onEnter-onExit 触发 |
| `packages/computer-use/src/memory/memory.test.ts` | 读/写/切片 |
| `packages/computer-use/src/safety/safety.test.ts` | 所有 blocked 模式 + 边界 |
| `packages/computer-use/src/approval/approval.test.ts` | 用户确认 / 取消 / 超时 |
| `electron/services/computer-use-audit.test.ts` | 审计日志格式 / 落盘路径 |

### 6.2 集成测试(Playwright + Electron)

- [ ] `e2e/smoke/computer-use.spec.ts` — 启用 mode → `os_capture_screen` → 验证 IPC 往返 + SOM 渲染
- [ ] `e2e/ipc/computer-use-confirm.spec.ts` — `os_click_at` 触发确认气泡,3s 超时自动 cancel
- [ ] `e2e/safety/computer-use-blocked.spec.ts` — `os_key_combo` blocked pattern 拒绝

### 6.3 手动验证清单

- [ ] 启用 mode → 说"打开 Chrome 的 settings" → SOM 截图 → model 按 element index 点击 → 看到 Chrome 设置页打开
- [ ] `os_type` 静默执行,审计日志可见
- [ ] 在密码框(`<input type="password">`)上 `os_type` → 拒绝 + WARN 日志
- [ ] `os_key_combo 'cmd+ctrl+q'` → 拒绝(安全规则)
- [ ] 关闭 mode → daemon 持续运行(可被 Wake Agent 复用,plan 453 设计意图);OSContextBridge 自动 disable

### 6.4 性能指标

- [ ] SOM overlay 渲染 **< 100ms**(sharp)
- [ ] `os_capture_screen` 端到端 **< 300ms**(desktopCapturer + SOM 渲染)
- [ ] `os_click_at` (element 模式) **< 200ms**(nut.js)
- [ ] `os_type` 静默,**不阻塞** UI

---

## 7. 关键决策点(本 plan 提交前必须确认)

| # | 决策 | 默认推荐 | 替代 |
|---|---|---|---|
| 1 | CUM 架构 | **Single tool + action enum + ModeModifier 注册**(10 个 action) | 6 个独立 tool(spec 原方案) |
| 2 | OS-side 实现栈 | **nut.js + desktopCapturer + sharp**(跨平台) | koffi + Win32 UIA InvokePattern(spec 原方案,WPF/WinUI 命中率低) |
| 3 | Mode 排他 | **与所有现有 mode 互斥**(plan-task/research/conductor/goal) | 仅与 conductor 互斥 |
| 4 | Mode kind | **`kind: 'session'`** | `kind: 'message'`(spec 隐含) |
| 5 | packages/computer-use/ 与 E:\Projects\computer-use-demo 关系 | **独立子包(职责:主动控制 OS),消费 wake-agent 的 OSContextBridge**(后者消费 E:\Projects\computer-use-demo daemon 输出) | 物理合并(symlink) |
| 6 | SOM 元素检测(Phase 1) | **启发式(focusedEntity bbox + 主按钮颜色对比度)** | ML 检测(YOLO/DETR)— Phase 2 评估 |
| 7 | Sub-Agent 模式 | **Phase 3 可选**;Phase 1-2 简化为 single tool 直接调 desktopBackend | Phase 1 即 sub-agent 委托(claude-quickstarts 原方案) |
| 8 | 沙箱 UI | **Material-style 确认气泡 + 3s cancel**(沿用 spec §4.6) | 全自动(高风险) |
| 9 | 操作审计 | **主日志管道 + `LogComponent.ComputerUse`**(落 `%APPDATA%/DUYA/logs/computer-use/`) | 独立文件目录 |
| 10 | 操作历史 UI 回放 | **Phase 3 可选** | Phase 2 必做 |

> 决策 #2/#3 已在 2026-08-28 与用户确认;其余按 spec §4 + 经验默认,**待评审时确认**。

---

## 8. 依赖与既有工作关系

| 既有 | 复用方式 |
|---|---|
| `ModeModifier` 基座(plan 224) | computer-use-mode 注册 |
| `ModeModifierRegistry`(plan 224) | `modeModifierRegistry.register(computerUseMode)` |
| `conductor-mode.ts` 模板 | 复用 `tools.inject` + `hooks.onEnter/onExit` 模式 |
| **`OSContextBridge`(plan 453)** | **核心依赖**,computer-use-mode 期间 enable,获取 focusedEntity 推断焦点 + redacted 校验 |
| **`computer-use-demo daemon`(plan 453 Task D)** | **核心依赖**,由 wake-agent plan 启动并看护;本 plan 只消费其输出 |
| `ContextualUserFragment`(plan 453) | 继续把 OSContext 注入 user message |
| `electron/services/automation/`(若存在) | spawn / IPC handler 模板 |
| `electron/logging/logger.ts` | 操作审计 + daemon panic 日志 |
| `packages/voice/`(plan 410) | Phase 3 sub-agent 可复用 voice prompt |

---

## 9. 风险与缓解

| 风险 | 影响 | 缓解 | 触发阶段 |
|---|---|---|---|
| Wake-Agent plan 453 未完成 | OSContextBridge 不可用 | **本 plan 必须等 plan 453 Phase 1 完成后开工** | 跨 Phase |
| nut.js ABI 与 Electron 不兼容 | FFI 调用崩溃 | 沿用现有 `better-sqlite3` 的 `prebuild-install` 策略(`scripts/ensure-sqlite-abi.mjs` 改 `ensure-nut-abi.mjs`) | Phase 1 |
| SOM overlay 渲染慢 | `os_capture_screen` 延迟高 | sharp 异步 + 元素检测用启发式,避免 ML 模型推理 | Phase 1 |
| macOS Accessibility 授权被拒 | `os_capture_screen` 失败 | 弹窗引导 + 失败降级到 screenshot-only 模式 | Phase 1 |
| Sub-agent memory 过度膨胀 | `~/.duya/computer-use/memory.md` 失控 | token 预算 + section 切片 + 老旧条目 TTL 清理 | Phase 3 |
| Blocked key combo 漏判 | 误触发危险操作 | safety.ts 单元测试覆盖所有 hermes-agent 列出的 blocked combos;新增 combo 需 PR review | Phase 3 |
| computer-use-mode 与 Wake Agent 同时激活 | 资源争用 | mode 互斥 + Wake Agent 不开 mode(plan 453 §2 决策 7),无冲突 | 跨 Phase |
| 操作审计日志膨胀 | 磁盘占满 | 沿用现有 Logging 规范的 daily rotation + 7 天保留 | Phase 2 |

---

## 10. 验收 checklist(Master)

### Phase 1 — packages/computer-use/ 子包骨架

- [ ] 子包 workspace 集成(`@duya/computer-use` workspace 引用打通)
- [ ] DesktopBackend 接口 + NoopDesktopBackend stub
- [ ] ElectronDesktopBackend Win32 实现(nut.js + desktopCapturer + sharp)
- [ ] SOM overlay 渲染 + 元素检测(启发式)
- [ ] vitest 单元测试 ≥ 90% 覆盖
- [ ] `npm run typecheck:all` 0 错

### Phase 2 — computer-use-mode 注册 + OS-side tools

- [ ] `computer-use-mode.ts` 注册,exclusiveWith 全 mode 互斥
- [ ] 10 个 OS-side tools(capture/click/type/key/scroll/drag/window_switch/list_apps/set_value/wait)
- [ ] 沙箱 UI(确认气泡 + 3s 自动 cancel)
- [ ] 权限请求(首次启用)+ 设置页
- [ ] 审计日志落 `%APPDATA%/DUYA/logs/computer-use/<date>.log`
- [ ] password field 拒绝 + WARN 日志
- [ ] blocked key combo 拒绝 + WARN 日志
- [ ] Playwright e2e:启用 mode → `os_capture_screen` → SOM → `os_click_at(element=5)` → 确认气泡 → 鼠标动作
- [ ] `npm run electron:build` 成功,打包产物包含 `packages/computer-use/dist/`

### Phase 3 — Memory + Sub-Agent + Safety(可选)

- [ ] `~/.duya/computer-use/memory.md` 读/写/切片
- [ ] `os_recall_layout` / `os_refresh_memory` tools
- [ ] safety.ts blocked patterns 全覆盖
- [ ] approval 回调 IPC 打通
- [ ] 操作历史 UI 回放(可选 P2)

---

## 11. 进度记录

> 实施时按 Phase 推进,每完成一个 Task 在对应 `- [ ]` 改为 `- [x]`,并在下方记录决策与偏差。

### 2026-08-28 — 草案

- 与用户确认 3 项关键决策:
  - **computer-use 应主要以截图和鼠标点击的 mode 进行操作,类似 claude-quickstarts 里的实现**
  - **新建独立 plan,主要建设 computer-use 的 mode 在 duya 里如何代码实现,结合现有框架**
  - **新建 packages/computer-use/ 子包(独立 Node.js),共享部分电脑使用的逻辑**
- **关键拆分**:从原 plan 452(混合方案)拆出:
  - plan 453(Wake Agent)负责 OSContextBridge + mini-input + daemon 生命周期
  - **本 plan 454(Computer Use Mode)** 负责 `computer-use-mode` ModeModifier + `packages/computer-use/` 包 + 10 个 OS-side tools + SOM overlay
- 决策 **wake 优先**(本 plan 依赖 plan 453 提供的 OSContextBridge)
- **核心差异 vs 原 plan 452**:
  - 架构:Single tool + action enum(hermes-agent 风格)替代 6 个独立 tool
  - 栈:nut.js + desktopCapturer + sharp 替代 koffi + Win32 UIA InvokePattern
  - 渲染:SOM overlay(元素索引)替代 UIA 控件查找
  - 持久记忆:`~/.duya/computer-use/memory.md` 是新增能力
  - 平台:nut.js 跨平台(Mac/Win/Linux),不再 Win32-only
- **完全采用** [`E:\cloned-projects\claude-quickstarts\duya-computer-use-plan.md`](../../../cloned-projects/claude-quickstarts/duya-computer-use-plan.md) 的设计骨架(19 Task 的核心 idea),只在 Phase 划分与文件位置上做了 duya 适配
- **待评审**:Plan 草稿完成后,需用户确认 §7 决策 #4–#10 + Phase 1–3 时间盒(1 周 + 1 周 + 1.5 周)可接受