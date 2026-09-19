# Plan 551: Prompt module flatten — 内容维度模块化 + profile 纯组装

> **Status**: Planning (2026-09-19)
> **Priority**: P1
> **Companion**: [Plan 550](./550-prompt-hbs-and-agent-decomposition.md)（承接其 1d 静态半边扫尾；2e/3c 在 DuyaAgent 侧，无文件交集）
> **Related**: [Plan 474](./474-bot-system-prompt-sections.md)（bot 提示词层，Phase 3 需协调）

## Background

用户目标（原话）：**"全部平摊成一个个模块，就是 basicprompt、finalanswer、tools、skill，一块块的。每个 profile 用的都大差不差，只不过是不同的组装。"**

即：按**内容维度**切模块，而不是按 profile 平行挂目录。profile 文件退化为纯组装声明。

Plan 550 session 7++ 之后的实际地基（本 plan 的起点）：

| 资产 | 现状 |
|---|---|
| `assets/general/system-prompt.md.hbs` | 227 行巨型模板，内联 10 个 authored 段落（identity / system / destructive-actions / config-protection / communication / tools / tasks / skills-usage / duya-desktop-context / final-answer），仅 general 使用 |
| `general/sections/*.ts` (10 文件) | **仍被 code / gateway / research 配置 import** —— 跨 profile 静态重复的真实所在 |
| `code|gateway|research/sections/*.ts` | 各 profile 私有静态段（identity-compact / personality / rules / toneAndStyle×2 份 95% 相同 / intro / evidencePolicy / ...） |
| `assets/dynamic/*.hbs` (14 文件) | context-fed 半边已**全部**迁完（550 1d-rest，`ec4ebcd9` 后生产路径只走 template）；legacy TS 在 `sections/dynamic/*.ts` 仅作 parity 参照 |
| `hbs/HbsPromptSystem.ts` | 单一全局 mapper `mapPromptContextToHbs`（~230 行）喂所有模板；assetLoader 按字符串路径查找，模板缺失时 `loadHbsAssetSync` **throw** |

## 设计决策（回答"为什么分 dynamic/module、为什么要 TS 导出"）

### D1 — `modules/` 与 `dynamic/` 的分治是迁移落点，不是终态分类

终态概念只有一个 **module**。两个目录今天并存，是因为两半边的迁移各自完成在不同合同下：

- **authored（文案）模块**：人写的文本，profile 选择哪些块出现 + 传 variant 参数。参数是组装期的，渲染是纯函数。→ 本 plan 新建 `assets/modules/` 收纳。
- **context-fed（取数）模块**：代码从运行时状态算出内容（fs / 时钟 / db / registry），需要 preBuildHook 注入 + `''→null` 收缩语义。→ `assets/dynamic/` 已按此合同迁完并被 ~50 个 parity 测试锁定。

**做法**：`assets/dynamic/` 物理不动；新建 `prompts/modules/registry.ts` 统一查找两个命名空间，目录布局降级为实现细节。把 14 个 dynamic 模板改名搬目录是纯 churn（零行为收益、扰动全部 parity 测试），降级为可选的 Phase 4 机械操作，默认不做。

### D2 — TS 导出规则：registry 必需，per-module 文件按需

**不是**每个模块一个 TS 文件。必需的 TS 只有一处：`modules/registry.ts`。它解决三件事：

1. **引用类型化**：今天 config 里是裸字符串路径（`'dynamic/memory.hbs'`），改名要到运行时才炸（renderer throw）。`MODULES as const` + configs `satisfies ModuleName[]` 让改名变成编译错误。
2. **参数合同**：`identity(variant: 'full'|'compact')`、`toneAndStyle(variant: 'base'|'concise')` —— 字符串清单表达不了参数；registry 条目的 params 类型就是合同。
3. **mapper 落点**：`mapPromptContextToHbs` 已 230 行且每迁一个模块就要继续膨胀（550 遗留风险）。有取数/参数逻辑的模块，其 per-module TS 文件就是 mapper 的家（先例：`memoryPreBuildHook` + `memory_*` slots）。

纯文案模块（destructive-actions、communication、tasks…）**零 TS 文件**，只有 registry 一行条目。规则一句话：**TS 文件跟着合同走，不跟模块数量走。**

### D3 — variant 不引入新 handlebars helper

不注册 `eq` 等 helper。沿用 1d-rest 先例：mapper/参数层预计算 boolean slot（如 `identity_compact: params.variant === 'compact'`），模板只写 `{{#if}}`。与现有 14 个 dynamic 模板风格一致，renderer 零改动。

## Phase 1 — 拆巨型模板 + module registry（零行为变化）

