# Plan 572 — macOS 原生 Computer-Use 后端（AX 全面接入）

> **Status**: Phase 0–4 代码+单测落地（2026-09-27，plan 572 新增 45 单测 + 相邻簇 335 绿、
> tsc 对基线零新增错误、helper universal 二进制编译+真机协议冒烟通过）；Phase 5 SCK 实现就绪
> （SDK 14 门控，本机 SDK 13.1 未编译）；Phase 6 配置落地（entitlements/extraResources/
> NSAppleEventsUsageDescription/tccutil 脚本）；**真机 Gate（AX 授权后的 Finder/Safari 覆盖矩阵、
> 录制三目标、packaged 产物五项检查、Phase 7 端到端）待人工**。落地注记见 §7
> **Priority**: P0
> **技术底稿**: [docs/references/macos-accessibility-research.md](../../references/macos-accessibility-research.md)（AX API 面、AX↔UIA 能力矩阵、注入/截屏/权限、先例项目教训，全部技术断言以底稿为准）
> **定位**: computer-use 五腿框架（capture/plan/record/execute/verify）的 macOS 腿 —— 对标并局部超越 Windows UIA 栈。**收编 plan 562 Phase 4**（macOS AX 读树 helper），并解除 plan 556 §6「macOS out of scope」红线的后半句（Linux 仍 out of scope）。
> **上游依赖**: 454（computer-use mode）、519（harness gaps / 后台优先语义）、552（gui-runner/DesktopBackend）、556（recorder 框架、daemon 扩展点）、562（enumerate 协议、element-detector axElements 路径、overlay）
> **范围红线**: 全部 macOS 代码置于平台守卫之后，Windows 行为零改动；MVP 不引入任何私有 API（SkyLight / `_AXObserver*` 记为后备）；Linux 不做。

## 1. 背景与动机

Windows 侧 computer-use 栈已落地：capture（desktopCapturer + SOM）、execute（PowerShell UIA probe + nut.js 注入 + 后台优先梯）、record（uiohook + converter + element-matcher）、verify（verdict 三态 + 审批门）。macOS 现状只有两条路：`factory.ts` 把非 win32 全部路由到 MCP `cua-driver` 兜底（无元素语义），以及 562 Phase 4 的一纸空文（Swift helper 只写了方向）。

调研结论（底稿 §2/§8）：macOS AX API 的读侧与 UIA 大体相当（角色/名称/矩形/动作/文本参数化属性齐全），写侧靠 AX action + 可写属性补齐；三处**结构性优势**可超越 Windows 栈 ——
1. `CGEventPostToPid` 定向注入（Windows 的 SendInput 只能全局）；
2. `AXUIElementCreateApplication(pid)` 后台应用树 + AX action 后台执行不抢焦点（UIA 无 create-from-PID）；
3. `AXUIElementGetWindow` ↔ CGWindowID ↔ ScreenCaptureKit 的捕获关联 + per-app AppleScript 词典（浏览器 URL 等）。

三处**结构性劣势**须工程化绕行：AX 调用同步阻塞（`AXUIElementSetMessagingTimeout` + 独立进程 + 看门狗）、AutomationId 对应物稀疏（matcher 依赖可读名）、TCC 四权限 + dev/packaged 归属分叉。

先例项目（trycua/cua、Hammerspoon、Peekaboo）反复验证的八条设计模式（底稿 §8）直接采纳为决策依据。

## 2. 技术决策

