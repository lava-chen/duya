# 618 — duya 桌面端管理控制面（616 加强版）

> **状态**：Proposed（2026-10-20 立项）
> **归属**：**[616](./616-duya-app-mcp-layer.md) 的加强版 / 续章**——不是并列的第二个真相源。
> 616 的分期表不重开，本章只在其未覆盖的「桌面外壳面」上补卡。
> **硬前置**：[616](./616-duya-app-mcp-layer.md) T610b（ALS 上下文穿透管道）
> + T610e（`source: 'app'` 权限分支）；交付状态从 616 的验证记录核对，不在此复制。
> **参照**：Claude Code Desktop 自带的 61 个 `mcp__ccd__*` 工具（§1 逐域实测清单）
> **关联**：[617 基础工具接口 v2](./617-basic-tool-interface-v2.md)（正交，618 不碰基础工具）
> · [571 Tab Shell Workbench](../backlog/571-tab-shell-workbench.md) ·
> [527 Dock 布局树](../backlog/527-dock-layout-and-window-management.md) ·
> [582 会话归档加固](./582-session-archive-hardening.md) ·
> [496 worktree 框架](./496-worktree-framework-implementation.md)（已有隔离实现，剩余范围见该计划）

---

## 0. 一句话

616 把 duya 的**产品能力**（画布 / 消息通道 / 浏览器 / 多模态）收进进程内 MCP server
`duya_app`。但**桌面外壳本身**——侧边栏分组、面板与视图、窗口、会话归档、目录授权——
还住在 renderer 的 React 状态里，agent 够不着。

**618 把桌面外壳也接进同一套 MCP 管道**，让 duya 里的 agent 能管理 duya 桌面端自己。

---

## 1. 参照：Claude Code Desktop 的 61 个 `mcp__ccd__*` 工具

> 2026-10-20 在 Claude Code Desktop 会话内**实测调用**所得，非转述。

| server | 工具数 | 覆盖 |
| --- | --- | --- |
| `mcp__ccd_session_mgmt__` | 20 | 会话增删改查、跨会话投递、模型/努力度/权限模式/输出风格切换、Remote Control、额度与上下文占用、transcript 导出与全文检索 |
| `mcp__ccd_sidebar__` | 13 | 自定义分组增删改、成员移动、置顶、未读标记、每分区视图配置（`group_by` / `sort_by` / `collapsed` / `shown`） |
| `mcp__ccd_host__` | 7 | 磁盘占用扫描、闲置 worktree 清理、在编辑器打开文件、文件管理器定位、防休眠、合并 base 分支 |
| `mcp__ccd_pr__` | 5 | PR 绑定/解绑、CI 状态读取、自动合并开关、CI 失败唤醒 |
| `mcp__ccd_view__` | 4 | 打开/关闭侧边面板（diff / file / terminal / pr / tasks / plan / preview）、转录视图切换 |
| `mcp__ccd_window__` | 4 | 分屏打开另一会话、窗口布局、侧边栏折叠 |
| `mcp__ccd_session__` | 4 | 章节标记、待办建议卡生成与撤销、内嵌组件上下文读取 |
| `mcp__ccd_settings__` | 2 | Code 标签页偏好读写（自动归档、分支前缀、通知、输出风格…） |
| `mcp__ccd_directory__` | 2 | 切换会话工作目录、申请访问工作目录之外的文件夹 |

### 1.1 三条形状观察

1. **一动作一工具**，每工具带精确 JSON Schema；副作用、拒绝条件、权限档位都写进
   `description`（例：`move_sessions` 的 description 明确写出「把置顶会话拖进分组会
   自动取消置顶」）。
2. **边界是「作用于 Desktop 自己」**——这 61 个工具全部操作应用外壳（会话 / 面板 /
   侧边栏 / PR / 窗口 / 偏好），**不操作文件内容**。文件内容是 Claude Code 自己的
   基础工具（Read / Write / Bash）管的，两层分得很干净。
3. **读工具与写工具同构**，没有单独的「只读 namespace」。区分靠 permission mode，
   不靠工具面分层。

### 1.2 duya 要抄哪部分、不抄哪部分

