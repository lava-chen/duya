# 487 — Host 持久工具权限开关（Global Standing Permission）

> **Status**: Planning · **Priority**: P1 · **Owner**: TBD
> **Created**: 2026-09-02
> **参考源码**：grok-bot `source/host/extensions/local-tool-permission/extension.ts`（三态 ask/always/never 全局开关）+ `local-tool-permission-controller.ts`（状态机 + directionEpoch + refused-action 记忆）+ `local-tool-permission-resolution.ts`（4 选 1 ask 决策 + boot sweep）；duya `electron/db/queries/settings.ts` + `electron/ipc/settings-handlers.ts` + `packages/agent/src/permissions/permissions.ts` + plan 419（权限决策总线）
> **非目标**：本期不做 per-agent workflow enablement（grok 第二层）和 per-call approval card 改造（plan 419 P1 MCP 接入标准管线已涵盖）；本期只做 **host 级三层中的第一层** — 全局持久开关。

---

## 1. 为什么做 / 问题

duya 当前权限模型是 **per-session/per-call**（plan 419）：
- `ToolPermissionContext.mode ∈ {default | acceptEdits | bypassPermissions | dontAsk | plan | auto | bubble}` — 来自 `appState`，每个 session 一次设入
- UI 在 Settings 切 mode → 下次启动 session 生效
- 缺：**host 级持久开关** — "我短期内不想被打扰"（never）、"我在场，全部自动放"（always）这种**跨 session 持久意图**

grok 三层模型中第一层（host extension `localToolPermission`）就是为这个场景设计的；duya 用 SQLite `settings` KV 即可实现等价物。

| 用户场景 | 当前 duya | grok 三层对应 | 改造后 |
|---|---|---|---|
| "我不在电脑前，不要弹任何权限框" | 切 `bypassPermissions` mode（默认放所有）+ 担心安全 | `permissionState='never'` | 设全局 `localToolPermission='never'` |
| "我信任这台机器，全部自动放" | 同上 | `permissionState='always'` | 设全局 `localToolPermission='always'` |
| "临时想每次都问" | 留 `default` | `permissionState='ask'` | 默认 `'ask'` |

## 2. 设计：3 态持久开关 + 启动注入

### 2.1 Settings 持久化（KV，最小改动）

```ts
// electron/db/queries/settings.ts — 复用已有 getJsonSetting/setJsonSetting
const LOCAL_TOOL_PERMISSION_KEY = 'host.localToolPermission';
type LocalToolPermission = 'ask' | 'always' | 'never';

// default = 'ask'
```

- 持久化到 settings 表 `key='host.localToolPermission'`、value=JSON `"'ask'|'always'|'never'"`。
- 与 419 现存 `appState.toolPermissionContext.mode`（per-session）正交；本期不覆盖 session-level mode，只是新增 host-level 闸门。

### 2.2 闸门求值顺序（`packages/agent/src/permissions/permissions.ts`）

`canUseTool()` 主入口（419 已落地唯一决策点）按以下顺序求值：

```
1. CATASTROPHIC deny（419/471 已落地，永不绕过）
2. session.mode 已是 bypassPermissions/dontAsk → 继续当前行为（向后兼容）
3. session.mode 是 default/acceptEdits/plan/auto/bubble → 查 host 持久开关:
   ├─ 'never' → deny(HOST_PERMISSION_DENIED)    ← 新增
   ├─ 'always' → allow(HOST_PERMISSION_GRANTED)  ← 新增
   └─ 'ask'    → 走 419 既有管线（pre-check 弹窗 / rule match / classifier）
```

**关键设计**：
- 闸门只覆盖 session.mode 不是显式 `bypassPermissions/dontAsk` 的场景 — 用户已切 session.mode 时优先尊重（不抢用户显式意图）
- CATASTROPHIC 永不被任何 host 开关盖掉
- 加 `reason` 字段值 `'HOST_PERMISSION_GRANTED'` / `'HOST_PERMISSION_DENIED'` 进入 audit log，便于追溯"为什么这条命令没弹窗/没执行"

### 2.3 启动注入（electron main）

