# Plan 584 — plugin 信任层接线：让已有的 trust 分层真正有牙齿

> 状态：**已完成**（2026-10-01）。P0 安全项。由
> [583 §7 Phase 4](./583-browser-capability-boundary.md) 的调研拆出，
> 独立成 plan 的原因是：**这个缺口与缝 C 做不做无关，且是缝 C 的硬前提**。
>
> **交付摘要**：六个 capability 字段中，只有一个（`meetsMinimumLevel`）存在
> 可接的执行点，已接线（Phase 1）。其余五个一个未接线、四个**没有执行点**，
> 如实标为 N/A 而非接假门（Phase 2）。同时**删掉**了一个读起来像执法、
> 实际零调用点的 `PermissionService`（Phase 3），并给 Phase 1 开的逃生口
> 补上审计痕迹（Phase 4）。过程中修掉两处真实缺陷：共享能力表被按引用交出，
> 以及 `builtin-directory` 被误判 `untrusted`（后者差一步就会禁用所有内置插件）。

## 0. 结论

`TrustEngine` 是一套设计完整但**从未被执行**的分层。plugin 安装后按来源算出
`trustLevel` 并持久化，也有 `TrustLevelCapability` 表规定每档能干什么——但表里的
每一项都没有任何代码去读。实际生效的唯一开关是 `enabled`。

今天**不存在**「这个 plugin 被信任运行代码」这个概念，只有「启用了没有」。

## 1. 缺口边界（实测，勿再凭印象扩大）

### 1.1 真的没接线

| 事实 | 证据 |
|---|---|
| `getCapabilities()` 全仓唯一调用点是**只读 IPC 查询** | `electron/ipc/plugin-handlers.ts:630`（`plugin:security:trust-info`） |
| `meetsMinimumLevel` 在 `electron/` 与 `packages/agent/src/` 下**零调用方** | 本人 grep 复核 |
| `trustLevel` 只被**写入** registry entry 与**展示**，从不参与任何决策 | 写入 `PluginManager.ts:495`；展示 `plugin-handlers.ts:532` |
| `autoUpdate` 是调用方裸参数，从不与 `capabilities.allowAutoUpdate` 比对 | `PluginManager.ts:330` / `:520` 是 `autoUpdate: boolean = false`，`:498` 直接落库 |
| `PermissionService` 是**纯内存 Map**，进程重启即丢 | `permission-service.ts:41` |
| `PermissionService.checkPermission` **零运行时调用方** | 同上 grep |
| 安装时无信任提示，`enabled: true` 无条件写入 | `PluginManager.ts:491` |
| plugin 声明的 `manifest.permissions` 被记录（`:482`）但从不校验 | 同上 |

### 1.2 **已经**有门控的部分（不要重复造）

- **MCP 调用时门控是真实存在的**：`decideMcpSource`（`permissions/permissions.ts:289`）
  对 `bundled` / `settings` 放行，对 `plugin` / `local` / `unknown` 一律 `ask`
  （永不自动批准）。它在两处生效：`hasPermissionsToUseTool`（`:357`）与 MCP executor
  内的 `apply.ts:502`。所以「plugin 提供的 MCP 能力会在用户不知情下静默执行」是**错的**。
- **企业 blocklist** 生效：`PluginManager.ts:345-353`。
- **`installPolicy: 'not_available'`** 生效：`PluginManager.ts:356-363`。

**因此本 plan 的缺口不在「执行时」，而在「安装/激活时」与「能力分层」。** 这比
583 初稿假设的窄，但也更明确：不需要重做调用时门控，只需要把分层接上去。

### 1.3 顺带发现的死引用

`permission-service.ts:6` 指向 `packages/agent/src/mcp/permission-gate.ts:evaluateMcpToolPermission`——
**该文件不存在**。`permissions.ts:353` 说明该函数已被折叠进 `decideMcpSource`。
这条注释会把下一个读代码的人带偏，先修。

## 2. 设计原则

1. **不新增第二套真相。** `PluginRegistryEntry.grantedPermissions`（`PluginManager.ts:501`）
   已经持久化了授权清单，`PermissionService` 的内存 Map 是重复的第二份。
   正确修法是让 `checkPermission` 读 registry entry，而不是给内存 Map 加持久化。
2. **失败方向要安全。** 拿不到 trust 信息时按 `Untrusted` 处理，不按 `Official`。
3. **只影响新装。** 已安装 plugin 的 `enabled` 已在库里，不追溯改写，避免
   「升级后用户的插件集体被禁用」这类事故。
4. **分层要可测。** 每条接线配一个「未接线时会红」的测试，否则下一个重构又会静默拆掉。

## 3. Phases

