# Worktree 根目录配置、自动清理与独立设置页

状态：active · 负责人：本会话（codex/worktree-settings） · 更新：2026-11-03
分支：`codex/worktree-settings` · worktree：`E:\Projects\duya\.claude\worktrees\worktree-settings` · base：`origin/master` `bae0896e` · owner：本会话

## 目标与边界

用户可在 Desktop 的独立 **Worktrees** 设置页配置托管 checkout 的根目录、自动清理开关与保留数量，并可立即执行一次清理。配置写入 `~/.duya/config.toml` 的 `[desktop]` 表，与 codex 的键名一致；Host 在创建 checkout 时读取同一份配置，因此 Desktop / TUI / Web / worker 全部生效。

改动只落在 Host 的 workspace 路径/清理逻辑、agent-protocol 的 checkout 契约、Desktop 的 config schema/store 与 IPC、shared UI 的设置页与 i18n。不改 git worktree 的身份模型（owner 文件 + `duya-checkout.json`），不迁移既有 checkout，不引入数据库表。

关联：[621 工作区生命周期](621-coding-workspace-lifecycle-harness.md)、[496 worktree 框架](496-worktree-framework-implementation.md)。

## 范围

| In | 说明 |
| --- | --- |
| `[desktop] git-worktree-root` | 绝对路径；空/缺省 = `<checkout data root>/worktrees`。只影响新建 checkout |
| `[desktop] worktree-auto-cleanup-enabled` | 默认 `false`（用户裁定，与 codex 默认 `true` 有意不同） |
| `[desktop] worktree-keep-count` | 默认 `15`；正整数；按 source repo 保留最新 N 个 |
| 标记发现 | `list()` 与恢复不再只认“当前 managed root 的父目录”，改用 origin/owner 标记 |
| `createdAt` | `duya-checkout.json` 增加可选字段，供清理排序；旧文件仍合法 |
| 自动清理 | 创建成功后、开关开启时执行；best-effort，不阻断创建 |
| 手动清理 | `POST /v1/checkouts/cleanup` + IPC；设置页 Two-step 确认后执行 |
| Worktrees 设置页 | 根目录草稿/保存/恢复默认 + 自动清理开关 + 保留数 + Clean up now |

| Out | 理由 |
| --- | --- |
| 迁移旧 checkout 到新根目录 | 用户选择“按标记发现”；迁移会移动用户正在使用的工作树并打断 `git worktree list` |
| 改用 codex 的 4-hex bucket 布局 | 现有布局是多仓库共享一个根目录；换布局会孤立已发布版本创建的目录（`paths.ts:5-13` 原有决定） |
| 删除未注册/未标记的用户自建 worktree | 清理只走 `reclaim()` 的 fail-closed 判定，身份不成立即拒绝 |
| 单独的 worktree 数据库表/注册表 | 身份权威是 git 注册 + checkout 内的 owner/origin 文件（621 D2） |
| TUI/Web 的清理设置 UI | 配置本身由 Host 读取，全端生效；本次只新增 Desktop 设置页 |
| 按项目维度展示/清理 | 需要项目↔仓库解析；本次用“本次配置根 + 默认根 + 会话工作目录反推的仓库”覆盖 |

## 已核对的现状（base `bae0896e`）

