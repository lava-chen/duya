# Wake Agent & Computer Use Mode

> 更新时间：2026-08-27
> 
> **状态**：设计草案（Draft） — 待评审

## 概述

DUYA 计划引入两个相互关联的新能力:

1. **唤醒 Agent(Wake Agent)** — 允许用户在不打开 DUYA 主窗口的情况下,从任意桌面位置召唤 Agent。
2. **Computer Use Mode(CUM)** — 在 Agent 已有"对话 + 工具调用"能力基础上,新增"直接驱动操作系统桌面"的能力。

两个功能的依赖关系:**Computer Use Mode 的输入 = Wake Agent 的上下文源 = `computer-use-demo` 包**(`E:\Projects\computer-use-demo` v0.4.0,作为独立 daemon 写 `context-latest.json`)。

## 设计目标

1. **无障碍** — 任意桌面焦点 / 任意 App 内都能唤醒 Agent,不需要先打开 DUYA
2. **可观察性** — Agent 唤醒瞬间就能看到用户在做什么(`focusedEntity` + `interactionTrail` + `intentCandidate`)
3. **可控制性** — Computer Use Mode 必须有显式权限确认 + 操作可中断 + 密码字段永不触发
4. **平台无关** — Win32 / macOS / Linux 都可走,MacOS 与 Linux 通过 AXAPI / xdotool 适配
5. **解耦** — `computer-use-demo` 仍是独立 daemon,不嵌入 DUYA 主进程

## 设计非目标 (Out of Scope)

- 远程 Agent / 跨设备操控(等 A2A 协议成熟后再考虑)
- 自主决策的 Agent(Self-Operating):当前只在用户明确请求时执行,不主动监控+行动
- 操作系统底层特权(`SYSTEM`/`root`):所有操作走用户态无障碍 API

---

## 1. 现状盘点

### 1.1 已有基础设施

| 模块 | 位置 | 复用方式 |
|---|---|---|
| Mode 注册机制 | `packages/agent/src/modes/` | 已有 `automation-mode.ts` / `conductor-mode.ts` / `research-mode.ts`,新 mode 直接挂载 |
| Browser 侧 Computer Use | `packages/agent/src/tool/BrowserTool/actions/computer.ts` (318 行, CDP `Input.*`) | 不动,继续服务浏览器 |
| Mode 入口 UI | `packages/agent/src/modes/*.tsx`(display label/icon/description) | 沿用 `display: { label, icon, description }` pattern |
| Voice 链路 | `packages/voice/`(vad/stt/whisper/cloud) | 仅 STT/TTS,Wake-word 与 PTT trigger 是新加层 |
| MCP 客户端 | `packages/agent/src/mcp/` | DUYA 已是 MCP client,可消费 computer-use-demo 暴露的 MCP server (v0.5+) |
| Electron IPC 总线 | `electron/main.ts` + `electron/ipc/*` | 沿用现有 channel 命名约定 `automation:*` |

### 1.2 缺失的部分

| 缺失 | 由本 spec 引入 |
|---|---|
| OS-side Computer Use tools(6 个) | §4 |
| 全局快捷键 + mini-input UI | §3 |
| OS Context Bridge(`computer-use-demo` → Agent) | §2 |
| Wake-word / PTT trigger | §3.2 / §3.3 |

### 1.3 关键复用依赖

```
computer-use-demo (v0.4.0, E:\Projects\computer-use-demo)
├─ L1 sensors: Win32 GUITHREADINFO + UIA + MSAA + koffi
├─ L2 fusion: FocusedEntity / InteractionTrail / IntentCandidate
├─ L3 schema: ContextPayload schemaVersion 0.4.0 (17 顶层字段)
└─ L4 transport: 文件契约 ~/.duya/context/<sessionId>.json
```

详细字段定义见 `E:\Projects\computer-use-demo\src\types.ts`。

---

## 2. OS Context Bridge(共用基座)

把 `computer-use-demo` 输出的 ContextPayload 注入到 DUYA Agent 的 system prompt / message history。

### 2.1 架构

