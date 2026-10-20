# @duya/tooling

扩展契约与装配层。拥有 13 槽位的贡献者词汇表、`ExtensionRegistry`、以及装配期校验。零跨包依赖。

## 1. 负责 / 不负责

**负责**

- 13 个窄接口的贡献者契约（modes / tools / promptSections / hooks / context / skills / approvalPolicies / profiles / servers / memoryPolicies / decisions / lifecycles / tokenUsage）。
- 装配期的校验规则与失败原因（重复 id、未授权能力、生命周期环、prompt 槽冲突）。

**不负责**

- 真正的扩展实现（工具、模式、hook 的本体）→ `@duya/capabilities`（工具）、`@duya/agent-runtime`（模式与生命周期）。
- 运行时注册与调度 → `@duya/agent-runtime`（`packages/agent-runtime/src/tools/catalog/registry.ts:247`）。
- 插件的发现与信任 → `@duya/plugin-core`（`packages/plugin-core/src/plugins/loader/capability-discovery.ts:423`）。

## 2. 关键文件

| 文件 | 作用 |
| --- | --- |
| `packages/tooling/src/grants.ts:20` | `EXTENSION_SLOTS`——13 个槽位名，顺序即契约，`validate` 原样回报槽位名。 |
| `packages/tooling/src/contributors.ts:66` | `ToolContributor` 与 12 个兄弟接口；每个接口对应一个槽位。 |
| `packages/tooling/src/registry.ts:45` | `ExtensionRegistry`（13 个独立只读槽 + `create`）；`ExtensionRegistryBuilder` `:129`。 |
| `packages/tooling/src/validation.ts:291` | `validate(snapshot, granted)`——纯函数、返回 issues；`ExtensionValidationError` `:304`。 |
| `packages/tooling/src/assemble.ts:23` | `assembleExtensions(builder, granted)`：先 `validate` 再 `ExtensionRegistry.create`，有 issue 就抛。 |

公共面：`packages/tooling/src/index.ts`（单一 barrel，`package.json` 只导出 `.`）。

## 3. 排障入口

| 症状 | 先看这里 | 为什么 |
| --- | --- | --- |
| 扩展（模式 / prompt / hook）不生效 | `packages/tooling/src/assemble.ts:23` | 装配在这里发生；没走到就说明没被装配，不是"生效但没效果"。 |
| 装配被拒 / 报"unknown slot" | `packages/tooling/src/validation.ts:291` | `validate` 返回的 issue 带槽位名与规则名。 |
| 重复 id 导致装配失败 | `packages/tooling/src/registry.ts:45` | 每个槽位独立，`ExtensionRegistry` 按槽存内容，重复检查在 `validate` 内。 |
| 贡献者接口对不上 | `packages/tooling/src/contributors.ts:66` | 13 个接口各带独立槽位语义，改一个要同步 `grants.ts:20`。 |

## 4. 边界约束

- `architecture-policy.yaml:649-652`：模块 `tooling`，`managed: true`，`requires: []`——**零跨包依赖**，G7 禁止它将来 import capabilities / connectors / memory。
- **本包目前是契约，不是已接线的运行时行为**：`assembleExtensions` 与 `ExtensionRegistryBuilder` 的调用点只出现在 `packages/tooling/tests/*` 与文档里；全仓唯一的跨包引用是 `packages/capabilities/src/fs-contributors.ts:15` 的 **type-only** import。写"扩展系统怎么生效"的文档前，先确认这一点。
- 装配器没有 catch-all 注册方法：`packages/tooling/tests/03-t3-no-catch-all-register.test.ts` 会因为新增 `register*` 通用入口而变红。
