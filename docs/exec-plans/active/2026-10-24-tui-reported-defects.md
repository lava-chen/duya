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

每次跑构建链都会把 `packages/capabilities/src/ModuleTool/inline-content.ts` 写成 CRLF，内容不变（去 CR 后 `md5` 与 HEAD 相同），
但 `bundle:verify` 用 `git status --porcelain` 判定，于是报「1 uncommitted input / STALE」。
2026-10-25 逐个复跑定位到确切来源：**是 `npm run typecheck:all`**（`vitest` 与 `architecture:check` 单独跑都不脏它）——
它经 `scripts/build-packages.mjs:379` 调 `scripts/inline-modules.mjs`，从 `ModuleTool/modules/*/README.md` 重新生成该文件，
`writeFileSync` 直接落平台行尾。仓库是 `core.autocrlf=false` + `.gitattributes` 的 `* text=auto`，
所以不是 checkout 转换，而是生成器写入 CRLF、blob 却是 LF，`git status` 因此报脏。
处理顺序由此确定：**门禁先跑、`bundle:verify` 放最后，中间 `git checkout --` 该文件**，不要把它混进本任务提交。
连带影响：worker bundle 的字节会跟着内联文本的行尾变（`bytesInOutput` 在 1955 / 1968 之间摆），
本机重复构建不复现同一字节；本任务因此不追产物噪声，只在合并 commit 里保留 CI 已验过的那一份。

### 二次同步 master（`40d3de56`）

创建 PR 后 #457 合入 master（`dc6d4ee7`），PR #469 转为 CONFLICTING。#457 只给工具结果补 `status: 'success'`，
没有改 `buildToolResultEnvelope` 的文本，所以第 1 项的解包前提仍然成立；合并后按新树整体重验：

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `40d3de56`（merge `origin/master`）+ 无本地未提交 | Win10 26200 x64 / Node 24.16.0 | `npx vitest run --pool=forks packages/cli packages/agent-runtime/test/tools/execution/streaming-tool-executor.test.ts packages/agent-runtime/test/run-engine-ports-drain.test.ts packages/host/tests/worker-config/provider-catalog.test.ts` | 0 · 106 files / 1289 tests passed | 冲突仍只有 `packages/host/bundle/**`，重建解决；含 #457 的工具状态用例与 `run-engine-ports-drain` |
| 同上 | 同上，真 provider | 真 PTY 一轮真实 turn（`todo` 工具） | 0 | 转写区 `└ ✔ Todo list 0/1` 加 `○ 写解析`，底部 `↓6 Σ6 · ⚡ 4.3 tok/s`——`?` 已被 #457 换成 `✔`，证明两侧改动可叠加 |
| 同上 | 同上 | `npm run typecheck:all` · `npm run architecture:check` · `npm run bundle:verify` | 0 · 0 · 0 | 架构仍 2730 条全在既有 baseline（「2 fingerprints no longer triggered」未重录，不用 `--write`）；bundle FRESH 0/950 |

### 三次同步 master（`baf1bcfc`）

PR 描述与实录提交推上去之后，master 又前进 7 个 commit——PR #466 改了 `packages/data/src/message-log.ts` 的读路径并附带
重建的 worker bundle（`275abfd9`），PR #469 因此变成不可合并。合并后按新树重验：

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `baf1bcfc`（merge `origin/master`）+ 无本地未提交 | Win10 26200 x64 / Node 24.16.0 | `npx vitest run --pool=forks packages/cli packages/agent-runtime/test/tools/execution/streaming-tool-executor.test.ts packages/agent-runtime/test/run-engine-ports-drain.test.ts packages/host/tests/worker-config/provider-catalog.test.ts packages/data/tests/message-log-read-range.test.ts` | 0 · 107 files / 1293 tests passed | 冲突仍只有 `packages/host/bundle/**`（worker-entry + metafile），`npm run bundle:worker` 从合并后源码重建解决；多出的 4 个用例来自 master 的读路径改动 |
| 同上 | 同上 | `npm run typecheck:all` · `npm run architecture:check` · `npm run bundle:verify` | 0 · 0 · 0 | `bundle:verify` 必须放在最后跑（行尾陷阱见上）；干净树上 FRESH 0/950 |
| 同上 | 同上，真 provider | 真 PTY 一轮真实 turn | 1 · `✗ fetch failed` | **本轮真机验收未完成，且与本任务改动无关**：最小 prompt（「只回一个字」）也 `fetch failed`；`api.minimaxi.com` / `api.minimax.cn` / `api.minimax.io` 三处 `curl` 均可达（根路径 404），`POST https://api.minimaxi.com/anthropic/v1/messages` 返回 401（说明 TLS 与出网正常，是无凭据的预期码），本机无 proxy 环境变量。判别实验：`git checkout 40d3de56 -- packages/host/bundle`（真机 1.5 小时前刚成功的那一版）后跑同一 prompt，仍 `✗ fetch failed` → 归因于环境（provider 侧或凭据获取），不是合并或重建 bundle 引入。跑失败时 `docs-local/tui-frames.jsonl` 未生成，说明 turn 在产帧前就断了；`~/.duya/logs/background-host.log` 记录 worker 用的正是本检出的 `packages/host/bundle/worker-entry.js`，Host 正常 listen |

