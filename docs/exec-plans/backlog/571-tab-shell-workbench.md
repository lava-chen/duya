# 571 — Tab Shell Workbench（主区域 Tab 化 + 会话平等化）

> Status: **Planning**（2026-09-27 立项）
> 交互原型：`docs/prototypes/tab-shell/index.html`（已评审通过，本 plan 的交互契约以原型为准）

## 0. 背景与设计决定

主区域从「单一会话视图 + 右侧面板」重构为 **VSCode 式 Tab Shell**：

1. **Header 取消**：顶栏改为 title bar（后退/前进/侧栏开关/拖拽区/窗口控件），会话标题与运行状态收进标签本身。
2. **所有视图统一为 tab**：会话、项目列表、项目详情、画布、自动化、代码预览、浏览器、工作流、审查、终端、文件……全部是同一种标签，可开在任意组。
3. **侧栏 → 拆分视图**：原右侧面板不再固定为侧栏；主区域 = 圆角卡片，卡片内含极窄侧栏（可收起）+ **左右两个视图组**（组内多 tab、各有一个激活 tab）。
4. **极窄侧栏**：duya 图标 + 搜索/新建（复用现有两个 icon 的逻辑）+ 画布/自动化/工作流/项目/Bots 五个入口；侧栏分「会话」与「Bots」两个分区，Bots 是独立入口（进入后侧栏显示 bot 列表）。
5. **项目两层**：「项目」tab 只是项目列表（对齐 `ProjectsView`：标题 + 搜索 + 新建项目 + 项目行）；点项目行打开该项目自己的详情 tab。

## 1. 目标 / 非目标

**目标**

- 主区域 = title bar + 圆角卡片（内含侧栏 + 1–2 个视图组），视图全部 tab 化，支持组内拖排序、跨组移动、拖到屏幕左右缘拆分。
- **会话与 tab 平等绑定**：不存在全局唯一 active 会话；每组可各自激活一个会话，两组 = 两个会话同时 mounted 同时渲染。
- 现有 `panels/registry.ts` 的 `PageTab/PageId/PageDescriptor` 模型泛化为全窗口 view registry。
- 会话的后台生命周期（agent run、SSE）不受 tab 开合影响。

**非目标**

- 不改 Agent Server / SSE 协议（事件本就按 sessionId 寻址）。
- 不做 >2 组、垂直分栏、tab 拖出独立窗口（另立项）。
- 不动 bot 后端；bot 会话（`bot:<agentId>`）只是带 owner 的普通会话，走同一绑定规则。
- 项目详情的数据接线仅到现有 store（`useProjectsStore` + threads 按路径归组 + workflow runs 摘要），深度治理另立项。

## 2. 现状锚点（真实代码）

| 现有物 | 位置 | 处置 |
| --- | --- | --- |
| `PageTab` / `PageId` / `PageDescriptor` + `openOrActivatePage` | `src/components/layout/panels/registry.ts` | **泛化种子**：升级为全窗口 `ViewDescriptor` registry |
| `PanelZone`（右面板 + launcher + 加页菜单） | `src/components/layout/PanelZone.tsx` | Phase 5 退役；`ResizeHandle` 保留复用为组分隔条 |
| `currentView: ViewType` / `activeThreadId` / `setCurrentView` | `src/stores/conversation-store.ts:88,136` | 单一 active 假设的源头；降级为兼容 shim（见 §4.2） |
| `stream-session-manager`（per-sessionId listeners + LRU 逐出） | `src/lib/stream-session-manager.ts` | 寻址模型已正确；`streamMemoryPolicy` 豁免集合需升级（§4.4） |
| `TitleBar.tsx`（拖拽区 + window controls + sidebar spacer） | `src/components/layout/TitleBar.tsx` | 扩展 back/forward/sidebar toggle |
| 事件入口 `duya:open-workflow-node-panel` / `duya:open-office-panel` / `duya-file` 附件 | 各发射点 | 全部改投 `openTab(kind, params)` |
| `SearchCommandPalette` / `app-sidebar.tsx` 的 `setCurrentView` 调用 | `src/components/*` | remap 到 `tabShell.openView()` |
| `usePanel.ts` / `PanelHeader` | `src/hooks/usePanel.ts` 等 | 随 PanelZone 退役 |
| 快捷键 Ctrl+\` / Ctrl+T / Ctrl+Shift+G / Ctrl+P / Ctrl+Alt+S | `PanelZone.shortcutFor` | remap 到 view shortcuts；新增 Ctrl+B（侧栏）/ Ctrl+F（搜索） |

## 3. 核心模型

```ts
// src/stores/tab-shell-store.ts
type ViewKind = 'session' | 'home' | 'project' | 'canvas' | 'automation'
              | 'code' | 'browser' | 'workflow' | 'review' | 'terminal'
              | 'files' | 'conductor' | 'session-messages' | 'bot-settings'
              | 'room-settings' | 'office';   // 与现有 PageId 一一对齐