| CCD 做法 | duya 取舍 | 理由 |
| --- | --- | --- |
| 一动作一工具 | **部分抄** | 见 §3.1：duya 已有 `duya_cli` 的「单工具 + 子命令」形状，两条通道分工 |
| 精确 JSON Schema | **抄** | `duya_cli` 的 schema 是从 CLI descriptor registry 派生的，参数校验在运行时；模型调用高频动作时精确 schema 更省 token 也更少错 |
| 作用于外壳 | **抄** | 这正是 618 的定义 |
| 61 个工具一次性上 | **不抄** | 61 个工具会撑爆 schema 预算（§C16）；duya 走 deferred 暴露 + `tool_catalog` 发现 |
| PR 监控 / Remote Control | **不抄** | 前提缺失（§7） |

---

## 2. duya 现状（2026-10-20 实测）

### 2.1 三块拼图

| 拼图 | 形态 | 覆盖面 | 状态 |
| --- | --- | --- | --- |
| `duya_cli` | **1 个工具** + N 个子命令，schema 由 `packages/cli/src/program/descriptors.ts` 派生 | plugin / skill / session / cron / channel / provider / mcp / memory / hook / config / backup / security / voice / gateway / message / agent | ✅ 数据面齐了 |
| `duya_app` | 进程内 MCP server（616） | canvas / bot / browser / 多模态 | 🔨 T610a 骨架已交付；`tools/call` 管道（T610b）未交付 |
| **桌面外壳面** | —— | 侧边栏分组 / 面板 / 窗口 / 置顶 / 目录授权 | ❌ **没接进控制面** |

**616 已经把 `session` / `SessionSearch` / `duya_cli` 等 17 个「产品能力」判给
`duya_app`（616 §3.1），但那批工具作用的是「会话内容 / 会话检索 / CLI 调度」，
不是「会话这个对象本身」与「桌面外壳」。本章补的是后者。**

### 2.2 逐域缺口

| CCD 域 | duya 现状 | 缺什么 |
| --- | --- | --- |
| session 管理（20） | `duya_cli session`（list / show / search / export / import）、host `/v1/agent-runs` `/v1/mode-state` `/v1/permission-requests`、`Thread.pinned` + `setThreadPinned` | agent **开 / 切 / 归档 / 删除 / 置顶**会话；跨会话投递；模型/权限模式切换 |
| sidebar（13） | **Plan 471 全套已有**：`sidebar_sections` / `sidebar_section_projects` 表、SQLite store、IPC、renderer store、dnd-kit 拖拽排序、右键「移动到 section」 | per-section 视图配置（`group_by` / `sort_by` / `hidden`）；**session 级归组**（今天 section 只能装 `workingDirectory`） |
| view / 面板（4） | 10 个 `duya:open-*-panel` window 事件已在 `usePanel.ts` 注册 | **缺「面板显示」的控制面封装**；且 viewId 契约未冻结（§C17） |
| 窗口（4） | BrowserWindow 在，orb 窗口有第二窗口先例 | split view / 窗口布局管理——依赖 527，本期不碰 |
| host（7） | `/v1/locks`、projects 目录管理 | worktree 管理（plan 496 **至今 0 代码**，2026-10-20 实测 `packages/agent/src/worktree/` 不存在）；keep-awake（Electron `powerSaveBlocker`，很便宜，可做）；open_in_editor |
| pr（5） | 无 | duya 没有 PR 数据模型，CodeReviewPanel 只做本地 diff——**整域划到范围外** |
| settings（2） | `/v1/local/settings` + `duya config kv` | per-key 白名单与类型约束（低优先） |
| directory（2） | `projects.addRecentFolder` | 工作目录**之外**的目录授权（走 Electron 目录选择框） |

### 2.3 已有接缝（**不用新造**）

| 接缝 | 位置 | 用途 |
| --- | --- | --- |
| main → renderer | `apps/desktop/src/main/agents/session-manager.ts:96`（`window.webContents.send`）、`apps/desktop/src/main/automation/agent-run.ts:371`（`sync:threads-changed`） | host 让 renderer 执行动作 |
| renderer 事件总线 | `apps/desktop/src/renderer/hooks/usePanel.ts:572-875`（10 个 `duya:open-*-panel`）、`app-sidebar.tsx:282,296`（`duya:rooms-changed` / `duya:new-project`） | renderer 侧动作的落点 |
| 侧边栏数据面 | `packages/data/src/sidebar-sections-store.ts`（SQLite）+ `apps/desktop/src/renderer/stores/sidebar-sections-store.ts`（renderer 镜像）+ `packages/host/src/http-server.ts:651`（`/v1/local/sidebar-sections`） | 分组的增删改排与归属 |
| CLI 描述符 | `packages/cli/src/program/descriptors.ts`（`CLI_DESCRIPTORS`）+ `registry.ts`（`CliCommandPath`）+ `apps/desktop/src/main/cli/handlers/` | 新命令族的落点 |
| 进程内 MCP 骨架 | `packages/capabilities/src/AppServer/in-process-app-server.ts` | 新 namespace 的模板 |

