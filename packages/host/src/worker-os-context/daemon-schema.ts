/**
 * Shared types for the computer-use demo.
 *
 * v0.3 (2026-08-22 方向调整):
 *   - 双模式共存: screen-daemon.ts (v0.2 全屏上下文) + main.ts (v0.3 浏览器专精)
 *   - v0.3 新增 BrowserPageExtract 系列类型: url / title / visibleText / focusedField /
 *     selection / forms[] / tabs[] / extractionPath
 *   - schemaVersion 升到 0.3.0; 兼容 v0.2 的 screen / mouseTarget 字段
 *   - screen 改为可选: v0.3 浏览器模式不截屏
 *
 * v0.2 遗产 (screen-daemon.ts 仍使用):
 *   - ContextPayload / WindowInfo / FocusInfo / RedactionInfo / ScreenInfo
 *   - UiaInfo / MsaaInfo
 *   - CaptureResponse
 *
 * 设计原则:
 *   - 两个 daemon 共享同一份 types.ts, 共享同一份 ContextPayload schema
 *   - v0.2 路径填 screen + mouseTarget; v0.3 路径填 browserPage
 *   - duya consumer 读 context-latest.json 时根据 schemaVersion + 字段有无判断来源
 */

// ---------------------------------------------------------------------------
// 基础结构
// ---------------------------------------------------------------------------

/** 屏幕上某个可见顶层窗口的元信息。 */
export interface WindowInfo {
  /** 原生窗口句柄 (Windows: HWND). 跨平台时为抽象句柄字符串。 */
  hwnd: string;
  /** 窗口标题。脱敏状态下为 "[REDACTED]"。 */
  title: string;
  /** 窗口类名 (Windows: Win32 class name)。 */
  className: string;
  /** 拥有该窗口的进程 PID。 */
  processId: number;
  /** 该窗口所属的可执行文件名 (小写, 不含路径)。脱敏状态下为 "[REDACTED]"。 */
  processName: string;
  /** 窗口是否拥有键盘焦点 (前台)。 */
  isFocused: boolean;
  /** 窗口在虚拟屏幕坐标下的矩形 (x/y/w/h, 单位像素)。 */
  bounds: { x: number; y: number; w: number; h: number };
}

/** 当前前台焦点信息。 */
export interface FocusInfo {
  /** 前台顶层窗口句柄。 */
  foregroundHwnd: string;
  /** 前台窗口的进程 PID。 */
  foregroundPid: number;
  /** 前台窗口所属可执行文件名 (小写)。 */
  foregroundProcessName: string;
  /** 键盘焦点控件句柄 (GUITHREADINFO.hwndFocus)。null = 无法解析或无独立控件。 */
  focusControlHwnd: string | null;
  /** 焦点控件的 Win32 类名 (如 "Edit"、"Chrome_RenderWidgetHostHWND")。 */
  focusControlClassName: string | null;
  /**
   * 焦点控件文本 (WM_GETTEXT 尽力读取, 截断至 ~200 字符)。
   * 标准控件 (记事本 Edit 等) 可读到内容; Electron/Chromium 应用通常只返回标题。
   * 密码框 (ES_PASSWORD) 不读取, 返回 null 并置 focusControlIsPassword=true。
   */
  focusControlText: string | null;
  /** 焦点控件是否为密码输入框 (ES_PASSWORD 样式)。 */
  focusControlIsPassword: boolean;
  /** 插入符 (光标) 在屏幕上的位置 (ClientToScreen 换算后)。null = 不可用。 */
  caret: { x: number; y: number; w: number; h: number } | null;
}

/**
 * 鼠标光标所在窗口 — 用户实际关注的窗口 (优先级高于前台焦点)。
 * 由 Win32 WindowFromPoint 拿到 HWND, 再从 enumWindows 列表中查详情。
 */
export interface MouseTargetInfo {
  /** 鼠标所在窗口的 HWND (Win 字符串形式)。 */
  hwnd: string;
  /** 窗口标题 (脱敏状态下为 "[REDACTED]")。 */
  title: string;
  /** 进程名 (小写)。 */
  processName: string;
  /** 窗口类名。 */
  className: string;
  /** 窗口矩形。 */
  bounds: { x: number; y: number; w: number; h: number };
  /** 进程 PID。 */
  processId: number;
  /** 鼠标所在窗口是否就是前台窗口 — 简化判断用户是否正在该窗口操作。 */
  isForeground: boolean;
}

