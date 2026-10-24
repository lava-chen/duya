# TUI 三项用户反馈缺陷：todo 不显示、模型只能选 config 已有、底部统计不美观

状态：active · 负责人：本会话（tui-polish） · 更新：2026-10-24
分支：`codex/tui-polish` · worktree：`.claude/worktrees/tui-polish` · base：`379d990b` · owner：Qoder 会话 `1cab68f9`

## 目标与边界

用户在 `duya tui` 里报告的三件事，改完后他应当能观察到：

1. 模型写 todo list 时，转写区出现一条可折叠的 `Todo list n/m` 行，而不是什么都不显示。
2. `/model` 除了 `config.toml` 里 `enabled_models` 写过的模型，还能选该 provider 厂商的预设立模型；选中后行尾标 `preset`，并明确告知没有改写 `config.toml`。
3. 底部统计行不再是一串无差别数字：`↑ ↓ Σ`、上下文占用、`⚡ tok/s` 三组用 ` · ` 分开，速度用强调色。

允许修改的路径：`packages/cli/src/tui/**`、`packages/host/src/worker-config/provider-catalog.ts`、`packages/agent-protocol/src/provider-catalog.ts`、对应测试、`packages/host/bundle/**`（重建产物）。

本次不处理：

| 范围 | 为什么不处理 |
| --- | --- |
| 工具状态行的 `?`（indeterminate） | PR #457 已在途且 CONFLICTING，重复实现必然撞车 |
| 把 preset 写进 `config.toml` | Host 唯一的 config 写者 `../config-agents` 只动 `[agents]`；从选择器重写手工编辑的文件不是本任务的权利 |
| 上下文占用组在某些 provider 上缺席 | `stats.contextBudget` 本身为 null，属数据来源，不是行渲染；本次只保证「有 budget 时分组正确」 |
| minimax-cn 上报 `input_tokens = 0` | provider 侧事实，`↑` 省略是既有设计 |

关联：[CLI todo 渲染](2026-10-23-cli-todo-list-render.md)（第 1 项的原始计划）、[输出速度 tok/s](2026-10-23-output-token-rate.md)（第 3 项的速度标签来源）。

## 验收

```bash
npx vitest run --pool=forks \
  packages/cli/src/tui/__tests__/tui-todo-list.test.ts \
  packages/cli/src/tui/__tests__/footer.test.ts \
  packages/cli/src/tui/__tests__/tui-model-selector.test.ts \
  packages/cli/src/tui/slash/__tests__/slash-commands.test.ts \
  packages/host/tests/worker-config/provider-catalog.test.ts
npm run typecheck:all
npm run architecture:check
npm run bundle:verify
```

真机路径（无 mock，`duya tui` 起临时 Host + 真 worker + 真 provider）：

- `/model` 面板出现 `… · preset` 行，Enter 后打印 `Model switched to <preset> (<provider>). … is not written into config.toml.`。
- 一轮真实回答后底部显示 `↓N ΣN · ⚡ N.N tok/s`。
- 真实 turn 里 `todo` 工具完成后转写区显示 `└ ✔ Todo list 1/3` 与逐条状态。

## 进度

- [x] 第 1 项：`parseTodoItems` 先剥执行器包的结果信封，再从 JSON 取清单
- [x] 第 3 项：底部统计分三组、速度用强调色、上下文仍是唯一告警色
- [x] 第 2 项：契约加 `presetModels`（Host 从 `BUILTIN_CATALOG` 读，剔除已配置 id，未知 provider 不编造）
- [x] 第 2 项：`/model` 列 preset 行、标 `preset`、preset 排在本 provider 配置行之后、切换后说明未写文件
- [x] 第 2 项连带：`/effort` 的档位读取覆盖 `presetModels`，否则选 preset 后档位退化成默认四档
- [x] 单元与真机验证
- [x] 门禁与 bundle 重建
- [ ] PR 集成后回收 worktree

## 发现与决策