```
┌────────────────────────────────────────────────────────────┐
│  computer-use-demo daemon (Node child process)            │
│  写入 ~/.duya/context/<sessionId>.json 每 ~500ms           │
└──────────────────────────┬─────────────────────────────────┘
                           │ fs.watch (chokidar)
                           ▼
┌────────────────────────────────────────────────────────────┐
│  packages/agent/src/context/os-context/                    │
│  ├─ watcher.ts     fs.watch + JSON parse                   │
│  ├─ payload.ts     schemaVersion 校验 + 字段裁剪           │
│  ├─ dispatcher.ts  → agent context injector                │
│  └─ mode-flag.ts   computer-use-mode 开关 (决定是否注入)   │
└──────────────────────────┬─────────────────────────────────┘
                           │ contextInjector callback
                           ▼
┌────────────────────────────────────────────────────────────┐
│  Agent system prompt                                       │
│  <OSContextSection>                                        │
│  focusedEntity: { kind: "Text", source: "uia", ... }       │
│  intentCandidate: { intent: "edit_code", confidence: 0.7 } │
│  interactionTrail: [ 30s 滑动窗口, max 50 events ]         │
│  </OSContextSection>                                       │
└────────────────────────────────────────────────────────────┘
```

### 2.2 接口契约

```typescript
// packages/agent/src/context/os-context/payload.ts

export interface OSContextBridgeConfig {
  /** 用户上下文目录,默认 ~/.duya/context */
  contextDir: string;
  /** 文件契约读取间隔,默认 200ms */
  pollIntervalMs: number;
  /** 是否启用,默认 false(Wake Agent / Computer Use Mode 打开时启用) */
  enabled: boolean;
  /** schemaVersion 白名单,默认 ["0.4.0"] */
  acceptedVersions: string[];
  /** Trail 注入上限,默认 30 (来自 InteractionTrail 30s 滑动窗口的 60%) */
  maxTrailEvents: number;
}

export interface OSContextBridge {
  start(): Promise<void>;
  stop(): Promise<void>;
  getCurrent(): OSContext | null;
  subscribe(listener: (ctx: OSContext) => void): () => void;
}

export interface OSContext {
  schemaVersion: string;
  capturedAt: string;
  focusedEntity: FocusedEntity | null;
  interactionTrail: InteractionEvent[];
  intentCandidate: IntentCandidate | null;
  /** 当前前台窗口 */
  foreground: { pid: number; exeName: string; title: string };
  /** 截屏(可选,v0.4 不带,v0.5+ 携带 base64) */
  screenshot?: { base64: string; width: number; height: number };
}
```

### 2.3 关键文件改动

| 文件 | 改动 |
|---|---|
| `packages/agent/src/context/os-context/watcher.ts` (新建) | `chokidar.watch()` + JSON.parse + schemaVersion 校验 |
| `packages/agent/src/context/os-context/payload.ts` (新建) | `OSContextBridge` 类实现 |
| `packages/agent/src/context/os-context/dispatcher.ts` (新建) | 注册到 agent context injector,沿用 multi-agent.md §1.3 的 `contextInjector` 模式 |
| `packages/agent/src/context/os-context/mode-flag.ts` (新建) | `isComputerUseModeActive()` 决定注入与否 |
| `electron/main.ts` | 启动 computer-use-demo 子进程(spawn,带 stdio:"pipe" 捕获 panic 日志) |
| `packages/agent/src/context/registry.ts`(或现有 index.ts) | 导出 `getOSContextBridge()` singleton |

### 2.4 接入决策(必须先确认)

| 方案 | 优点 | 缺点 | 推荐度 |
|---|---|---|---|
| **A. 进程外文件契约** | 解耦;daemon 挂了 Agent 不死;cross-language | 50-200ms 文件 I/O 延迟;Windows `fs.watch` quirks | ⭐ 推荐 |
| **B. 进程内 embed**(`@duya/computer-use-demo` 包) | 零延迟;共享内存 | 拖入 daemon 子进程到主进程,崩了影响整个 DUYA | 不推荐 |
| **C. MCP server** | 标准协议;未来 A2A/ACP 兼容 | 需要 computer-use-demo 加 mcpServer.ts(2-3 天) | v0.5+ 升级 |

**初始选 A,设计保留升级到 C 的空间**:dispatcher.ts 抽象成 interface,实现可换。