---

## 3. 目标形态

### 3.1 两条通道分工

**不把 61 个工具照抄成 61 个工具。** duya 已经有「单工具 + 子命令」的控制面
（`duya_cli`），再叠一套全是离散工具的平行通道是重复投资。分工按**参数形态**切：

| 通道 | 承载 | 判据 | 形态 |
| --- | --- | --- | --- |
| **`duya desktop` CLI 命令族** | 侧边栏分组、设置、目录、工作区列表 | 参数多变、既有数据面已有完整 store/表 | 子命令；schema 从 descriptor registry 派生，**零新 MCP 机制** |
| **`duya_desktop` 进程内 MCP server** | 会话生命周期、视图/面板、目录授权 | 模型高频调用、参数少而固定、需要精确 schema | 一动作一工具，deferred 暴露 |

判定规则：**同一动作若已能通过 `duya_cli` 表达，就不新增离散工具**；只有「模型每轮
都可能调用、且参数形态固定」的动作才做成离散工具。

### 3.2 工具清单（首批，15 个离散 + 1 个 CLI 命令族）

**A. 会话面（`duya_desktop`）**

| 工具 | 动作 | 备注 |
| --- | --- | --- |
| `desktop_session_list` | 列会话 | `scope: active\|archived\|all`、`workingDirectory` 可选过滤 |
| `desktop_session_create` | 新建会话 | `workingDirectory` / `projectName` / `providerId` / `model` |
| `desktop_session_open` | 切到某会话 | 改 renderer 的 `activeThreadId` |
| `desktop_session_rename` | 改标题 | |
| `desktop_session_archive` | 归档 | **必须走 plan 582 的归档链**（含 spawn 子树判定），不得另起炉灶 |
| `desktop_session_delete` | 删除 | **危险**——`source:'app'` 完整权限链 + 风险档位 |
| `desktop_session_pin` | 置顶 / 取消 | 对齐 `Thread.pinned`（conversation-store） |

**B. 视图 / 面板面（`duya_desktop`）**

| 工具 | 动作 | 备注 |
| --- | --- | --- |
| `desktop_view_open` | 按 viewId 打开视图 | viewId 契约见 §C17 |
| `desktop_view_list` | 列当前打开的视图 | |
| `desktop_view_close` | 关闭视图 | |
| `desktop_view_focus` | 聚焦某视图 | |

**C. 目录面（`duya_desktop`）**

| 工具 | 动作 | 备注 |
| --- | --- | --- |
| `desktop_workspace_list` | 列已授权工作目录 | |
| `desktop_workspace_grant` | 授权新目录 | **必须走 Electron 目录选择框**，不得接受任意路径字符串 |
| `desktop_workspace_revoke` | 撤销授权 | |

**D. 侧边栏面（`duya desktop` CLI 命令族）**

```
duya desktop section list|show|create|rename|remove|assign|unassign|reorder|view
duya desktop workspace list
```

`assign` 支持两种成员：今天的 `workingDirectory`（已有），与新增的 **session id**
（需要新表，见 T618e）。

### 3.3 命名与身份

| 维度 | 值 |
| --- | --- |
| 内部键 | `mcp__duya_desktop__<tool>` |
| 模型可见名 | `mcp_duya_desktop_<tool>` |
| 稳定 tool_id | `mcp:duya_desktop:<tool>`（`catalog-identity.ts:20` 既有形状） |
| 暴露 | `[tools] exposure` 既有开关；**这 15 个工具默认 `deferred`**，靠 `tool_catalog` 的 `namespace: 'duya_desktop'` 模式发现 |
| 权限 | `source: 'app'`（新值，616 §C9 已论证）——**不得用 `bundled`** |
| 上下文 | AsyncLocalStorage（616 T610b），不污染 MCP 协议 |
| 路由匹配 | 从 `mcp_duya_desktop_` 前缀**反解原名**，不依赖 `mcpInfo`（616 §C7 同因） |

---

## 4. 承重约束（读出来的，不是猜的）