### Phase 0 — 让缺口可见 ✅ 已落地

- [x] 修 `permission-service.ts:6` 的死引用——原注释指向
      `packages/agent/src/mcp/permission-gate.ts:evaluateMcpToolPermission`，
      **该文件不存在**，函数已折叠进 `decideMcpSource`。
- [x] 给 `TrustEngine` 补契约测试：`packages/plugin-core/tests/trust-engine.test.ts`
      （18 用例）。覆盖来源→档位映射、marketplace 需具名才升 Verified、
      未知来源 fail-safe 到 Untrusted、分层单调性（`maxHooks` / `maxFileAccess`
      随信任上升不减）、`requirePermissionConfirmation` 非 Official 一律为真、
      `meetsMinimumLevel` 的全序关系。
- [x] **写测试时抓到一处真实缺陷并已修**：`getCapabilities()` 原本
      `return TRUST_LEVEL_CAPABILITIES[trust.level]`——把模块级表**按引用交出**。
      任何调用方改一下返回值就污染了全局策略。Phase 1/2 一旦开始拿它做安装决策，
      这就是活的隐患。已改为返回浅拷贝。
- [x] **同时更正我自己对能力表的误读**：`allowAutoUpdate` 并非只有 Official 为真，
      **Verified 也是 `true`**（`trust-engine.ts:38`）。语义是「marketplace 具名 =
      有人审过」，Local / Untrusted 才禁止自更新。测试已按实际表写。

#### capability 字段对账表

| 字段 | 现状 | 说明 |
|---|---|---|
| `requirePermissionConfirmation` | **未接线** | 表里有、无人读。Phase 1 明确**不**拿它做安装门控（语义不同） |
| `allowAutoUpdate` | **N/A：执行点不存在** | plugin 无任何 update/sync 机制，`autoUpdate` 存了但无人读。见 Phase 2 |
| `maxFileAccess` | **N/A：执行点不存在** | plugin 无文件访问执行路径，接线是假的 |
| `maxHooks` | **N/A：执行点不存在** | plugin 声明的 hook 从不执行（见 583 §7 Phase 4） |
| `allowHttpHooks` | **N/A：执行点不存在** | 同上 |
| `allowAgentHooks` | **N/A：执行点不存在** | 同上 |
| `meetsMinimumLevel()` | **已接线（Phase 1）** | 唯一有消费者的能力相关 API |

> **Phase 1 之后，六个 capability 字段里只有 `meetsMinimumLevel` 有消费者。**
> 其余五个要么未接线、要么根本没有执行点。这不是本 plan 没做完，
> 是**当前代码里不存在可接的地方**。给不存在的执行点接线，会造出一个看起来
> 在管事、实际不拦任何东西的字段——和 583 Phase 3 里 `permissions[].domains` 的
> 情况是同一类错误。若将来 plugin 真的开始执行 hook / 自动更新，这几行要重新评估。

> 「N/A」是**有意的标注**，不是漏做。给一个不存在的执行点接线，会造出一个看起来
> 在管事、实际不拦任何东西的字段——和 583 Phase 3 里 `permissions[].domains` 的
> 情况是同一类错误。若将来 plugin 真的开始执行 hook，这三行要重新评估。

### Phase 1 — T-1 安装时门控 ✅ 已落地

形态：**装上但默认不启用**（用户 2026-10-01 按 goal「怎么安全怎么来」授权推进，
非再次确认）。理由见 `electron/plugins/install-gate.ts` 头部注释。

- [x] 新增 `electron/plugins/install-gate.ts`：`decideInstallGate(trust)` 返回
      `{ enabled, reason, detail }`；只有 `Untrusted` 档 `enabled: false`。
- [x] `PluginManager.installFromCatalog` / `installFromPath` 两处 `:491` / `:572`
      的裸 `enabled: true` 改走门控，并对非默认决策记 `logger.warn`。
- [x] 新增 `initialHealthStatus(enabled, setupState)`，让「装上即禁用」与
      `setEnabled(false)` 的 health 语义一致（否则一个显示 `ready`、一个 `disabled`）。
- [x] `electron/plugins/install-gate.test.ts`（12 用例）：四档矩阵 + 5 个
      `PluginSource` 全部 enabled + health 三态。

**明确不按 `requirePermissionConfirmation` 门控。** 该字段语义是「使用时询问」；
拿它做安装门控会把**所有 marketplace 与所有 local 安装**一起禁用，那是 UX 回归
而非安全收益——用户在 catalog 点 Install 本身就是那几个档位的同意行为。
安装时要问的问题更窄：**这个来源我们认不认识。**

#### 落地前抓到的两件事