---

## 3. 唤醒 Agent (Wake Agent)

### 3.1 范围

用户在不打开 DUYA 主窗口的情况下,从任意桌面位置召唤 Agent。Agent 唤醒瞬间自动加载 OSContextBridge 当前快照。

### 3.2 触发方式(分阶段)

| 阶段 | 触发 | 实施包 | 优先级 |
|---|---|---|---|
| **WAKE-P0** | 全局快捷键(`Ctrl+Shift+Space` 中文输入法不抢) | `electron/main.ts` + `electron/ipc/wake.ts` | ⭐ P0 |
| **WAKE-P1** | Hold-to-Talk(鼠标侧键 / F12 长按录音) | `packages/voice/src/wake-trigger.ts` | P1 |
| **WAKE-P2** | Wake-word 语音唤醒("Hey Duya" / "嗨 Duya") | `packages/voice/src/wake-word/` (本地 openWakeWord) | P2 |

### 3.3 三态转换

```
       submit                    done
DORMANT ────→ INPUT ────→ THINKING ────→ DORMANT
   ▲                                       │
   └─────────── (cancel / Esc) ────────────┘
```

| 状态 | UI | 后台 |
|---|---|---|
| `DORMANT` | 无 UI,daemon 仍在喂 context | computer-use-demo daemon 持续运行 |
| `INPUT` | mini-input 浮窗(300x80 px,可叠加语音) | Voice worker 启动 |
| `THINKING` | mini-input 切到 progress,显示 token 流 | Agent streamChat |

### 3.4 系统 Prompt 注入

唤醒后,**第一轮** system prompt 自动包含 OSContextBridge.current:

```xml
<OSContextSection>
focusedEntity: { kind: "Text", source: "uia", nativeControlType: "Edit", 
                 confidence: 0.9, text: "..." }
intentCandidate: { intent: "edit_code", confidence: 0.7, evidence: [...] }
interactionTrail: 过去 30 秒用户在 Chrome → VS Code → Chrome
foreground: { pid: 12345, exeName: "chrome.exe", title: "GitHub - ..." }
</OSContextSection>
```

LLM 据此**预填**第一轮响应。例如看到用户在 Chrome 读 GitHub,可直接生成"需要我帮你 review 这个 PR 吗?"。

### 3.5 关键文件改动

| 文件 | 改动 |
|---|---|
| `electron/main.ts` | `globalShortcut.register('CommandOrControl+Shift+Space', wakeHandler)` |
| `electron/ipc/wake.ts` (新建) | `IPC:automation:wake` channel,唤起 renderer mini-input |
| `electron/renderer/mini-input/` (新建,300x80 浮窗) | 极简聊天输入 UI;接受 `wakeless: true` 参数 |
| `packages/voice/src/wake-trigger.ts` (新建, P1) | PTT 触发器(注册到 globalShortcut PTT 按键) |
| `packages/voice/src/wake-word/` (新建, P2) | openWakeWord / Picovoice 本地检测 |
| `packages/agent/src/chat/ChatStartCommand` | 接收 `wakeless: true` 参数时不开主窗口,只走 mini-input |
| `electron/app-icon-tray.ts`(如有) | 系统托盘图标添加"Wake Agent"右键菜单 |

### 3.6 mini-input UI 设计原则

- 始终置顶(`alwaysOnTop: true`)
- 屏幕底部居中(类似 Spotlight / Raycast)
- 支持文字 / 语音 / 文件拖拽
- 自动隐藏逻辑:60 秒无操作 → fade-out
- 快捷键:`Esc` 关闭 / `↑↓` 翻历史 / `Enter` 提交

---

## 4. Computer Use Mode

### 4.1 范围

Agent 不仅能对话,还能**直接驱动 OS 桌面** —— 点击、键入、滚动、切窗口 —— 配合 computer-use-demo 的 OSContextBridge,完成"用户看着屏幕,Agent 在旁边动手"。

### 4.2 OS-side Computer Use 实现路线