**C10 — 桌面外壳状态住在 renderer，host 够不着。**
侧边栏分组的展开态、面板显隐、当前 tab 全是 renderer 的 zustand / React state。
host（main 进程）不能直接改。这决定了 618 必须有一条 host→renderer 的下行链路，
而不是把状态搬到 host。

**C11 — 下行链路现成。**
`session-manager.ts:96` 的 `window.webContents.send(event, data)` 与
`automation/agent-run.ts:371` 的 `sync:threads-changed` 都是 main→renderer 的既成用法。
renderer 侧的动作落点是 `usePanel.ts:572-875` 已注册的 10 个 `duya:open-*-panel` 事件。
**618 不新造事件总线，沿用这套 `window` CustomEvent 形状。**

**C12 — 硬前置是 616 T610b。**
`tools/call` 只带 `name` + `arguments`，desktop 工具的 executor 需要活的
`context.ipcRequest`（函数）与 `options.sessionId`。616 已实测 AsyncLocalStorage 可行
（5 并发各带各的 context，穿过 `await` 无泄漏），但**管道本身还没写**（T610b 未交付）。
**没有 T610b，618 一行都动不了。**

**C13 — CLI 命令族是三步。**
`descriptors.ts` 头部注释写明：加一个顶层命令 = ① `CLI_DESCRIPTORS` 加条目
② `registry.ts` 的 `CliCommandPath` 加路径 ③ 若 agent 工具要暴露，更新
`DuyaCliTool/constants.ts`。`duya desktop` 走这三步。

**C14 — `source: 'bundled'` 会短路安全检查，对 desktop 工具是安全回退。**
616 §C9 已实测：`hasPermissionsToUseTool` 的 step 0 对 `bundled` 直接 allow，
**后面全不执行**——灾难检查、宿主常驻开关、风险档位。
desktop 工具比 canvas/bot 更危险：`desktop_session_delete` 删会话、
`desktop_view_close` 关面板、`desktop_session_archive` 移动 rollout 文件。
**必须走新的 `source: 'app'`**，语义是「自家能力，但走完整条链」。

**C15 — 改名会打穿 renderer 路由。**
616 §C2–C5 实测：renderer 靠工具名前缀匹配（`ToolActionRow.tsx:201` 的
`name.startsWith('canvas_')`），改名成 `mcp_duya_app_canvas_manage` 后全部落进通用行。
desktop 工具同样会经历 `desktop_session_delete` → `mcp_duya_desktop_desktop_session_delete`
的改名，**必须做「从模型可见名反解原名」**，且反解逻辑要与 616 T610e 共用同一份。

**C16 — 工具数量有预算。**
`catalog-types.ts:3` 的 `ToolExposure = 'eager' | 'deferred' | 'hidden'`，
schema 预算在 `spec-budget.ts:19`。15 个离散工具 + 一个 CLI 族**必须 deferred**，
否则挤占常驻 `tools[]`。

**C17 — viewId 契约不能自造。**
527 已定「viewId 是跨 Phase 的序列化契约」（`session:<threadId>` / `conductor:<canvasId>` /
`files` / `preview` / `review` / `terminal` / `browser` / `bot-settings:<id>`），
571 把它泛化为全窗口 `ViewDescriptor` registry。**两个计划都在 backlog 未启动。**
618 的 `desktop_view_*` 工具**不得自造一套 view 命名**——必须等 571/527 冻结契约，
或由 618 显式采用它们的 `viewId` 形状（作为临时约定，但要在计划里标为待冻结）。
**这是 T618f 的硬前置。**

**C18 — session 级归组需要新表。**
今天的 `sidebar_section_projects` 映射的是 `working_directory`
（`packages/data/src/main-schema.ts:2576`），一个 workingDirectory 至多属于一个 section
（`packages/data/src/sidebar-sections-store.ts:202` 的 `assignProject` 先 DELETE 旧行）。
session 级归组需要**平行的** `sidebar_section_threads` 表（主键 `(section_id, thread_id)`，
thread_id 单列索引支撑「至多一个 section」的 O(1) 反查），
**不得复用同一张表**——那会把 project 成员和 session 成员混在一个排序空间里。

---

## 5. 分期

> 每卡独立可交付、独立可回滚。**T618c 必须与 616 T610e 同卡或在其后**——
> desktop 工具要用的 `source: 'app'` 权限分支是 616 T610e 交付的。

