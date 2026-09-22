# Plan 562 — 元素全树枚举 + 真实坐标 SOM + 可视化 Overlay

> **Status**: Windows 侧 Phase 0–2 完成、Phase 3/5 代码+单测落地（2026-09-22，全部未提交）；
> Chrome enumerate 退化观察、overlay Playwright 真机对位、录制+overlay 全链路冒烟待人工；
> Phase 4（macOS AX helper）未开工
> **Priority**: P1
> **定位**: plan 556 capture/record 通道的能力补齐 —— 从「点击时点探单元素」升级为「窗口内全部可交互元素枚举 + 真实坐标」，对标商业 computer-use demo 的全树可视化（macOS AX 框框图）。
> **上游依赖**: 556（uia-probe 管线、daemon 扩展点、ElementDescriptor）、519（element-detector 的 AxInfo 消费接口）
> **范围红线**: 本 plan 只做**只读枚举 + 可视化 + SOM 坐标接入**；输入注入（CGEventTap/SendInput 模拟）不在本 plan。macOS 部分只做 AX 读树 helper，不做完整 mac 录制（那仍是 556 的 out-of-scope）。

## 1. 背景与动机

plan 556 落地的 UIA 能力只有 `probe(x,y)` 点探（点击瞬间查单元素，200ms 预算），
plan 519 的 `element-detector` 虽然消费 AxInfo，但 **AX 输入不带坐标**，SOM bbox 只能画启发式网格
（`element-detector.ts` axInputsToSom：左对齐网格，非真实位置）。

商业 computer-use demo（如 macOS AX 框框截图）的做法是：遍历系统无障碍树 →
过滤可交互角色 → 输出每个元素的 rect+name+role → 叠加绘制。duya 三块都缺：

| 缺口 | 现状 | 本 plan |
|------|------|---------|
| 全树枚举 | 只有 FromPoint 点探 | Windows UIA TreeWalker / macOS AX 递归 |
| 真实坐标 | AxInfo 无 bbox，SOM 画网格 | 枚举结果自带 BoundingRectangle |
| 可视化 | 无 | Electron 透明点击穿透 overlay |

## 2. 技术决策

| # | 决策 |
|---|------|
| D1 | Windows 枚举**复用 uia-probe.ps1 常驻进程**：新增 `enumerate` op，C# helper 内 TreeWalker 递归 + 子树分片 Task 超时；不新开进程 |
| D2 | macOS 用 **Swift CLI helper 子进程**（AXUIElement），复用 556 的 daemon spawn/心跳/超时管线；Electron 主进程无原生 AX 入口，原生模块方案否决（ABI 维护成本同 556 D2 的否决理由） |
| D3 | 枚举输出统一为**带坐标的 ElementDescriptor 列表**；element-detector 新增带坐标输入路径，优先级高于现有启发式网格 |
| D4 | overlay = 单例 BrowserWindow（transparent + alwaysOnTop + `setIgnoreMouseEvents(true)`），IPC 推元素列表渲染 rect+index 标签；badge/开关复用 recorder UI 惯例 |
| D5 | degraded 策略修订（556 遗留）：degraded 后**每隔 60s 自动重试恢复**，不再永久短路；枚举按 (hwnd, title) 缓存，应用未变不重扫 |
| D6 | overlay **保持只读点击穿透**，不做交互入口（裁定见 §5 缺口1）：录制中用户点编号框 → 事件天然穿透到底层真实元素 → 被 hook-worker 捕获 + probe 附着，触发路径免费获得，无需注入通道 |

## 3. Phases

### Phase 0 — 协议契约（不动行为）

- [x] `packages/computer-use/src/recorder/uia-probe-protocol.ts`：`enumerate` 请求/响应 zod
      （`{op:'enumerate', hwnd, maxDepth?, maxNodes?}` → `{ok, elements: ElementDescriptor[]}`，
      ElementDescriptor 复用 556 已有形状，新增可选 `interactive: boolean`）
- [x] 交互 ControlType 白名单常量：Button / Edit / Hyperlink / CheckBox / RadioButton /
      ComboBox / TabItem / MenuItem / Slider / ListItem / ToggleSwitch（可配置）
- [x] Gate：协议单测绿（18/18）

### Phase 1 — Windows UIA 全树枚举

- [x] `resources/recorder/uia-probe.ps1`：C# helper 加 `EnumerateWindow(IntPtr hwnd, ...)`：
      FromHandle 取根 → TreeWalker.ControlViewWalker 递归；命中白名单 ControlType 才出节点；
      每棵子树独立 `Task.Run + Wait` 分片预算（250ms/子树，受总预算剩余量钳制），
      总预算 1500ms + maxNodes 上限（默认 500）防大树卡死；超时返回**已收集的部分树**
      + `truncated:true`，不整体丢弃（真机冒烟暴露的 JSON 拼装 bug 与 50ms 冷启动
      全超时已修复，见 §6）
