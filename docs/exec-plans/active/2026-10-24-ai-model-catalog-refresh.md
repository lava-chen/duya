# 刷新 @duya/ai 各 provider 模型目录

状态：active · 负责人：mavis（会话 mvs_35672764d34e4ec2800223e322efa928） · 更新：2026-10-29
分支：codex/model-catalog-discovery（发现/准入分离） · worktree：E:\Projects\duya\.claude\worktrees\model-discovery · base：origin/master · owner：mavis

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
- [x] #441 合并进 master（c426d029）。
- [x] 模型 id 排序改成码位序，去掉对 ICU 本地化的依赖。
- [x] 重跑同步脚本，吸收 openrouter 价格漂移并重建 worker bundle。
- [x] 新增夜间刷新 workflow：只开 PR，不自动合并。
- [x] 提交后续改动、提 PR（#442）。
- [x] 发现与准入分离：每 shard 全量扫描上游、准入规则、中文 Markdown 发现报告（`--report` / `--discover`）、离线 fixture 用例。
- [x] 复核补强：上游 `status: "deprecated"` 不自动上架；未收录候选全部列出（近期 / 更早两栏）；`--write` 用例写到复制的 shard 目录，不碰真实目录。
- [ ] 等人工复核、PR 与 CI（本分支尚未推送）。

## 夜间自动刷新

`.github/workflows/model-catalog.yml`：每天 21:30（北京时间）跑同步脚本，无变化就早退，有变化则重建
worker bundle、跑 `packages/ai` 自检、推到滚动分支 `chore/ai-model-catalog-nightly` 并开/更新一个 PR。

| 旋钮 | 位置 | 默认 |
| --- | --- | --- |
| 时间 | workflow `schedule.cron` | `30 13 * * *`（UTC） |
| 纳入哪些上游模型 | 同步脚本的发现/准入规则 | 见 `packages/ai/scripts/sync-models.mjs` |
| 是否合并 | workflow「Merge validated catalog PR」 | 目录-only 校验通过后自动合入；异常保留 PR |

- **自动合并有前置闸门**：只有提交里全部是 `packages/ai/src/providers/*.models.ts` 与 `packages/host/bundle`、
  目录自检、Host 构建与 bundle 校验都通过，且分支保护要求的检查全绿时才合入；否则 workflow 保留 PR 并标红。
- **滚动分支**：每天新开一个 PR 会攒出一堆过期评审对象，所以固定一个分支 force-push。
- **排序不能依赖 locale**：`localeCompare` 走 ICU 排序，结果随机器 locale 变。夜间任务跑在 Linux runner、
  目录却是在开发机上写的，本地化排序会让「上游没变」每晚都被判成「有变化」。改成码位序后两边一致。
- **开 PR 需要有权限的 token**：仓库已于 2026-10-24 开启 "Allow GitHub Actions to create and approve pull requests"，
  `GITHUB_TOKEN` 可以建 PR。workflow 仍优先用 `NIGHTLY_PR_TOKEN` secret（没有则回退 `GITHUB_TOKEN`），
  建不出来时打印可直接点开的 compare 链接并把任务标红，不会静默跳过。
- **发现报告不随早退消失**：目录无 diff 时 workflow 会早退，但发现报告写入 job summary，能看到「上游有新模型
  但未准入」；PR 正文也以报告为主体，不再用 `+N/-N` 行解析。
- **「只有价格变了」的 PR 是常态**：OpenRouter 部分模型给的是换算价，会持续微漂
  （实测 `deepseek/deepseek-v4-pro` 二十分钟内漂 ~2.6%）。夜间任务因此几乎每晚都有差异可报，
  但模型增删列表会是空的。价格按上游原样写入，不做四舍五入掩盖。


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
- **发现与准入分离**：每晚扫描每个 shard 目标分组的**完整上游目录**，报告新增、下架与参数变化；
  只有同时满足上游未标记 `status: "deprecated"`、`tool_call === true`、输出纯文本（不含 audio / image / video）、
  输入含 text、未被该 section `exclude` 排除、且发布日期在最近 45 天（`SYNC_MODELS_RECENT_DAYS` 可覆盖）的新 id
  才写入 shard。Google 只准入 `^gemini`、百炼只准入 `^qwen` 的 family；OpenRouter 设置
  `autoAdd: false`，继续只作离线种子（运行时从 `/models` 动态获取），只报告不写入；
  Bedrock 排除 `us.*` / `eu.*` / `global.*` 等区域前缀别名。
  已签入 id 只要上游仍提供且未被排除就保留，`--write` 不因超出发布窗口而删除历史模型。
  报告分「近期未收录」与「更早未收录」两栏，**所有**未收录候选都列出：上游可能在发布很久后才补录，
  只按发布时间丢弃会把这类模型永久藏起来；自动准入仍只看近期，历史候选由人工决定是否加入。
  上游把退役模型继续列在目录里（例如已被 `deepseek-flash` 取代的 `deepseek-v4-flash`），
  `deprecated_upstream` 规则阻止它们被自动复活。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| 3ddbbfaf + 本次改动 | Windows / Node 24 | `npm run typecheck:all` | 0 | 全仓类型检查通过 |