| 方案 | 工具 | 精度 | 权限 | 改动量 |
|---|---|---|---|---|
| **A. UI Automation InvokePattern** | `UIAutomationCore.dll` | 控件级(像素自由) | 无 | 中 |
| **B. Win32 SendInput** | `user32.dll!SendInput` | 像素级 | Windows 设置无障碍 | 小 |
| **C. Apple Accessibility API** | `ApplicationServices.framework` | 控件级 | macOS 无障碍授权 | 中 |
| **D. xdotool** | Linux 子进程 | 像素级 | X11 display | 小 |

**推荐路线**:**Windows 用 A**(控件级,UI 抖动健壮);**macOS 用 C**;**Linux 用 D**。

| 浏览器内 | OS 桌面 |
|---|---|
| 沿用现有 `computer.ts` (CDP `Input.*`) | 新建 `OSTool/*` (6 个 tools) |

### 4.3 Mode 注册

```typescript
// packages/agent/src/modes/computer-use-mode.ts

export const computerUseMode: ModeModifier = {
  id: 'computer-use',
  kind: 'message',
  display: {
    label: 'Computer Use',
    icon: 'MousePointerClick',
    description: 'agent 可直接操作桌面与浏览器',
  },
  // 注入 OS Context 到 system prompt
  contextInjector: injectOSContext,
  // 注册 OS-side tools
  tools: [
    'os_capture_screen',
    'os_click_at',
    'os_type',
    'os_key_combo',
    'os_scroll',
    'os_window_switch',
  ],
  // 严格沙箱
  permissions: {
    requireUserConfirm: ['os_click_at', 'os_window_switch'],
    allowList: ['os_type', 'os_key_combo'], // 键入无确认
    deniedTargets: ['password_field'],
  },
  onEnter: () => {
    osContextBridge.enable();
    toast('Computer Use Mode 已启用 — 所有操作会请求确认');
  },
  onExit: () => {
    osContextBridge.disable();
  },
};
```

### 4.4 OS-side Tools(6 个)

沿用 `computer.ts` 的 ActionContext + ActionHandler 模式,新建 `packages/agent/src/tool/OSTool/`:

| Tool | 实现 | 复用 |
|---|---|---|
| `os_capture_screen` | koffi 调用 GDI `BitBlt` 截屏 → base64 | computer-use-demo v0.2 截屏路径 |
| `os_click_at(x, y)` | UI Automation InvokePattern(优先)/ Win32 `SendInput` 兜底 | koffi FFI |
| `os_type(text)` | Win32 `SendInput` unicode(每字符 KEYEVENTF_UNICODE) | koffi FFI |
| `os_key_combo(key, mods)` | Win32 `SendInput` keyboard(vkKeyScan + modifiers) | koffi FFI |
| `os_scroll(direction, amount)` | Win32 `SendInput` mouse wheel | koffi FFI |
| `os_window_switch(title)` | `SetForegroundWindow` + UIA 验证焦点 | computer-use-demo `windowWatcher.ts` |

**关键设计**:OS端 tool 通过 **computer-use-demo 的 IPC** 触发(`automation:computer-use:exec` channel),让 daemon 保持单一职责。

### 4.5 Tool 接口契约

```typescript
// packages/agent/src/tool/OSTool/types.ts

export type OSToolAction =
  | { kind: 'os_capture_screen' }
  | { kind: 'os_click_at'; x: number; y: number; button: 'left' | 'right' | 'middle' }
  | { kind: 'os_type'; text: string; delayMs?: number }
  | { kind: 'os_key_combo'; key: string; modifiers: ('ctrl' | 'alt' | 'shift' | 'meta')[] }
  | { kind: 'os_scroll'; direction: 'up' | 'down' | 'left' | 'right'; amount: number }
  | { kind: 'os_window_switch'; title: string; processName?: string };

export interface OSToolResult {
  ok: boolean;
  /** 执行前 / 后的截屏对比(可选,base64) */
  beforeScreenshot?: string;
  afterScreenshot?: string;
  /** 若 UI Automation InvokePattern 命中,返回控件信息 */
  targetControl?: { className: string; name: string; automationId?: string };
  error?: string;
}
```

### 4.6 沙箱与安全(必做)