1. **tier 映射不完整，且差一步就会造成生产事故。** `PluginSource` 有 5 个值，
   `TrustEngine` 只处理 4 个——`'builtin-directory'` 落进默认分支被判 `Untrusted`。
   而 `catalog.ts:268` 恰恰给内置插件声明 `trustLevel: 'official'`，但
   `PluginManager:365` **忽略 catalog 的声明**、用 `source` 重算，于是注册表把
   **所有一方内置插件记成 `untrusted`**。
   **如果先写门控、后查映射，这个门会禁用所有内置插件**——包括 plan 583 刚发的
   browser plugin。已先修（`6e620ac8`），并加了「覆盖 `PluginSource` 全枚举」的
   守卫测试。
2. **`getCapabilities` 把共享表按引用交出**（Phase 0 已修，`491e65c3`）。

#### 如实说明：今天这个门不改变任何用户可见行为

tier 映射补全后，5 个 `PluginSource` 全部落在已识别档位，**`Untrusted` 分支通过
两条 install 路径都不可达**。所以这是一道**面向未来的 fail-safe**，不是用户能感觉
到的安全提升。两个方向的测试都写了：门存在，且门不碰正常安装。

真要让它有实际拦截力，需要出现一个「来源无法识别」的真实入口——目前没有。
不要把它当成「已经修好了一个安全漏洞」来记录。



### Phase 2 — T-2 `autoUpdate` 比对 ❌ 取消，改为 N/A

原计划：把 `autoUpdate` 入参与 `capabilities.allowAutoUpdate` 比对。
**动手前查执行点，发现不存在，故取消。**

证据：

- `PluginManager` 的公开方法全集是 `listCatalog` / `listInstalled` / `getDetail` /
  `getSetupValues` / `saveSetupValues` / `installFromCatalog` / `installFromPath` /
  `setEnabled` / `remove` / `buildHealthIssue` / `getPathValidator` / `getPolicyEngine` /
  `getTrustEngine` / `getPermissionService`——**没有任何 update / sync / upgrade**。
- `electron/services/updater.ts` 是**应用自身**的 electron-updater，与 plugin 无关。
- `plugins.autoUpdate` 只是一个被存下来、能通过 `plugin:install-local` 的 IPC 传入的
  标志，**没有任何代码读它**。

所以 `allowAutoUpdate` 与 `maxHooks` / `allowHttpHooks` / `allowAgentHooks` 同类：
**没有执行点**。去「接线」只有两种做法，两种都错：

- (a) 顺便把 plugin 自动更新机制做出来 —— 那是功能开发，不属于安全 plan。
- (b) 把一个没人读的标志钳一下 —— 制造一个看起来在管事、实际不拦任何东西的字段。
  这正是本 plan §Phase 0 标 N/A 时要避免的同一类错误。

**副产品发现（值得单独记）**：`autoUpdate: false` 这个名字**暗示**了一个保护性语义，
但它不提供任何保护。以后若有代码读它做安全判断，会建立在一个假前提上。



### Phase 3 — T-3 授权单一真相 ✅ 已落地（结论是「删掉」而非「接线」）

原计划：让 `checkPermission` 读 `PluginRegistryEntry.grantedPermissions`。
**动手前查调用方，发现连「接线对象」都不存在，故改为删除。**

实测（`PermissionService` 全部方法的外部调用方计数）：

| 方法 | 外部调用点 |
|---|---|
| `recordGrantedPermissions` | 1（`PluginManager` install，效果无人读） |
| `revokeAllPermissions` | 1（`PluginManager` remove，效果无人读） |
| `getPermissionService()` | **0** |
| `checkPermission` | **0** |
| `getPluginPermissions` | **0** |
| `requestTemporaryPermission` | **0** |
| `revokePermission` | **0** |
| `revokeExpired` | **0** |
| `isExpired` | **0** |

即：那个 Map **只写不读**。且它是内存态，进程重启即丢，本来也不可能成为可靠的
权限判定依据。

- [x] 删除 `packages/plugin-core/src/security/permission-service.ts` 与其
      `packages/plugin-core/tests/security/permission-service.test.ts`。
- [x] 移除 barrel 导出、`PluginManager` 的字段 / 3 处调用 / 访问器。
- [x] 清理两个 PluginManager 测试里已失效的 mock 桩。
- [x] 在写入点留注释：plugin 声明的 permissions 现在是**单一记录**
      （`entry.grantedPermissions`，UI 读它），且 `domains` **不执行**——
      导航拦截由设置驱动的 `DomainBlocker` 决定。写明是为了防止下一个人
      以为「少了什么」而再加一份账本。