阻塞与解除条件：出网恢复后用同一脚本重跑
（`MSYS_NO_PATHCONV=1 node docs-local/tui-pty-repro.mjs` 加 todo 提示词），转写区出现 `└ ✔ Todo list`、底部出现 `⚡ N.N tok/s` 即解除。

### 四次同步 master（`f820ff99`）

`9bdb896f` / `6dec8d45` 两个实录 push 之后，PR 又变 CONFLICTING：master 带进 PR #454（忙时 steer / queue / stop-and-send，
`4533c3cc`）。它改 `TUIApp.ts`、`turn-queue.ts`、`actions.ts`、`dev/preview.ts`，与本任务的 `footer.ts`、`todo.ts`、
`slash/*` 无文本重叠，git 自动合并干净；为排除语义撞车（两者都经 `TUIApp.ts` 驱动底部行）整体重跑：

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `f820ff99`（merge `origin/master`）+ 无本地未提交 | Win10 26200 x64 / Node 24.16.0 | 同上五条测试目标 | 0 · 108 files / 1318 tests passed | 冲突仍只有 `packages/host/bundle/**`，`npm run bundle:worker` 重建解决；新增的 25 个用例来自 steer 的 `tui-busy-draft-keys` / `turn-queue` |
| 同上 | 同上 | `npm run typecheck:all` · `npm run architecture:check` · `npm run bundle:verify` | 0 · 0 · 0 | 架构 baseline 从 2730 降到 **2530**（master 的重构缩了债），「2 fingerprints no longer triggered」依旧不重录；bundle FRESH 0/950 |
| 同上 | 同上，真 provider | 真 PTY 一轮真实 turn | 1 · `✗ fetch failed` | 环境未恢复：`build:cli-dev` 后重跑同一 prompt 仍失败，与上一条的判别结论一致（旧 bundle 同样失败），不是 steer 合并引入 |

### PR head CI

| SHA | 环境 | 命令或操作 | 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `fb78ed13`（本轮实录提交，即 PR head） | GitHub Actions ubuntu-latest / Node 22.x | `gh run view 40109121091` | success | 5 个 job 全绿：test scope 9s、architecture 2m27s、typecheck 6m55s、test 4m21s、build 2m10s；PR `MERGEABLE` / `mergeStateStatus CLEAN` |
| `bbeb9e04` · `baf1bcfc` | 同上 | `gh run view 40109781940` · `gh run view 40146195715` | success · success | 两次 head 各自 5 个 job 全绿，含合并 master 之后的 `baf1bcfc` |

master 规则集 `Protect master branch` 的 `required_status_checks` 为空且 `required_approving_review_count = 0`，
所以这 5 项都是非必需检查——按仓库约定仍逐条记录，非必需失败由获授权的集成者评估，本次无失败。

### 在途 PR 冲突面（2026-10-24 对 16 个 open PR 逐个 `gh pr view --json files` 比对）

- 源码零重叠：`todo.ts`、`footer.ts`、`slash/model.ts`、`slash/effort.ts`、协议目录、Host 目录读取器都只本任务在改。
- 会撞的只有两处，且都是追加：`docs/exec-plans/README.md` 的表行（#454 #464 #466 #467 #468 都改），
  `packages/cli/src/tui/slash/__tests__/slash-commands.test.ts`（#463 #464 也在加命令用例）。
- 本轮四次 `git merge origin/master` 的冲突都只是 `packages/host/bundle/**`，一律用 `npm run bundle:worker`
  从合并后源码重建解决，不手改产物。
- PR #457（工具状态 indeterminate）在本任务开工时是在途 CONFLICTING，故第 1 项只修解析、不碰状态位；
  它已合入 `dc6d4ee7`，合并后真机重跑显示 `└ ✔ Todo list 0/1`，两边改动可叠加。

## 接续 / 结果

- 已实现：三项全部落地，含 `/effort` 的连带修正。
- 已验证：单元、真机 PTY、typecheck、architecture、bundle 重建；四次合入 `origin/master`（`4bf210cc` 12 个 commit，含重写行内绘制的 PR #455；`40d3de56` 带进 PR #457；`baf1bcfc` 带进 PR #466 的读路径改造；`f820ff99` 带进 PR #454 的忙时 steer）后各重跑一遍，最新全量为 108 files / 1318 tests。
- 待补：`baf1bcfc` 起的真机一轮 turn 未完成——provider 调用返回 `fetch failed`，判别实验证明旧 bundle 同样失败，属环境侧；自动化门禁与各 head 的 CI 均已过，解除条件见「三次同步」。
- CI 覆盖缺口：`9bdb896f` 与 `6dec8d45` 两个 push 之后 `gh run list --branch` 里查不到对应的 `pull_request` run（同期别的分支有 run），所以不能假定「每个 push 都有检查」；集成前应核验**最新 head** 上确实有 run，而不是引用上一个 head 的绿色结果。
- 未合并：PR #469 https://github.com/lava-chen/duya/pull/469（GitHub 侧无必需 review / 必需检查，保持可 review，未获授权不合并）。
- 副作用：`packages/host/bundle/**` 为重建产物，随源码同 commit 交付。
- 回收：PR 集成、master 重验后由本 agent 走 managed 工具回收；未集成前保留分支与检出。
- 下一步：请用户授权集成——验收条件（无冲突、最新 head 有 run 且全绿、工作树干净）里只剩「最新 head 的 CI」与真机补验两项待落；获授权后用 merge commit 合并，再同步 master 重验并回收检出。