- [ ] `prompts/modules/registry.ts`：`MODULES` map（name → `{ path, description, params? }`）+ `ModuleName` 类型 + `renderModule(name, ctx, params?)` 入口（可放 HbsPromptSystem 或 registry，倾向前者复用 compile cache）
- [ ] `assets/modules/*.hbs` × 10：按巨型模板实际段落拆（identity / system / destructive-actions / config-protection / communication / tools / tasks / skills-usage / duya-desktop-context / final-answer）。注意：模板里 `# Using your tools` 出现两次是 `isReplModeEnabled` 内部分支，属 tools 模块内部 `{{#if}}`，不拆开
- [ ] `PromptSystemConfig.staticModules?: ModuleRef[]` 新字段，与 `staticTemplate` 并存
- [ ] `generalConfig` 切到 `staticModules`；模块间空行分隔由 joiner 或模板尾部产生，**以 byte parity 为准**
- [ ] 新增 split-parity 测试：`join(renderModule(...)) === renderStaticTemplate('general/system-prompt.md.hbs')`；巨型模板保留为 parity 参照，本阶段不删
- **Gate**：现有 `general-prompt-byte-diff` + `prompts/hbs/` 全套测试绿；`npm run typecheck:all`

## Phase 2 — 收敛跨 profile 静态重复（以 configs 实际清单为准）

- [ ] `identity`：code/sections/identity.ts → identity 模块 `variant=compact`（先建 byte-diff vs legacy，再切）
- [ ] `tone-and-style`：gateway 与 research 两份 95% 相同的 toneAndStyle 合并为一个模块 `variant=concise|base`（gateway 多 "NEVER include analysis" 段）
- [ ] code 私有：personality / rules / working-with-user / system(capability 段走 variant) → 模块
- [ ] gateway 私有：intro / gateway-role → 模块
- [ ] research 私有：evidence-policy / memory-write-proposal / output-format / profile / task-intent → 模块
- [ ] `configs/{code,gateway,research}.ts` 改为 `staticModules` 组装清单
- [ ] 删除 `general/sections/*.ts`、`code/sections/`、`gateway/sections/`、`research/sections/`（**完成 550 1d 的静态半边扫尾**）
- **Gate**：每个被替换的 TS section 先有 byte-diff 测试锁输出，删除后测试改断言新路径仍绿

## Phase 3 — 组装层收口 + 双轨退役

- [ ] `PromptSystemConfig` 删 `staticTemplate` 字段 + 删巨型模板（Phase 1 参照退役）
- [ ] `SectionDef.compute` 双轨退役：general config 里 language / outputStyle / platform / mcp / visionGuidelines 5 个仍带 `compute:` 兜底的条目转纯 template；删 `sections/dynamic/*.ts` legacy（= 550 1d 的 dynamic 半边扫尾，8 个 parity 测试改为 hardcoded 断言或随删除退役）
- [ ] bot：`basicPrompt` 以 registry 条目登记（authored 模块、无 TS），`_buildSystemPrompt` 前置路径不变、保持 byte-stable 与 KV-cache 友好；bot 深度拆分归 plan 474，不在本 plan 范围
- [ ] （可选）mapper 分片：`mapPromptContextToHbs` 收缩为 base slots + per-module mapper 合并，止住全局函数继续膨胀

## Phase 4（可选、机械）— 目录合并

- [ ] `assets/dynamic/*.hbs` → `assets/modules/`（纯改名 + registry 条目 + 测试路径更新）。仅在 Phase 1-3 稳定后做；不做也不影响终态语义（registry 已统一查找）。

## 风险

| 风险 | 缓解 |
|---|---|
| byte parity 漂移（拆分 / 合并 / variant 全程） | 每个 commit 带 parity 测试；`.gitattributes` 已锁 `*.hbs` LF（550 教训） |
| 模块间空行 / 分隔符丢失 | joiner 契约测试先行于任何模板改动 |
| rename 静默失败 | registry `as const` + `satisfies ModuleName`；把 renderer 的运行时 throw 前移成编译错 |
| variant 命名外泄成外部契约 | params 字面量 union 类型定义在 registry，configs 只能传合法值 |
| 与 plan 474 bot 提示词工程撞车 | bot 只登记 registry 条目、不改渲染路径；474 落地后 bot sections 再入 modules |
| 与 plan 550 并行 | 550 的 2e/3c 在 `agent/` 侧，与 `prompts/` 无文件交集；550 的 1d 扫尾移交本 plan Phase 3 |

## Testing gates

每个 commit：
- [ ] `npm run typecheck:all`
- [ ] `prompts/hbs/` 全套 parity 测试（含本 plan 新增的 split-parity）
- [ ] 触及 profile 配置时跑对应 `configs/__tests__/*` 与 `bot/__tests__/sections.test.ts`