| 断言 | 证据 |
| --- | --- |
| 根目录布局固定为 `<data root>/worktrees/<repoName>-<sha12>/<slug>-<hex6>` | `packages/host/src/workspace/paths.ts:47`、`:54` |
| 布局选择是刻意保留 duya 历史路径，避免孤立既有 worktree | `packages/host/src/workspace/paths.ts:5-13` |
| `list()` 只接受“父目录 == 当前 managed root”的条目 | `packages/host/src/workspace/checkout-provider.ts:249-256` |
| 创建入口只有 `GitCheckoutProvider.create()`，Desktop/TUI/子代理共用 | `packages/host/src/workspace/checkout-provider.ts:73`、`worker-subagents/worktree.ts:92` |
| `duya-checkout.json` 目前为 `{version:1, baseSha, operationId?}` | `packages/host/src/workspace/checkout-origin.ts:8-44` |
| owner 文件是 `codex-thread.json`，是托管 checkout 的权威身份 | `packages/host/src/workspace/checkout-metadata.ts`（`OWNER_FILENAME`） |
| 删除唯一入口是 fail-closed 的 `reclaimCheckout()`，拒绝矩阵见 621 D8 | `packages/host/src/workspace/worktree-removal.ts:99-183` |
| Host 已有 checkout 观察/列表/回收契约，但 `listCheckouts` 未暴露为 HTTP 路由 | `packages/agent-protocol/src/checkout-api.ts:153-175`、`packages/host/src/http-server.ts:3487-3530` |
| 两套 Host（headless 与 Desktop 内嵌）共用同一 checkout 组装入口 | `packages/host/src/workspace-lifecycle-api.ts:67-100`、`apps/desktop/src/main/cli/desktop-host-api.ts:732` |
| Desktop `DuyaConfig` 无 `[desktop]` 表；`mergeConfig` 会保留磁盘上的未知键 | `apps/desktop/src/main/config/schema.ts:331`、`:547` |
| 配置端口按 `FLAT_TO_PATH` 把扁平键映射到点路径 | `apps/desktop/src/main/config/store.ts:113` |
| 设置页由 `SettingsTab` 联合、`settingsNavGroups`、`SettingsView` 三处共同定义 | `packages/ui/src/stores/conversation-store.ts:113`、`packages/ui/src/components/layout/app-sidebar.tsx:120`、`packages/ui/src/components/settings/SettingsView.tsx:30` |
| 侧栏 badge 只对路径含 `worktrees` 段的会话提问，自定义根会漏问 | `packages/ui/src/hooks/useSessionWorktreeBadges.ts:101` |
| 现有 Electron 桥只暴露 observe / reclaim，无清理与 list | `apps/desktop/src/contracts/workspace-lifecycle.ts:33`、`apps/desktop/src/preload/index.ts:2680` |
| codex 键名与校验规则（绝对路径、正整数、默认 15） | `E:\cloned-projects\codex\codex-rs\worktree\src\settings.rs:12-90` |

## 设计决策

**D1 · 配置读取位置：`resolveCheckoutDataRoot()/config.toml`，每次使用时读取。**
理由：Desktop 的 ConfigStore 与 Host 的 `resolveConfigRoot()` 在正常安装下都指向 `~/.duya`；而 Host 测试普遍用 `DUYA_APP_DATA_PATH` 隔离 checkout 存储（见 `packages/host/tests/checkout-identity.test.ts:92`），只有跟随同一根目录，测试才不会读到开发机真实配置。不新增缓存或 IPC，避免出现第二份配置快照；文件只有几 KB。
非法值处理：根目录不是绝对路径 → 回退默认并 `warn`；开关不是布尔、保留数不是 1..1000 的整数 → 回退默认。配置错误不阻断 checkout 创建（创建失败会让整个会话无法工作），但设置页在写入前自行校验并显示错误。

**D2 · 自定义根下仍保留 duya 布局 `<root>/<repoName>-<sha12>/<slug>-<hex6>`。**
理由：根目录可能同时承载多个仓库；直接用 codex 的 `<root>/<4hex>/<repoName>` 会引入第二套布局，且需要迁移。仓库哈希段继续避免同名仓库冲突。

**D3 · 托管身份 = 已注册 linked worktree + 任一标记（当前/默认 managed root 父目录、`duya-checkout.json`、`codex-thread.json`）。**
理由：用户选择“按标记发现”。根目录改变后，旧 checkout 不在新根下，但仍能被 `list()`、恢复和诊断识别。owner 文件不可读也算“标记存在”（列表是观察，不是授权；授权仍由 `assertWritable`/`reclaim` 判定）。父目录判定保留，用于识别早期无标记的遗留 checkout。