interface TabDescriptor {
  id: TabId;                 // 't'+seq
  kind: ViewKind;
  title: string;             // 可动态刷新（会话改名 / 文件切换 / run 标题）
  icon?: string;
  singletonKey?: string;     // 同 key 复用激活：'canvas' / 'project:<id>' / 'code:<path>' / 'workflow:<runId>' / 'home'
  sessionId?: SessionId;     // kind==='session' 时必填 —— 绑定关系唯一真相
  params?: Record<string, unknown>;
}
interface ViewGroup { id: string; tabs: TabId[]; active: TabId | null; ratio: number; }
interface TabShellState {
  groups: ViewGroup[];       // 长度 1..2，永不为空
  tabs: Record<TabId, TabDescriptor>;
  focus: number;             // 最近交互组（title bar 拆分按钮 / rail 打开视图的作用对象）
  navStack: TabId[];         // 激活历史（back/forward 跳过已关闭 tab）
  navIndex: number;
  sidebar: { open: boolean; section: 'sessions' | 'bots' };
}
```

- **持久化**：tab 形状（groups/tabs/sidebar/nav）入 localStorage（恢复时校验 sessionId 仍存在，失效降级为草稿 tab）；会话消息本体不进 tab store，仍归 conversation-store / DB。
- **派生态**：`running`（会话有 in-flight prompt 或 run）、`mountedSessionIds`（两组 active 的会话集合）为 selector，不入持久化。

## 4. Session ↔ Tab 绑定规则（本 plan 核心）

原则一句话：**tab 是会话的视口，不是会话的生命周期**。会话与其 agent run、SSE 流的生命周期归 Agent Server / DB；tab 只决定「谁被看见」。此设计后**所有 tab 与会话界面都是平等关系**——没有全局唯一 active 会话，以下 10 条是全部任务的验收依据。

1. **唯一绑定**：`kind==='session'` 的 `tab.sessionId` 是绑定唯一真相；一个 sessionId 至多一个 tab（open 已存在 → 激活既有 tab，不新建）。反向同样成立：一个 tab 至多绑定一个 sessionId，绑定后不改绑（唯一例外是 §4.6 认领）。
2. **平等 mounted 策略**：`mounted(tab)` = 该 tab 是**任意组**的 active。两组各激活一个会话 = 两个会话同时 mounted、同时渲染、同时接收事件。`activeThreadId` 不再是全局状态，降级为「focus 组的 active 会话」的**派生 getter**（过渡期保留，见 Phase 3）。
3. **流按 sessionId 寻址**：`stream-session-manager` 本就 per-session listeners，SSE 路由不感知视图；但所有 `sessionId === activeThreadId` 式的消费点必须改为 `isMounted(sessionId)`（审计清单见 Phase 0）。
4. **LRU 豁免升级**：`streamMemoryPolicy.evictExcessSessions` 的豁免集合从 `{activeThreadId}` 改为 `mountedSessionIds`（两组 = 2 个豁免）。会话切走但 tab 仍 open（非 active）→ 允许瘦身/逐出，重激活走既有 live-state replay（plan 447 mid-run refresh parity）。**注意**：renderer 记忆三层修复（ad031b18）的「切会话逐出」假设单 active，Phase 3 必改，否则第二组的会话消息会被逐出。
5. **打开语义**：`openSession(sid)` → 有 tab 激活之；无 tab → 新建 tab 绑定 + commitNav。**后台会话**（wake / bot / routine）收到消息且无 tab → 侧栏行 badge，不自动开 tab（打扰最小化；后续可加自动弹出开关）。
6. **新对话认领（rebind）**：未命名草稿 tab（`sessionId=null`）发出第一条消息 → `createThread` 成功后 `tab.sessionId=sid`、`title=首条消息截断`、登记 dedupe map；此窗口期它是唯一允许无绑定的 tab。NewChatView 的草稿/视图残留逻辑（已知 enterSettings 漏清 isNewChatDrafting、丢 mode 两个 bug）随该路径一并消化。
7. **关闭语义**：关闭会话 tab ≠ 停止会话。in-flight run 继续（Agent Server 生命周期不变），侧栏该会话保留 running 徽标；再打开 = 重放 live-state。只有「无 tab + 用户在侧栏显式删除」才走 archive/delete 管线。
8. **卡片投递按会话作用域**：AskUserQuestion、permission card、auth elicitation 等按 sessionId 投递到其视图；mounted 即渲染——**两组可同时各有一张待审批卡，互不抢占**。全局性 escalation（如 approval center）只允许出现在 focus 组。
9. **会话内 UI 状态跟随 tab**：输入草稿、滚动位置、面板展开态等 per-session UI 态存 `session-ui-state` map（key=sessionId），切 tab / 关 tab 保留，仅在会话被删除时清空。
10. **bot 会话 = 普通会话**：`bot:<agentId>` 会话同样开 session tab；侧栏 Bots 分区只是另一个入口列表（数据来自 bot-contacts store），绑定规则与 1–9 完全一致，无任何特例。

## 5. View Registry 泛化

`PageDescriptor` → `ViewDescriptor`：`{ kind, title(动态 resolver), icon, component(lazy), singletonKey(params), shortcut?, eventHandlers? }`。现有 `PageId` 全部平移，新增 `home`（项目列表）、`project`（详情，param=projectId）、`session`。PanelZone 的 launcher 与加页菜单逻辑移入 tab bar `+` 菜单与 rail。

## 6. Phases

### Phase 0 — 审计与详设（0.5d）
- [ ] 单一 active 假设审计：`grep activeThreadId / currentView / setActiveThread / setCurrentView` 全消费点清单（预期：conversation-store、app-sidebar、ChatView、MessageList、MessageInput、usePanel、SearchCommandPalette、TitleBar、TaskDrawerToggle）
- [ ] SSE 消费点 `sessionId===active` 式判断清单（stream-session-manager + 组件层）
- [ ] 快捷键冲突表（Ctrl+\` / Ctrl+T / Ctrl+Shift+G / Ctrl+P / Ctrl+Alt+S ↔ 新 Ctrl+B / Ctrl+F）
- [ ] 本 plan §4 逐条对照现有实现，标注 keep/remap/retire
- **Gate**：清单落在本文件附录，逐条有三态标注

### Phase 1 — TabShellStore（1.5d）
- [ ] `tab-shell-store.ts`：groups/tabs/nav/sidebar + `openSession/openView/openProject/openBot/openTab/closeTab/activateTab/moveTab/splitTab/commitNav/goBack/goForward`
- [ ] 不变式：sessionId↔tab 唯一绑定；关闭激活邻位（右优先）；组空即删组；至少一组；nav 跳过已关 tab；singletonKey 复用
- [ ] 持久化 + 恢复校验（sessionId 失效 → 草稿 tab；组数量收敛 1..2）
- **Gate**：vitest 不变式 ≥20 case；`typecheck:web` 绿

### Phase 2 — 骨架 UI（2d）
- [ ] `TitleBar.tsx` 扩展：back/forward/sidebar-toggle + 既有拖拽区/window controls 对接（Electron app-region 语义保留）
- [ ] `ActivityRail`（duya 图标/搜索/新建菜单/画布/自动化/工作流/项目/Bots/主题/扩展/设置）+ `SidebarCard`（会话与 Bots 分区、搜索、收起）
- [ ] `ViewGroup` + `TabBar`（激活/关闭/running 点/+菜单/split 按钮/DnD 排序、跨组、屏幕左右缘拆分）+ 组分隔条（复用 `ResizeHandle`）
- [ ] App shell 重排：titlebar / body(rail + card(sidebar + groups))；圆角卡片主题令牌
- **Gate**：对照原型逐项手工走查（electron:dev）；`typecheck:web` 绿

### Phase 3 — 会话视图接入与平等化（2.5d，核心）
- [ ] `session` ViewDescriptor：ChatView / MessageList / MessageInput 以 `sessionId` prop 挂载，移除对全局 active 的直接依赖
- [ ] conversation-store 兼容层：`activeThreadId` → 派生 getter（focus 组 active 会话），写路径双写过渡，标注迁移点
- [ ] `streamMemoryPolicy` 豁免集合升级为 `mountedSessionIds`；Phase 0 清单中的消费点逐条 `isMounted` 化
- [ ] 新对话认领（rebind）落地；NewChatView 退役
- [ ] 权限/提问/auth 卡片按 sessionId 投递到视图；两组同时各挂一张卡的形态验证
- [ ] per-session UI state map（草稿/滚动/展开态）
- [ ] 背景会话 badge（wake/bot/routine 到达、无 tab → 侧栏标记）
- **Gate**：双组各挂一个流式会话同时跑的组件测试（mock SSE 用 emit 直驱 + fresh 实例，遵循现有测试约定）；Phase 0 清单逐条复核归零

### Phase 4 — 其余视图平移（2d）
- [ ] PageId→ViewKind 平移：files / terminal / browser / review / workflow / conductor / session-messages / office / bot-settings / room-settings（lazy 边界保留，plan 426 chunk 策略不变）
- [ ] 事件入口改投：`duya:open-workflow-node-panel` / `duya:open-office-panel` / `duya-file` → `openTab(kind, params)`
- [ ] `home` 项目列表（ProjectsView 瘦身：标题 + 搜索 + 新建项目 + 项目行 + hover「新对话」）+ `project` 详情（useProjectsStore + threads 按路径归组 + workflow runs 摘要 + 当前打开过滤）
- [ ] Bots 分区接 bot-contacts store；bot 会话开 tab（§4.10）
- [ ] SearchCommandPalette / app-sidebar 的 `setCurrentView` 调用点 remap；快捷键 remap
- **Gate**：每个 kind 一条 open→activate→close 冒烟记录；i18n（en/zh）key 补齐

### Phase 5 — 退役与清理（1d）
- [ ] PanelZone / usePanel / PanelHeader / 旧 sidebar 布局退役（ResizeHandle 保留）
- [ ] conversation-store `currentView/previousView` shim 收口：外部调用点归零后删除
- [ ] globals.css 相应布局段清理；ARCHITECTURE.md 更新（App Shell 一节）
- **Gate**：grep 无退役符号残留；`typecheck:all` 绿（若涉 electron/ 手动 `npx tsc -p electron/tsconfig.json`）

### Phase 6 — 打包与冒烟（1d）
- [ ] `npm run electron:build`；打包产物检查（无新增资源路径，预期无变化）
- [ ] 手工冒烟清单：双组双会话同时流式 / 关闭运行中会话 tab 后重开 replay / 权限卡双组同时出现 / wake 后台 badge / 项目两层 / bot 会话打开 / 快捷键全表 / 持久化恢复（重启还原布局）
- **Gate**：清单全过、console 无 error

## 7. 风险与雷区

- **renderer 记忆三层修复（ad031b18）的「切会话逐出」假设单 active** —— Phase 3 必改点，否则第二组会话的消息会被 LRU 逐出白屏。
- mock SSE 测试必须 emit 直驱 + fresh 实例（现有约定，见 stream-session-manager 相关 spec）。
- tab 形状持久化不进 IPC 持久载荷，metadata whitelist 不涉及。
- worktree 开发：junction 全套 `node_modules`；Windows 下严禁 `rm -rf` worktree（用 `scripts/remove-worktree.sh`）。
- 两列布局下 MessageList 宽度变窄：消息气泡/composer 已是弹性布局，Phase 2 走查时确认 480px 组宽下不破。

## 8. 验证策略

- **vitest**：tab-shell-store 不变式（≥20 case）+ TabBar/ViewGroup 组件测试 + 双会话双挂载组件测试。
- **typecheck**：`typecheck:web`（每 Phase gate）、`typecheck:all`（提交前）。
- **手工冒烟**：Phase 6 清单；Electron 不走 Playwright（环境限制），用 electron:dev 人工走查 + 截图归档到本文件。