**为什么是删而不是接**：一个叫 `PermissionService`、带 `checkPermission` 方法的类，
读起来就是执法，但它什么都不拦。要「接线」就只能自己发明一个执行点——那正是
583 里 `permissions[].domains` 和本 plan 六个 capability 字段中的四个
所犯的同一类错误。留着比删掉危险。

### Phase 4 — T-4 激活时门控 ⚠️ 原设想大部分落空，需重新定范围

原写「启用时重算 trust，信任下降的 plugin 不应能被无提示启用」。**这条今天不成立**：

- `PluginRegistryEntry.source` 安装后不再变化，而 trust 完全由 `source` 推导，
  所以「信任下降」在当前数据模型下**不可能发生**。
- Phase 1 的门已经是 fail-safe（`Untrusted` 不可达），所以 Phase 4 想守的
  那个缺口本身不存在。

**唯一还剩的真实价值**：`setEnabled(pluginId, true)` 是 Phase 1 那道门的
**逃生口**——用户可以显式启用一个装上时未启用的 plugin。这件事本身没问题
（`decideMcpSource` 已在**调用时**对 plugin/local/unknown 逐次询问），
但**当前没有任何审计痕迹**：谁在什么时候启用了什么，只有 `logger.info` 一行。

- [x] `setEnabled` 在启用「装上时被门控扣下」的 plugin 时，记一条带
      `trustLevel` 的 **warn**（含 `source` / `marketplace`）；其余启用变更记
      **info**。策略仍单源：`isWithheldAtInstall()` 委托给 `decideInstallGate()`。
      代价极小，且把 Phase 1 开的口子闭上。
- [x] 与 plan 419 P1 对齐前**不**在此加注册时门控（避免两套门）。



## 4. Gates

- 全程：`npx vitest run electron/plugins packages/plugin-core`；
  `npm run typecheck:web`；改动打包路径时 `npm run electron:build`。
- 不跑 `npm test` 与 `npm run electron:dev` 并行（共享 `better-sqlite3` 二进制）。
- 每个 Phase 至少一个「未接线时会红」的测试。
- 涉及安装行为的改动：**必须**附四种 trust level 的矩阵测试，
  因为这是唯一能证明「没有误伤正常安装」的东西。

### 已跑结果

| 门禁 | 结果 |
|---|---|
| `npx vitest run electron/plugins` | **12 文件全绿**（含覆盖 install 的 `PluginManager.test.ts`） |
| `npx vitest run packages/plugin-core/tests/trust-engine.test.ts` | 全绿 |
| `npx tsc -p packages/plugin-core --noEmit` | exit 0 |
| `npm run typecheck:web` | exit 0 |

**两个环境陷阱（都不是本次改动造成的，但会浪费下一次的时间）**：

1. worktree 内 `node_modules/@duya/*` 是指向**主 checkout** 的 Junction，所以
   `@duya/agent/*` 解析到主 checkout 的 `dist`，不是 worktree 的。主 checkout 的
   `packages/agent/dist` 当时是**空的**，导致 `PluginManager.test.ts` 报
   `Cannot find package '@duya/agent/message'`——看起来像代码坏了，其实是
   dist 没建。在主 checkout 跑一次 `npm run -w @duya/agent build` 即可。
   （注意 `git status` 数 dist 文件时只数顶层会漏掉 `dist/<dir>/` 子目录，
   我因此误判过一次「dist 只有 8 个文件」。要用 `-Recurse`。）
2. `packages/plugin-core/tests/app-schema-marketplace-compat.test.ts` 失败，
   断在 `app.name` 断言。它读的是**外部仓库**
   `E:/Projects/duya-marketplace/duya-marketplace/plugins` 下的 `.app.json`，
   与本 plan 无关（本分支 diff 零文件落在 `connectors/`）。属既有红。

## 5. 明确不做

- 不改 `decideMcpSource` 的调用时语义（它是对的）。
- 不做进程内 plugin 代码执行（那是 583 缝 C 方案 C，**本 plan 完成后**才可评估）。
- 不给 `PermissionService` 的内存 Map 加持久化（那是制造第二套真相）。
- 不动产品面（安装确认 UI 归 plan 573）。

## 6. 决策记录

- 2026-10-01：从 583 拆出独立 plan。理由：缺口独立存在、独立有价值，
  且是缝 C 的前提；混在 583 里会让安全项被功能项挤掉。
- 2026-10-01：**修正 583 调研的一处措辞**。583 §7 Phase 4 写「今天不存在
  『被信任运行代码』这个概念」——对 trust **分层**成立，但容易被读成
  「MCP 执行无门控」，而 `decideMcpSource` 是真实生效的。本 plan §1.2 明确划界。