- **todo 不显示不是渲染缺失，是解析入口没料到信封。** 执行器把工具结果包成 `[completed] todo\n<content>\n[Duration: Nms]` 再交给模型，TUI 收到的正是这一串；`parseTodoItems` 要求首字符是 `{`，于是整条清单被丢弃。单测一直喂裸 JSON，所以绿灯与真机同时成立。决定：在解析处剥信封，而不是让执行器为 TUI 另发一份未包装结果——后者会让「模型看到的」和「客户端看到的」再次分叉。
- **provider 的可选模型只有一个真源。** 旧 `/model` 读 `provider_model_capabilities`（Desktop 编辑器与 models API 写的 OVERRIDE 表），在纯 `config.toml` 安装上恒为空。本次沿用 `getProviderCatalog()`：它读 `[providers.*]`，再用 `@duya/ai` 内置目录补 context window / reasoning / 档位。
- **preset 单独成字段，不并进 `models`。** `packages/ui/src/lib/ipc-client.ts` 用 `provider.models` 反推 `enabled_models`；合并会让 Desktop 把preset 当成已配置项写回文件。保持 `presetModels` 与 `models` 分离后，Desktop 的写侧一行都不用改。
- **preset 用切换、不用注册。** `resolveModel` 对「provider 服务但 `enabled_models` 未列」的模型只告警不拒绝，所以选中 preset 能直接跑；代价是它不在配置里，故提示文案必须说清没有写 `config.toml`。
- **`findPresetEntry` 只取第一个前缀匹配。** 内置目录把一个厂商拆成多个端点（`glm-cn` / `glm-global`、`anthropic-official` / `anthropic-thirdparty`）。合并两个区域的清单会产出一行「看着对、计费不同」的模型；取第一个至多给出一条用户看得见、可否决的建议。`category === 'media'` 的条目排除，与字段注释一致。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `379d990b` + 6 源文件（todo / footer / slash model / slash effort / 协议目录 / Host 目录）+ 5 测试文件 | Win10 26200 x64 / Node 24.16.0 | `npx vitest run --pool=forks <5 个受影响文件>` | 0 · 127 passed | todo 15、footer 24、model selector 4、slash 75、provider catalog 9 |
| 同上 | 同上 | `npx vitest run --pool=forks packages/cli` | 0 · 103 files / 1258 tests passed | 含 `packages/cli/test/tui-pty.test.ts` 两个真 PTY 用例；`AttachConsole failed` 是 node-pty 退出噪声，不是用例失败 |
| 同上 | 同上 | `npm run typecheck:all` | 0 | evals 门禁仅报基线收缩提示，无新错误；`/effort` 改动后重跑一次，仍 0 |
| 同上 | 同上 | `npm run architecture:check` | 0 | 2730 条全部落在既有 baseline；「2 fingerprints no longer triggered」未重录，不用 `--write` 掩盖；`/effort` 改动后重跑一次，仍 0 |
| 同上 | 同上 | `npm run build:cli-dev` | 0 | worker-entry 4.47 MB、cli.cjs 3.60 MB |
| 同上 | 同上 | `npm run bundle:verify` | 1 · STALE | 提交 bundle 前的预期结果，随后 `git add packages/host/bundle` 重跑 |
| 同上 | 同上，真 provider | 真 PTY 驱动 `duya tui`：`/model` → 选中 preset 行 | 0 | 面板出现 `MiniMax-M2.5 … · preset`、`MiniMax-M3.1-Flash … · preset`；切换后打印 `Model switched to MiniMax-M3.1-Flash (MiniMax CN). … is not written into config.toml.` |
| 同上 | 同上，真 provider | 真实一轮回答后读底部 | 0 | `↓3 Σ3 · ⚡ 2.1 tok/s`，模型名右对齐；上下文组缺席因 `contextBudget` 为 null |
| 同上 | 同上，真 provider | `todo` 工具完成一轮 | 0 | 转写区 `└ ✔ Todo list 1/3` 加逐条状态（第 1 项修复后首次真机可见） |

驱动脚本 `docs-local/tui-pty-repro.mjs` 是一次性工具，不入库；两个坑记录在此：Git Bash 会把 `/model` 参数转换成 `C:/Program Files/Git/model`（需 `MSYS_NO_PATHCONV=1`），以及同一 burst 里的 `\r` 会被 ConPTY 吞掉，按键必须分帧发送。

### 合入 master 之后（`4bf210cc`）

master 在本任务期间前进了 12 个 commit，其中 PR #455 重写了 `packages/cli/src/tui/terminal/surface.ts`
与 `TUIApp.ts` 的行内绘制，正是本任务三处改动的输出通道，所以整体重验：

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `4bf210cc`（merge `origin/master`）+ 无本地未提交 | Win10 26200 x64 / Node 24.16.0 | `npx vitest run --pool=forks packages/cli packages/host/tests/worker-config/provider-catalog.test.ts` | 0 · 104 files / 1266 tests passed | 冲突只有 `packages/host/bundle/**`，用 `npm run bundle:worker` 从合并后源码重建解决，不手改产物 |
| 同上 | 同上 | 真 PTY 一轮真实 turn（真 provider + 真 worker） | 0 | 转写区 `└ ? Todo list 0/3` 加三条 `○ 读 schema / 写解析 / 跑测试`；底部 `↓6 Σ6 · ⚡ 5.2 tok/s` |
| 同上 | 同上 | `npm run typecheck:all` · `npm run architecture:check` · `npm run bundle:verify` | 0 · 0 · 0 | 合并后全部重跑；架构仍是 2730 条全在既有 baseline，未用 `--write`；bundle FRESH 0/950 |

