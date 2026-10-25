# 内置插件随本体分发（builtin plugin distribution）

状态：active · 负责人：本会话 · 更新：2026-10-24
分支：主仓 `codex/builtin-plugin-distribution`（worktree `E:/Projects/duya/.claude/worktrees/builtin-plugin-distribution`，base origin/master 3a687e41）· marketplace 仓 `feat/builtin-plugins`（worktree `E:/Projects/duya-marketplace/wt/builtin-plugins`，base origin/main bf26086）· owner：本会话

## 目标与边界

让 duya 的发行包自带"必装插件"资产：marketplace 仓声明哪些插件随本体分发 → 构建时打进安装包 → 启动时 seed 到本地插件缓存 → 出现在商店并按清单决定默认启停。

改动落在三个地方：duya-marketplace 仓（内置清单）、duya 主仓（seed 加固 + 清单执行 + 构建流水线）、computer-use 插件（驱动缺失时的指引）。

不改动：插件的权限裁决与审批 UI、市场（marketplace）的克隆/同步语义、插件的工具命名。

关联：[computer-use 插件审计](2026-10-24-computer-use-plugin-audit.md)（本次要随本体分发的插件本体）、[455 开放连接器注册表](455-open-connector-registry.md)（marketplace 目录结构的由来）。

## 现状（已核实）

- **duya 已有 builtin 通道**：主仓 `packages/plugin-core/src/plugins/builtin/` 有 10 个内容型插件 → `electron-builder.yml:111-116` 的 `extraResources` 打进 `builtin-plugins/` → `apps/desktop/src/main/index.ts:512` 调 `syncBuiltinPlugins()` → `apps/desktop/src/main/plugins/catalog.ts:831` 复制到 `~/.duya/plugins/cache/builtin/<id>/<version>/` → `catalog.ts:197` `getBuiltinCatalogEntries()` 让它们出现在商店。
- **缺的是"marketplace 仓的插件进不了发行包"**：marketplace 仓 15 个插件（app-builder/browser/computer-use/conductor-canvas/feishu/linear/playwright/slack/supabase/vercel…）全靠市场克隆，新装用户必须自己联网装。
- **两个仓有 6 个插件同名双份**（documents/github/notion/pdf/presentations/spreadsheets），`catalog.ts:305-310` 的注释就是在处理这个重复 id。
- **`policy.installation` 已有 `installed_by_default`**（`packages/plugin-core/src/formats/registry.ts:109`、`apps/desktop/src/main/plugins/types.ts:281`），但**只有类型与透传，没有执行方**。
- **现有 seed 缺四道保护**：无完整性校验（缺文件照装）、无 sha256、无原子替换、无并发锁；桌面端多 workspace Agent 并发启动会写坏缓存。
- **ZCode 的参照实现**：`apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts:100`（显式清单：version/rootCandidates/requiredSeedPaths/defaultEnabled/listing）、`bundled-plugins.ts:91`（seed + sha256 + 原子替换 + 锁 + 降级）、`bootstrap/tests/plugins.test.ts:168`（package==manifest==definition 版本一致）。

## 验收

- marketplace 仓根有 `builtin-plugins.json`，声明 computer-use 的路径、必需文件与默认启停；**版本号不在清单里**（读插件自己的 manifest，避免三处漂移）。
- `npm run electron:build` 在本地能跑通：marketplace 仓不在本地时 stage 步骤跳过并降级，不阻断构建；发行流水线里缺 marketplace 仓则**构建失败**（发一个不带必装插件的包是坏包）。
- 发行包里 marketplace 内置插件在 `resources/builtin-marketplace-plugins/`（与主仓自带的 `builtin-plugins/` 分开）；清单同在这个目录里。
- 缺必需文件的插件**不被 seed**，已 seed 的旧版本继续可用。
- 启动后内置插件被注册为已安装，registry 里 `plugins.<id>@<marketplace>.enabled` 按清单的 `defaultEnabled` 落定；用户改过的状态不被覆盖。
- `syncBuiltinPlugins` 的并发启动不会写坏缓存（锁 + 原子替换）。
- computer-use 在驱动缺失时给出可执行指引（官方安装器），不静默失败。

## 进度

- [x] S0 现状核实与设计定稿（路线 B + 驱动不进包）
- [x] S1 marketplace 仓：内置清单 → `builtin-plugins.json` + README
- [x] S2 主仓：seed 加固 → `builtin-manifest.ts` / `builtin-seed.ts`，seed 改为 copy-then-swap
- [x] S3 主仓：清单 `defaultEnabled` 的执行 → `builtin-install.ts`，走既有 `installFromCatalog`
- [x] S4 构建流水线 → `scripts/stage-builtin-plugins.mjs` + `electron-builder.yml` + `release.yml`
- [x] S5 computer-use 驱动引导 → 错误信息 / README / SKILL.md 指向官方安装器
- [x] S6 提交、PR、验证记录

## 决策