**D4 · `duya-checkout.json` 增加可选 `createdAt`，`version` 保持 1。**
理由：清理需要稳定排序，目录 mtime 会被检出/编辑刷新。旧文件没有该字段仍合法，排序回退到 checkout 目录 mtime。`createdAt` 只用于排序，绝不参与“能否删除”的判定。

**D5 · 清理语义：按 source repo 分组，按 `createdAt` 降序保留最新 `keepCount` 个，其余逐个走 `reclaim()`。**
`reclaim()` 已覆盖未注册、锁、owner 存活、cwd 占用、dirty/untracked/ignored、detached 无引用、reparse point；清理不新增删除路径，不调用 `--force`。新建的那个 checkout 通过 `protectRoots` 显式排除，避免 `keepCount=1` 时被同一次清理误删。单个 checkout 抛错只记入 `failed`，不中断其他。

**D6 · 自动清理默认关闭，且只在创建成功后执行。**
用户裁定，与 codex 默认 `true` 不同。执行时 `await`，但异常只走 `warn` 端口，绝不让创建失败。关闭时除一次配置读取外零额外 git 调用。

**D7 · 清单一律经 Host API，不在 Desktop 重算。**
`POST /v1/checkouts/cleanup` 由现有 `checkoutApi` 承载；Desktop 主进程只做参数边界校验并转发，UI 只渲染 Host 的结果。这样 owner 存活/cwd 占用仍用 Host 的 `runs`/`sessions` 事实（与 `workspace-lifecycle-api.ts:75-100` 同一套组装），不会出现 Desktop 与 headless Host 判定不同的情况。

**D8 · 全量清理的仓库来源：会话工作目录反推 + 配置根/默认根扫描。**
显式传入 `sourceCwd` 时只清理该仓库。未传入时：Host 用 `sessions.list()` 的工作目录跑 `git rev-parse --show-toplevel` 去重，再加上 `discoverManagedRepos()` 扫描当前配置根与默认根的 repo-key 子目录；随后对每个仓库调用 `list(sourceRoot)`（标记发现），因此曾配置过、现已换掉的根目录里的 checkout 也能通过其所在仓库被找到。已知限制：一个仅存在于“第三个历史根”、且没有任何会话记录/当前根扫描不到的 checkout 不会被全局清理发现；`list(sourceCwd)` 与恢复仍可见。

**D9 · 根目录变更立即生效，无需重启，不迁移旧 checkout。**
Host 每次创建时读取配置；设置页文案明确“只影响新建 worktree，已有 worktree 保持原位置并继续受管理”。

## 契约

### `config.toml`

```toml
[desktop]
git-worktree-root = "D:/duya-worktrees"
worktree-auto-cleanup-enabled = false
worktree-keep-count = 15
```

| TOML 键 | 类型 | 缺省 | 校验 |
| --- | --- | --- | --- |
| `desktop.git-worktree-root` | string | `""` → 默认根 | 空或绝对路径；相对路径忽略并告警 |
| `desktop.worktree-auto-cleanup-enabled` | bool | `false` | 非布尔回退 `false` |
| `desktop.worktree-keep-count` | int | `15` | `1 <= n <= 1000` |

Desktop 扁平键（`FLAT_TO_PATH`）：`worktreeRoot`、`worktreeAutoCleanupEnabled`、`worktreeKeepCount`。

### Host 设置读取（`packages/host/src/workspace/settings.ts`）

```ts
export interface WorktreeSettings {
  readonly root: string | null;          // absolute; null = default root
  readonly autoCleanupEnabled: boolean;
  readonly keepCount: number;
  readonly problems: readonly string[];  // invalid values that fell back
}
export function readWorktreeSettings(): WorktreeSettings;
```

### 协议增量（`packages/agent-protocol/src/checkout-api.ts`）

```ts
export interface HostWorktreeCleanupInput {
  readonly sourceCwd?: string;
  readonly dryRun?: boolean;
}
export interface HostWorktreeCleanupResult {
  readonly dryRun: boolean;
  readonly keepCount: number;
  readonly examined: number;
  readonly removed: readonly string[];
  readonly retained: readonly { readonly root: string; readonly reason: HostCheckoutRetainReason }[];
  readonly failed: readonly { readonly root: string; readonly message: string }[];
}

export interface HostCheckoutApiV1 {
  // ...existing methods
  cleanupWorktrees(input?: HostWorktreeCleanupInput): Promise<HostWorktreeCleanupResult>;
}
```

