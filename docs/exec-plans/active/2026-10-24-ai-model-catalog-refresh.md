# 刷新 @duya/ai 各 provider 模型目录

状态：active · 负责人：mavis（会话 mvs_35672764d34e4ec2800223e322efa928） · 更新：2026-10-24
分支：codex/ai-model-catalog · worktree：E:\Projects\duya\.claude\worktrees\ai-model-catalog · base：3ddbbfaf · owner：mavis

## 目标与边界

把 `packages/ai/src/providers/*.models.ts`（能力目录：上下文窗口 / 输出上限 / 推理档位 / 定价）与
`catalog-data.ts`（预设默认模型）刷新到厂商当前在售模型，并修掉目录本身的两处错误。

允许改：`packages/ai/src/providers/**`、`packages/ai/scripts/sync-models.mjs`、`packages/ai/test/**`。
不改：运行时协议实现（`api/**`）、provider 工厂、UI 与 Host 逻辑。

关联：`packages/ai/src/providers/catalog.ts`（预设结构）、`packages/host/src/worker-config/provider-catalog.ts`（按 id 查能力）。

## 验收

- `npm run typecheck:all` 退出码 0。
- `npx vitest run --root packages/ai` 全绿，含新增的目录一致性用例。
- `npm run architecture:check` 无新增违规。
- 目录刷新可用 `npm run sync:models -w @duya/ai -- --write` 复现。

## 进度

- [x] 取上游现状：models.dev `api.json` 与 OpenRouter `models` 两个公开源，按厂商分组核对。
- [x] 核对目录与运行时的一致性（id 形态、cost 量级、预设→能力命中）。
- [x] 重写同步脚本，支持 models.dev 直连 id + 每 shard 白名单 + cost 归一化 + 保留治理字段。
- [x] 刷新各 shard，ollama 手写补齐，新增小米 MiMo shard。
- [x] 同步 `catalog-data.ts` 默认模型。
- [x] 补治理用例：预设 id 必须命中能力目录、同 shard 不得重复 id、cost 量级一致。
- [x] 跑门禁、提交、提 PR。

## 发现与决策

- **目录落后一整代**：openai 只有 gpt-4o / o3，google 只有 gemini-2.5，volcengine 还停在 doubao-1.5，
  anthropic 用的是 OpenRouter 的点号 id（`claude-sonnet-4.6`），与厂商直连 id（`claude-sonnet-4-6`）不一致。
- **成本量级混用**：`Model.cost` 运行时按「每百万 token」消费（`provider-store.ts:830`），但
  anthropic / deepseek / xai / qwen / openrouter 等 shard 存的是「每 token」，导致这些模型的成本估算为 0。
  本次统一到 $/M。
- **目录与预设两张皮**：`catalog-data.ts` 的 `defaultModels` 才是真正发给厂商的 id；两边不同名时
  `findBuiltinModel` 命中不了，预设模型就拿不到上下文窗口与思考档位。本次让两边对齐。
- **数据源选 models.dev**：它的 id 是厂商直连 id，与 duya 的 catalog 一致；OpenRouter 只有代理侧 id，
  仅用于 openrouter shard。OpenRouter 侧用真实 id（`claude-opus-4.7` 点号、`claude-opus-5` 短横线混用）。
- **治理字段不丢**：`compat` / `thinkingLevelMap` 逐模型原样保留，新模型才用 provider 级默认值。
- **GLM shard 有重复 id**（`glm-5.3`、`glm-5.3-flash` 各出现两次），刷新时按分组重写消除。
- **同一个 id 不能有两套上限**：百炼 Coding Plan 也卖 GLM/Kimi/MiniMax，但它的代理上限与厂商直连不同。
  同一个 (api, id) 出现两套 `maxTokens` 会让能力查询变成顺序问题，因此百炼 shard 只收 Qwen，
  其余模型由各自厂商的 shard 描述（按 id 回退查找已经支持这种用法）。
- **套餐分组没有单价**：token plan / coding plan 分组给的是 0（订阅制），价格要从同厂商按量分组取；
  取不到就不写 `cost` 字段——「没有价格」和「免费」是两回事。
- **Anthropic 目录已无非推理模型**：claude-3-haiku 退役，思考档位用例改用合成模型覆盖非推理分支。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| 3ddbbfaf + 本次改动 | Windows / Node 24 | `npm run typecheck:all` | 0 | 全仓类型检查通过 |
| 3ddbbfaf + 本次改动 | Windows / Node 24 | `npm run architecture:check` | 0 | 无新增边界违规 |
| 3ddbbfaf + 本次改动 | Windows / Node 24 | `npx vitest run packages/ai/test` | 0，550 通过 | 含新增目录一致性用例 |
| 3ddbbfaf + 本次改动 | Windows / Node 24 | `npx vitest run packages/ui/src/lib/providers packages/ui/src/components/providers apps/desktop/src/main/services/providers packages/host/tests` | 0，220 文件 / 2086 通过 | 消费侧 provider 链路 |
| 3ddbbfaf + 本次改动 | Windows / Node 24 | `npm run bundle:worker` + `npm run bundle:verify` | 0 | worker bundle 随本 PR 重建 |

## 接续 / 结果

- 已实现：19 个 provider shard 刷新 + 1 个新增（小米 MiMo）、预设默认模型对齐、同步脚本重写、
  目录一致性用例、worker bundle 重建。
- 已验证：见上表（本地全绿，合并 master 后复跑仍全绿）。
- PR：#441 https://github.com/lava-chen/duya/pull/441 （base=master，未合并）。
- 合并记录：master 前进导致 PR 冲突，冲突只在 `packages/host/bundle/**`；已合并
  origin/master 并基于合并后的源码重建 bundle，门禁回到 FRESH。
- 未提交路径：无。
- 副作用：worker bundle 产物变化（`packages/host/bundle/**`），属本次改动的应有产物。
- 阻塞：无。
- 回收：未回收原因——PR 尚未集成，需保留分支与检出。

下一步：等 CI 与 review 通过后由获授权的集成者合并；本 agent 不自行合并。