| # | 决策 | 依据 |
|---|------|------|
| D1 | AX/window/URL/权限探测走 **Swift CLI helper**（`resources/ax-helper/`，swiftc 出 universal binary），stdin/stdout JSON 行协议；**否决**原生 addon（ABI 矩阵成本同 556 D2）与 Rust（无增益多工具链） | 562 D2 延续；peekaboo/active-win 均为 thin-JS-over-native-CLI 形态 |
| D2 | helper 经 **`createComputerUseDaemon` 管线**常驻（spawn/心跳/重启/`onStdoutLine`，复用 556/562 的 recycle/degrade 策略）；helper 内部所有 AX 调用走专用 dispatch queue + `AXUIElementSetMessagingTimeout`（启动即对 systemwide 设 0.5s 全局）+ 每请求主侧竞速超时；**Electron 主进程永不直接发 AX 调用** | 底稿 §1.7；Hammerspoon「阻塞 5 分钟」教训；daemon 管线已有三个消费者先例 |
| D3 | 元素寻址 = **快照作用域句柄**（enumerate 返回 `h:<n>` 句柄 + rect + role/name/actions），动作按句柄直达 `AXUIElementPerformAction`；句柄仅在快照内有效，陈旧句柄 fail-closed 拒绝 | cua element_index + peekaboo snapshot 收据制；防陈旧树竞态 |
| D4 | 注入梯（后台优先，对齐 519 语义）：**AX action / set-value（后台、可读回验证）→ `CGEventPostToPid`（键盘/滚动，不抢焦点）→ activate + AXRaise + nut.js（前台兜底）**；Chromium 系坐标点击因 Chrome 过滤 pid 鼠标事件（cua 发现），**直接走前台档或 AX action**，不赌；私有 SkyLight 不进 MVP | 底稿 §3；cua injection ladder |
| D5 | capture：全屏沿用 desktopCapturer（已有，需 Screen Recording）；**单窗/遮挡/排除自身 overlay** 用 ScreenCaptureKit（helper 内 `SCScreenshotManager`，macOS 14+）经 `AXUIElementGetWindow`↔CGWindowID 定向，列 Phase 5 增强 | 底稿 §5；CGWindowListCreateImage 已废弃 |
| D6 | 录制通道复用 556 框架：hook-worker（uiohook-napi N-API，跑系统 Node ABI）macOS 可用；**新增 kVK 键码表**（uiohook 在 darwin 发 Carbon `kVK_*`，非 Win32 VK）；焦点走 helper `fg`（NSWorkspace，须避 runloop 冻结坑）；browserUrl 走 **AppleScript 词典**（Chrome/Safari/Edge/Brave 白名单，osascript 子进程 + 超时）而非 AX 抓取 | 底稿 §3/§4/§7；active-win 先例 |
| D7 | 权限：helper 提供 `permissions` op（Accessibility/Screen Recording/Input Monitoring 三态 + Apple Events 按目标 app 记录）；UI 引导卡片深链系统设置 + 重查；**dev 模式 TCC 归属 Terminal/IDE 的分叉写进文案，验收只认 packaged 产物**；Screen Recording 授权后须重启的提示前置 | 底稿 §6；cua daemon-first 授权教训 |
| D8 | 坐标：helper 全程输出 **points**（AX/CG 同系）；截图像素 → points 换算集中在 `electron/ipc/computer-use-coords.ts` 增补 darwin 路径（per-display `backingScaleFactor`） | 底稿 §3；Retina 半坐标是第一大正确性风险 |
| D9 | 读树策略：`kAXVisibleChildren` 优先 + 深度/节点预算 + 部分树 `truncated:true`（对齐 562 enumerate 语义）；Chromium/Electron 目标走「先查询 → 不行设 `AXManualAccessibility` → 等 100–300ms 重试 → 每 app 重启重设」配方；密码框 = role `AXSecureField` → `isPassword:true` 脱敏 | 底稿 §1.5/§1.8；562 预算语义 |
| D10 | 验证：AX 读回（动作后重读 value/属性/状态）映射既有 verdict 梯 —— 读回命中 = `confirmed`，无法读回 = `unverifiable`；对接 552 evidence 标注，matcher L1 依赖可读名（AX title/description 兜底），`kAXIdentifier` 稀疏性不阻塞 | 底稿 §2 矩阵；cua "AX read-back = 唯一 driver-verifiable 档" |

## 3. Phases

### Phase 0 — 协议契约（不动行为）

- [x] `packages/computer-use/src/recorder/ax-helper-protocol.ts`（对齐 uia-probe-protocol 惯例）：
      ops = `ping` / `permissions` / `apps` / `fg` / `windows(pid)` / `enumerate(pid, windowId?, maxDepth?, maxNodes?)` /
      `probe(x,y)` / `action(pid, handle, action)` / `setValue(pid, handle, value)` / `readUrl(pid, app)` / `secureInput` /
      （Phase 5 增补 `screenshotWindow(windowId)`）；响应统一 `{ok, data?|error:{code,message}}`，错误码含
      `permission-denied` / `timeout` / `stale-handle` / `unsupported`
- [x] 句柄与 ElementDescriptor 契约：enumerate 输出复用 556 `ElementDescriptor`（新增可选 `actions: string[]`、`handle: string`；`source:'ax-helper'`）；role → UIA ControlType 映射表（AXButton→Button … AXSecureField→Edit+isPassword，供 matcher/白名单复用）
- [x] 交互角色白名单常量（对齐 562 的 ControlType 白名单集合语义，AX 侧全集）
- [x] Gate：协议/映射/白名单单测绿