/** 鼠标光标位置 (物理像素 + VLM 像素 — 仅 v0.2 截屏路径需要 vlmX/vlmY)。 */
export interface CursorInfo {
  /** 物理像素 (实际屏幕坐标)。 */
  physX: number;
  physY: number;
  /** VLM 空间像素 (缩放后坐标, 与 VLM 输入对齐; 仅 v0.2 有截屏时使用)。 */
  vlmX?: number;
  vlmY?: number;
}

/** 整张截屏的元信息 (不包含像素数据, 像素走 IPC 单独通道或 base64 嵌入)。 */
export interface ScreenInfo {
  /** 主显示器边界 (x/y/w/h)。 */
  primaryBounds: { x: number; y: number; w: number; h: number };
  /** 屏幕缩放因子 (Windows: 通常为 1.0 / 1.25 / 1.5 / 2.0)。 */
  scaleFactor: number;
  /** 截图生成时间 (ISO8601)。 */
  capturedAt: string;
  /** 截图文件路径 (相对 capture 子文件夹, 如 "./screenshot.png")。 */
  screenshotPath: string;
  /** 截图绝对路径, 便于 duya 直接读取文件。 */
  screenshotAbsolutePath: string;
  /** 截图字节长度 (便于 duya 校验完整性)。 */
  screenshotByteLength: number;
}

/** 脱敏决策结果。 */
export interface RedactionInfo {
  /** payload 是否经过脱敏。 */
  redacted: boolean;
  /** 脱敏触发原因。null 表示未脱敏。 */
  reason: RedactionReason | null;
  /** 被屏蔽的具体字段路径列表 (如 ["windowList[*].title"])。 */
  maskedFields: string[];
  /** 检测时使用的方法: "process-name-match" | "ui-pattern" | null (未脱敏)。 */
  method: "process-name-match" | "ui-pattern" | null;
}

export type RedactionReason =
  | "password-manager-foreground"
  | "password-input-focused"
  | "private-browsing"
  | "user-disabled"
  | "user-bypass";

/** 前台窗口内的可输入控件 (Edit/RichEdit/Scintilla 等) 的文本结构。 */
export interface TextInputInfo {
  /** 控件句柄 (Win 字符串形式)。 */
  hwnd: string;
  /** 控件 Win32 类名 (如 "Edit"、"RichEdit20W"、"Scintilla")。 */
  className: string;
  /**
   * 控件文本 (WM_GETTEXT, 截断至 ~300 字符)。
   * 密码框不读取 → null 且 isPassword=true。
   * Chromium/Electron 内部 DOM 输入框拿不到 → null。
   */
  text: string | null;
  /** 文本总长度 (WM_GETTEXTLENGTH)。null = 不可读。text 被截断时 > text.length。 */
  charLength: number | null;
  /** 是否密码框 (ES_PASSWORD 样式)。 */
  isPassword: boolean;
  /** 是否当前键盘焦点控件。 */
  isFocused: boolean;
}

/**
 * UIA sidecar 结果 (PowerShell UIAutomationClient, 见 src/uiaSidecar.ts)。
 * Chromium/Electron 应用的输入框只有这条路径能读到。
 */
export interface UiaInfo {
  ok: boolean;
  error?: string;
  /** 当前是聚焦元素模式 (默认) 还是按 HWND 模式 (从 focused 或 root HWND 抽) */
  source: "focused" | "by-hwnd";
  /** 抽的 HWND 字符串 (focused 模式为聚焦元素的最终根 HWND, by-hwnd 模式为传入的 HWND) */
  hwnd: string | null;
  focused: {
    name: string;
    controlType: string;
    className: string;
    processId: number;
    isPassword: boolean;
  } | null;
  root: { name: string; className: string; frameworkId: string } | null;
  inputs: Array<{
    name: string;
    controlType: string;
    className: string;
    isPassword: boolean;
    value: string;
    hasTextPattern: boolean;
    /** 候选 URL (Document 节点 Name/Value 匹配 https?|file|about|chrome|edge|view-source) */
    urlCandidate?: string;
  }>;
  elapsedMs: number;
  /** 当前激活 Document 的 Name (页面标题, 比 window title 新鲜)。 */
  documentName?: string | null;
  /** 当前激活 Document 正文 (GetText 2000)。 */
  documentText?: string | null;
  /** Tab 栏枚举 (best-effort)。 */
  tabs?: Array<{ title: string; active: boolean }>;
}

