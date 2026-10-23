# 06 — runtime 纯净度：过渡导出 vs 实耦合

状态：todo · 负责人：待认领 · 更新：2026-10-23
分支：待建（建议 `codex/622-06-runtime-purity`） · worktree：待分配
base：`d9eb7dba96f63b3e07b4fba9c068acd017616913` · owner：待认领

关联：[622 README](./README.md) · 前置：[04](04-remaining-unlayered-packages.md)

---

## 目标与边界

**目标**：把 `@duya/agent-runtime` 的跨层耦合拆成**两条处置路径不同**的工作，
并给每一条一个可测的判据。

**为什么必须拆成两条**（这是本卡的核心）：

| 路径 | 判据 | 处置 |
| --- | --- | --- |
| **过渡导出**（该迁走） | 目标包**已经在正确的层**，runtime 只是还没放手 | **平移到目标包**，runtime 侧删掉 re-export |
| **实耦合**（该经端口注入） | 目标包**的职责属于 runtime 之下**，runtime 只是直接 import 了它 | **在 runtime 与它之间建端口**，runtime 不再直接依赖包 |

⇒ **一条判据**：看目标包的**层归属**（由 [04](04-remaining-unlayered-packages.md) 定）。
`@duya/client-core` 是 core 层、`@duya/capabilities` 与 `@duya/plugin-core` 也在
runtime 层或以下 —— 但**同层不等于同职责**。
⇒ **第二条判据**：看 runtime 侧那行 import 的**性质**——
`export *` / `export { x }`（过桥）vs 真正**用到的实现**（实耦合）。

---

## 验收

### 首个失败证据（今天长什么样）

**今天的失败形态**：三个 import 语句**都是值导出**，不是 type-only：

```text
packages/agent-runtime/src/authorization/permissions/types.ts:1
  export * from '@duya/capabilities/permissions';

packages/agent-runtime/src/authorization/permissions/policy.ts:1
  export * from '@duya/capabilities/permissions';
```

⇒ runtime 的**授权模块**在运行时直接依赖 `@duya/capabilities/permissions`。
这是审计说的「落在安全核心上」——**判定准确**。

**必须先写的用例**：

```text
packages/agent-runtime/test/runtime-purity.test.ts   （新建）
  it('does not reach @duya/capabilities at runtime from the authorization module', ...)
```

**今天跑它，红的形态是**：断言"`authorization/**` 不含指向
`@duya/capabilities` 的值级导出"失败，失败信息点名
`authorization/permissions/types.ts:1` 与 `authorization/permissions/policy.ts:1`。

**第二个必须先写的用例**（守"过渡导出已迁走"）：

```text
packages/agent-runtime/test/runtime-purity.test.ts
  it('no longer re-exports SurfaceModel from the runtime surface barrel', ...)
```

**今天跑它，红的形态是**：`surface/index.ts:20` 的
`export { SurfaceModel } from '@duya/client-core';`、
`surface/index.ts:43` 与根 `index.ts:194`、`:217` 的
`export type { ... } from '@duya/client-core'`、
`surface/legacy-projection.ts:28` 的
`import { SurfaceModel, type SurfaceEffect } from '@duya/client-core'`
仍然存在。

**第三个必须先写的用例**（守"实耦合走端口"）：

```text
packages/agent-runtime/test/runtime-purity.test.ts
  it('resolves the permission contract through an injected port, not a package import', ...)
```

**今天跑它，红的形态是**：runtime 里不存在这样的端口
（`authorization/permissions/ports.ts:1` 现在只有
`import type { AppConnectionToolDescriptor } from '@duya/capabilities/AppConnectionTool'`，
**仍然是指向包的类型导入**）。

### 耦合清单（实测，2026-10-23）

**→ `@duya/client-core`（5 处引用，全是 `SurfaceModel` 的过桥 re-export）**

| 位置 | 形状 |
| --- | --- |
| `packages/agent-runtime/src/surface/index.ts:20` | `export { SurfaceModel } from '@duya/client-core';` |
| `packages/agent-runtime/src/surface/index.ts:43` | `export type { ... } from '@duya/client-core';` |
| `packages/agent-runtime/src/surface/legacy-projection.ts:28` | `import { SurfaceModel, type SurfaceEffect } from '@duya/client-core';` |
| `packages/agent-runtime/src/index.ts:194` | `export { SurfaceModel } from '@duya/client-core';` |
| `packages/agent-runtime/src/index.ts:217` | `export type { ... } from '@duya/client-core';` |