```ts
// electron/main.ts — 启动编排（plan 330 已规划下沉到 services/）
function loadHostToolPermission(): LocalToolPermission {
  return getJsonSetting<LocalToolPermission>(LOCAL_TOOL_PERMISSION_KEY, 'ask');
}

// 在 agent process spawn / reinit 时,作为 init payload 一部分注入
// 复用 plan 419 已有的 init 协议,不新加 IPC channel
```

**不新加 IPC channel**：用 plan 328/419 已有的 `agent:reinit-provider` 路径一并下发；新增字段 `hostToolPermission: 'ask' | 'always' | 'never'` 进 agent init payload。

### 2.4 Renderer 设置入口

`src/components/settings/` 新增子组件（参考现有 auto-start / wake / orb 卡片）：

- 卡片标题：`Local Tool Permission`（国际化 key：`settings.hostToolPermission.title`）
- 三态单选：`Ask every time`（默认）/ `Always allow` / `Never allow`
- 持久化通过 IPC `settings:set-host-tool-permission`
- **副作用按钮**：切换后立即调 `agent:reinit-provider`，不重启 app

### 2.5 与 grok 的差异（duya 简化点）

| grok 实现 | duya 简化 | 理由 |
|---|---|---|
| 35 extension 全套 + DAG 启动 | 不引入 host extension 框架 | duya 已稳定模块拓扑，引入收益小、风险高 |
| `directionEpoch`（agent process 复活防 stale grant） | **不做**（本期） | duya agent process 是真子进程，不是 capsule 恢复，epoch 暂不需要 |
| `refusedActions` LRU（同命令防重试） | **不做**（本期） | 419 + classifier 已有限频；精细化交给后续 plan |
| `outlivesScope` approval（attach 跨 tool call） | **不做** | per-call approval card 不在本期 |
| `widgetResponses.expireAllPendingLocalToolPermissionCards` boot sweep | **不做**（本期没有 per-call card） | 本期只做开关，无 card |
| 每 agent `enabled-workflows.json` | **不做**（grok 第二层） | 独立 plan 488（per-agent workflow enablement）后续 |

**结论**：本期是 grok 三层模型的 **最薄一层**，只做"host 级 ask/always/never 持久开关 + 启动注入"。其余两层留给 488（per-agent）和 plan 419 P1（per-call）。

## 3. 文件改动

| # | 文件 | 改动 |
|---|---|---|
| 1 | `packages/agent/src/permissions/types.ts` | 加 `LocalToolPermission = 'ask'\|'always'\|'never'` type + `HOST_PERMISSION_GRANTED/HOST_PERMISSION_DENIED` 决策 reason 常量 |
| 2 | `packages/agent/src/permissions/permissions.ts` | `canUseTool()` 入口加 §2.2 闸门逻辑（3 行） |
| 3 | `packages/agent/src/agent/DuyaAgent.ts` | init payload 加 `hostToolPermission` 字段 + 在 `ToolPermissionContext` 注入（与 mode 平行，不替换） |
| 4 | `electron/db/queries/settings.ts` | 加 `getHostToolPermission()` / `setHostToolPermission()` 两个薄封装（复用 getJsonSetting/setJsonSetting） |
| 5 | `electron/ipc/settings-handlers.ts` | 加 2 个 IPC：`settings:get-host-tool-permission` / `settings:set-host-tool-permission`（后者触发 `agent:reinit-provider`） |
| 6 | `electron/preload.ts` | 暴露 renderer API |
| 7 | `src/components/settings/HostToolPermissionCard.tsx`（新） | 三态单选卡 + i18n |
| 8 | `src/components/settings/index.ts` | 挂载新卡（按现有 auto-start / wake / orb 同位置） |
| 9 | `src/lib/settings-ipc.ts` | renderer client |
| 10 | `packages/agent/src/permissions/__tests__/permissions.test.ts` | 扩测试：3 态 × session.mode 矩阵（≥12 case）+ CATASTROPHIC 永不被 host 开关盖 |

**总改动** ≈ 10 文件，2 个新文件，1 个 settings KV key，0 个 migration，0 个新表。

## 4. 分阶段实施