### HTTP

| 方法 | 路径 | Body | 响应 |
| --- | --- | --- | --- |
| POST | `/v1/checkouts/cleanup` | `{ sourceCwd?, dryRun? }` | `200 { result: HostWorktreeCleanupResult }`；400 `invalid_checkout_query`；404 `checkout_api_unavailable` |

### IPC

`workspace-lifecycle:checkout:cleanup` → `window.electronAPI.workspaceLifecycle.checkouts.cleanup(input)` → `getDesktopHostWorkspaceLifecycleApi().cleanupWorktrees(input)`。

## UI 规格

导航：`settingsNavGroups` 的 `application` 组新增 `{ id: 'worktrees', labelKey: 'settings.worktrees', icon: FolderIcon }`（位于 appearance 之后）；`SettingsTab` 增加 `'worktrees'`；`SettingsView` 渲染 `<WorktreesSection />`。

页面（复用 `SettingsSection / SettingsCard / SettingsRow / SettingsToggle / SettingsInput / Button`）：

1. **Location**：输入框显示草稿值；Browse 调 `window.electronAPI.dialog.openFolder` 写入草稿；Save 只在“绝对路径或空”时提交到 `worktreeRoot`；Reset 提交空串。输入框旁显示解析后的默认位置文案 `~/.duya/worktrees`。空值 = 默认。保存后提示“仅对新建 worktree 生效；已有 worktree 仍在原位置并继续受管理”。
2. **Automatic cleanup**：toggle → `worktreeAutoCleanupEnabled`；保留数 `SettingsInput type=number` → `worktreeKeepCount`，失焦/回车时校验 1..1000 并提交；说明“每次新建 worktree 后，删除超出保留数的、可安全删除的托管 worktree”。
3. **Clean up now**：按钮两步（`Clean up now` → `Confirm cleanup`，5 秒后自动复位）。确认后调用 `cleanup({ dryRun: false })`，渲染 `removed / retained(reason) / failed` 计数与逐条路径；refusal 显示为正常结果而不是错误。
4. 无 Electron 配置端口（Web）时：控件禁用，显示只读提示；不伪造成已保存。

i18n：`packages/ui/src/i18n/en.ts` 与 `zh.ts` 同步新增 `settings.worktrees*`、`settings.group.application` 不变。

## Phases

- [x] **P1 · Host 设置与根目录**
  - 新增 `packages/host/src/workspace/settings.ts`（默认值、校验、`problems`）。
  - `paths.ts`：`managedRootFor(sourceRoot, settings?)` 使用配置根；`isManagedCheckoutPath()` 同时识别配置根与默认根；导出 `defaultManagedRootFor()`。
  - `checkout-provider.ts`：`create()` 读取设置、`warn` 端口输出 `problems`；`list()` 改用标记发现。
  - `checkout-origin.ts`：写入/读取可选 `createdAt`；新增 `hasCheckoutIdentity(gitDir)`（只 stat，不解析）。
  - 门禁：`npx vitest run packages/host/tests/workspace/checkout-provider.test.ts packages/host/tests/checkout-identity.test.ts`

- [x] **P2 · 清理实现**
  - 新增 `packages/host/src/workspace/cleanup.ts`：`runWorktreeCleanup(port, options)`、`discoverManagedRepos(settings)`；`CheckoutProvider` 增加 `cleanup()` 与 `discoverManagedRepos()`；`types.ts` 增加结果类型。
  - `create()` 成功后：开关开启时调用清理（`sourceCwd=sourceRoot`、`protectRoots=[newRoot]`），异常只 `warn`。
  - 门禁：`npx vitest run packages/host/tests/workspace/worktree-removal.test.ts packages/host/tests/workspace/subagent-checkout-cleanup.test.ts`