**→ `@duya/capabilities`（22 条跨包边 / 15 个 import 语句）**

| 位置 | 形状 | 分类 |
| --- | --- | --- |
| `authorization/permissions/types.ts:1` | `export * from '@duya/capabilities/permissions';` | **过桥（值导出）** |
| `authorization/permissions/policy.ts:1` | `export * from '@duya/capabilities/permissions';` | **过桥（值导出）** |
| `authorization/permissions/permissions.ts:56` | `} from '@duya/capabilities';` | **实耦合** |
| `authorization/permissions/permissions.ts:40` | `import { appToolOriginalName, appToolVisibleName, isTrustedAppToolRegistration, type AppToolRegistration } from '@duya/capabilities/AppServer/app-tool-namespace';` | **实耦合（值）** |
| `authorization/permission-gate.ts:32` | `import type { AppToolRegistration } from '@duya/capabilities/AppServer/app-tool-namespace';` | 类型耦合 |
| `authorization/tool-filter.ts:15` | `import { appToolOriginalName } from '@duya/capabilities/AppServer/app-tool-namespace';` | **实耦合（值）** |
| `authorization/permissions/ports.ts:1` | `import type { AppConnectionToolDescriptor } from '@duya/capabilities/AppConnectionTool';` | 类型耦合 |
| `tools/catalog/registry.ts:31` | `import { PermissionRequiredError } from '@duya/capabilities/BaseTool';` | **实耦合（值）** |
| `tools/catalog/registry.ts:32-33` | `import type { ToolDependencyDeclaration } ...`、`import type { RiskTier } ...` | 类型耦合 |
| `tools/execution/ToolExecutionPipeline.ts:57` | `import type { ToolDependencyDeclaration } from '@duya/capabilities/contracts';` | 类型耦合 |
| `tools/execution/StreamingToolExecutor.ts:12` | `import { PermissionRequiredError } from '@duya/capabilities/BaseTool'` | **实耦合（值）** |
| `tools/execution/StreamingToolExecutor.ts:17` | `} from '@duya/capabilities/utils/shell/intelligence'` | **实耦合（值）** |
| `tools/execution/orchestration/DependencyGraphOrchestrator.ts:49` | `} from '@duya/capabilities/contracts';` | **实耦合（值）** |
| `tools/mcp-executor.ts:5` | `import { withAppToolContext } from '@duya/capabilities/AppServer/app-tool-context';` | **实耦合（值）** |

**→ `@duya/plugin-core`（2 处，同一文件）**

| 位置 | 形状 | 分类 |
| --- | --- | --- |
| `tools/catalog/catalog-identity.ts:9` | `export { computeSchemaRevision as getSchemaRevision, canonicalizeJson } from '@duya/plugin-core/mcp/core/descriptor';` | **过桥（值 re-export）** |
| `tools/catalog/catalog-identity.ts:10` | `import { canonicalizeJson } from '@duya/plugin-core/mcp/core/descriptor';` | **实耦合（值）** |

**→ `@duya/host`：0 处**（runtime 不反向依赖 host，这一层是干净的）。

### 验收命令与预期结果

```bash
# 1) runtime 包全量
npx vitest run packages/agent-runtime/test/
#    预期：全部 passed；新用例 3 条全绿

# 2) 包级 typecheck
npx tsc -p packages/agent-runtime --noEmit
#    预期：exit 0

# 3) 跨包边计数真的降了
node scripts/architecture/audit-imports.mjs --json > /tmp/audit2.json
node -e "
const d = JSON.parse(require('fs').readFileSync('/tmp/audit2.json','utf8'));
const e = d.crossBoundaryEdges.filter(x => x.fromOwner === 'pkg:agent-runtime');
const by = e.reduce((a,x)=>{a[x.toOwner]=(a[x.toOwner]??0)+1;return a;},{});
console.log(by);
"
#    预期：runtime 的出边里不再有 pkg:client-core；
#    预期：pkg:capabilities / pkg:plugin-core 的边数按处置结果下降（目标值在卡片执行时锁定）

# 4) 下游不许坏
npm run architecture:check     # 预期：仍 OK
npm run plan:sync              # 预期：仍 OK
```

### 完成判据

1. **`@duya/client-core` 过桥全部迁走**：runtime 的 `surface/` 与根 `index.ts`
   不再 import `@duya/client-core`。
   ⇒ **注意**：这是 610 A8.1 平移（PR #270 / `943225cf`）的收尾，
   **不是**新建第二条客户端状态路径。迁走的方向必须是
   **消费者去 client-core 取**，不是"再造一个 surface 副本"。

