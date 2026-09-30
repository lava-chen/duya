# Plan 564 — 结构化电脑控制（UIA 树为主、视觉为辅）

> **Status**: Phase 1–5 代码+单测落地（2026-09-27，未提交）；真机冒烟待人工
> **Priority**: P0
> **定位**: computer-use mode 的操控范式升级 —— 将 plan 454 的「截图 + 鼠标」纯视觉
> 路线倒置为 **结构化（无障碍树/UIA）为主、视觉为辅**，并广泛对标业界 Windows
> 系统控制实现（UFO/UFO²/UFO³、pywinauto、WinAppDriver、Windows Agent Arena、
> Power Automate Desktop、FlaUI/UIA-v2）后落地。
> **上游**: 556（uia-probe 管线）、562（enumerate + 真实坐标 + overlay）、519（SOM/verdict/decide）
> **范围红线**: 只做 Windows 结构化通道；macOS AX 通道仍是 562 Phase 4；不改审批/访问策略语义（仅把 `invoke` 纳入既有审批集）。

## 1. 动机与业界对标结论

调研（2026-09-27，附报告要点）确认业界最强 Windows agent 范式即「UIA first, vision second」：

| 项目 | 做法 | 本 plan 采纳 |
|---|---|---|
| **UFO²** (microsoft/UFO) | UIA 枚举（条件过滤 + CacheRequest）+ 编号控件表 + pattern 式操作，视觉(OmniParser)只兜底 UIA 盲区 | ✅ 树为主通道；`IsOffscreen` 过滤；交互 ControlType 白名单（562 已有） |
| **UFO³ MCP** | 元素寻址 = **顺序 id + act 时 name 校验**（廉价防陈旧） | ✅ invoke 带 1-based index + 可选 name/controlType 守卫 |
| **pywinauto** | Invoke/SelectionItem/ExpandCollapse/Toggle/Value/Scroll 模式映射 + `click_input` 坐标兜底 | ✅ auto 方法链按 ControlType 分派，no-pattern 回落视觉 |
| **WinAppDriver / WAA** | RuntimeId 仅会话内有效；枚举要 depth/width cap | ❌ 不用 RuntimeId 持久化；probe 已有节点/深度/时间预算 |
| **Power Automate** | 结构选择器为主，图像兜底为独立错误类 | ✅ STRUCTURAL_UNAVAILABLE 显式错误码引导回落 |
| 纯视觉派 (CUA/Operator/Agent-S2) | 截图→VLM→SendInput | 保留为辅助通道（capture/click/zoom/drag） |

关键增量认知：**ValuePattern.SetValue 绕过 IME** —— 中文输入（562 §7 遗留的
IME 录制盲区的反向问题）经结构化写入比 SendInput 键入可靠得多。

## 2. 架构

```
computer_use tool (agent, 11-action enum: + tree + invoke)
   │ computer-use:execute IPC
   ▼
electron/ipc/computer-use.ts dispatcher
   ├─ tree    → backend.uiaTree  ─┐
   ├─ invoke  → backend.uiaInvoke ┤ 同一常驻 uia-probe.ps1（556/562 管线，零新 spawn）
   ├─ set_value(element=n)        │ → UIA ValuePattern
   └─ capture(somMode) → detectElements(axElements=enumerate 缓存, 真实坐标 SOM)
   ▼
uia-probe.ps1（扩展）
   ├─ enumerate: TreeWalker + 元素缓存（hwnd → List<AutomationElement>，4 窗口上限）
   │             + IsOffscreen 过滤 + Edit/Document/ComboBox 的 ValuePattern value 读取
   └─ invoke:    ResolveCached(1-based index + name/controlType 校验) → ExecuteMethod
                 （invoke/toggle/expand/collapse/select/setValue/focus/auto 链）
                 → OK:{method,pattern,value,element} / ERR:<code> / timeout
```

错误码契约（probe → client → tool）：`stale-tree`（缓存元素失效/守卫不符，client 自动
重枚举重试一次，仍败则交还模型重跑 tree）/ `no-element` / `bad-index` /
`no-pattern`（引导回落视觉）/ `no-window` / `timeout`。

## 3. Phases（全部完成 ✅）

### Phase 1 — 协议契约
- [x] `uia-probe-protocol.ts`：`invoke` 请求（hwnd/index/method/value/name/controlType）
      + 响应（method/pattern/value/element）+ `UIA_INVOKE_METHODS` / `UIA_INVOKE_FAILURE_REASONS` 常量
- [x] `events.ts` ElementDescriptor：文本字段 nullish 容忍（修复 C# `"name":null` 被 zod 静默丢弃的潜在缺陷）+ `value` 字段
- [x] Gate：协议单测 27/27（含 invoke 收发 + null-name/value 元素存活）

### Phase 2 — probe 结构化执行（Windows）
- [x] `uia-probe.ps1` C#：ElementCache（锁保护、4 窗口整体淘汰）、ResolveCached
      （含 verify 守卫）、ExecuteMethod（显式方法 + auto 链：Button/MenuItem/Hyperlink→Invoke、
      CheckBox/ToggleSwitch→Toggle→Invoke、ComboBox→Expand→Invoke、ListItem/RadioButton/TabItem→
      Select→Invoke、Edit/Document→value?SetValue:SetFocus、未知→Invoke→Toggle→Select→Expand→Focus）、
      InvokeElement（Task 超时挂网 1000ms，"OK:json"/"ERR:code" 线协议）