- [x] **P3 · 协议 / HTTP / Desktop 桥**
  - `packages/agent-protocol/src/checkout-api.ts` 增加清理输入/结果与方法。
  - `checkout-api.ts`：`cleanupWorktrees`（校验 `sourceCwd`/`dryRun`；无 port/无 cleanup 时抛 `checkout_observation_unavailable`）。
  - `workspace-lifecycle-api.ts`：把 `sessions.list()` 反推的仓库回调传给 `createHostCheckoutApi`。
  - `http-server.ts` 增加 `POST /v1/checkouts/cleanup`；`http-client.ts` 增加 `cleanupWorktrees()`；`desktop-host-api.ts` 接口与实现转发。
  - `apps/desktop/src/main/ipc/workspace-lifecycle-handlers.ts`、`preload/index.ts`、`contracts/workspace-lifecycle.ts` 增加 `cleanup`。
  - 门禁：`npx vitest run packages/host/tests/checkout-api.test.ts packages/host/tests/checkout-integration-http.test.ts apps/desktop/src/main/__tests__/preload-workspace-lifecycle-bridge.test.ts`

- [x] **P4 · Desktop 配置**
  - `schema.ts`：`DesktopConfig` 接口 + `DuyaConfig.desktop` + `DEFAULT_CONFIG.desktop`。
  - `store.ts`：`FLAT_TO_PATH` 增加三个扁平键。
  - `packages/ui/src/hooks/useSessionWorktreeBadges.ts`：启发式增加“配置根前缀”判定（订阅 `worktreeRoot`，首次 `getConfig('worktreeRoot')`）。
  - 门禁：`npx vitest run apps/desktop/src/main/config/__tests__/store.test.ts apps/desktop/src/main/config/__tests__/store-port.test.ts`

- [x] **P5 · Worktrees 设置页**
  - 新增 `packages/ui/src/components/settings/WorktreesSection.tsx`；从 `components/settings/index.ts` 导出。
  - `SettingsTab`、`settingsNavGroups`、`SettingsView` 接线；`workspace-lifecycle-ipc.ts` 增加 `cleanupCheckouts()`；i18n en/zh。
  - 门禁：`npx vitest run packages/ui/src/components/settings`（新增组件测试）+ 真机 Playwright 走查。

- [x] **P6 · 门禁与验收**
  - `npm run typecheck:all`
  - `npm run architecture:check`
  - 相关 host/desktop/ui 测试（记录基线失败）
  - 若触及打包/懒加载边界：`npm run electron:build`

## Verification

1. **根目录生效**：在临时 `config.toml` 写入绝对 `git-worktree-root`，创建 checkout 后 `git worktree list` 的路径位于该根下，且形如 `<root>/<repo>-<12hex>/<slug>-<6hex>`。存在理由：这是用户可见的主能力。
2. **非法配置不阻断创建**：相对路径 / 非布尔 / `0` / `1.5` 时创建仍成功、落在默认根，并发出 warn（用注入的 `warn` 端口断言）。
3. **旧路径仍被发现**：先创建 checkout，再把配置根改到另一目录；`list(sourceCwd)`、`observe`/恢复仍返回旧 checkout（标记发现）。存在理由：用户选择的“按标记发现”。
4. **保留数**：为同一仓库创建 `N+2` 个干净、已释放 owner 的 checkout；`keepCount=N` 清理后最新 N 个存在、其余被删；`dryRun` 不删除任何目录。
5. **fail-closed**：dirty/untracked/ignored/owner 存活/locked/detached 无引用/含 junction 的 checkout 在清理后仍在，原因逐条匹配。
6. **保护新 checkout**：`keepCount=1` + 自动清理开启，创建后新 checkout 必须存在。
7. **自动清理默认关闭**：不写配置时，创建后不删除任何旧 checkout，也不产生 reclaim 调用。
8. **设置页写入**：通过 config port 设置三个扁平键后，磁盘 `config.toml` 出现 `[desktop]` 与对应键；重启 ConfigStore 后值保留。
9. **仅新建生效**：改根目录后，已有 checkout 的路径不变、仍出现在 `list()`；下一次创建落在新根。
10. **UI 清理结果**：Clean up now 对可删项显示 removed 计数，对拒绝项显示 reason，不把 refusal 渲染为错误；控件在无配置端口时禁用。