2. **权限契约有明确归属，且 runtime 不再包级依赖**：
   - 若判为「契约属于协议层」→ 契约定义**平移到 `@duya/agent-protocol`**，
     `capabilities` 与 `runtime` 都从协议取。
   - 若判为「契约属于 core 层」→ 契约定义**平移到 `@duya/agent-core`**，
     runtime 从 core 取。
   ⇒ **裁决属于执行时**，但**判据固定**：契约必须是**纯的、零 IO 的**，
   且**被 capabilities 与 runtime 双方消费**。
   落点建议：**`@duya/agent-protocol`**（它已经是零运行时依赖的契约层，
   `ARCHITECTURE_MAP.md:20`：「Wire contract … Zero runtime deps」）。

3. **实现类耦合走端口**：`PermissionRequiredError`（`@duya/capabilities/BaseTool`）、
   `withAppToolContext`（`@duya/capabilities/AppServer/app-tool-context`）、
   `canonicalizeJson` / `computeSchemaRevision`（`@duya/plugin-core/mcp/core/descriptor`）
   这三个是**真实现依赖**。
   ⇒ 它们要么**下移到 runtime 之下**（协议/core 层），
   要么**经注入的端口**交给 runtime。
   **不允许**用"runtime 直接 import，但加注释说明"来收场。

4. **runtime → capabilities / plugin-core 的出边降到目标值**，且目标值在验收里写死。

### 变异证明（门禁卡必填）

- **变异 ①**：把 `authorization/permissions/types.ts:1` 的 `export *` 加回来
  → "authorization 模块不触达 capabilities"那条用例**必须红**。
- **变异 ②**：把 `surface/index.ts:20` 的 `export { SurfaceModel }` 加回来
  → "不再 re-export SurfaceModel"那条用例**必须红**。
- **变异 ③**：把端口注入改回包级 import
  → "经注入的端口"那条用例**必须红**。
  **对照组要求**：这条用例必须能区分"端口存在但没被用"与"端口被用了"——
  否则它会恒绿（610 D9.6 踩过这个坑：spy 返回 allow 时，"闸门自己放行"与
  "闸门转发给同意的 approver"产出完全相同的返回值）。

---

## 进度

- [ ] 写 3 条红用例（见 §首个失败证据）
- [ ] 裁决权限契约的归属（协议层 or core 层），写下理由
- [ ] 迁走 `surface/` 与根 `index.ts` 的 `@duya/client-core` 过桥；
      更新所有消费者（**先查消费者清单，不要只改 runtime**）
- [ ] 迁走权限契约；把 `capabilities` 与 `runtime` 两边都切过去
- [ ] 为三个实现类依赖建端口并接线
- [ ] 跑 §验收 的 4 组命令，锁定出边目标值
- [ ] 跑 §变异 的 3 组变异（含对照组）

---

## 发现与决策

1. **审计对 `@duya/client-core` 的判定是准确的。**
   5 处引用全在 `surface/index.ts` / `surface/legacy-projection.ts` / 根 `index.ts`，
   是 `SurfaceModel` 的过渡 re-export。⇒ **该迁走**。

2. **审计对 `@duya/capabilities` 的判定也准确，但"实耦合"的落点要改。**
   审计把它和过桥混在一起说成"实耦合"。实测要分三档：
   - **过桥（值导出）**：`types.ts:1` / `policy.ts:1` 的 `export *` —— 2 处。
     它们把 `@duya/capabilities/permissions` **原样再导出**，runtime 自己不实现任何东西。
   - **实耦合（值）**：`permissions.ts:40`、`tool-filter.ts:15`、`registry.ts:31`、
     `StreamingToolExecutor.ts:12,17`、`DependencyGraphOrchestrator.ts:49`、
     `mcp-executor.ts:5`、`catalog-identity.ts:10` —— **8 处真用实现**。
   - **类型耦合**：`permissions.ts:56`（部分）、`permission-gate.ts:32`、
     `ports.ts:1`、`registry.ts:32-33`、`ToolExecutionPipeline.ts:57` —— 5 处。
   ⇒ **裁决**：2 处过桥按"迁走"处理；8 处实耦合按"经端口或下移"处理；
   5 处类型耦合在契约平移后**自然消失**。