### Phase 1 — Swift helper 基础盘 + 权限引导

- [x] `resources/ax-helper/main.swift`（源码入库）+ `scripts/build-ax-helper.sh`（swiftc `-target arm64-apple-macos13 -target x86_64-apple-macos13` + lipo universal；构建机需 Xcode CLT，CI 非必需 —— 预编译产物随 extraResources 分发，对齐 562 D2）
- [x] 基础 ops：`ping`（就绪行 `{"ready":true}` 对齐 uia-probe）、`permissions`（`AXIsProcessTrustedWithOptions` prompt:false + `CGPreflightScreenCaptureAccess` + `CGPreflightListenEventAccess`）、`apps`（NSWorkspace runningApplications）、`fg`（frontmostApplication + `menuBarOwningApplication`，在 helper 内泵 runloop 避 NSWorkspace 冻结坑）、`windows(pid)`（CGWindowListCopyWindowInfo layer 0 + AX 窗口求交）
- [x] helper 内 AX 运行时纪律：专用 dispatch queue + 启动即 `AXUIElementSetMessagingTimeout(systemWide, 0.5)` + 每属性读取包超时 + 90s 心跳行（对齐 daemon dead-man）
- [x] `electron/services/recorder/ax-helper.ts`：主侧客户端（daemon 管线接入，per-op 竞速超时 + 3-stall 回收 + degraded 60s 自动重试，全对齐 uia-probe.ts 客户端语义）
- [x] 权限引导：`electron/ipc/computer-use-permissions.ts`（`computer-use:permissions:get/request`）+ 设置页/automation 页引导卡片（三权限状态 + 系统设置深链 + 「Screen Recording 授权后需重启」「dev 模式授权归属宿主 App」文案）；AX 未授权时 helper 显式 `permission-denied`，不静默降级
- [x] Gate（单测部分）：客户端单测 6 测绿（FakeProcess，对齐 recorder-uia-probe 模式）；
      helper 编译 smoke（ping/ready）通过
- [ ] Gate（真机部分）：Finder/Safari `apps/fg/windows/enumerate` 全流程——**待人工**（需先授 Accessibility；
      本机已冒烟 ping/permissions/fg/enumerate→permission-denied/screenshotWindow→unsupported 全部符合预期） —— Finder/Safari 各一次 `ping/apps/fg/windows`；权限卡片三态流转人工验证

### Phase 2 — 读树通道（收编 562 Phase 4）

- [x] helper `enumerate(pid, windowId?)`：`AXUIElementCreateApplication(pid)` → `kAXChildrenAttribute` 递归，`kAXVisibleChildren` 优先 + 白名单角色过滤 + 每子树独立超时 + 总预算 1500ms/maxNodes 500（对齐 562 enumerate 语义），输出带 `position/size`（points）+ `actions` + `handle`；`AXUIElementCopyMultipleAttributeValues` 单元素批量读
- [x] helper `probe(x,y)`：systemwide `AXUIElementCopyElementAtPosition` + `kAXParentAttribute` 上行归一深度
- [x] Chromium/Electron 目标：查询失败 → 设 `AXManualAccessibility` → 200ms 重试（一次）；app 重启检测后重设（复用 enumerate 缓存失效路径）
- [x] `AXSecureField` → `isPassword:true`（value 永不出 helper）
- [x] 生产接线：`electron/services/computer-use-backend.ts` `detectElements` darwin 分支 —— 聚焦 app 的 enumerate 结果喂 `element-detector` `axElements`（`axElementsSource:'ax-tree'`；562 Phase 2 已留好的路径，这是它在生产侧的第一次通电）；Windows 路径零改动
- [x] overlay 复用：enumerate 结果经 562 `overlay:show-elements` 通道可视化（rect 已是 points，注意 px 边界换算）
- [x] Gate（单测部分）：protocol/客户端/detectElements 接线单测绿
- [ ] Gate（真机部分）：覆盖矩阵 —— Finder/Safari/Chrome（未开树与 AXManualAccessibility 后）/自绘 Qt 应用（微信类）/密码框脱敏，记录 AX 覆盖差异（对齐 562 Gate 形态）

### Phase 3 — 动作与注入梯

