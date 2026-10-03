# 执行记录与 Handoff

本文件只记录简洁事实、证据位置和下一动作。完整原始输出放忽略验证目录；不记录credentials、用户消息、原始大量终端日志。

## 当前基线

2026-10-03由G0.1在本隔离分支实测刷新。原始证据目录：`E:\Projects\duya\.tmp-validation\587-g0\`（gitignored，不提交）。下文只记摘要与文件名。

### 接管点

| 事实 | 值 |
| --- | --- |
| HEAD | `0e13d4cd944809888e39f3b53e8f8e81d2ec409a`（= `origin/master`，也是最新CI 37099318050的SHA） |
| 分支 / 工作树 | `plan/587-g0-baseline` / `.claude/worktrees/587-g0` |
| 启动时`git status` | clean |
| 开放PR | **0**（最近30个PR全部MERGED/CLOSED） |
| 远端分支 | 129个；`origin/HEAD -> master`；**`main`/`develop`不存在** |
| workspace context工具 | **不可用**，未编造共享任务状态 |
| `@duya/*`解析 | 12个workspace链接与4个起点的`require.resolve`全部落在本工作树内 |

### 环境

| 事实 | 值 |
| --- | --- |
| 平台 | Windows NT 10.0.26200.0 (win32/AMD64) |
| Node / npm | v24.16.0（NODE_MODULE_VERSION **137**）/ 11.13.0 |
| `better-sqlite3` ABI | **137，本地Node下实际加载成功**（SQLite 3.53.4），全程未遇mismatch |
| Electron ABI（对照） | 149 / electron 44.2.0 |
| 安装状态 | **clean**：全新`npm ci`，无junction、无暖`node_modules`、无dist/tsbuildinfo |
| CI对照 | Node **22.x** × ubuntu/windows/macos |

### 门禁退出码（本机实测）

| 命令 | 退出码 | 说明 |
| --- | --- | --- |
| `npm ci` | **1** | 见下方"未达成项" |
| `npm test` | **1** | 101 failed tests / 45 failed files（warm口径） |
| `npm run typecheck:all` | **0** | 154s，clean安装下通过 |
| `npm run build` | **0** | 87s，vite build |
| `npm run architecture:check` | **0** | total 802 = tolerated 802 = baseline 802，新增**0** |
| `npm run architecture:self-test` | **0** | 7类期望计数合计802，独立复现同一数字 |
| `npm run typecheck:electron`（单跑） | **1** | 49个TS2307，见下方"构建次序" |
| `npm run typecheck:electron`（在`typecheck:all`内） | **0** | `OK — no new type errors (303 known across 148 key(s))` |

### 失败集合（按file+test+signature，非按总数）

WARM口径（唯一可与CI对比的口径）：1009文件/11873测试全部collect，**45失败文件 / 101失败测试 / 1 unhandled error**，exit 1。

分类：**77 deterministic产品/测试失败 / 25 environment-infra / 1 已证flake**。

- flake仅1个，且**经过二次运行证实**：`stream-session-manager.test.ts` 的 "Phase transitions transitions through correct phases"。8个疑似flake文件已单独重跑，23个失败中**22个原样复现**，只有该1个第二次通过。其余80个tuple记为"单次观测（未重跑）"，不冒充稳定。
- Linux CI 37099318050（同一SHA）：**64失败文件 / 188失败测试 / 1 error**，collect量与本机完全一致（1009/11873）。**"45 vs 64"不得当作回归或修复**——OS不同，且只有本机侧有机器可读集合。

完整集合：`test-failure-set.md` + `test-failure-set.json`（解析器 `parse-vitest-json.mjs`）。

### CI状态（`gh`已认证，非推测）

- 执行日志原先引用的 37095446083 / 37095893167 **已不是最新**，其后还有8次run。最新为 **37099318050**（master push，SHA `0e13d4cd`，failure）。上一次 37098693756（PR，SHA `c1c01d23`）。
- 两次run一致形态：**`typecheck:all`三OS全绿**；`npm test` 红；其余OS的`Run tests`是**cancelled**（matrix未设`fail-fast: false`，先失败者取消其余）——**cancelled不得记为通过**；`build` job因`needs: test` **skipped**，故 `electron:build` 与打包parity在CI上**完全未执行**。
- typecheck步骤heap：`NODE_OPTIONS: --max-old-space-size=6144`（test.yml:44-46），**仅作用于typecheck步骤**；`npm test`/`test:coverage`/`build` 均为runner默认heap。
- trigger分支配置 `[master, main, develop]`，而远端只有 `master`——两个死配置。
- `test.yml` **没有** `architecture:check` / `architecture:self-test` job，也没有ruleset强制。属G0.2范围，本次未声称已完成。

### 架构门禁与ratchet

- `typecheck:electron` ratchet **确实存在且确实在跑**：`scripts/typecheck-electron-gate.mjs` + 已提交的 `scripts/typecheck-electron-baseline.txt`（162行/148条，格式`<path> <TScode> <count>`），基线为 **303 known errors / 148 keys**，按(file,code)计数、故意不含line:col以免行号漂移造成假"新增"。计划中"完全没有typegate"是**文档缺陷**，已按源码与CI日志证伪。
- 零容忍managed模块实际为**4个**（非计划/AGENTS.md所写的3个）：`agent-protocol`、`agent-core`、`agent-runtime`，外加 `legacy-plugin-core`（plan 584因真实`exports` map而置`managed: true`）。
- 802存量违规与baseline完全对齐，**未运行** `architecture:baseline`（`--write`），baseline未被改动。

### 本任务发现的两处真实缺口（供后续任务）

1. **构建次序只存在于一个`&&`字符串里。** 单跑 `typecheck:electron` 得到49个`TS2307`"新增"错误，根因是clean检出下workspace包尚未build、`types`指向不存在的`dist/`。`typecheck:all`因先build而绿。仓库**没有** npm workspaces 拓扑依赖，也**没有** TS project references。任何直接调用子门禁的新CI job都会看到49个假回归。
2. **`npm test` 在clean检出上必须先build。** COLD口径实测252失败文件，其中 **250个**是`@duya/*`无法解析，纯构建次序产物；build后降到45。CI恰好因为`Run typecheck`先build而免疫。G0.2新增job若不先build会报约250个假失败。

### 未达成项（明确留开，未勾选）

`npm ci` 未取得exit 0，属**环境/工具链**问题，非仓库缺陷：

1. 第一次失败于 `puppeteer` postinstall：机器本地缓存 `C:\Users\lavachen\.cache\puppeteer\chrome\win64-146.0.7680.31` 存在但 `chrome.exe` 缺失（puppeteer是传递依赖，不在根`package.json`）。重试时按其自身提示设 `PUPPETEER_SKIP_DOWNLOAD=1`（只跳过Chrome二进制下载，不跳过任何依赖解析；所有门禁都不消费该二进制）。
2. 第二次失败于仓库自身 `postinstall`：`node-pty` 编译报 **MSB8040**（本机VS 18工具集缺Spectre缓解库）。仅影响 `node-pty`；`better-sqlite3` 已成功重建。`node-pty/build/Release/pty.node` 与 `winpty-agent.exe` 均不存在。

**因此依赖树本身是干净且工作树本地的（1043个顶层条目、12个`@duya/*`全部内部链接），但`npm ci`进程退出码为1。** 需要装VS的Spectre缓解库组件，或提供匹配的`node-pty`预编译产物。G0.1 (c) 因此只算**部分**满足。

## 本次计划整合

| 项目 | 状态 |
| --- | --- |
| 单主入口、阶段合同、文件范围/验收/回退 | 文档已写；阶段执行未开始 |
| 原计划与设计资料迁入同一dossier | 以实际Gitdiff和链接检查验收 |
| 旧任务接管与依赖 | 接管表+原checkboxinventory；旧checked不自动完成 |
| 修改runtime或产品UI | 本次未执行 |
| 提交/推送/PR | 本次未执行；交付为可审阅工作区文档 |

## 并行预备工作（2026-10-03，父会话协调）

计划允许"设计、夹具和无冲突的纯叶子预备工作提前准备"。以下三项在G0.1取证期间并行推进，**均未切换生产路径**，各自独立分支、独立提交、未合并。

| 工作 | 分支 / 提交 | 内容 | 状态 |
| --- | --- | --- | --- |
| R1.1 四接缝测绘（只读） | — | 四个接缝在当前源码**全部仍存在**，且**零测试覆盖**；已定位到行 | 已完成 |
| R1.1 回归测试（只写测试） | `plan/587-r1-1-seam-tests` / `c824c771` | 8个测试对当前代码**真实失败** + 1个护栏测试通过；**未改任何生产源码** | 已提交，**故意不合并**（保持master失败基线干净） |
| G0.4 文档事实（仅AGENTS/ARCHITECTURE） | `plan/587-g0-4-doc-facts` / `af190aaa` | Electron版本28→44；Agent Server实为spawn子进程；拓扑图改三层；`electron/`旧路径清扫；**Electron ABI实测149**（非文档的119） | 已提交，待PR |

### R1.1 接缝现状（`00-contracts.md` §C 为判定依据）

1. **预算 vs 完成**：`RunControllerOptions`无budget字段，`start()`建`RunSession`时不传，`#budgetVerdict`恒false；另有三处硬编码`{status:'completed'}`绕过resolver。
2. **`result()`驱动执行**：`result()`内部调用`settle()`，读路径带写副作用（并额外写`session.terminal`）。
3. **durable barrier**：公共terminal在`flush()`/`persistence.complete`**之前**就resolve。合同允许内存决策提前，但公共完成信号必须遵守barrier。
4. **ack/CAS被吞**：orchestrator adapter丢弃`{ok, applied}`回复。Control Plane侧报告是诚实的，CAS也是真的。

测绘还纠正了自身地图的4处错误，其中两处影响验收写法：接缝4的"抛错"子情形**并未被吞**（抛错会正常上抛，丢失的是ack形状的静默）；接缝1的可观测结果是`failed`/`runtime_crash`而非`completed`。另确认**仓库的tsc不覆盖任何测试文件**（`packages/agent-runtime/tsconfig.json`排除`test`，`apps/desktop/tsconfig.main.json`排除`__tests__`），属既有治理缺口，归G0。

### 新发现的基线隐患（须在G0.4修正索引）

`docs/exec-plans/README.md:70,91` 记录的"Local (Windows): 45 files / **112** tests"中，文件数45本次可复现（WARM口径），但**112这个测试数无法复现**：COLD口径为75、WARM口径为101，且 `1e6d0b0e..0e13d4cd` 之间**没有任何测试文件改动**（全为文档提交）。因此该数字既非COLD也非WARM，**不可作为基线**。后续一律以本目录的 (file, test, signature) 集合为准，不引用单一总数。

## 每个任务更新模板

```text
Task: R1.2 / named slice
State: implemented | typechecked | tested | merged | runtime-verified | blocked
Head / branch / PR:
Changed files and public entry:
Old caller → new caller / ownership:
Baseline failure set and new failure diff:
Checks: command, exit, environment, clean/warm, artifact location
Capabilities actually verified / still unsupported:
Shim consumers + removal criterion:
Rollback/data compatibility:
Remaining blocker: specific evidence, required external input if any
Next task: exact ID + file + first action
```

## 阶段证据账本

| 阶段 | Commit/PR | targeted / fullsetdiff | clean / CI | host / artifacts | Exit |
| --- | --- | --- | --- | --- | --- |
| G0 | G0.1 `93fcc97e`(PR #138)；G0.2-A `313d1f66`(PR #140)；G0.2-B `a3fe1f14`(PR #143) | 首次建立集合：45文件/101测试/103 tuple，按file+test+signature；G0.2-A未改测试；G0.2-B collect 1009文件/11873测试不变 | 本地clean安装（`npm ci` exit 1，环境原因）/ CI 37099318050 @同一SHA | `.tmp-validation/587-g0/`、`587-g0-2/`、`587-g0-2b/` | G0.1部分、G0.2-A/B完成；G0未验收 |
| R1 | — | — | — | — | 未验收 |
| R2 | — | — | — | — | 未验收 |
| T3 | — | — | — | — | 未验收 |
| E4 | — | — | — | — | 未验收 |
| M5 | — | — | — | — | 未验收 |
| C6 | — | — | — | — | 未验收 |
| D7 | — | — | — | — | 未验收 |
| H8 | — | — | — | — | 未验收 |

不要用“已定位/已改文件/已merge”替代runtimeverified。修改主Next时同步阶段入口，阻塞描述给下一agent一条具体可实施动作。

## G0.1 接管与可重复基线

```text
Task: G0.1 / 接管与可重复基线
State: typechecked + tested（证据采集，未改任何源码）；G0阶段仍未验收
Head / branch / PR: 0e13d4cd944809888e39f3b53e8f8e81d2ec409a / plan/587-g0-baseline / 无PR（父会话处理）
Changed files and public entry: 仅两个计划文件——本文件与 01-baseline-and-gates.md。**无任何源码、配置或测试文件改动**（`git status` 只有这两个文件）
Old caller → new caller / ownership: 不适用（纯证据任务）
Baseline failure set and new failure diff: 首次建立可比集合，见"失败集合"节。WARM 45文件/101测试/103 tuple；COLD 252文件（250个为构建次序产物）。分类 77 deterministic / 25 env-infra / 1 已证flake。无"新增失败"可报——因为这是基线本身
Checks:
  - npm ci            exit 1（环境，见"未达成项"）
  - npm test          exit 1  warm/clean依赖 build后 / Windows Node24 / `.tmp-validation/587-g0/test-run-warm.log` + `test-results-warm.json` + `test-failure-set.md`
  - flake二次运行     exit 1  8文件重跑，22/23复现 / `flake-rerun.log` + `flake-rerun-set.json`
  - typecheck:all     exit 0  clean安装 / 154s / `typecheck-all.log`
  - build             exit 0  87s / `build.log`
  - architecture:check exit 0 / `architecture-check.log`
  - architecture:self-test exit 0 / `architecture-self-test.log`
  - typecheck:electron 单跑 exit 1（49个假TS2307）/ 在typecheck:all内 exit 0 / `typecheck-electron.log` + `architecture-and-ratchet.md`
  - gh CI（只读）    已认证 / `ci-runs.md` + `run-37099318050-jobs.json`
Capabilities actually verified / still unsupported:
  - 已验证：clean检出下 typecheck:all 与 build 绿；architecture两门禁绿且ratchet=303/148零漂移；@duya/*全部解析进本工作树；better-sqlite3 ABI 137本地可加载；CI在同SHA上typecheck三OS全绿
  - 仍不支持/未验证：`npm ci` exit 0（node-pty需Spectre库）；CI上 `build` job（因needs:test被skipped，electron:build与打包parity在CI从未执行）；`architecture:check` 未接入CI；本机Node24 vs CI Node22 版本差未受控
Shim consumers + removal criterion: 不适用
Rollback/data compatibility: 不适用（只改文档）
Remaining blocker:
  1. `npm ci` exit 1 = 本机VS 18缺MSB8040要求的Spectre缓解库（+ puppeteer本地缓存chrome.exe缺失）。需要：装该VS组件或提供匹配`node-pty`预编译产物，然后重跑`npm ci`取得exit 0
  2. G0.2 前置事实：构建次序只存在于`typecheck:all`的一个`&&`链里，无 npm 拓扑依赖/TS project references
Next task: G0.2 — `docs/exec-plans/active/587-agent-harness-monorepo/01-baseline-and-gates.md`，第一个动作：把 `architecture:check` 作为独立只读CI job接入 `.github/workflows/test.yml`，并让 `build` job 不再因 `needs: test` 失败而被整job跳过（否则 `electron:build` 在CI永远没有证据）
```

## G0.2-A CI 接线

```text
Task: G0.2-A / CI gate wiring
State: merged（PR #140，`42cef0f0`，master `313d1f66`）；G0仍未验收
Head / branch / PR: 313d1f66 / plan/587-g0-2-ci-wiring / #140
Changed files and public entry: 仅 `.github/workflows/test.yml`（+275/-10）。无源码、无测试、无配置改动
Old caller → new caller / ownership: 新增 `architecture` job（ubuntu）；`test` job解除依赖；`build` job 的 `needs: test` 改为 `needs: architecture`
Baseline failure set and new failure diff: 未改任何测试。`npm test` 仍 exit 1；本worktree collect 1009文件/10709测试（junction依赖口径，与G0.1的clean-install 45/101不可直接比较，但红色一致、collect未削减）
Checks:
  - architecture:check / self-test（无任何dist的clean树） exit 0 / 0 —— 802/802/802，548/35/16/162/25/16/0
  - architecture-check.mjs --json                    exit 0  total:802 blocking:0 tolerated:802
  - npm test                                        exit 1  1009 files / 10709 tests
  - 边界探针（agent-protocol 内 import @duya/agent-core） architecture:check exit 1，指名文件+两条规则+原因
  - 测试探针（expect(1+1).toBe(3)）                    npm test exit 1，collect 1009→1010
  - 清除两探针后                                    git status 仅 test.yml；两路径 Test-Path=False；两个architecture门禁回0
  - guard 在 Git Bash 下跑真实日志（含UTF-16日志）    真实日志0 / 零collection 1 / 12文件0测试 1 / 无摘要 1 / 缺日志 0(defer)
  - pipefail 传播                                   内层失败传出 1
Capabilities actually verified / still unsupported:
  - 已验证：architecture门禁不依赖dist（resolver读package.json声明的exports，不读构建产物）；新job在真实probed失败下确实变红；零collection无法伪装成绿
  - 仍不支持/未验证：未在真实GitHub runner上执行（`shell: bash` on windows-latest 依赖预装Git Bash、fetch-depth:0 的成本均为推理未实测）；`npm test` 的红仍是既有债，本次未收敛
Shim consumers + removal criterion: 不适用
Rollback/data compatibility: 纯CI配置，可git revert
Remaining blocker: G0.2其余项（合同测试独立job、测试债收敛、required checks/ruleset）与G0.2-B构建次序
Next task: G0.2-B — 根 `package.json` 的scripts。方向已定为显式topological scripts（不引入TS project references），依据见01-baseline-and-gates.md对应条目
```

## G0.2-B 构建次序根治

```text
Task: G0.2-B / build order, single source of truth
State: merged（PR #143，`adb7b78c`，master `a3fe1f14`）；G0仍未验收
Head / branch / PR: a3fe1f14 / plan/587-g0-2b-build-order / #143
Changed files and public entry: `scripts/build-packages.mjs`（新增，128行）+ 根`package.json`（仅scripts）。无源码、无测试、无tsconfig改动
Old caller → new caller / ownership: 顺序的唯一事实源 = `scripts/build-packages.mjs`的`BUILD_ORDER`。`build:agent`降为薄别名（`release.yml`仍调用它）。`electron:dev`/`electron:dev:nohmr`/`electron:build`/`electron:preview`里临时拼装的`build:voice`/`build:gateway`/`build:computer-use`步骤已删除
Baseline failure set and new failure diff: 未改任何测试。collect **1009文件/11873测试，修复前后完全一致**。失败数漂移经证实非本改动：无代码改动的重跑给出43 vs 基线41，40个失败文件稳定，`RealTasks`/`GrepTool`/`app-connection-service`抖进、`bash-task-store`抖出；末次干净树跑精确回到41文件/96测试
Checks（全部先移走所有dist/与tsbuildinfo并核验为0，单跑入口，不手工还原）:
  - typecheck:electron   前 exit 1 / 153个新错误（113假TS2307） → 后 **exit 0**, 29.1s
  - bundle:agent         前 exit 1 / 14个esbuild解析错误        → 后 **exit 0**, 24.4s, 5.04MB, 0 unresolved
  - electron:build                                        → **exit 0**, 70.8s, 三个bundle齐备
  - npm test                                               exit 1（仅既有债），collect不变
  - typecheck:all          exit 0
  - architecture:check     exit 0，**802/802/802零新增**，且在**无dist**的树上跑
  - architecture:self-test exit 0
  - check:encoding / manifest-keys / no-ts-suppress / test-coverage  全 0
  - 父会话独立复核 `npm run build:packages` → exit 0，11个包按序构建
Capabilities actually verified / still unsupported:
  - 已验证：四个入口均可从无dist的干净树单跑；两个实证缺陷（`build:agent`漏voice/gateway、`bundle:agent`只build ai）已修；`exports` resolver不依赖构建产物
  - 仍不支持/未在真实GitHub runner验证；`electron:build`未做打包与packaged parity
Shim consumers + removal criterion: `build:agent`别名待CI在范围内时改名并删除；`release.yml:70`的`build:agent && build:gateway`现为冗余但幂等，本次未改workflow
Rollback/data compatibility: 纯构建脚本，git revert即可，无数据/schema影响
Remaining blocker: 无权限阻塞。本会话`gh api`确认`admin: true`，`master`无分支保护。G0.2-C待用户确认job名与rulesetdiff后执行
Next task: G0.2-C — required checks。计划要求仓库设置变更前先给出具体job名与rulesetdiff；候选与可稳定通过性已写入01-baseline-and-gates.md，等待用户确认后再动仓库设置
```

不要用"已定位/已改文件/已merge"替代runtimeverified。修改主Next时同步阶段入口，阻塞描述给下一agent一条具体可实施动作。