## 风险与限制

| 风险 | 处理 |
| --- | --- |
| 读取配置是同步 IO，出现在 `create()`/`list()` 热路径 | 文件小；每次调用一次 `readFileSync`。若后续出现性能证据再按 mtime 缓存 |
| `DUYA_APP_DATA_PATH` 与 Desktop 真实配置根可能分叉 | 以 `resolveCheckoutDataRoot()` 为准，和现有测试隔离一致；在模块注释写明 |
| 自定义根位于网络盘/受限目录 | 由 `git worktree add` 报错并回滚；不额外吞错 |
| 全量清理漏掉“只在第三个历史根、无会话记录”的 checkout | 已写入 D8 限制；`list(sourceCwd)` 与恢复不受影响 |
| 自动清理在子代理 provider（默认 `isSessionAlive=true`）下只清无主 checkout | 安全侧退化，不会误删有主 checkout |
| 设置页依赖配置端口，Web 无端口 | 禁用 + 只读提示，不伪造成功 |
| 清理是真实删除 | 仅走 `reclaim()` 的 fail-closed 判定；UI 两步确认；`protectRoots` 排除新建项 |

## 待裁定

无。默认关闭与标记发现已由用户确认。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `bae0896e` + 39 dirty（30 M / 9 ??） | Windows 11 / Node 24.18.0 | `npx vitest run`（WorktreesSection、store-port、worktree-cleanup、worktree-settings、checkout-root-config） | 0 · 5 files / 40 tests passed | 覆盖 V2/V3/V4/V5/V6/V7/V8/V9 |
| 同上 | 同上 | `npx vitest run packages/ui/src/components/settings` | 0 · 11 files / 80 tests passed | 设置页无回归 |
| 同上 | 同上 | `npx vitest run packages/host/tests/workspace packages/host/tests/checkout-identity.test.ts` | 0 · 135 passed / 5 skipped；加新增用例共 144 passed | checkout 身份与清理既有面 |
| 同上 | 同上 | `npm run build:packages` | 0 · 22 packages | 先对 `packages/agent-protocol` 执行 `npx tsc -b --force`（旧 dist 缺清理类型） |
| 同上 | 同上 | `npm run typecheck:all` | 0 · 无 TS 错误 | 首次运行 exit 3221225477（环境崩溃），重跑通过 |
| 同上 | 同上 | `npm run architecture:check` | 0 · OK，tolerated 3068，无新增违规 | 修复 `paths.ts ↔ settings.ts` 环：抽出 `workspace/data-root.ts` |
| 同上 | 同上 | Playwright 走查（throwaway Vite entry + 系统 Chrome，900×900，DSF 2） | 6 张截图：light/dark × default/invalid/cleanup；无横向溢出；像素 light `255/247`、dark `30/43`；配置写入精确为 `worktreeRoot=D:/checkouts`、`worktreeAutoCleanupEnabled=false`、`worktreeKeepCount=20`；cleanup 入参 `{dryRun:false}` 且仅 1 次 | 截图 `%TEMP%/wt-shots`；harness 已删除 |

## 接续 / 结果

下一步：无（P1–P6 完成）。提交与 PR 未执行，等待用户授权；`docs/exec-plans/` 在 `.gitignore`，提交本计划需 `git add -f`。
回收：未回收；分支 `worktree-settings`，worktree 保留。

已知限制（明确未验）：
- 真机走查用 throwaway Vite 渲染真实组件 + 配置端口 stub，未在 Electron 内点击真实配置总线与 IPC/worker 链路；该链路由 `store-port` 与 Host 测试覆盖，但仍建议集成前在 Electron 里点一次。
- 视觉走查发现共享原语 `SettingsInput` 的 `bg-black/30` 在 light 主题下呈中灰输入框；这是既有样式（Bridge/General 等页面同款），未在本次改动中修改。