/** UIA sidecar 抽出的单个控件元素 (供 browserTargets / formatMarkdown 复用)。 */
export interface UiaInput {
  name: string;
  controlType: string;
  className: string;
  isPassword: boolean;
  value: string;
  /** v0.3 sidecar 设置; v0.2 sidecar (focused) 不一定填。 */
  hasValuePattern?: boolean;
  hasTextPattern?: boolean;
  urlCandidate?: string;
}

/**
 * MSAA sidecar 结果 (oleacc IAccessible, 见 src/msaaSidecar.ts)。
 * 作为 UIA 的 fallback / 对照来源 — WPS/微信等 Qt 应用。
 */
export interface MsaaInfo {
  ok: boolean;
  error?: string;
  hwnd: string;
  root: { name: string; className: string } | null;
  inputs: Array<{ name: string; value: string }>;
  elapsedMs: number;
}

// ---------------------------------------------------------------------------
// v0.3 BrowserPageExtract — 浏览器页面上下文 (核心)
// ---------------------------------------------------------------------------

/** 当前激活标签里用户正在输入的字段 (comment box / search box / form field)。 */
export interface BrowserFocusedField {
  /** UIA ControlType (Edit / Document / ComboBox / Button 等)。 */
  role: string;
  /** 控件名 / label (从 UIA Name 读取)。 */
  name: string;
  /** 控件已填值 (截断至 ~300 字符)。 */
  value: string;
  /** 是否密码字段。 */
  isPassword: boolean;
  /** 是否必填 (仅在 UIA 提供此信息时填充)。 */
  required?: boolean;
}

/** 浏览器页面内用户已选中的文本。 */
export interface BrowserSelection {
  /** 选中的纯文本 (UIA TextPattern Selection, 截断至 ~500 字符)。 */
  text: string;
  /** 选中文字所在文档的上下文摘要 (前后各 100 字符)。 */
  surrounding: string;
}

/**
 * 表单字段 (UI 层视角, 不依赖 DOM 解析 — 仅用 UIA 暴露的语义)。
 * 限制: placeholder / aria-label / pattern / maxlength 在 UIA 拿不到,
 * 仅依赖 Name + ControlType + Value + IsPassword。
 */
export interface BrowserFormField {
  /** 字段标签 / name (UIA Name, 可能是 "Email" / "搜索" / "评论" 等)。 */
  label: string;
  /** 字段角色 — UIA ControlType 去前缀 ("Edit" / "ComboBox" / "Button" / "CheckBox" / "RadioButton" / "Document" / "Text")。 */
  role: string;
  /** 当前已填值 (截断至 ~300 字符)。 */
  value: string | null;
  /** 是否密码字段。 */
  isPassword: boolean;
  /** 是否必填 (尽力推断)。 */
  required: boolean;
  /** 是否只读 / 禁用 (尽力推断)。 */
  readonly: boolean;
}

export interface BrowserForm {
  /** form 的 container 控件 name (Chrome 里通常是 "Web content" 这种; null = 单一 form)。 */
  name: string | null;
  /** form 内字段列表。 */
  fields: BrowserFormField[];
}

/** 当前窗口的标签列表。 */
export interface BrowserTab {
  /** 标签 title。 */
  title: string;
  /** 是否当前激活标签。 */
  active: boolean;
  /** 标签内容 HWND (best-effort, Chromium 一个 tab 一个 HWND, Firefox 共享 HWND → null)。 */
  hwnd: string | null;
}

/**
 * 浏览器当前打开页面的上下文提取结果。
 * 这是 duya consumer 真正关心的字段集合。
 *
 * 关键场景覆盖:
 *   - 社交平台评论: url + title + visibleText (帖子正文) + focusedField (评论框)
 *   - 填表单: forms[].fields[].label/role/value (字段结构)
 *   - "我在看什么": url + title + tabs[]
 */