- **清单放 marketplace 仓**（`builtin-plugins.json`），不放主仓：插件仓是插件的单一事实源，主仓只提供分发通道。清单随插件一起打进安装包，启动时从 marketplace 插件目录读。
- **版本号不进清单**：读插件自己的 `.duya-plugin/plugin.json`，只有一处要 bump（ZCode 那种 definition/manifest/package 三处版本会漂）。
- **内置插件仍走既有 marketplace 命名空间**（builtin 条目的 `source` 是 `builtin-directory`，注册键为 `plugins.<id>@builtin-directory`），复用现有 catalog 与 registry 语义，不新增第三种来源。安装路径就是普通 `installFromCatalog`，不新造。
- **`installed_by_default` 保留为商店语义**，"随本体分发"由清单单独表达：一个是商店展示策略（Codex 语义），一个是发行属性（打包行为），两者不是一个维度。
- **computer-use 默认关闭**：它带 MCP server 与外部驱动，对齐 ZCode 2026-09-11 的产品决策（带系统依赖的插件不默认注入工具集）。
- **cua-driver 不进安装包**：36MB 第三方二进制、自带 `install.ps1`/`install.sh`、有独立授权模型；由用户在设置页用驱动自带安装器安装。
- **清单缺必需文件时拒绝 seed**，并降级到已有的旧版本缓存，不装残缺插件、不阻断启动。
- **清单坏掉时不阻断既有内置插件**：读不出清单时按"无清单"降级（照旧 seed 主仓自带的 10 个），只是不执行任何默认值；清单本身由构建期的 stage 脚本校验，构建期就已经拦住坏清单。
- **marketplace 插件单独暂存**（`resources/builtin-plugins/` → 打包为 `builtin-marketplace-plugins/`），不塞进主仓自带的 `builtin-plugins/` 目录：前者是 gitignore 的暂存区（一条规则管住），后者是被 git 跟踪的源码目录；两者在磁盘上分开，也就不依赖 electron-builder 对同一个 `to` 多源合并的行为。
- **清单里的 `name` 是目录名**，运行时按目录名找插件，`path` 只在构建期用来定位源码。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| bf26086（干净，origin/main） | Windows / Node 24.16.0 | 目录与配置核对 | 0；marketplace 15 个插件、主仓 builtin 10 个、6 个同名 | `packages/plugin-core/src/plugins/builtin/`、`marketplace.json` |
| marketplace f7b6062 | Windows / Node 24.16.0 | 清单与磁盘核对 | 0；6 条 requiredPaths 全部存在，`com.duya.computer-use@0.6.0`，`defaultEnabled=false` | `builtin-plugins.json` |
| marketplace 03661a3 | Windows / Node 24.16.0 | `node --test plugins/computer-use/test/*.test.cjs` | 0；116 例，115 通过 / 1 skip（真实驱动例） | 改动只碰提示文案，无协议变更 |
| 主仓 7b1ef9b5 | Windows / Node 24.16.0 | `vitest run apps/desktop/src/main/plugins/builtin-{manifest,seed,install}.test.ts` | 0；22 例全过 | 含缺文件拒 seed、旧版本留存、锁跳过、staging 无残留 |
| 主仓 7b1ef9b5 | 同上 | `vitest run apps/desktop/src/main/plugins` | 0；16 文件 155 例全过 | 无插件侧回归 |
| 主仓 0a833dac | 同上 | `node scripts/typecheck-electron-gate.mjs` | 0；OK — no new type errors | 中途修掉 2 处 LogComponent/logger.error 用法错误 |
| 主仓 e52c10f2 | 同上 | `node scripts/architecture/bundle-verify.mjs` | 0；FRESH 0/928 | 我的改动不进 worker bundle 输入集（实测 0 个 `plugins/builtin` 输入） |
| 主仓 e52c10f2 | 同上 | `check:encoding` / `check:manifest-keys` / `check:test-coverage` / `check:no-ts-suppress` | 全部 0 | |
| 主仓 e52c10f2 | 同上 | `node scripts/stage-builtin-plugins.mjs` 四条路径 | 正常 → 退出 0 并暂存 1 个插件；缺 marketplace → 退出 0 跳过；strict 缺 marketplace → 退出 1；插件缺必需文件 / 路径越界 → 退出 1 | 坏清单在构建期就被拦住 |
| 主仓 e52c10f2 | 同上 | `vitest run apps/desktop/src/main` | 1；3505 例中 3493 通过、0 断言失败，2 个 suite 级失败：`memory-worker.test.ts`（解析不到 better-sqlite3）、`stt-worker.test.ts`（worker 起不来） | 两个都是本 worktree 的环境问题，与本改动无关 |

## 接续 / 结果

已实现并推送：

- marketplace 仓 PR #4（draft）：`feat(builtin): add the builtin plugin distribution manifest` + `fix(computer-use): point a missing driver at the official installer`
- 主仓 PR #445（draft）：`feat(plugins): harden the builtin plugin seed` / `feat(plugins): register the builtin plugins the app ships with` / `build: stage the marketplace builtin plugins into the installer`

仍需人工：

1. `E:\Projects\duya-marketplace\wt\.staging` 需要手工删除（工作区外，策略拒绝自动删除与移入）。
2. 真实驱动的输入路径仍需在可控窗口上手工跑一次（真实点击/键入），确认收据的 `outcome`/`action_sent` 与驱动实际行为一致。
3. PR 评审：主仓 PR 的 CI 只会跑"受影响文件集"，release 流水线的 marketplace checkout 与 stage 步骤要等合并后才能实跑验证。