3. **`@duya/plugin-core` 只有 2 处，且其中 1 处是过桥。**
   `catalog-identity.ts:9` 是 `export { ... } from`（过桥），
   `:10` 是 `import { canonicalizeJson }`（实耦合）。
   ⇒ **裁决**：过桥那条直接删（消费者去 `@duya/plugin-core` 取）；
   实耦合那条看 `canonicalizeJson` / `computeSchemaRevision` 的性质
   —— 它们是**纯的 schema 规范化函数**（`descriptor.ts`），
   ⇒ 归 core 层或协议层，runtime 从那里取。

4. **"同层"不等于"可以直连"。**
   `@duya/capabilities` 与 `@duya/agent-runtime` **同在 runtime 层**
   （`LAYERS:72`），所以 G1 **不会**把它们之间的边判成反向边
   （实测：runtime → capabilities 的 22 条边，G1 的 revFound 是 **0**）。
   ⇒ **裁决**：这不是层违规，是**职责归属**问题。
   这也是 [04](04-remaining-unlayered-packages.md) 定层之后、
   本卡仍必须独立存在的原因。

5. **不要用"runtime 直接 import 但加注释"收场。**
   610 §D10 的教训：幽灵指针（`permission.resolved`）之所以能同时出现在两行，
   是因为一条**只验一半**的门禁守它。⇒ 本卡的用例必须验**符号**，
   不能只验文件路径。

6. **迁移方向必须先查消费者。**
   `SurfaceModel` 的消费者清单不在 runtime 里（`packages/agent/src/cli/ui/surface-view.ts:206`
   是 610 T10 记录的**唯一**使用点，且它在**退役包**里）。
   ⇒ 迁走 runtime 侧过桥之前，**必须**确认 `packages/agent`（退役中）与
   `packages/cli` 的消费者清单。**这条与 [10](10-retirement-and-doc-truth.md) 耦合**：
   退役包的消费者不迁走，runtime 的过桥就删不掉。

---

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `d9eb7dba` / 干净 | macOS 12.7.6 · Node v20.20.2 | `grep -rn "@duya/client-core" packages/agent-runtime/src` | 0 | **5** 处：`surface/index.ts:20,43`、`surface/legacy-projection.ts:28`、`index.ts:194,217` |
| `d9eb7dba` / 干净 | 同上 | `grep -rn "@duya/capabilities" packages/agent-runtime/src` | 0 | **15** 个 import 语句（22 条跨包边，全部 `kind: "public"`） |
| `d9eb7dba` / 干净 | 同上 | `grep -rn "@duya/plugin-core" packages/agent-runtime/src` | 0 | **2** 处，同在 `tools/catalog/catalog-identity.ts:9-10` |
| `d9eb7dba` / 干净 | 同上 | `grep -rn "@duya/host" packages/agent-runtime/src` | 1 | **0** 处（runtime 不反向依赖 host） |
| `d9eb7dba` / 干净 | 同上 | `sed -n '1,3p' packages/agent-runtime/src/authorization/permissions/{types,policy}.ts` | 0 | 两处均为 `export * from '@duya/capabilities/permissions';`（**值**导出，非 type-only） |
| `d9eb7dba` / 干净 | 同上 | G1 覆盖计算（`audit-imports.mjs --json` + `sourceLayerOf`） | 0 | runtime → capabilities 的 22 条边**全部不是反向边**（同层）；revFound **0** |

---

## 接续 / 结果

- **已实现 / 已验证 / 已合并**：本卡**尚未开工**。以上是开工前的基线取证。
- **未提交路径**：无。
- **副作用**：无。
- **阻塞**：**被 [04](04-remaining-unlayered-packages.md) 阻塞**（契约落点要引用层归属）；
  且"迁走 `@duya/client-core` 过桥"依赖 `packages/agent` 侧消费者的处置，
  与 [10](10-retirement-and-doc-truth.md) 耦合。

**下一步**：认领本卡，先做"裁决权限契约归属"这一步——
读 `packages/capabilities/src/permissions/{index,policy,types}.ts`，
判断 `PermissionRulesWire` / `RiskTier` / 权限判定函数是否**零 IO**，
并写出「落到 `@duya/agent-protocol` 还是 `@duya/agent-core`」的结论与理由。
**完成判据**：结论有依据（零 IO + 双方消费），且能指出契约里**哪几个符号**要搬。

**回退**：本卡会改 `packages/agent-runtime/src/**`、
`packages/capabilities/src/permissions/**`、可能的 `packages/agent-protocol/src/**`
⇒ **按子步分提交**，每个子步可单独 revert。
**无 schema 变更、无数据迁移**；但**协议成员的新增是 additive**，
回退时不能与已落库的历史事件冲突。