export interface BrowserPageExtract {
  /** 浏览器进程名 (lowercase, 无 .exe, 如 "chrome")。 */
  browser: string;
  /** 浏览器进程 PID。 */
  browserPid: number;
  /** 顶层窗口 HWND (用于重抽/调试)。 */
  hwnd: string;
  /** 当前标签 URL (best-effort, 来源 UIA Document 节点 Name/Value 正则)。 */
  url: string | null;
  /** 当前标签 title (优先 UIA focused 元素, 退到 window title)。 */
  title: string | null;
  /** 当前 tab 可见文本 (UIA Document 节点 TextPattern, 截断至 ~2000 字符)。 */
  visibleText: string | null;
  /** 用户正在输入的字段 (null = 不在输入)。 */
  focusedField: BrowserFocusedField | null;
  /** 用户已选中的文本 (null = 没选中)。 */
  selection: BrowserSelection | null;
  /** 当前页面内识别出的表单 / 字段结构 (UIA 暴露的 Edit/ComboBox/Button 节点)。 */
  forms: BrowserForm[];
  /** 当前窗口的 tab 列表 (best-effort, UIA Tab 控件聚合)。 */
  tabs: BrowserTab[];
  /** 提取所用路径 (供调试与降级决策)。 */
  extractionPath: "uia-hwnd" | "uia-focused" | "window-title" | null;
  /** 提取耗时 (ms, 仅 UIA sidecar 部分)。 */
  elapsedMs: number;
}

// ---------------------------------------------------------------------------
// IPC 契约 (向后兼容)
// ---------------------------------------------------------------------------

/** 主进程 → 渲染进程: payload 响应。 */
export interface CaptureResponse {
  ok: boolean;
  payload?: ContextPayload;
  /** 失败时的错误信息。 */
  error?: string;
}
// ---------------------------------------------------------------------------
// v0.4 InteractionEvent — 30 秒滑动窗口 timeline
// ---------------------------------------------------------------------------

/** 应用上下文:跨平台应用标识 (Windows PID + exe, macOS PID + bundleId)。 */
export interface AppContext {
  pid: number;
  /** Windows 进程名 (chrome.exe), macOS BundleID (com.google.Chrome)。 */
  exeName: string;
  /** macOS BundleID 可选 (Windows 字段恒为 undefined)。 */
  bundleId?: string;
}

/** 窗口快照 (InteractionEvent 携带,便于离线 LLM 推理)。 */
export interface TrailWindow {
  hwnd: string; // 字符串化的 HWND
  title: string;
  bounds?: { x: number; y: number; w: number; h: number };
  processName: string;
  pid: number;
}

/**
 * InteractionEvent — 单次前台交互事件。
 *
 * 事件类型:
 *   - window_focus: 前台窗口变更 (Win32 EVENT_OBJECT_FOCUSCHANGED)
 *   - selection_change: 选中文本变更 (UIA TextPattern.GetSelection / AX selectedTextRange)
 *   - text_change: 文本内容变更 (diff before/after)
 *   - app_launch: 新进程启动 (可选, 需订阅 EVENT_OBJECT_CREATE)
 *   - hotkey: 全局热键触发 (trigger.ts 记录)
 *
 * 设计取舍:
 *   - 选中文本截断 500 字符;长文本仅保留前 80 字符 + "…" 防 token 暴涨
 *   - textChangeDelta 仅当 <500 字符差异时填,否则只填 before 的 80 字符 + "diff-too-large" 标记
 *   - 时间戳 epoch ms, LLM 看 timeline 时按时间排序
 */
export interface InteractionEvent {
  ts: number;
  type: "window_focus" | "selection_change" | "text_change" | "app_launch" | "hotkey";
  app?: AppContext;
  window?: TrailWindow;
  selectedText?: string;
  /** 文本变更 diff (仅 text_change 事件填, 密码框永不填)。 */
  textChangeDelta?: { before: string; after: string; range: [number, number] };
  /** 全局热键名 (仅 hotkey 事件)。 */
  hotkey?: string;
  /** 投影源 (调试)。 */
  source: "uia" | "win32" | "ax" | "manual";
}

// ---------------------------------------------------------------------------
// v0.4 IntentCandidate — Apple Onscreen Awareness + Microsoft App Actions 对齐
// ---------------------------------------------------------------------------

/** 应用分类 — 跨平台 app 类别, 让 agent 知道"这个程序是什么类型"。 */
export type AppKind =
  | "browser"
  | "code_editor"
  | "text_editor"
  | "terminal"
  | "file_manager"
  | "chat"
  | "media"
  | "productivity"
  | "unknown";