- [x] helper `action(pid, handle, action)`：快照句柄校验（陈旧 → `stale-handle` fail-closed）→ `AXUIElementPerformAction`；`setValue(pid, handle, value)`：`AXUIElementIsAttributeSettable` 探测 → `kAXValueAttribute` set → 失败降级「聚焦 + Cmd+A + 键入」
- [x] `packages/computer-use/src/backend/electron/darwin-injection.ts`（对齐 win32-injection.ts 形态）：后台梯 = AX action → `CGEventPostToPid`（键盘/滚动）；前台梯 = activate + `kAXRaiseAction` + nut.js（libnut-darwin）；Chromium 系（pid 归属判定）坐标点击直接跳前台梯 —— 决策 D4 落地
- [x] `ElectronDesktopBackend` darwin 适配：`focusApp`/`listApps`/`showWindowWithoutFocus` 走 helper（替换 PowerShell/libnut 路径），`setValue` Cmd+A 已有分支保持
- [x] 坐标中心化：D8 落地为「AX 矩形 points → 截图像素」检测侧换算（capturePxPerPoint）+ `computer-use.ts`
      的 getScaleFactor/getPhysicalDisplaySize darwin 分支（目标空间 = points，模型坐标经 remembered
      capture size 解析为 points，避免 Retina 双倍）
- [x] verdict 接线（部分）：AX 点击成功返回 `via:'ax-action'` evidence；读回 verdict 梯未接（回流 §7） → `buildClickVerdict` 既有梯（confirmed/unverifiable/suspected_noop）；evidence 带 `via: 'ax-action' | 'cg-event-pid' | 'foreground'`
- [x] Gate（单测部分）：injection/ax-refs 单测绿
- [ ] Gate（真机部分）：后台/前台两梯 —— 后台文本编辑器免焦点输入（不抢前台）、Chrome 按钮点击（前台档 + AX action 双路径）、slider 拖动、键盘组合键

### Phase 4 — 录制通道 macOS 化

- [x] hook-worker darwin：启动前 `permissions` 检查（Accessibility + Input Monitoring），未授权 → 结构化失败（引导卡片接手，不静默无事件）
- [x] `packages/computer-use/src/recorder/keymap-darwin.ts`：uiohook darwin 键码（kVK_*）→ char/name 表；非美式布局降级 `<key:N>` 语义对齐 Windows 侧
- [x] focus-tracker darwin 分支：`fg` op 轮询（500ms，变化才上报；probe 降级回落策略对齐 562 §7）
- [x] helper `readUrl(pid, app)`：osascript 子进程 + 浏览器词典白名单（Chrome/Edge/Brave/Safari 各一模板）+ 2s 超时 + Apple Events 未授权时优雅失败（错误码区分「未授权」与「无 URL」）；RecorderService `maybeRefreshBrowserUrl` 点击驱动刷新逻辑复用
- [x] helper `secureInput`：`CGSessionCopyCurrentDictionary` 读 `kCGSSessionSecureInputPID` → RecorderService 状态位 + 录制 badge 提示（键盘监听盲区显性化）；Secure Input 期间键盘事件静默为已知边界写进 UI 文案
- [x] 自过滤：主进程 pid 命中丢弃事件（对齐 556 自窗口过滤）；blockedApps 黑名单复用
- [x] Gate（单测部分）：keymap/service/RecorderView 回归绿
- [ ] Gate（真机部分）：Safari/Chrome/备忘录三目标录制 —— Safari/Chrome/备忘录三目标录制：app_focus 两段、URL 落盘、按钮元素名附着、密码框脱敏 case

### Phase 5 — 窗口级 capture 增强（ScreenCaptureKit）

- [x] helper `screenshotWindow(windowId)`（SDK≥14 才编入；低版本 helper 回 `unsupported`）：`SCContentFilter(desktopIndependentWindow:)` + `SCScreenshotManager.captureImage`（macOS 14+，低版本显式 unsupported）；`AXUIElementGetWindow` 打通 enumerate 窗口 → CGWindowID → 截图定向
- [ ] `CaptureOptions` 增 `windowId` 路径 + 排除自身 overlay —— **deferred**（等 SDK 14 真机联调时随
      helper op 一起接线，见 §7）
- [x] Gate（单测部分）：低版本降级路径由 helper 冒烟覆盖（`unsupported`）
- [ ] Gate（真机部分）：遮挡窗口捕获——**需 macOS 14+ 人工验证**

### Phase 6 — 打包与发布门

- [x] `electron-builder.yml` mac 补全：`build/entitlements.mac.plist` + inherit（已建，随本 plan 入库）；
      mac-scoped extraResources 增 `resources/ax-helper/`；uiohook-napi darwin prebuild 已随 `npm install` 落位
      （hook-worker 打包接线沿用 556 既有 extraResources）