| 3ddbbfaf + 本次改动 | Windows / Node 24 | `npm run architecture:check` | 0 | 无新增边界违规 |
| 3ddbbfaf + 本次改动 | Windows / Node 24 | `npx vitest run packages/ai/test` | 0，550 通过 | 含新增目录一致性用例 |
| 3ddbbfaf + 本次改动 | Windows / Node 24 | `npx vitest run packages/ui/src/lib/providers packages/ui/src/components/providers apps/desktop/src/main/services/providers packages/host/tests` | 0，220 文件 / 2086 通过 | 消费侧 provider 链路 |
| 3ddbbfaf + 本次改动 | Windows / Node 24 | `npm run bundle:worker` + `npm run bundle:verify` | 0 | worker bundle 随本 PR 重建 |
| c426d029 + 本次改动 | Windows / Node 24 | `npm run typecheck:all` | 0 | 全仓类型检查通过 |
| c426d029 + 本次改动 | Windows / Node 24 | `npm run architecture:check` | 0 | 无新增边界违规 |
| c426d029 + 本次改动 | Windows / Node 24 | `npm run plan:sync` | 0 | 计划表与仓库一致 |
| c426d029 + 本次改动 | Windows / Node 24 | `npx vitest run --root . packages/ai/test` | 0，550 通过 | 含目录一致性与治理用例 |
| c426d029 + 本次改动 | Windows / Node 24 | `node scripts/build-packages.mjs --target @duya/host` + `npm run bundle:worker` | 0 | worker bundle 随 openrouter 价格重建 |
| e40357ad + 本次改动 | Windows / Node 24.16 | `npx vitest run --root . packages/ai/test` | 0，56 文件 / 559 通过 | 含新增发现/准入 fixture 用例 |
| e40357ad + 本次改动 | Windows / Node 24.16 | `npm run typecheck:all` | 0 | 全仓类型检查通过（178 个已基线错误，无新增） |
| e40357ad + 本次改动 | Windows / Node 24.16 | `npm run architecture:check` | 0 | 无新增边界违规（2999 均为 baseline） |
| 2d2dc7d1 + 复核改动 | Windows / Node 24.16 | `npx vitest run --root . packages/ai/test` | 0，56 文件 / 560 通过 | 含 deprecated 与 `--write` 用例 |
| 2d2dc7d1 + 复核改动 | Windows / Node 24.16 | `npm run typecheck:all` | 0 | 全仓类型检查通过 |
| 2d2dc7d1 + 复核改动 | Windows / Node 24.16 | `npm run architecture:check` | 0 | 无新增边界违规 |
| 2d2dc7d1 + 复核改动 | Windows / Node 24.16 | `npm run plan:sync` | 0 | 计划表与仓库一致 |
| 2d2dc7d1 + 复核改动 | Windows / Node 24.16 | `node packages/ai/scripts/sync-models.mjs --report=<tmp>`（真实上游，只读） | 0 | 报告 47,117 字节；OpenAI 仅自动准入 `gpt-6.1-terra`；`deepseek-v4-flash` 等 deprecated id 不再上架 |

## 接续 / 结果

- 已实现（#441，已合并）：19 个 provider shard 刷新 + 1 个新增（小米 MiMo）、预设默认模型对齐、同步脚本重写、
  目录一致性用例、worker bundle 重建。
- 已实现（后续 PR）：模型 id 排序去本地化、openrouter 价格随上游漂移刷新 + bundle 重建、夜间刷新 workflow。
- 已验证：见上表（本地全绿）。
- PR：#441 https://github.com/lava-chen/duya/pull/441 （已合并，merge commit c426d029）；
  夜间刷新 #442 已合并；目录自动合并 #537 已合并（`1ebe97d0`，merge `07341c28`）。
- 已实现（本次分支，未推送、未建 PR）：发现与准入分离（同步脚本）、`--report` / `--discover`、
  `.github/workflows/model-catalog.yml` 的发现报告与 job summary、离线 fixture 用例；分支已 rebase 到
  `1653a238`，与 #537 的自动合并步骤共存（保留目录-only 校验与自动 merge，报告只加不改合并语义）。
- 未提交路径：见工作树 `git status`。
- 副作用：worker bundle 产物变化（`packages/host/bundle/**`），属本次改动的应有产物。
- 阻塞：无技术阻塞。
- 回收：未回收——后续 PR 尚未集成，需保留分支与检出。

下一步：由人工复核本次提交后建 PR；合并仍由获授权的集成者处理，本 agent 不自行合并。