真机那行的 `?` 是工具状态 indeterminate，属 PR #457 的在途范围，本次不重复实现；它与本任务无关，因为清单主体与计数本来就渲染对了——这正是第 1 项要的效果。

`npm run bundle:worker` 会顺手把 `packages/capabilities/src/ModuleTool/inline-content.ts` 的行尾重写成 LF，内容不变（`md5` 去 CR 后与 HEAD 相同），但 `bundle:verify` 用 `git status --porcelain` 判定，于是报「1 uncommitted input / STALE」。处理是核对内容一致后 `git checkout --` 该文件，不是把它混进本任务提交。

### 二次同步 master（`40d3de56`）

创建 PR 后 #457 合入 master（`dc6d4ee7`），PR #469 转为 CONFLICTING。#457 只给工具结果补 `status: 'success'`，
没有改 `buildToolResultEnvelope` 的文本，所以第 1 项的解包前提仍然成立；合并后按新树整体重验：

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `40d3de56`（merge `origin/master`）+ 无本地未提交 | Win10 26200 x64 / Node 24.16.0 | `npx vitest run --pool=forks packages/cli packages/agent-runtime/test/tools/execution/streaming-tool-executor.test.ts packages/agent-runtime/test/run-engine-ports-drain.test.ts packages/host/tests/worker-config/provider-catalog.test.ts` | 0 · 106 files / 1289 tests passed | 冲突仍只有 `packages/host/bundle/**`，重建解决；含 #457 的工具状态用例与 `run-engine-ports-drain` |
| 同上 | 同上，真 provider | 真 PTY 一轮真实 turn（`todo` 工具） | 0 | 转写区 `└ ✔ Todo list 0/1` 加 `○ 写解析`，底部 `↓6 Σ6 · ⚡ 4.3 tok/s`——`?` 已被 #457 换成 `✔`，证明两侧改动可叠加 |
| 同上 | 同上 | `npm run typecheck:all` · `npm run architecture:check` · `npm run bundle:verify` | 0 · 0 · 0 | 架构仍 2730 条全在既有 baseline（「2 fingerprints no longer triggered」未重录，不用 `--write`）；bundle FRESH 0/950 |

### 在途 PR 冲突面（2026-10-24 对 16 个 open PR 逐个 `gh pr view --json files` 比对）

- 源码零重叠：`todo.ts`、`footer.ts`、`slash/model.ts`、`slash/effort.ts`、协议目录、Host 目录读取器都只本任务在改。
- 会撞的只有两处，且都是追加：`docs/exec-plans/README.md` 的表行（#454 #464 #466 #467 #468 都改），
  `packages/cli/src/tui/slash/__tests__/slash-commands.test.ts`（#463 #464 也在加命令用例）。
- 本轮两次 `git merge origin/master` 的冲突都只是 `packages/host/bundle/**`，一律用 `npm run bundle:worker`
  从合并后源码重建解决，不手改产物。
- PR #457（工具状态 indeterminate）在本任务开工时是在途 CONFLICTING，故第 1 项只修解析、不碰状态位；
  它已合入 `dc6d4ee7`，合并后真机重跑显示 `└ ✔ Todo list 0/1`，两边改动可叠加。

## 接续 / 结果

- 已实现：三项全部落地，含 `/effort` 的连带修正。
- 已验证：单元、真机 PTY、typecheck、architecture、bundle 重建；两次合入 `origin/master`（`4bf210cc` 12 个 commit，含重写行内绘制的 PR #455；`40d3de56` 带进 PR #457）后各重跑一遍，最新全量为 106 files / 1289 tests。
- 未合并：PR #469 https://github.com/lava-chen/duya/pull/469（head `40d3de56`，状态 MERGEABLE，保持可 review，未获授权不合并）。
- 副作用：`packages/host/bundle/**` 为重建产物，随源码同 commit 交付。
- 回收：PR 集成、master 重验后由本 agent 走 managed 工具回收；未集成前保留分支与检出。
- 下一步：等 PR #469 head 的必需 review 与必需 CI 全绿，再请用户授权集成；集成后同步 master 重验并回收检出。