- [x] enumerate 侧：走完后 RememberElements（发射序=1-based 索引）、IsOffscreen 过滤、
      ElementJson 补 value（Edit/Document/ComboBox，密码不读、无值省键）
- [x] Gate：**C# 块 Add-Type 真机编译 CSC-OK**（739 行，方法表确认）；ps1 Parser 零错误

### Phase 3 — 客户端与 backend
- [x] `electron/services/recorder/uia-probe.ts`：`invoke()`（stale-tree 自动恢复：fresh 枚举后重试一次）
      + `getSharedUiaProbeClient()` 共享访问器 + `enumerateCached` 每调用 TTL 覆盖 + `UIA_INVOKE_TIMEOUT_MS=2500`
- [x] `backend/types.ts`：`UiaTree*` / `UiaInvoke*` 类型 + DesktopBackend 可选 `uiaTree?`/`uiaInvoke?`
      （平台无结构化通道时省略，工具层报 STRUCTURAL_UNAVAILABLE）
- [x] `win32.ts`：ElectronDesktopBackend 透传 provider（缺省返回 unavailable）
- [x] Gate：probe 客户端 18/18（invoke 成功/失败/stale 恢复两条路径）

### Phase 4 — 工具与 dispatcher 接线
- [x] `constants.ts`（agent 镜像同步）：11-action + `invoke` 入审批集（focus-only 豁免在 dispatcher）
- [x] `schema.ts`：treeShape（hwnd/maxElements/fresh）+ invokeShape（1-based element、method 枚举、
      setValue 必带 value）+ set_value 增 `element`
- [x] `ComputerUseTool.ts`：描述改写为双通道工作流 + STRUCTURAL_UNAVAILABLE 错误码
- [x] `electron/ipc/computer-use.ts`：tree（访问门，无审批）/ invoke（访问门+审批，focus 豁免）/
      set_value(element=) 走 ValuePattern；tree data 附 LLM 文本
- [x] `computer-use-backend.ts`：uiaTreeProvider（fg 解析目标 → enumerate[Cached]）、
      uiaInvokeProvider、**capture SOM 接 axElements**（10s 短 TTL 真实坐标）
- [x] Gate：ComputerUseTool 测试含 tree/invoke schema（346 测试绿）

### Phase 5 — 模式语义翻转
- [x] `computer-use-mode.ts` prompt：TARGET(tree)→ACT structurally→VERIFY cheaply→
      fall back to vision；索引按观察失效规则；stale-tree/no-pattern 处置；IME/背景窗口优势写明
- [x] `som/structural-format.ts`：`[n]Role "Name" value="…" @(rect)` 单行格式 + 密码掩码
      + 空树按 reason 给回落指引（token 经济：不向 LLM 暴露 automationId/class）
- [x] Gate：格式化器 8/8 + computer-use-mode 16/16

## 4. 测试汇总（2026-09-27 全绿）

| 套件 | 结果 |
|---|---|
| packages/computer-use 全包 | 262/262（+协议 invoke 6、格式化器 8、nullish schema 回归） |
| agent OSTool + workflow 簇 | 346/346（ComputerUseTool schema tree/invoke + element-matcher nullish 兼容） |
| agent modes（computer-use-mode） | 37/37 |
| electron recorder-uia-probe | 18/18（invoke 4 条新用例含 stale-tree 恢复） |
| typecheck | computer-use 构建零错；agent/electron/根 src 我改文件零错（预存红均已归因为并行 WIP） |

## 5. 已知边界与后续

- **真机冒烟待人工**：tree/invoke 全链路（记事本/计算器/微信/Chrome）——重点观察
  ① Chrome enumerate 是否受 a11y 未激活影响（Chrome 138+ 原生 UIA 默认开启）；
  ② Qt 应用（微信）点击目标能否经 tree 命中；③ set_value ValuePattern 在 WPF/WinForms 的覆盖。
- 虚拟化列表（Explorer/Edge tabs）只报已实现项 —— ItemContainer/VirtualizedItem
  Realize 未做，长列表需先滚动再 tree（prompt 已写）。
- Slider 的 RangeValue 写入未暴露（auto 链回落 Invoke/视觉）；ScrollPattern 未接。
- macOS 结构化通道 = 562 Phase 4（Swift AX helper），未动。
- 提权窗口：enumerate 返回 `reason:'elevated'`，tree 文本引导走视觉；UIAccess helper 不在范围。

## 6. 对标来源（调研报告存档要点）

microsoft/UFO（inspector.py 条件枚举 + CacheRequest、control_filter、controller 的
pattern→坐标兜底链、UFO³ MCP 的 id+name 校验与 `label/control_text/control_type/
control_rect` 最小字段面）；pywinauto uiawrapper 模式映射；microsoft/WinAppDriver
locator 策略；microsoft/WindowsAgentArena（win32 vs uia backend 的 Chromium 覆盖差
异、深度/宽度 cap）；Chromium 138+ 原生 UIA 默认开启；ValuePattern 绕 IME；UIPI/UIAccess。