### Phase 1 — Settings 后端 + 闸门核心
- [ ] **P1.1** types.ts `LocalToolPermission` type + decision reason 常量（无运行时副作用）
- [ ] **P1.2** settings.ts `getHostToolPermission`/`setHostToolPermission` 封装
- [ ] **P1.3** permissions.ts `canUseTool` 加 §2.2 闸门（4 行代码 + 决策 reason）
- [ ] **P1.4** DuyaAgent init payload 注入（不动 `appState.toolPermissionContext.mode`）
- [ ] **P1.5** permissions.test.ts 扩矩阵（12 case）

### Phase 2 — IPC + main 启动编排
- [ ] **P2.1** settings-handlers.ts 2 个 IPC + set 触发 `agent:reinit-provider`
- [ ] **P2.2** main.ts 启动时 `loadHostToolPermission()` 写入 init payload（与 419 已有的 `blockedDomains/sandboxEnabled/browserBackendMode` 并列）
- [ ] **P2.3** preload.ts + settings-ipc.ts 暴露

### Phase 3 — UI
- [ ] **P3.1** `HostToolPermissionCard.tsx` 三态单选 + i18n key（zh/en）
- [ ] **P3.2** 设置面板挂载（与 auto-start / wake / orb 同 group）
- [ ] **P3.3** Playwright MCP 验证：切 always → Bash 命令不再弹窗；切 never → 命令直接拒绝

### 验收
- [ ] 全部 case `npm run typecheck:all` 通过
- [ ] permissions.test.ts 12 case 全绿
- [ ] 手动 e2e：开 always → 跑危险命令无弹窗直接放；开 never → 跑任意命令被拒绝并显示原因 `HOST_PERMISSION_DENIED`
- [ ] settings 重启后保留（KV 持久化）
- [ ] 切换时无需重启 app（`agent:reinit-provider` 立即生效）

## 5. 风险

| 风险 | 应对 |
|---|---|
| 切 `always` 后用户忘记 → 危险命令被自动放 | UI 卡底部加 warning 文字"Always allow 模式：所有本地工具调用将自动通过审批，谨慎使用"；与 419 catastrophic 不冲突（catastrophic 永不被盖） |
| 与 session.mode 优先级混乱 | 文档化求值顺序：session 显式 `bypassPermissions/dontAsk` 优先于 host 开关；只有 session.mode 为 `default/acceptEdits/plan/auto/bubble` 时 host 开关生效 |
| 多 renderer 实例（settings 面板打开 + 主窗口）同时写 | 复用 419 既有 appState 通道；settings UI 在切前 disable 控件 1s 防双击 |
| 老版本 agent process 不认识 `hostToolPermission` 字段 | 字段 optional + DuyaAgent start 处容错（旧 process 退化为 session.mode 既有行为，不崩） |
| 与 plan 419 P1（per-call approval card）时间冲突 | 互不耦合：487 只改 canUseTool 入口前 3 行，419 P1 改 canUseTool 内部分支 |
| 与 488（per-agent workflow enablement）可能同期 | 488 是 grok 第二层，独立 plan；487 完成后再开 488 |

## 6. 决策日志

- **Decision H**（2026-09-02 新增 — 不引入 host extension 框架）：grok 把 host 模块拆成 35 个 `defineHostExtension()` 插件对象，通过 DAG 拓扑排序 + 依赖注入启动；duya 已稳定 35+ 模块拓扑，引入扩展框架收益小、风险大（重构可能破坏现有 import 拓扑）。**决定**：487 只复用 duya 既有 settings KV + 419 决策总线 + main.ts 启动编排，**不抄** grok 的 host extension 协议。这一决定记录在 `docs/design-docs/host-extension-pattern.md`（独立 memo）。
- **Decision H-2**（2026-09-02 新增 — 只做 host 层，不做 per-agent 层）：grok 三层中 host（全局）+ per-agent（disabled workflows）+ per-call（approval card）独立可叠加。本期只做 host 第一层；per-agent 留 488；per-call 已在 plan 419 P1。**决定**：三 plan 分立推进，避免一个 plan 改三处。