- [x] `electron/services/recorder/uia-probe.ts`：`enumerate(hwnd)` 客户端方法（超时 3s 主侧竞速）；
      (hwnd,title) 缓存层——`enumerateCached(hwnd, title)` 未变直接回缓存
- [ ] Gate：probe 协议/客户端单测绿（✅ 30/30）；真机冒烟——前台窗口一次通过
      （JSON 合法、count>0）；**Chrome 无障碍树未激活时的退化行为待观察记录**

### Phase 2 — SOM 真实坐标接入（519 升级）

- [x] `element-detector.ts`：ElementDetectorInput 新增 `axElements?: ElementDescriptor[]`
      （带 bbox）；优先级置于 AxInfo 网格之前，`axSource: 'uia-tree' | 'ax-tree'`
      （`axElementsSource` 指定，默认 uia-tree）；AxInfo 网格路径保留为无坐标降级。
      **类型层同步已完成**：`SomElement.axSource`（backend/types.ts）与
      `SomCandidate.axSource`（element-matcher.ts）闭合 union + `AX_SOURCE_RANK`（tree 源
      排最前）+ `isAxSource` guard 三处一致，新值不再被静默丢弃
- [x] **matcher 联动回归**：`element-matcher.ts` 本身不改（坐标已在其命中条件内：
      L1 tie-break 用 bbox 中心距、L2 anchor 兜底 `recorded.element.rect` 中心），
      但新增断言——**回放期 fresh 候选带真实坐标**（走 uia-tree 路径）时，L2 containment
      与 L1 距离 tie-break 的行为对比启发式网格版本；此即本 plan 对回放命中率的提升点
      （详见 §5 缺口3）
- [x] Gate：element-detector 单测扩展（带坐标优先、降级回网格、无 rect 跳过、ax-tree 标签）
      + matcher 新回归绿（som.test.ts 22/22 + element-matcher.test.ts 23/23）

### Phase 3 — Overlay 可视化

- [x] `electron/services/overlay/`：单例透明点击穿透 BrowserWindow 加载静态 overlay 页
      （无边框、skipTaskbar、全屏覆盖元素 rect 并集所在显示器，data-URL 页 +
      `setIgnoreMouseEvents(true)` + `setContentProtection(true)`，照抄
      computer-use-overlay 惯例）；`overlay:show-elements` IPC 通道（主侧结构校验
      sanitize + 页内 interactive 白名单二次过滤 + index 角标）；`overlay:clear`；
      preload 契约（`window.electronAPI.overlay.*`）+ 类型声明。SOM capture 通道元素
      不上 overlay（通道语义即 enumerate 形状）
- [x] 生命周期：随 recorder start/stop 启停（status→idle 即 clear）+ 显示器/缩放变更
      （display-metrics-changed / display-removed 重建）；computer-use mode capture
      开关联动待接（当前 overlay 由 IPC 与 recorder 生命周期驱动）
- [ ] Gate：sanitize payload 门单测绿（5/5）；**Playwright MCP UI 冒烟（真机截图核对
      rect 对位）待人工**

### Phase 4 — macOS AX helper（读树）

- [ ] Swift CLI helper（`resources/ax-helper/` 源码 + 预编译产物随 extraResources 分发）：
      stdin/stdout JSON 行协议（对齐 uia-probe 惯例）；`enumerate(pid)` =
      `AXUIElementCreateApplication(pid)` → `kAXChildrenAttribute` 递归，
      输出 role/name/position/size；内部对每次属性读取加超时（AX 调用对挂死应用可阻塞）
- [ ] 权限门：启动时 `AXIsProcessTrustedWithOptions`（prompt 引导），未授权 →
      helper 返回 `permission-denied`，UI 呈现引导卡片，不静默降级
- [ ] main 侧客户端：复用 daemon 管线 + 556 的 recycle/degrade 策略（含 D5 修订）
- [ ] Gate：真机（macOS）冒烟——Finder/Safari/自绘应用各一次，记录 AX 覆盖差异

### Phase 5 — 收尾

- [x] recorder 事件流可选附加 `enumerate` 快照（app_focus 变化时异步刷新，不阻塞落盘；
      `onEnumerateSnapshot` 注入单例 → overlay；空树/UIPI/自身窗口/黑名单应用不触发）
- [x] `npm run typecheck:all`（改动文件零错误）+ electron tsconfig 复查
      （改动文件零错误）+ daemon/probe/recorder/som/matcher 既有单测回归绿