- **首次启动** → 弹权限请求(Windows: UIAccess;macOS: Accessibility;Linux: X11 无)
- **每次 os_click_at / os_window_switch** → 弹确认气泡(material-style UI),3 秒无操作自动 cancel
- **密码字段** → `OSTool` 入口校验 `redaction.redacted=true` 时**拒绝执行**
- **退出 mode** → 自动 `ModeModifier.cleanup()` 关闭 IPC + 撤销权限
- **操作历史** → 写入 `~/.duya/logs/computer-use/<date>.log`(可审计)

### 4.7 关键文件改动

| 文件 | 改动 |
|---|---|
| `packages/computer-use/` (新建,作为 duya 包) | 把 `E:/Projects/computer-use-demo` 物理迁过来或软链接 |
| `packages/agent/src/modes/computer-use-mode.ts` (新建) | ModeModifier 注册,沿用 `conductor-mode.ts` 模板 |
| `packages/agent/src/modes/registry.ts` | 注册 `computer-use-mode` |
| `packages/agent/src/tool/OSTool/` (新建) | 6 个 OS-side tools + types.ts |
| `packages/agent/src/tool/OSTool/os-capture.ts` | koffi FFI + GDI |
| `packages/agent/src/tool/OSTool/os-click.ts` | UIA InvokePattern 优先 + SendInput 兜底 |
| `packages/agent/src/tool/OSTool/os-type.ts` | SendInput unicode |
| `packages/agent/src/tool/OSTool/os-key-combo.ts` | SendInput keyboard |
| `packages/agent/src/tool/OSTool/os-scroll.ts` | SendInput wheel |
| `packages/agent/src/tool/OSTool/os-window-switch.ts` | SetForegroundWindow + UIA 验证 |
| `electron/main.ts` | 启 computer-use-demo daemon 子进程 |
| `electron/ipc/computer-use.ts` (新建) | `automation:computer-use:exec` channel |
| `packages/voice/src/wake-trigger.ts` | 接 computer-use-mode 的 PTT 唤醒 |

---

## 5. 关键决策点(实施前必须确认)

| # | 决策 | 默认推荐 |
|---|---|---|
| 1 | OS Context Bridge 接入方式(A 文件契约 / B embed / C MCP) | A(进程外文件契约),设计保留升级 C 的接口 |
| 2 | OS-side click 实现(A UIA InvokePattern / B Win32 SendInput) | A(控件级,UI 抖动健壮) |
| 3 | Wake 快捷键默认值 | `Ctrl+Shift+Space`(中文输入法不抢) |
| 4 | Password 字段处理 | 永不触发 + 写日志(可审计) |
| 5 | OS-side 操作是否需要用户确认 | 是(`os_click_at` / `os_window_switch` 必须;`os_type` / `os_key_combo` 静默) |
| 6 | computer-use-demo 物理路径 | 软链接到 `packages/computer-use/`(暂时),后续迁移 |
| 7 | Wake-word 检测库 | P2 阶段优先 openWakeWord(本地,免费) |

---

## 6. 实施计划

### Phase 1: P0 基础设施 + Wake-P0(2 周)

- [ ] 把 `E:\Projects\computer-use-demo` 软链接到 `packages/computer-use/`
- [ ] 实现 `OSContextBridge` 基座(watcher + payload + dispatcher + mode-flag)
- [ ] `electron/main.ts` 注册 `CommandOrControl+Shift+Space` globalShortcut
- [ ] 新建 `electron/ipc/wake.ts` + `electron/renderer/mini-input/`
- [ ] `ChatStartCommand` 支持 `wakeless: true`
- [ ] **验收**:按快捷键 → mini-input 浮窗 → 输入"现在在做什么?" → Agent 答"你在 Chrome 看 GitHub"

### Phase 2: P1 Computer Use Mode MVP(2 周)

- [ ] `packages/agent/src/modes/computer-use-mode.ts` 注册
- [ ] 6 个 OS-side tools 实施(`os_click_at` 走 UIA InvokePattern 优先)
- [ ] 沙箱弹窗 UI(确认气泡 + 3 秒自动 cancel)
- [ ] 操作历史写入 `~/.duya/logs/computer-use/`
- [ ] **验收**:Mode 切到 Computer Use → "帮我点一下 Chrome 的 settings" → 看到鼠标动

### Phase 3: P2 Wake-P1 Hold-to-Talk(1 周)