```
616 T610b (ALS 管道) ──┐
                       ├──→ T618a (探针) ──→ T618b (只读盘点) ──┬──→ T618c (权限收口) ──┬──→ T618d (会话写操作)
616 T610e (source:'app') ┘                                     │                      └──→ T618e (侧边栏 + session 级归组)
                                                             └──→ T618f (视图/面板)  ← 另需 571/527 冻结 viewId
```

| 卡 | 交付 | 独占路径 | 首个失败证据 | 依赖 |
| --- | --- | --- | --- | --- |
| **T618a** | **前置探针**：证明 desktop 域能穿过 ALS 拿到 host 活上下文（一个只读探针工具，输出 host 侧 sessionId / cwd） | `packages/capabilities/src/AppServer/**` | 探针工具读不到 `ipcRequest`——今天 `in-process-app-server.ts` 只实现了 `tools/list`，无 `tools/call` 处理器 | 616 T610b |
| **T618b** | **只读盘点面**：`desktop_session_list` / `desktop_view_list` / `duya desktop section list`。**零写操作** | `packages/capabilities/src/AppServer/**`、`apps/desktop/src/main/cli/handlers/desktop.ts`、`apps/desktop/src/renderer/hooks/usePanel.ts` | 今天 agent 无法列出桌面端有任何会话 / 面板 / 分组 | T618a |
| **T618c** | **权限收口**：`duya_desktop` 走 `source:'app'`；反解原名机制覆盖新 namespace；`desktop_session_delete` 等危险动作的风险档位 | `packages/agent-runtime/src/authorization/**` | 把 `source` 改成 `'bundled'` → 「灾难检查未被跳过」的断言必须报红 | 616 T610e |
| **T618d** | **会话写操作面**：create / open / rename / archive / delete / pin。归档必须走 582 的链 | `packages/capabilities/src/AppServer/**`、`apps/desktop/src/renderer/stores/conversation-store.ts` | 今天 agent 无法切会话或归档会话 | T618b + T618c |
| **T618e** | **侧边栏分组暴露** + **session 级归组**：`sidebar_section_threads` 新表 + 对应 store / IPC / CLI / renderer 过滤 | `packages/data/src/main-schema.ts`、`packages/data/src/sidebar-sections-store.ts`、`apps/desktop/src/renderer/stores/sidebar-sections-store.ts` | 今天 section 只能装 `workingDirectory`；`assignProject` 的「至多一个 section」不变量无法套到 session | T618b + T618c |
| **T618f** | **视图 / 面板控制面**：`desktop_view_open` / `list` / `close` / `focus` | `apps/desktop/src/renderer/hooks/usePanel.ts`、`apps/desktop/src/renderer/components/layout/panels/registry.ts` | 今天只有 10 个写死的 `duya:open-*-panel` 事件，agent 无法「列出已打开的视图」 | T618b + **571/527 冻结 viewId 契约** |

### 5.1 为什么先做只读

T618b 明确**不含任何写操作**，原因是：写操作（尤其 `desktop_session_delete` /
`desktop_view_close`）一旦寻址错对象，agent 可能删掉用户正在跑的会话或关掉用户正在看的
面板。盘点面让 agent 先看清自己身处什么状态——**这也正是 CCD 把 `list_sessions` /
`list_sections` / `get_layout` 这些只读工具放在最显眼位置的原因**。

---

## 6. 验收证据（必须是正面的）

**通用**

- `npm run typecheck:all` exit 0（esbuild 不做类型检查，这是硬门禁）。
- `npm run check:encoding` exit 0。
- `npm run architecture:check` 无新增边界违规——618 新增 host→renderer 与
  capabilities→host 两条链路，都要登记进边界基线。
- **反向证明（必须做）**：把 T618c 的「反解原名」改回「直接用模型可见名」，
  renderer 路由测试必须报红；把 `source` 从 `'app'` 改成 `'bundled'`，
  「灾难检查未被跳过」的断言必须报红。**证明门禁在守，不是恒绿。**
- 工具名列表里 `mcp_duya_desktop_*` 出现，且**基础工具 wire name 一字未改**。

**T618a**

- `packages/capabilities/tests/mcp/in-process-app-server.test.ts` 加例：
  探针工具在 server 侧读到 `ipcRequest` 是 `function`、`sessionId` 与调用方一致。
- 5 个并发探针调用各自拿到自己的 context（照抄 616 C8 的验收形态）。

**T618b**

- `npx vitest run packages/capabilities/tests/mcp/` 全绿。
- 新增 `apps/desktop/src/main/cli/__tests__/desktop.test.ts`：
  `duya desktop section list` 返回真实分组。