/**
 * IntentCandidate — 从 raw UI 信号 (focus + trail + appCapability) 推断的"用户当前最可能想做的事"。
 *
 * 设计原则:
 *   - 静态规则优先, 不调用 SLM/LLM (v0.5 才上 SLM)
 *   - 单候选 + confidence (0..1), LLM 据此决定是否信任
 *   - requiredCapabilities 表达该意图落地需要的实体能力
 *
 * 推断来源 (按权重):
 *   1. focusedEntity.kind + title 关键词
 *   2. appCapabilities.intents × 窗口标题 titlePatterns
 *   3. interactionTrail 30s 窗口事件密度
 */
export interface IntentCandidate {
  /** 意图名 (e.g. "research", "edit_code", "fill_form")。 */
  intent: string;
  /** 推断置信度 (0..1)。 */
  confidence: number;
  /** 触发推断的证据 (LLM 可读)。 */
  evidence: string[];
  /** 落地该意图所需的最小能力 (LLM 据此判断能否执行)。 */
  requiredCapabilities: {
    canRead: boolean;
    canWrite: boolean;
    canInvoke: boolean;
  };
  /** 推断用的应用上下文快照。 */
  app: {
    pid: number;
    exeName: string;
    appKind: AppKind;
  };
  /** 投影源 (调试)。 */
  source: "rule" | "slm" | "fallback";
}

/** RGBA 像素缓冲 (imageUtils 双线性插值用)。 */
export type RGBA = Uint8Array;

// ---------------------------------------------------------------------------
// v0.4 FocusedEntity — Apple Onscreen Awareness + Microsoft Click to Do 投影对齐
// ---------------------------------------------------------------------------

/**
 * 实体类型枚举。对齐 Microsoft App Actions 的 8 种 ActionEntityKind
 * (None/Document/File/Photo/Text/StreamingText/RemoteFile/Table/Contact)
 * 与 Apple App Intents 的 AppEntity 命名。
 *
 * 注:"None" 不出现于 FocusedEntity.kind,直接省略。
 */
export type EntityKind =
  | "Text"
  | "StreamingText"
  | "File"
  | "Document"
  | "Photo"
  | "RemoteFile"
  | "Table"
  | "Contact";

/**
 * FocusedEntity — 投影自 raw UIA/AX 的"前台最关键元素"实体。
 *
 * 目标:
 *   - 跨平台:Windows UIA + macOS Accessibility API 输出统一结构
 *   - 跨产品:让 duya / Apple Onscreen Awareness / MS Click to Do 共享同一概念
 *
 * 设计取舍:
 *   - 不放 coords 当主键:屏幕位置易变,语义化 kind + properties 才是稳定信号
 *   - confidence 0..1 表达投影可靠度(UIA.IsOffscreen / AXUIElement.isAttributeSettable)
 *   - capabilities 是 AgentIntent 推断的输入(LLM 看到 capabilities.canRead 就知道"用户想读取这个 Text")
 */
export interface FocusedEntity {
  kind: EntityKind;
  /** 投影置信度 (0..1)。0.9+ = 多源一致;0.5-0.9 = 单源; <0.5 = 不确定。 */
  confidence: number;
  /** 元素在屏幕上的矩形 (用于 VLM 视觉验证)。跨平台为虚拟屏幕坐标。 */
  bounds?: { x: number; y: number; w: number; h: number };
  properties: {
    /** Text / StreamingText / Document / Table / Contact 主文本 (截断至 ~500 字符)。 */
    text?: string;
    /** StreamingText 增量流式 (Markdown 或 Plain);File/Photo 路径。 */
    path?: string;
    /** iCloud/OneDrive 等网盘标识 (RemoteFile 用)。 */
    remoteId?: string;
    /** 元素标题 (浏览器 tab title / 文档 title / 联系人姓名)。 */
    title?: string;
    /** 选中文本 (UIA TextPattern.GetSelection / AX selectedTextRange)。 */
    selectedText?: string;
    /** caret 位置 (line, column)。 */
    caret?: { line: number; ch: number };
    /** 文本总长度 (text 被截断时 > text.length)。 */
    length?: number;
  };
  capabilities: {
    /** 元素可读取 (Text.value_pattern.IsReadOnly / AXUIElement.isEnabled)。 */
    canRead: boolean;
    /** 元素可写入 (Text.value_pattern / Document.value_pattern)。 */
    canWrite: boolean;
    /** 元素可调用 (Button.Invoke_pattern)。 */
    canInvoke: boolean;
  };
  /** 投影数据源 (调试与降级)。 */
  source: "uia" | "ax" | "fallback";
  /** UIA/AX 原生控件类型 (如 "Edit" / "Button" / "AXTextField")。 */
  nativeControlType?: string;
}