- [ ] 真机 Gate：录制 + overlay 同开全链路冒烟

## 4. 已知边界（写入 UI 文案，不静默）

- 自绘窗口（游戏/DirectX 画布）枚举为空树 → overlay 无框 + SOM 走 heuristic 兜底
- 提权应用：UIPI 拒读 → 该窗口跳过（检测 elevated pid 直接 short-circuit，不烧超时预算）
- Chromium 系未开无障碍树：只见文档级节点 → 已知退化，Phase 1 真机记录实测行为后决定
  是否加 `--force-renderer-accessibility` 引导提示

## 5. 评估回应与缺口裁定（2026-09-22）

外部评估提出四个缺口，逐条对照代码（element-matcher.ts / uia-probe.ps1）后裁定：

### 缺口1 — overlay 点击 → workflow 触发（成立，裁定为 D6 被动方案）

评估方向 1/2/3 中取 **3（被动可视化）为 MVP，1（录制触发）天然免费获得**：
overlay 全程 `setIgnoreMouseEvents(true)`，录制中用户对着编号框点击 → 鼠标事件穿透
落到真实元素 → hook-worker 捕获 click + probe 附着描述符。**不需要任何注入通道**，
overlay 的价值是帮用户瞄准。方向 2（点编号 → gui-runner 选节点执行）涉及 workflow
选择语义，**out of scope**，待 workflow UI 有元素选择需求时另立 plan。

### 缺口2 — overlay 渲染未过滤不可交互元素（部分成立，已补防线）

枚举侧白名单（Phase 1「命中白名单 ControlType 才出节点」）已保证 enumerate 输出
只含可交互元素；评估混淆的是 SOM capture 通道（无白名单概念）。已在 Phase 3 补
渲染侧二次断言 + 明确「SOM capture 通道元素不上 overlay」。

### 缺口3 — enumerate 坐标未进 matcher 链路（**说反了**，真实缺口恰被 Phase 2 修复）

代码事实：
- 录制侧 probe 描述符**自带 rect**（uia-probe.ps1 ElementJson 含 BoundingRectangle），
  评估链路图标注「无 bbox」有误；
- matcher 早已消费坐标：L1 多命中 tie-break 按 bbox 中心距最近（rankByName →
  centreDistance）；L2 的 anchor 除点击点外兜底 `recorded.element.rect` 中心
  （recordedAnchor）。

**真实缺口在回放侧**：fresh SOM 候选的 bbox 来自 519 启发式网格（假坐标），导致
L2 containment 和 L1 距离 tie-break 全部失真。Phase 2 恰好修复这一侧——fresh
候选换上真实坐标后，matcher 无需改动命中率即提升。已在 Phase 2 补 matcher 回归
断言固化此结论。

### 缺口4 — macOS 输入模拟不在 plan 内（维持，范围红线）

556 明确 mac 录制需 CGEventTap 全套重写、out of scope；562 只补读树半边。
macOS 完整 CUA（读树 + 注入）待 Windows 侧真机 Gate 通过后单独立项。

## 6. Phase 1 真机冒烟修复记录（2026-09-22）

首次真机冒烟（管道喂 `{"id":1,"op":"enumerate","hwnd":...}`）返回：

```
{"id":1,"ok":true,{"elements":[],"truncated":true,"reason":null,"count":0}}
```

两个问题，均已修复并复测通过（前台窗口 enumerate：JSON 合法、count=4、truncated=false）：

1. **非法 JSON**：C# `EnumerateWindow` 返回完整对象（自带前导 `{`），PS 侧又拼了
   `'{"id":...,"ok":true,'` → `{"elements"` 前缺 key，主侧 `parseUiaProbeLine`
   JSON.parse 失败返回 null，整条枚举链路拿不到数据。修复：PS 拼接前
   `$json.Substring(1, $json.Length - 2)` 剥掉外层花括号（保留 C# 返回完整对象，
   便于单测直接喂 JSON 解析器）。
2. **truncated:true + count:0**：所有分片的 50ms Wait 全部超时——冷启动首次 UIA COM
   激活偏慢，首个节点都没落地就被切。修复：分片预算 50ms → 250ms，且每个分片的
   Wait 受总预算剩余量钳制（`min(slice, TotalMs - elapsed)`），兄弟分片并行推进，
   总预算语义不变。

踩坑补充：块注释里写 `max*/controlTypes` 会提前闭合 `*/`（esbuild 解析失败）；
electron 侧测试 import `@duya/computer-use` 走 dist，改包源码后必须先
`npm run build:computer-use`，否则新协议不生效（现象：enumerate 请求退化成
`op:"ping"` 旧 dist 兜底分支）。