- [x] Info.plist：`NSAppleEventsUsageDescription`（缺失 10.14+ 直接 crash）+ AppleScript 通道文案
- [x] `tccutil reset` 开发脚本（`scripts/reset-mac-tcc.sh`）（Accessibility/ScreenCapture/ListenEvent 一键重置，dev/packaged 双模式验收工具）
- [ ] Gate：`npm run electron:pack:mac` 产物五项检查——**待人工**（ax-helper 存在并可执行、uiohook prebuild 装载、权限卡片在 packaged 产物上全流程、录制 + computer-use 各一回合、app.log 无输入内容泄漏）

### Phase 7 — 端到端验收与能力矩阵对照

- [ ] 全链路：录制（Phase 4）→ converter 转定义 → gui-runner 执行（Phase 2/3 通道）→ ≥1 步 AX-action verified + 1 步人为改名后 agent 兜底 unconfirmed
- [ ] computer-use mode 真机会话：capture（ax-tree 元素）→ click/type → verdict 三态各一例
- [ ] 能力矩阵对照表落档（对齐底稿 §2）：逐项标注 mac 达成 / 借道 / 已知边界，差距项回流 tech-debt-tracker
- [ ] Playwright MCP UI 冒烟（权限卡片 / 录制 badge / overlay / workflow 会话）
- [ ] Gate：全部 DoD（§6）

## 4. 依赖与风险

| 风险 | 缓解 |
|------|------|
| AX 调用阻塞（目标 app 挂起/繁忙） | messaging timeout 0.5s + helper 独立进程 + daemon 看门狗 + 主侧竞速；`kAXErrorCannotComplete` → degraded 语义（对齐 uia-probe） |
| TCC 授权归属 dev 宿主（Terminal/VS Code），packaged 后需重授 | 权限卡片显式区分 dev/packaged；验收只认 packaged 产物；tccutil 重置脚本 |
| Chrome 过滤 `CGEventPostToPid` 鼠标事件 | D4：Chromium 系坐标点击直接前台档；AX action 优先；SkyLight 记为后备不进 MVP |
| Retina px↔points 半坐标（Hunch 实测第一大坑） | D8 中心化换算 + Phase 3 真机对位 Gate |
| Secure Input 期间键盘监听静默/注入不可靠 | `secureInput` 状态位 + badge 提示；已知边界写进 UI 文案 |
| uiohook-napi darwin prebuild/崩溃疑点 | hook-worker 跑系统 Node ABI（Windows 已验证）；Phase 1 前置冒烟；备选 fork `@mukea/uiohook-napi` |
| `kAXIdentifier` 稀疏 → matcher L1 命中率 | L1 依赖可读名（AX title/description 兜底）；L2 相对位置 + L3 agent 兜底照旧；AutomationId 不作为依赖 |
| 虚拟化大表（`kAXVisibleChildren` per-app 缺口） | 预算 + `truncated` 部分树；深表场景滚动重扫记为已知边界 |
| macOS 26 Tahoe AX 回归未确证 | Phase 2 覆盖矩阵在 Tahoe 上跑；差异记录回流 |
| 构建机需 Xcode CLT（swiftc） | 预编译 universal 产物随 extraResources 分发；源码入库可复编 |
| 键盘全文捕获隐私（同 556） | 显式开启 + badge 可停 + AXSecureField 脱敏 + 黑名单过滤 + 内容不进 app.log |

## 5. 明确不做（out of scope）

- Linux 捕获/注入（继续 556 红线）
- 私有 API：SkyLight（`SLEventPostToUid`）、`_AXObserverAddNotificationAndCheckRemote`、`_AXUIElementGetPid` —— notarization 与稳定性风险，全部记为后备
- AXObserver 推送通知接入 os-context 桥（poll → push 架构升级，另立 plan）
- ScreenCaptureKit 流式（只做静帧）；SCK 内容选择器（user-consent 免 TCC 路线）
- App Store 沙盒分发形态（AT 类应用事实不可行，Mac 直发 + notarization）
- duya 自身 UI 的无障碍化改造（仅保留 `app.setAccessibilitySupportEnabled` 开关现状）
- Excel 单元格级等深层数据读取（对齐 556 §6）

## 6. 验收标准（MVP Definition of Done）