- renderer：`desktop_view_list` 返回当前打开的视图，与 `usePanel` 的真实状态一致。

**T618d**

- 会话生命周期闭环测试：create → open → rename → archive → 列表里消失 →
  `archivedThreads` 里出现。
- **归档必须走 582 的链**：断言 `desktop_session_archive` 在会话有运行中 turn 时
  **拒绝**（与 582 的「refuse when a turn is still running」一致）。

**T618e**

- `sidebar_section_threads` 的迁移测试：新库上建表成功，老库迁移后 section 成员不丢。
- 不变量测试：同一 thread_id 归到第二个 section 时，第一个 section 的行被删除
  （照 `assignProject` 的先 DELETE 旧行语义）。
- 项目展开的 thread 列表**过滤掉**已被 session 级归组的 thread（对齐「一个成员只出现
  在一处」的语义，§4 卡片备注）。

**T618f**

- `desktop_view_open` 打开的视图与手动点击打开的视图，渲染结果一致。
- viewId 非法时报**明确错误**（列出可用 viewId），不是静默失败。

---

## 7. 非目标

- **不做 PR 监控域。** CCD 的 `mcp__ccd_pr__` 依赖一个 duya 没有的 PR 数据模型
  （duya 的 CodeReviewPanel 只做本地 diff）。要做得先立 PR 实体，单独立项。
- **不做 Remote Control / keep-awake / open_in_editor。** 前者需要账号与远端服务；
  后两者 Electron 原生能力便宜但**不属于「agent 管理桌面端」的核心闭环**，
  可以在 618 落地后按需加进 `duya desktop` CLI 族。
- **不做 worktree 管理。** plan 496 至今 0 代码（2026-10-20 实测
  `packages/agent/src/worktree/` 不存在），没有底层就没有工具。
- **不做窗口布局管理 / split view。** 依赖 527 的 dock 树。
- **不改基础工具的 wire name。** 那是 617 的范围。
- **不把 618 做成对外 MCP server。** 618 的工具**给 duya 内的 agent 用**。
  「让外部 agent（Claude Code CLI）遥控 duya」是另一个方向——duya 有
  `packages/host/src/http-server.ts` 的 HTTP 面，可以在上面挂一个**对外** MCP server，
  但那是独立立项，与 618 的进程内形态不同（进程内形态依赖 ALS 穿透活上下文，
  §C12）。
- **不新增第二个 MCP 机制。** 复用 616 的 in-process server、deferred 暴露、
  `tool_catalog` 发现、`source:'app'` 权限链。

---

## 8. 与既有计划的关系

| 计划 | 关系 |
| --- | --- |
| **616** | **父计划**。618 是它在「桌面外壳面」的加强版：616 §3.1 判定了产品能力的归属，618 补上外壳能力。**616 的分期表不重开**；616 T610b / T610e 是 618 的硬前置。616 需要加一行指向本章。 |
| **617** | 正交。617 改基础工具的界面形状，618 增加一个新的 namespace，两边不碰对方的工具。 |
| **580** | 616 §2.2 已列的地基（catalog / exposure / tool_invoke / 稳定 tool_id）——618 直接复用，**不改 580 的任何机制形状**。 |
| **571 / 527** | 571 泛化 `ViewDescriptor` registry、527 冻结 viewId 契约。618 的 T618f **依赖**它们的契约形状；618 不自己造 view 命名。 |
| **582** | 618 的 `desktop_session_archive` **必须复用** 582 的归档链（spawn 子树判定、运行中 turn 拒绝），不另起炉灶。 |
| **496** | 618 的 worktree 域划到范围外，等 496 落地再议。 |
| **610 架构系列** | 正交。618 不改执行事件唯一化、agent 退役等架构裁决；但新增两条跨层链路要过边界门禁。 |

### 8.1 依赖图

```
616 T610b (ALS 管道)  ──┐
616 T610e (source:'app') ─┼──→ 618 T618a → T618b ─┬─→ T618c ─┬─→ T618d
                        │                          │          └─→ T618e
571 / 527 (viewId 契约) ───────────────────────────┴─→ T618f
```

**关键排序约束**：`T618c`（权限收口）依赖 616 T610e。**在 T610e 落地前不得交付
T618d / T618e**——否则写操作会走 `bundled` 短路路径，安全检查被跳过（§C14）。
T618b（只读）不受此约束，可以先行。