## 7. 焦点轮询 `fg` 操作（真机回归后追加，2026-09-22）

**现象**：真机会话回放显示两类焦点丢失——(a) 录制开始后 explorer 阶段 17.6s 零事件
（用户在资源管理器新建 txt + 打开，整段无 app_focus）；(b) 任意会话首事件普遍滞后
3.4s（微信会话录制开始时前台已在微信，首个 focus 事件 = 第一次轮询完成）。

**根因**：`getForegroundWindowInfo` 每次轮询 spawn 一个新 `powershell.exe` 并
`Add-Type` 现场编译 C#（叠加 Defender 扫描），单次实测 ~3.4s，设计写的 500ms
轮询名存实亡；负载高时超时返回 null → tracker「保持上一快照」，短暂前台状态被整段吞掉。

**修复**：复用 recorder 常驻 PowerShell 进程——uia-probe.ps1 新增 `fg` op
（C# `GetForegroundWindow` + 既有 `GetWindowThreadProcessId` 返回 `hwnd\tpid`，
PS 侧 `Get-Process` 补 processName/title，`ConvertTo-Json -Compress` 出载荷）；
协议层加 fg 请求/响应；客户端 `foreground()`（主侧竞速 1200ms，**fg 超时不计入
stall 计数**——fg 排队等长 enumerate 时不得误触回收）；RecorderService 焦点
tracker 查询优先走 probe fg，probe 降级/缺席时回落原 spawn 查询（录制永不中断）。

Gate：protocol 21 + client 14 + service 16 + sanitize 5 = 56 测试绿；ps1 Parser 零错误；
electron tsc 改动文件零错误。C# 块编译验证受会话安全策略限制（Add-Type/csc 均被拦），
由下次真机启动时的 probe Add-Type 兜底（编译失败走优雅降级，不影响录制本体）。

**遗留（真机回归暴露，未排期）**：① `type` 事件记不到 IME 提交后的中文（拼音 IME
组合键 `<key:61003>` 可见但最终文本丢失）——中文输入录制盲区；② click 事件只带
point-probe 元素（Qt 应用如微信返回 Window 级，无「发给谁/点了哪个按钮」语义）——
候选方案：click 落盘时用 (hwnd,title) 枚举缓存标注最近交互元素。

## 8. 真机门户会话回归两项修复（2026-09-22）

来源：用户真机录制「学校信息门户登录」会话后发现 (a) 浏览器窗口 title 记成了别的
Chrome 窗口标题，(b) 全程 0 条 URL——`browserUrl` 从未落盘。

**修复 1 — fg title 改走 `GetWindowText(hwnd)`**：`Get-Process MainWindowTitle`
返回的是进程的「主窗口」（chrome.exe 单进程多窗口模型下系统性取错——实测前台在信息
门户时返回了另一个 Chrome 窗口的标题）。uia-probe.ps1 C# 块补 `GetWindowText`
（CharSet.Unicode）DllImport，`ForegroundHandle()` 返回 `hwnd\tpid\ttitle` 三字段
（`-split` cap 3 保留 title 内 tab），PS 侧 dispatch title 直接取 `$parts[2]`，
不再依赖 `Get-Process` 补 title。

**修复 2 — 点击驱动 browserUrl 刷新**：`readUrl` 原本只在焦点变化时触发，浏览器
窗口内点链接导航（焦点不变）后所有后续事件永远带旧 URL，甚至从未捕获（冷启动
readUrl 失败后无重试）。RecorderService 新增 `currentHwnd`/`lastUrlRefreshAt` 状态 +
`maybeRefreshBrowserUrl`：worker 原始 `mouseup`（button=1）落在浏览器进程时异步
`readUrl(currentHwnd)` 刷新 `browserUrl`，节流 `URL_REFRESH_INTERVAL_MS = 2s`
（可经 `urlRefreshIntervalMs` 注入）。语义：click 事件本身带**点击前** URL（点击发生在
该页），后续事件经 feedContext 带导航后 URL。

Gate：recorder 三套件 53 测试绿（service 18 含 2 条新增：左键 mouseup 触发节流刷新 +
右键/非浏览器不触发）；ps1 Parser 零错误；electron tsc 改动文件无新增错误。

**仍未排期（用户明确暂缓）**：① 密码脱敏缺口——`isPassword` 只由 click 时 point-probe
盖章，Tab 键盘导航进密码框绕过检测，密码明文进 events.jsonl（P0 隐私，方案已设计：
probe `focusedInfo` op）；② 录制 → dwf.ts workflow 转换 skill（现无 converter，recorder:convert
已移除；Chrome 回放需 `--force-renderer-accessibility`）。