- [ ] `packages/voice/src/wake-trigger.ts` 接全局 PTT(鼠标侧键 / F12)
- [ ] mini-input 改成"按住说话"模式
- [ ] Voice worker 与 OSContextBridge 并行启动

### Phase 4: P3 Wake-Word + 高级 Tools(2 周)

- [ ] openWakeWord 集成(本地检测 "Hey Duya" / "嗨 Duya")
- [ ] `os_window_switch` / `os_drag` / `os_resize_window` 等扩展 tools
- [ ] 操作历史 UI(可在 DUYA 主窗口回放)

### Phase 5: P4 MCP 升级(可选,2 周)

- [ ] computer-use-demo 加 `mcpServer.ts` 暴露 ContextPayload 为 MCP 资源
- [ ] DUYA mcp client 切换从文件契约到 MCP
- [ ] 兼容期:文件契约与 MCP 并存,feature flag 切换

---

## 7. 与现有系统的依赖图

```
                ┌─────────────────────┐
                │  DUYA Agent         │
                │  (duyaAgent)        │
                └──────────┬──────────┘
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
        ▼                  ▼                  ▼
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│  modes/      │   │  tools/      │   │  context/    │
│              │   │              │   │              │
│  computer-   │   │  OSTool/     │   │  os-context/ │
│  use-mode   │   │  (NEW)       │   │  (NEW)       │
│  (NEW)       │   │              │   │              │
└──────┬───────┘   └──────┬───────┘   └──────┬───────┘
       │                  │                  │
       │                  │  automation:     │  fs.watch
       │                  │  computer-use:   │  ~/.duya/context/
       │                  │  exec            │
       │                  ▼                  ▼
       │          ┌─────────────────────────────────┐
       │          │  computer-use-demo daemon       │
       │          │  (E:\Projects\computer-use-demo)│
       │          │  v0.4.0                         │
       │          └─────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────┐
│  Mini-Input UI                  │
│  (electron/renderer/mini-input) │
│                                 │
│  alwaysOnTop: true              │
│  300x80 浮窗                    │
└─────────────────────────────────┘
```

---

## 8. 接口契约总览

### 8.1 OSContextBridge

```typescript
interface OSContextBridge {
  start(): Promise<void>;
  stop(): Promise<void>;
  getCurrent(): OSContext | null;
  subscribe(listener: (ctx: OSContext) => void): () => void;
}
```

### 8.2 ModeModifier:computer-use-mode

```typescript
interface ComputerUseMode extends ModeModifier {
  id: 'computer-use';
  contextInjector: (ctx: AgentContext) => AgentContext;
  tools: ['os_capture_screen', 'os_click_at', 'os_type', 'os_key_combo', 'os_scroll', 'os_window_switch'];
  permissions: {
    requireUserConfirm: ['os_click_at', 'os_window_switch'];
    allowList: ['os_type', 'os_key_combo'];
    deniedTargets: ['password_field'];
  };
}
```

### 8.3 IPC Channels

| Channel | 方向 | 用途 |
|---|---|---|
| `automation:wake` | renderer → main | Wake Agent 触发(快捷键 / 托盘) |
| `automation:mode:set` | renderer → main | 切换 mode(已有) |
| `automation:computer-use:exec` | renderer → main → daemon | OS-side tool 执行请求 |
| `automation:computer-use:result` | daemon → main → renderer | OS-side tool 执行结果 |
| `automation:computer-use:permission` | main → renderer | 弹确认气泡请求 |
| `automation:computer-use:cancel` | renderer → main → daemon | 撤销待执行操作 |

---

## 9. 测试与验证

### 9.1 WAKE-P0 验收清单

- [ ] 按 `Ctrl+Shift+Space` 在任意 App 内 → mini-input 浮窗出现
- [ ] mini-input 接受文字 + 文件拖拽
- [ ] 第一轮响应包含 OSContextBridge.current 摘要
- [ ] `Esc` 关闭浮窗
- [ ] 60 秒无操作 → 自动 fade-out

### 9.2 Computer Use Mode MVP 验收清单