1. 首次在 macOS 启用 computer-use：权限引导卡片三权限逐个授予（含 Screen Recording 重启提示）→ helper `permissions` 全绿。
2. computer-use mode 会话：capture 出 Safari/Chrome 真实元素表（`axSource:'ax-tree'`、真实 rect）→ 按 SOM 索引点击 AXButton（verified，`via:'ax-action'`，全程不抢焦点）→ 文本输入读回 confirmed。
3. 录制：Safari 导航 + 点击 + 输入 → 停止；会话时间线含两段 app_focus、浏览器 URL、元素名、一个密码框脱敏 case；转换产物 `validateWorkflow` 通过。
4. 回放：gui-runner 全链路，matcher L1 以 AX 名称命中 ≥1 步（verified）；1 步人为改名后 agent 兜底（unconfirmed）。
5. 后台注入：对非前台文本编辑器 `type_text` 全程前台应用焦点不变。
6. packaged 产物（electron:pack:mac）：Phase 6 五项检查全过；app.log 无任何输入内容泄漏。
7. 能力矩阵对照表落档：Windows 栈每一能力项标注 macOS 侧达成路径或已知边界。

## 7. 落地注记（2026-09-27，Phase 0–6 代码部分）

### 实际落点（与计划的差异 + 环境事实）

1. **helper 编译与环境**：本机 macOS 12.7.6 (x64) + CLT 13.1。`swiftc -target arm64/x86_64-apple-macos12`
   双架构 lipo universal 成功；SDK < 14 → `screenshot.swift` 不编入，`screenshotWindow` 回 `unsupported`
   （门控 `-DDUYA_HAS_SCK`，构建脚本自动探测 SDK 版本）。`timeout` 命令 macOS 不存在 → smoke 用 perl alarm。
2. **AXUIElementGetWindow 不可用**：CLT 13.1 的 HIServices tbd 缺该符号（链接失败），改用经典
   bounds-match 解析（AXWindow position/size ↔ CGWindowList 逐窗比对，唯一命中才返回 windowId）。
   `enumerate(windowId)` 定向与激活路径均不受影响。
3. **AXUIElementCreate\* 的 Swift overlay** 直接返回 `AXUIElement`（非 Unmanaged），probe out-param 的 CF
   引用由句柄注册表持有（上限 4096，helper 短生命周期，有意为之）。
4. **uiohook-napi 在 macOS 发的是 VC 码**（libuiohook 平台无关码空间，与 Windows 同表）——
   keymap.ts 原样复用于录制文本还原；`keymap-darwin.ts` 只承担 VC→kVK（`keyToPid` 用）。
5. **D8 的最终形态**：换算拆成两半 —— 检测侧 `capturePxPerPoint`（AX points → 截图像素，SOM bbox 与
   图像同系）+ IPC 侧 `getScaleFactor/getPhysicalDisplaySize` darwin 分支（点击目标空间 = points）。
   计划原文写的单侧「computer-use-coords.ts 换算」在实现中一分为二，语义等价。
6. **AXStaticText 进交互白名单**（mac 特有决策）：mac 按钮/链接常用 title-UI-element 关联命名，
   本体 name 常为空；静态文本是 web 内容 L1 matcher 名字的主要载体。节点预算（maxNodes 500）兜底。
7. **权限门 + Secure Input**：RecorderService 增 `permissionGate`（Accessibility/Input Monitoring 未授 →
   degraded 启动 + 结构化 reason，不再静默空事件流）与 `secureInputQuery`（焦点变化时刷新，
   状态进 snapshot）。
8. **AX action rung 的 verdict 读回未接**：点击成功以 `via:'ax-action'` evidence 标注，读回梯
   （confirmed/unverifiable）回流 tech-debt —— 需要先定「按 handle 重读状态」的判据语义。
9. **已知存量问题（与 plan 572 无关，基线验证）**：`tsc --noEmit` 15 个错误（logger.ts/
   useGitRepo/git-ipc/AgentFace 缺失 —— dev/mac 合并 140 commits 的存量）；`recorder-handlers.test.ts`
   convert case 失败（562 §8 已移除 recorder:convert，测试未清）。本 plan 的 tsc diff 为零新增。

### 待人工的真机 Gate（AX 授权是前置）

`scripts/reset-mac-tcc.sh` + Automation 页权限卡片完成三权限授予后：
① Phase 1/2 覆盖矩阵（Finder/Safari/Chrome/自绘 Qt/密码框）② Phase 3 后台/前台两梯注入
③ Phase 4 Safari/Chrome/备忘录三目标录制 ④ Phase 6 packaged 产物五项检查 ⑤ Phase 7 端到端 + 矩阵对照表落档。