// ---------------------------------------------------------------------------
// v0.4 ContextPayload (兼容 v0.3 字段)
// ---------------------------------------------------------------------------

/**
 * v0.3 → v0.4 升级说明:
 *   - schemaVersion 升到 "0.4.0"
 *   - 新增 focusedEntity?: FocusedEntity (optional, 向后兼容)
 *   - 红字段原封不动
 *
 * 消费者 (duya agent) 读法:
 *   - schemaVersion >= "0.4.0" → 可读 focusedEntity
 *   - schemaVersion < "0.4.0"  → 忽略 focusedEntity
 */
export interface ContextPayload {
  /** schema 版本, 便于后续 v0.5+ 平滑升级。 */
  schemaVersion: "0.4.0";
  /** 鼠标光标位置 (Win32 GetCursorPos; v0.3 浏览器模式无 VLM 缩放)。 */
  cursor: CursorInfo;
  /** 鼠标光标所在窗口 (用户实际关注的窗口, 优先级高于 focus)。 */
  mouseTarget: MouseTargetInfo | null;
  /** 整屏截屏元信息 — v0.2 路径填, v0.3+ 路径省略 (undefined)。 */
  screen?: ScreenInfo;
  /** 可见顶层窗口列表 (经脱敏处理后)。 */
  windowList: WindowInfo[];
  /** 当前前台焦点信息 (经脱敏处理后)。 */
  focus: FocusInfo;
  /** 前台窗口内可输入控件的文本结构 (经脱敏处理后)。 */
  textInputs: TextInputInfo[];
  /** UIA 无障碍树上下文 (sidecar; null = 不可用/超时/非 Windows)。 */
  uia: UiaInfo | null;
  /** MSAA 旧式无障碍树 (fallback; null = 不可用/非 Windows)。 */
  msaa: MsaaInfo | null;
  /**
   * 浏览器当前打开页面上下文 — v0.3 核心字段。
   */
  browserPage: BrowserPageExtract | null;
  /**
   * v0.4 新增:前台最关键元素的统一实体投影。
   * 跨平台抽象 (Windows UIA / macOS AX),让下游 agent 能做"基于实体"的意图推断
   * 而非基于坐标。
   *
   * null = 投影失败/不适用/未启用。
   * 缺省 (undefined) = v0.3 payload,消费者按 schemaVersion 判断。
   */
  focusedEntity?: FocusedEntity | null;
  /**
   * v0.4 新增:30 秒 InteractionEvent timeline (滑动窗口)。
   *
   * 这是 Apple Onscreen Awareness / Microsoft Recall 的核心信号源。
   * 下游 agent 通过 timeline 推断用户意图 (例如:
   *   - 连续 5 次 window_focus 集中在 chrome → 用户在做 web research
   *   - 连续 selection_change 集中在某段文本 → 用户在比较/选择
   *   - text_change 频率升高 + selection_change 频繁 → 用户在重写某段
   * )。
   *
   * undefined = v0.3 payload 或 trail collector 未启动;
   * 空数组 = 启动了但 30 秒内无事件。
   */
  interactionTrail?: InteractionEvent[];
  /**
   * v0.4 新增: 用户意图单候选 (静态规则推断)。
   *
   * 输入: focusedEntity + interactionTrail + appCapabilities
   * 输出: IntentCandidate (intent + confidence + evidence)
   *
   * LLM 据此决定调用哪个 AppIntent (Apple) 或 App Action (Microsoft),
   * 而非自己重新推断。这是 Apple Onscreen Awareness + Microsoft Recall 的
   * "意图中间层" 抽象。
   */
  intentCandidate?: IntentCandidate | null;
  /** 脱敏决策结果。 */
  redaction: RedactionInfo;
  /** 平台标识。 */
  platform: "win32" | "darwin" | "linux";
  /** 组装耗时 (ms), 用于性能监控。 */
  assembleDurationMs: number;
  /** payload 捕获时间 (ISO8601)。 */
  capturedAt: string;
}