- [ ] Mode 切换 UI 显示 "Computer Use" 卡片
- [ ] 启用 mode → 弹权限请求(首次)
- [ ] `os_click_at(x, y)` 命中目标控件 → 弹确认气泡 → 3 秒无操作自动 cancel
- [ ] `os_type` 静默执行
- [ ] password 字段 → `os_type` 拒绝执行 + 写日志
- [ ] 退出 mode → OSContextBridge 自动 disable

### 9.3 性能指标

- OS Context Bridge 端到端延迟:**< 300ms**(文件契约读取 + JSON 解析 + 注入)
- Wake Agent → 首 token:**< 800ms**
- OS-side click 响应:**< 200ms**(UIA 命中)/ **< 100ms**(SendInput 兜底)

---

## 10. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 中文输入法抢全局快捷键 | Wake-P0 失效 | 用 `Ctrl+Shift+Space`(中文输入法默认不抢);提供设置入口让用户自定义 |
| UIA InvokePattern 在某些 App 不工作 | `os_click_at` 失败 | 自动 fallback 到 SendInput 像素级;记日志 |
| computer-use-demo daemon 崩溃 | OSContextBridge 断流 | spawn 时带 stdio:"pipe" + 自动重启;UI 显示"Context Source Offline" 降级提示 |
| OS-side tool 误触发(用户没确认) | 不可逆操作 | 严格 requireUserConfirm + 3 秒 cancel + 操作历史可回滚(尽力) |
| MacOS / Linux 平台支持滞后 | 仅 Win32 可用 | P0/P1 阶段仅 Win32;P3 加 macOS(P2 已有 xdotool 路径) |
| 与 DUYA 主窗口的 mode 冲突 | 用户在主窗口内无法 wake | mini-input 始终置顶 + 不依赖主窗口存在 |

---

## 11. 后续工作(v0.5+)

- [ ] OCR 集成(取代截屏 base64)
- [ ] cross-platform:macOS AXAPI / Linux xdotool
- [ ] Wake-word 本地模型蒸馏(降低功耗)
- [ ] OS-side tool history UI(可在 DUYA 主窗口回放)
- [ ] computer-use-demo MCP server 暴露(替换文件契约)
- [ ] DUYA App 内手绘标注 → 直接转 OS-side 指令(白板式交互)

---

## 12. 附录

### A. computer-use-demo v0.4.0 ContextPayload 字段摘要

```
schemaVersion 0.4.0
├─ 元数据层: schemaVersion / capturedAt / platform / assembleDurationMs / redaction
├─ 物理输入层: cursor / mouseTarget / windowList[]
├─ 焦点层: focus
├─ 无障碍树层: textInputs[] / uia / msaa
├─ v0.2 截屏层: screen? (可选)
├─ v0.3 浏览器专精层: browserPage
└─ v0.4 意图中间层: focusedEntity / interactionTrail[] / intentCandidate
```

详见 `E:\Projects\computer-use-demo\src\types.ts`。

### B. 参考资料

- Microsoft App Actions `ActionEntityKind`(8 类):`docs.microsoft.com/en-us/windows/apps/develop/app-actions`
- Apple App Intents `@AppIntent` + `AppEntity`:`developer.apple.com/documentation/appintents`
- Apple Onscreen Awareness (iOS 27 / macOS 27 路线图)
- Microsoft Click to Do (`Win+Click` → OCR + Phi Silica + ActionEntity)
- DUYA 现有 mode 系统:`packages/agent/src/modes/`
- DUYA 现有 Computer Use (browser 侧):`packages/agent/src/tool/BrowserTool/actions/computer.ts`
- DUYA multi-agent spec:`docs/product-specs/multi-agent.md`(contextInjector 模式参考)

### C. 类型速查

```
OSContextBridge          // 文件契约 watcher
OSContext                // 当前 OS 上下文快照
FocusedEntity            // 8 类平台无关实体(Text / StreamingText / File / Document / Photo / RemoteFile / Table / Contact)
InteractionEvent         // 30s trail 单事件(window_focus / selection_change / text_change / app_launch / hotkey)
IntentCandidate          // 单候选 + 置信度
OSToolAction             // 6 类 OS 操作
ModeModifier             // mode 注册(已有,沿用)
ComputerUseMode          // 本 spec 新增
```