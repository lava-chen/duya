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
| G0 | #138 基线；#139 文档事实；#140 CI接线；#142 worktree安全；#143 构建次序；#146 门禁跨平台；#148 G0.3/G0.4收尾；#151 electron二进制 | 集合基线 45文件/101测试/103 tuple；G0.2-A未改测试 | master `f535c7d9`；`architecture` 已设为 required 并生效 | `.tmp-validation/587-g0/`、`587-g0-2/`、`587-g0-2b/`、`587-archfix/` | G0大部分完成；G0.2测试债收敛与G0.3余项留开 |
| R1 | R1.1 #147；R1.2 #149 | 30/30 → 58/58；collect 1010/11885 → 1011/11910，无下降 | 干净检出；两PR的 `architecture` check 绿 | `.tmp-validation/587-r1-1-fix/`、`587-r1-2-fix/` | R1.1/R1.2完成；R1.3/R1.4未开始 |
| R2 | R2.1 #150 | 新增41测试 + R1回归58，全绿；collect 1011/11910 → 1015/11931 | master `fd29af08` | `.tmp-validation/587-r2-1/` | R2.1完成（Desktop chat）；R2.2开工 |
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

## E4.4-A/B 边界取证（#180 打包门禁、#181 真实 Electron turn）

```text
Task: E4.4-A / E4.4-B / boundary evidence before any claim
State: merged（#180 `63ad8033`、#181 `2e452e67`）；E4仍未验收，且#181证伪了bridge合同
Head / branch / PR: 2e452e67 / feat/587-e4-4b-packaged-smoke + feat/587-e4-4a-electron-turn / #180、#181
Changed files and public entry:
  - #180: 新增 `scripts/check-packaged-artifacts.mjs` + `scripts/check-packaged-artifacts.test.ts`；根`package.json`加三个入口（`check:packaged-artifacts` / `:bundle` / `:packaged`），并接进 `typecheck:all`（CI的typecheck job每次都跑）
  - #181: 新增 `e2e/turn/electron-turn.spec.ts` + `e2e/turn/loopback-anthropic.ts`，新Playwright project `turn`（`npm run test:e2e:turn`）
Old caller → new caller / ownership: #180把`AGENTS.md` §"Agent Bundle (MUST FOLLOW)"预发布清单里**只由人读注释断言**的三条路径变成机器门禁，三模式按各自能证明什么拆开；#181新增`turn` project，真实边界由renderer发起（`preload` →`contextBridge`→`ipcMain`→子进程`POST /sessions/:id/chat`），durable行由**独立**SQLite连接在应用运行时读出
Baseline failure set and new failure diff: 两个PR都**不改产品代码**。#181新增的产品缺陷见下一切片（#182），本切片只负责发现与固定
Checks:
  - #180 `npx vitest run scripts/check-packaged-artifacts.test.ts`  exit 0，32 passed
  - #180 `npm run bundle:agent`                              exit 0，5.06 MB；`--bundle`模式对真实产物：入口自包含（0个bare/relative/dynamic require）、`bundle/package.json` type=commonjs、`assets/`在、`BashTool/BashWorker.js`**确认缺失**
  - #180 `typecheck:all` exit 0；`architecture:self-test` exit 0（460/227/0/146/25/16）；`architecture:check` exit 0（total 874 / tolerated 874 / baseline 811）
  - #180 归因：把三个新文件移开重跑`architecture:check`，数字**完全相同**——本切片对架构数字贡献为0
  - #180 突变自证（两次，均`git checkout`还原）：externals加`'sharp'` → `FAIL esbuild-externals-allowlist` exit 1；把`agent/process/…`提到`agent-bundle/…`之上 → `FAIL agent-entry-resolution-order` exit 1
  - #181 `npx playwright test --project=turn`  **1 passed, 1 skipped (16.9s)**，跑在真实`npm run electron:build`上
  - #181 `typecheck:all` exit 0（含`typecheck:cli`无OOM）；`architecture:self-test` OK；`audit-imports.mjs --json` 中指名`e2e/turn/`的边**恰好0条**
  - #181 `npx vitest run`（run-entry / run-orchestrator / eval-legacy-loop）3 files / 33 tests passed
Capabilities actually verified / still unsupported:
  - 已验证：静态模式确实能在真实probed失败下变红（两次突变都exit 1）；`--bundle`模式读的是esbuild真实输出而非源码；Electron的`runs`行在应用运行时可被独立连接看到（证明是已提交而非内存态）
  - 仍不支持/未验证：**`electron:pack`从未运行**（E盘开工5.23 GB free，`npm ci`后5.00 GB；早前会话曾两次把盘打满到0.27 GB/0.42 GB）。因此打包后的`resources/agent-bundle/…`、`resources/better-sqlite3/build/Release/better_sqlite3.node`的**实际拷贝结果**与打包Electron下的native加载**未验证**；`--packaged`模式每次都打印`UNVERIFIED`。"首个packaged chat turn到达Agent `ready`"与"`app.log`无`ERR_MODULE_NOT_FOUND`"需要真实provider key + 运行中的打包应用，**未验证也未用代理冒充**
  - 仍不支持/未验证：`typecheck:all` **不覆盖**`e2e/`（仓库16个tsconfig无一引用`e2e/`），该门禁绿对本文件不构成证据；#181的模型是127.0.0.1上的loopback provider，**不是E4.4 bullet 2的live provider**
Shim consumers + removal criterion: #180在`scripts/packaged-artifact-baseline.json`登记`BASHWORKER-NOT-BUNDLED`为known defect（打印`KNOWN-DEFECT`、永不计为pass、但不变红）；移除条件写在文件里：某个build step真的产出该文件、`after-pack.js`在缺失时FATAL、该条目被删除。已由#191满足
Rollback/data compatibility: 纯构建/门禁脚本，git revert即可，无数据/schema影响
Remaining blocker:
  1. #181在真实Electron里**证伪了bridge合同**：`app.log`在dispatch时刻写 `[WARN] [agent-server] chat turn dispatched without a durable run {"stage":"run_not_created","reason":"run:create replied without a boolean ok"}`。`runs`行确实写入了（真实`manifest_hash`/`manifest_json`/`input_hash`），但`openRun`报`accepted:false`，`router.ts`据此当作什么都没dispatch（#181在前波树记为`:1309`；修复后该拒绝分支在`:1317`）——worker起来了却收不到`chat:start`，于是SSE只有`ready`、`run_events` **0行**、行永久停在`status='running'`/`terminal=NULL`/`finished_at=NULL`。**即master上`runs`行、事件账本与终态三者互不一致，因为根本没有UI结果：整个turn被静默丢弃**
  2. #181刻意用`test.fixme`而非`test.skip`：这是有名字的可复现失败，skip会读成"无信息"。**任何断言都没有把坏状态钉成期望值，也没有为变绿放松任何门禁**。删掉`fixme`并运行它**就是**bridge修复的验收测试
  3. `evals/agent/matrix/rows.ts`没有覆盖真实Electron边界的行——eval harness直连worker、从不过`run:create`桥，所以这个缺陷此前无人看见
Next task: C6.1/F01（`13-progress-review-2026-10-04.md`）"修 bridge wire/read/write 和未接受 start 的响应"——修在`db-bridge.ts`这一跳，不在症状处
```

## run:create ack 形状漂移：Desktop chat turn 全量丢弃（#182）

```text
Task: C6.1 / F01 / bridge wire-read-write ack shape
State: merged + runtime-verified（#182，`e0b3c1be`）；**本计划迄今最严重的产品缺陷**
Head / branch / PR: e0b3c1be / fix/587-run-create-ack / #182
Changed files and public entry: `apps/desktop/src/main/agents/db-bridge.ts`（第三跳：改回转发生产者自己的reply）、`apps/desktop/src/main/control-plane/run-receipt.ts`（wire序列化器从`run-control-plane.ts`的私有`onWire`搬来，与读取方并排）、`run-control-plane.ts`、`apps/desktop/src/main/agents/server/router.ts`（先跑`openRun`再把response交给stream handler）、`run-orchestrator.ts`；新增回归测试`apps/desktop/src/main/__tests__/run-create-ack-real-bridge.test.ts`
Old caller → new caller / ownership: 三个hop，中间那个静默丢字段——
  1. `run-control-plane.ts` 产出正确的**wire**形状`{ ok, state, runId }`
  2. C6.1的`ControlPlaneService.serve` 把它解析回**typed**的`RunWriteReceipt`联合。该联合**没有`ok`成员**，也**没有`written`成员**（后者是`run:append`经`readRunReceipt`校验的计数）
  3. `db-bridge.ts` 原样返回`receipt.write`——那个typed对象
  `readRunReceipt` 要求`ok: boolean`，所以**每一个`run:create`都读成`unreadable`**。修复在第三跳：bridge现在转发`receipt.result`（`db-bridge.ts:382`），`serve`只有成功读出它之后才会到达那里，所以它**按构造就是一个wire receipt**。从解析后的形式重建，正是丢字段的那一步
Baseline failure set and new failure diff: 新增8个测试，**其中7个在pristine `origin/master`上失败**，修后8/8
Checks:
  - 回归测试本身：把5个源文件还原到pristine `origin/master`，同套件重跑 → **7/8失败**，逐字复现报告的症状：
    `openRun refused: {"accepted":false,"runId":null,"stage":"run_not_created","reason":"run:create replied without a boolean ok"}`；`expected 'running' to be 'failed'`（那条搁浅的行）；`expected { Object (state, runId) } to match object { ok: true, state: 'created', … }`
  - 修复后 **8/8 passed**，含`chat:start`恰好dispatch一次并携带canonical run id、run达到`terminal='completed'`且`finished_at`已设、`run_events`含`run.started`与一个终态事件
  - 归因证明：5个改动源文件移开、`git checkout`恢复pristine `origin/master`、同套件重跑 → pristine 40失败 / 带改动33失败；**唯一差异是新测试文件里那7个**（pristine挂、带修复过），其余33个两侧**逐字节相同**
  - `npx vitest run`（新测试 + run层 + control plane）  281 passed, 6 failed——6个全在`slice-classification`
  - `evals/agent`  **106/106 (9 files)**，与known-good基线一致
  - `npm run typecheck:all`  exit 0（含`typecheck:cli`无OOM；`typecheck:evals` "no new type errors"）——vitest不做类型检查，这是真类型门
  - `architecture:self-test` OK（460/227/0/146/25/16）；`architecture:check` exit 0 "OK, no new boundary violations"，计数与master相同
  - 7个文件的编码检查（BOM/NUL/U+FFFD）clean
Capabilities actually verified / still unsupported:
  - 已验证：缺陷穿过**真实bridge**被复现与修复——新测试驱动`handleDbRequest`（真实`db:request`入口）、真实bridge、真实`ControlPlaneService`、真实`dispatchControlPlaneAction`、真实SQLite文件上的真实`RunStore`，然后**直接**读`runs`与`run_events`。只双打了boot期`getCoreStores()`单例与worker进程
  - 已验证：`run:append`上**同一漂移的第二个实例**（丢失`written`计数）此前被第一个掩盖；序列化器现在对**每个**有reason的state都发`reason`（此前只对`conflict`发），于是`busy`/`unavailable`/`sql_failed`/`absent`/`invalid`/`unreadable`不再以无reason到达读取方、由读取方合成"run:create reported unavailable"
  - 已验证：`run:read`穿过bridge现在正确且有测试，但**仍无生产消费者**
  - 仍不支持/未验证：**没有真实worker进程**——`chat:start`断言是在真实`ExecutionChannel` dispatch上，不是fork出的`agent-process-entry`子进程；真实子进程端到端应答此命令需要一次打包Electron运行。**没有live provider**，此路径不涉及模型调用。**500响应体未被证明会渲染成用户可见的UI**——body刻意与周边`catch`块既有的`sendJson(res, 500, …)`行为一致，而不是引入SSE专用错误帧
  - 仍不支持/未验证：`eval-legacy-loop`/`eval-baseline-comparison`里的6个失败是**干净工作树产物**（缺gitignored的`packages/agent/bundle/agent-process-entry.js`），`bundle:agent`后16/16通过；**不是产品失败**，也未计入上面的33
Shim consumers + removal criterion: 序列化器已从`run-control-plane.ts`的私有`onWire`搬进`run-receipt.ts:177 writeRunReceiptOnWire`，与`run-receipt.ts:358 readRunReceipt`并排——**边界消费侧此前根本没有办法构造wire receipt，这正是形状漂移的成因**。无shim需要保留
Rollback/data compatibility: 无schema变更。`RunWriteState`（R1.3）未变；C6.1的命令拒绝映射到自己的`invalid` state（"refused before it reached storage"）并逐字保留拒绝码。R1.1的降级语义未动（`persistence.complete`拒绝仍降级为`failed`/`persistence_failed`，不reject），R1.3的"无活动"vs"未实现"区分未动——**一个没写任何行的拒绝不声称有行**。`conflict`读作"别人已决定终态"，不是搁浅
Remaining blocker:
  1. Router侧：`openRun`现在**先于**response交给stream handler运行，所以拒绝仍可被应答。旧注释声称stream handler"会在worker说`chat:error`时关闭它"——**对本情形是假的**，因为`accepted:false`意为什么都没dispatch、永远不会有worker turn发它。这就是turn挂到socket超时的原因。拒绝现在被应答（500，带`stage`）并释放streaming锁
  2. Orchestrator侧：由`run:create`写入、随后报unreadable的行会拿到`run.failed`事件**和**一个终态，按R1.2选定的顺序（先append确认，再complete）。这是唯一被搁浅的路径，因为controller在上面永远到不了
  3. 归因残留：我的新测试文件给`slice-classification`（`excluded`/未分类桶）恰好**+1**（379→380，记录值373）；`total`（2895）与`wire`（48）未变，所以没有wire或runtime协调指纹移动。该测试在master上已因+6个未分类文件而红；重录inventory意味着吸收既有漂移，故**留开**。`typecheck:evals`的"1 baselined key(s) shrank"经换入pristine `evals/agent/matrix/rows.ts`验证提示**完全相同**，是既有漂移
  4. `architecture:baseline --write` **从未运行**
Next task: 修在`db-bridge.ts`这一跳（已由#182完成）；把E4.4 bullet 1的合同从`fixme`放出来运行（见下一切片）
```

## 测试命名空间数据库pin：一次跑能劫持后续所有跑（#190）

```text
Task: E4.4 / e2e namespace integrity
State: merged（#190，`071b931d`）
Head / branch / PR: 071b931d / fix/587-namespace-db-path / #190
Changed files and public entry: `apps/desktop/src/main/config/boot-config.ts`（新增`isNamespacedTestRun()`；`resolveDatabasePath()`对命名空间测试跑跳过config读取并报`needsBootWrite: false`）；新增回归测试`apps/desktop/src/main/config/__tests__/namespace-db-path.test.ts`（7个）
Old caller → new caller / ownership: 一个namespace**同时**keyed两个root，而只有一个是per-checkout的：
  | Root | 派生自 | 生命期 |
  | `--user-data-dir` → `<repo>/.e2e-userdata/<ns>` | `e2e/helpers.ts` `userDataRootFor()` | 随工作树消亡 |
  | `~/.duya/test-namespaces/<ns>/config.toml` | `compass.resolveConfigRoot()` | **只按namespace名**，在所有工作树之外 |
  config决定数据库。boot时应用把自己**绝对**的`storage.database_path`写进那个文件（`compass.ts:34`选root；`boot-config.ts` `resolveDatabasePath()`第1步曾原样返回配置值并报`needsBootWrite: false`；`db/connection.ts:111` `initDatabaseFromBoot()`在`:136`调`initBootConfig(dbPath)`写入**绝对解析路径**）。于是**最后跑该namespace的检出捕获了它**；该工作树后来被删除，pin仍活着（因为`~/.duya`不在任何工作树内），**静默重定向了后续每一次运行的整个数据库集**。修复后：namespaced run从自己的userData派生数据库且**永不持久化pin**——持久值在测试模式下**既不被读也不被写**，没有能比产生它的run活得更久的state，所以移除的是**这一类**而不是一个实例
Baseline failure set and new failure diff: 命名空间`e4-4-electron-turn`被**故意留毒**用于本PR复现
Checks:
  - 复现（真实Electron e2e，未修复）**0 passed, 2 failed**，且`databases/`目录不出现；应用自己的日志显示重定向：`[WARN] [DB] memory-state: DB opened {"dbPath":"E:\\Projects\\duya\\.claude\\worktrees\\587-e4-4-contract\\.e2e-userdata\\e4-4-electron-turn\\databases\\memory-state.db"}`（指向**已删除**的工作树）
  - 回归测试红：把修复移开 → `Tests 4 failed | 3 passed (7)`，失败文本逐字复现缺陷：`Expected: "...\duya-run-root-PMdV08\.e2e-userdata\ns-...\databases\duya-main.db"` / `Received: "...\duya-home-vd3oTA\worktrees\587-e4-4a\.e2e-userdata\ns-...\databases\duya-main.db"`。**那3个生产测试此处已通过**——它们就是未变的合同
  - 回归测试绿：`namespace-db-path.test.ts` 7/7 + `compass.test.ts` 2/2 = **2 files / 9 tests passed**
  - e2e before→after（namespace两次都故意留毒）：**0 passed / 2 failed** → **1 passed / 1 failed (34.6s)**。与先前记录状态一致，但**没有清除pin**就达到——这正是要点
  - `npm run test`（全量） baseline **31 failed files / 58 failed tests / 12846 passed / 12997** → 带修复 **30 / 57 / 12854 / 12997**；+7测试全是本PR的、全部通过；skips不变（8 files / 86 tests）
  - `npm run typecheck:all`  exit 0，0 TS errors，18个门禁全过，`typecheck:cli`无OOM
  - `architecture:self-test` OK（460/227/0/146/25/16/0）；`architecture:check` exit 0 "OK — no new boundary violations"（total 874 / tolerated 874 / baseline 811）
Capabilities actually verified / still unsupported:
  - 已验证：坏pin会让应用在**任意位置创建真实SQLite文件**——未修复的baseline run在`E:\Projects\duya\.claude\worktrees\587-e4-4-contract\...`下物理造出5个游离SQLite文件（`.claude/`被gitignore，故共享检出的git状态未受影响；**故意留在原处未删**，它在本工作树之外）
  - 已验证：选择**惰性优于修复**。已存在的陈旧pin只是永不被查询，所以不可能致命、也无需清理。**刻意没有**重写namespace config去掉该key：并发切片可能在读那个文件，而该值已经无害
  - 已验证：作用域被限制在测试namespace，**绝不涉及用户config**。生产未动（`DUYA_TEST=1`之外配置过的`database_path`仍被尊重且仍被写入）；**无namespace**的测试跑仍解析真实`~/.duya/config.toml`并尊重用户自己的pin；legacy `duya-config.json`分支保留（它读在run自己的userData下，本来就是run-scoped、不能比检出活得久），只抑制它的boot写入。7个回归测试中有**两个纯粹为了钉住生产合同**，使这个豁免不能被意外放宽
  - 仍不支持/未验证：**本机28个namespace里27个带这种pin**，几乎全部指向已不存在的工作树。已记录的惰性意味着它们现在无害，但**留在文件里**——调试的人会看到一个与应用实际使用值不同的`database_path`，而代码注释与PR是唯一记录
  - 仍不支持/未验证：`DUYA_TEST=1`但**忘了**`--duya-namespace`的调用仍会读写用户真实config（既有行为，刻意不改）。其他namespace-scoped root**未动**：`resolveRolloutRoot`/`resolveAttachmentsRoot`/`projectService`/`tier-rpc`各有自己的`test-namespaces/<ns>`布局；本PR只修数据库路径
Shim consumers + removal criterion: 不适用（移除的是一个隐式状态通道而非shim）
Rollback/data compatibility: 生产boot行为与已发布的配置合同不变。回退会把"命名空间跑不再持久化pin"这一行为一并带回
Remaining blocker: 未来某个变更可以在测试模式下**剥掉那个key**，代价是与并发切片竞争——所以本PR选择惰性而非清理
Next task: 本条已合并且已被#188的e2e使用；剩余的pin清理是**可选的卫生工作**，不是阻塞（已记录的惰性使陈旧pin不可能致命）
```

## CI 基线诊断：把master的红重新框定为"从未绿过的门禁"（`diag/587-ci-baseline`）

```text
Task: G0.2 / CI baseline diagnosis
State: 诊断完成，文档已提交到分支 `diag/587-ci-baseline`（`3ad63c41`）；**未合并**；无源码/测试改动
Head / branch / PR: 3ad63c41 / diag/587-ci-baseline / 无PR（基线=`origin/master` `5dc45fcf`，分析的run=`37180632253`）
Changed files and public entry: 仅新增 `docs/exec-plans/active/587-agent-harness-monorepo/14-ci-baseline-diagnosis.md`。**未为产出该文档改动任何生产或测试代码**
Old caller → new caller / ownership: 不适用（纯取证）。但它**取代**了此前对本项目CI史的判断
Baseline failure set and new failure diff: 四次运行**collect完全相同**（1091 files / 12890 tests），所以vitest配置与include-glob**不是**问题，只有pass/fail不同
Checks（本切片亲自从CI日志复核的项）:
  - ubuntu `5dc45fcf`（run `37180632253`, job `111372319161`）**实测**：`Test Files 72 failed | 1010 passed | 9 skipped (1091)`、`Tests 216 failed | 12580 passed | 94 skipped (12890)`、`Errors 1`——与诊断文档表格一致
  - 15个最近的master push run**全部** `failure`（`1ffabfc9` … `5dc45fcf`），无一绿
  - workflow首次执行是`0bc78551`（2026-10-01）。`42cef0f0`（2026-10-03, "ci: wire architecture gate and stop skipping electron:build"）加了`push: branches: [master]`触发器；workflow自己的header注释记录它此前watch `main`/`develop`，**而本仓库这两个都不存在**，所以push触发器从不匹配、门禁从不运行
  - 文档自报（本次未逐项重测）：macos 80 files / **247** tests、windows 49 / 123、local干净树 47 / 113、local干净树 `bundle:agent` 之后 44 / 103
Capabilities actually verified / still unsupported:
  - 已验证（**本计划历史的核心重构**）：自2026-10-01起该workflow的**123次运行中有123次是failure，一次绿都没有**。这不是最近某个commit引入的回归。**587没有弄坏master。587打开了一个从未运行过的CI门禁，而门禁在到场时就是红的。** 门禁之所以对既有债**可见**，不是债存在的原因
  - 已验证：**macOS是最差的一条腿，不是ubuntu**（247 vs ubuntu 216）。briefing把ubuntu当作参照；macos实际多31个失败。**任何只在ubuntu上验证的修复切片都会少算**
  - 已验证：216个ubuntu失败里，**~21（10%）是587自己的**（4个文件）、**~180（83%）是2025→2026-09的既有债**、**~10（5%）加1个job是CI配置**
  - 已验证：216个中最大的一族**A**（39文件 / 99 ubuntu / 127 macos / 5 windows / 0 local）是**测试夹具把Windows路径与temp语义硬编码成普适真理且无平台守卫**。三个已证子机制（下述行号是**诊断所依据的前波树**，括号内为修复后master的对应行）：A1 `media-allowlist.test.ts:55`读`process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp'`（POSIX变量是`TMPDIR`，二者未设，于是落到不存在的硬编码Windows路径，一行`beforeEach`杀掉该文件全部21个测试；修复后为`:58`的`vi.importActual('node:os').tmpdir()`）；A2 `workspace-resolver.test.ts:58`种下`canonical_root: 'E:/repos/duya'`，在POSIX上**不是绝对路径**、生产代码的`path.resolve(cwd)`把它rebase到runner CWD（修复后为`:73`并经`fx()`包住）；A3 host语义被假设而非派生（`path.basename`/`path.isAbsolute`/shell的command-not-found退出码用Windows拼写断言）。**A不是产品逻辑损坏**——产品对真实POSIX路径行为正确，破的是套件把Windows假设编码成普适真理。仓库已经知道修法形状：`GrepTool.test.ts`用`describe.skipIf(process.platform !== 'win32')`（诊断记`:157`，修复后`:192`）
  - 已验证：族**B**（每平台8个）**被证明可修**：干净工作树里`before npm run bundle:agent : 47 files / 113 tests failed` → `after : 44 / 103`，清掉`run-suite` 2、`eval-baseline-comparison` 2、`eval-legacy-loop` 4，**引入0个新失败**；那三个文件定向重跑 `3 passed (3) / 12 passed (12)`。`pretest`是`build:packages && ensure-sqlite-abi.mjs`，它编译`dist/`但**从不**产出`packages/agent/bundle/`，而后者只由`bundle:agent`（`electron:build`的子步）产生
  - 已验证：族**D**（每平台14个）是**plan 580**的债（migration 58的`connection_slug`），不是587的；三个同级套件被更新过、两个没有
  - 已验证：族**H**（6个）是**587自己的账**——`scripts/architecture/slice-classification.test.ts`断言记录inventory仍描述该树
  - 已验证：族**I**（每平台10个）的harness只捕获stdout（`stdio: ['pipe','pipe','pipe']`，无stderr drain），所以底层错误从测试输出里**不可见**
  - 仍不支持/未验证：族**J**（30文件 / 49每平台）当时**未归因**；其中最大单点是`WorkflowPanel.test.tsx`（12，fails everywhere）
  - 仍不支持/未验证：`build (macos-latest)` job因`vite build`在~2042 MB heap OOM而红（`Abort trap: 6`、exit 134），同一步在ubuntu/windows默认heap下通过。`test` job的typecheck步骤**已**带该缓解（`5bf3220a`），`build` job的任何步骤**都没有**`env:`块——同一脚gun，同一runner，同一信号，只是多走了一步。判为**CI配置，不是代码**
Shim consumers + removal criterion: 不适用
Rollback/data compatibility: 不适用（只改文档）
Remaining blocker: 诊断给出的修复顺序是**范围建议，不是完成**；其中族A"最需要人类决定每文件属于'修夹具'/'守卫套件'/'产品在POSIX上真的错了'中的哪一种，应按子系统拆开而不是当一个整体取"
Next task: 按诊断§5的杠杆顺序落地；族A必须按子系统切分
```

### 诊断自身的两个数字漂移（已被后续切片证伪，必须记下来）

```text
1. 相对路径深度：诊断说 `phase_d_no_dangling.test.ts:19` 的 `..` 深度是 **five**（不是three）。#185 实测为**six**——文件位于 `apps/desktop/src/main/memory/__tests__`。
2. `@lobehub/ui` 归因：诊断把族G框为"nested-`node_modules` resolution … npm的hoisting没有创建包内构建`.mjs`所期待的nested `node_modules`"，并据此归入类(c)环境/CI配置。#189 实测：**`@lobehub/ui@5.14.1`把一个`package.json`缺失的 `es/node_modules/@base-ui/react/` 直接装在它自己的tarball里**（只有`esm/`，无`package.json`，无`merge-props`），而lockfile记录该处**零**个nested install，所以npm没有创建它。这是上游发布物形态问题，不是hoisting误配
```

### 诊断期间形成并被切片证伪的两个假设（它们花掉了真实时间）

```text
(a) "缺export的 `vi.mock` 警告是病因" —— 错。诊断文档自己写明族A"是briefing的 `vi.mock` 假设漏掉的那个"（14-ci-baseline-diagnosis.md:89），主因是平台夹具。注：把它们归为"**通过**的测试里也会出现的被捕获`[WARN]`"这一更细的说法来自形成该假设的会话，**本切片未独立复验**。
(b) "套件在本地接近绿" —— 错。干净工作树给**113**个本地失败，而ubuntu是**216**，而两次的**collect量完全相同**（1091 files / 12890 tests）。差额就是族A。再加上：共享检出里**有** `packages/agent/bundle/agent-process-entry.js`，干净工作树**没有**——所以共享检出里的任何本地跑都整族跳过该失败模式。这就是"本地比CI绿"的错觉来源。
```

## CI 修复波 A：配置、跨平台夹具、陈旧合同、POSIX 产品缺陷（#183–#186）

```text
Task: G0.2 / CI fix wave A (config, fixtures, stale contracts, POSIX products)
State: merged（#183 `3758724c`、#184 `1354feda`、#185 `9dd0eb97`、#186 `bba7fbed`）
Head / branch / PR: bba7fbed / fix/587-ci-config / fix/587-ci-cross-platform-tests / fix/587-stale-test-contracts / fix/587-posix-path-and-cookie-paths / #183 #184 #185 #186
Old caller → new caller / ownership:
  - #183: `build` job的`Build application`步骤**加** `env: NODE_OPTIONS: --max-old-space-size=6144`（沿用`release.yml:72-78`与`test.yml:210-218`既有的值与注释形状）；三个vitest `pretest*`钩子（`test`/`test:watch`/`test:coverage`）由`build:packages`换成`bundle:agent`。e2e的`pretest:e2e*`钩子**刻意不动**（它们驱动Playwright打**打包**Electron二进制，不是vitest套件）
  - #184: 20个文件的夹具改为经`os.tmpdir()`/`vi.importActual`解析temp（POSIX认`TMPDIR`、Windows认`TEMP`/`TMP`）；盘符夹具经每文件一个`fx()`helper（win32用Windows形式，**这样盘符小写化仍被断言**；其它平台用真正的绝对路径，**同时**作用到种下的值与期望值，使比较保持有意义而非仅仅通过）；host语义改为派生（`buildIdeCandidates()`、`path.join(path.sep, …)`、平台自己的`where`/`which`与command-not-found退出码）
  - #185: 族D的夹具改为复用产品的真实迁移路径——`app-connections-db.ts`经`initializeSchema`建表，即主进程用的同一入口，末尾调用`runMigrations`；目录下**全部六个**套件共享它，已更新的三个也不再留冗余副本
  - #186: `packages/voice/src/env.ts` 的`findOnPath`按平台分隔符切分；`packages/agent/src/permissions/policy.ts` 的cookie读取pattern拓宽
Baseline failure set and new failure diff:
  - #183: 未改任何测试文件（只改`.github/workflows/test.yml`与`package.json`）。45→44 failed files，110→104 failed tests；3个目标文件**定向**：before 3 files/8 failures全是"agent bundle missing" → after **11 files / 114 passed**
  - #184: 族A，20文件 / **93 failures**（92 ubuntu + 1 windows）。归因证明：把20个文件还原到`origin/master` vs 带改动 → `47 failed files / 112 failed tests` → `46 / 110`；四个不同测试全在本分支**从不触碰**的文件里（`AgentTool`/`GrepTool`/`file-mutation-queue`/`app-connection-service`），是既有flake。**族A在Windows上本来就绿，所以本地delta中性是预期结果**；ubuntu/macos的效果由CI失败文本与夹具属性证明建立，不是由本地计数建立
  - #185: 族C+D+E，9个在scope内文件：**37 → 3**（测试总数119→120）
  - #186: 无测试改动；这是把#184**故意留红**的bug detector变绿
Checks:
  - #183 workflow YAML解析 exit 0：`jobs: architecture,test,build`；`build.steps` = 7；`Build application.env` = `{"NODE_OPTIONS":"--max-old-space-size=6144"}`
  - #183 `npm run bundle:agent` exit 0（从缺失构建出5.06 MB入口）
  - #183 `npm run typecheck:all` **exit 0**（含`typecheck:cli`无OOM；两个被编辑文件`check:encoding`通过）
  - #184 `npx vitest run` 覆盖全部20个被触文件：**414 passed, 4 skipped, 0 failed**（4个skip是POSIX对偶测试，在Linux/macOS上运行）
  - #184/#185/#186 `npm run typecheck:all` 全过，无新类型错误
  - #184/#185/#186 `architecture:self-test` OK —— `module-dependency` 460、`module-dependency-permitted` 227、`forbidden-dependency` 0、`package-boundary-escape` 146、`deep-import` 25、`cycle` 16，与master**全部相同**
  - #185/#186 `architecture:check` OK "no new boundary violations"（total 874 / tolerated 874 / baseline 811）。#185 归因：把13个文件`git checkout origin/master --`后两个门禁报**逐字节相同**的数字
  - #186 `packages/voice` + `packages/agent/tests/permissions`：**132 passed, 2 skipped, 6 files**。归因：只还原产品修复（`git checkout origin/master -- packages/voice/src/env.ts`）→ `packages/voice` **重新变红**并带原始症状（`AssertionError: expected false to be true`，1 failed / 6 passed）；恢复后7/7
Capabilities actually verified / still unsupported:
  - 已验证（#183，两个**不需要碰产品代码**的CI配置缺陷）：macOS `build` job → 绿，零产品风险；agent bundle在测试前被构建。**为什么改`pretest*`钩子而不是workflow步骤**：`bundle:agent`本就是`build:packages && build-agent-bundle.mjs`，换入是旧命令的严格超集（同样工作加bundle，无重复构建），且对**干净的本地**检出也关掉同一缺口；而CI的`test` job会两次调vitest（`npm test`在三runtime、`npm run test:coverage`在ubuntu），workflow-only修法要么重复要么仍漏掉未来任何vitest入口
  - 已验证（#183，两个"新"失败文件被调查而非挥手放过）：全量after-run把`GrepTool.test.ts`与`run-cancel-budget.test.ts`列为before-run没有的失败，故头条delta是−6而非−8。`run-cancel-budget.test.ts`单独跑通过（load-sensitive flake）；`GrepTool.test.ts`是诊断族**F**（套件依赖`rg`已安装）。**对照实验**：把bundle移开它**仍然失败**（1 failure），bundle在时失败2——所以bundle不是原因
  - 已验证（#184，**两个真实产品bug，不是绕过**）：
    1. `packages/voice/src/env.ts:190`——`findOnPath`曾`pathEnv.split(';')`硬编码`;`，POSIX用`:`，于是切分产出一个垃圾条目、查找不可能成功。**在每个Linux与macOS host上，`detectWhisperBinary`永远无法从PATH找到二进制。** 证明分隔符就是全部故事——**同一目录、同一`whisper-cli`二进制**：`;`连接的PATH → **found**；`:`连接的PATH → **not found**。**既有测试断言的是正确行为，被故意留红——它是真正的bug detector。**
    2. `packages/agent/src/permissions/policy.ts:707`——browser-cookie路径只按字面`user data`/`microsoft/credentials`段识别（即AppData布局），而产品实际能读的路径里macOS `~/Library/Application Support/Google/Chrome/...`没有`user data`段、Linux `~/.config/google-chrome/...`是另一套布局、当前Windows的`Network/Cookies`布局也已搬走家。**修复前14种browser布局有10种不被识别；修复后14种全部匹配**，且原先把这些断言限定在Windows-only的测试现在到处都跑。`isSensitiveReadPath`只对工作区外读取可达，所以拓宽pattern不可能影响工作区内的读取。policy pattern与cookie importer之间加了交叉引用，使两份清单不能再次静默漂移
  - 已验证（#184，平台守卫不是偷懒）：四处窄的`describe.skipIf`/`it.skipIf`，每一处都因为被测行为在别的平台上**确实不存在**，且每一处都**配一个新的对偶合同断言**，使两个host的覆盖都被保留而非被丢弃（`securityPolicy`加POSIX断言、`cua-handlers`加off-Windows的`STRUCTURED_STATE_UNAVAILABLE`envelope、`profile-detector`加Linux"returns no profiles"、`policy-read-permission`保留`$HOME`断言在所有平台）。**没有`.skip`、没有xfail、没有文件排除、没有`--bail`、没有重试或阈值改动。夹具错的地方改夹具；测试对而产品错的地方（`env.ts`）把测试留红**
  - 已验证（#185，族C的缺失符号是**五种**不同种类，各自不同修法）：`getSubagentToolDefinition`（`99556ea4`删除，因为它只是`return subagentTool.toTool()`，而**advertised schema仍是真实合同**，故套件改从`subagentTool`对象读——**比被删的wrapper是更紧的断言**）；`_resetSharedParser`（随document parser service一起被`86f68e9e`删除，已无共享parser状态可重置，**移除该hook正是把下面的产品bug暴露出来**）；`APP_CONNECTION_SPEC_BYTE_BUDGET`（**relocated**——诊断没列的第五类：plan 580 D4删掉注册期`downgradeForByteBudget`并把8 KB裁剪搬到最后一公里`projectForProvider`，**不变量还活着，只是位置变了**）；`app-connection-tool.test.ts`**根本没有坏import**——它有2个陈旧断言（plan 580 D5加per-call `deadlineAt`、Phase 2C把工具移除改为owner-bucket作用域，故旧测试用`registry.register()`种下陈旧工具，而它硬编码`owner: 'non-mcp'`、位于每个replace set之外，**eviction路径从未被执行**）
  - 已验证（#185，族D的修复移除了**这一类**）：陈旧副本只会让碰巧写那一列的测试失败，而没人exercise的副本**永远不失败**——这就是三份已更新副本与三份陈旧副本并排存在的原因。`app-connections-fixture-head.test.ts`使这类漂移**可检测**：夹具必须位于已发布迁移列表的head、必须真的带`connection_slug`、且目录内任何文件都不得重新引入手写副本。修完缺失列后又暴露**两个叠在它后面的陈旧合同**（`FakeVault`没有`isUnavailable()`，而测试把fake以`vault as never`传入——**这正是该漂移躲过`typecheck`的原因**；`security.test.ts`的`toStatusDTO`白名单少两个字段且`remove()`已长出对进程级`ConnectorService`单例的调用，会构建真实`TokenVault`并去拿electron `app.getPath`）。`oauth-flow.test.ts`**不是漂移——它从未绿过**：其loopback stub以带伪造`.name`的普通`Error`拒绝，而`flow.ts`把`waitForCode`失败映射为`FlowError('redirect_failed')`并做`instanceof LoopbackServerError`检查，两半都落在`04521cb2`里，**该套件从写出来那天就自相矛盾**
  - 已验证（#185，族E的测试**此前是空转的**，这是该切片的头条发现）：`phase_d_no_dangling.test.ts`有3个失败，外加**1个静默通过却什么都没测的测试**——`consolidator.ts`那例断言`existsSync(path) === false`，路径是错的所以它指名的文件同样不存在，断言在从未看过真实文件的情况下通过。`orb-insert-tab.test.ts`的`vi.mock`指向上三级而被测模块import五级，**一个解析到不同文件的`vi.mock`什么也没mock**，所以那6个测试在对着一个从未生效的mock断言的同时执行**真实的**OS-context桥——这正是每例都报`os-context-bridge-disabled`而不是被测原因的原因。**非空转性由扰动证明、不是断言**：往`reconcile.ts`里重新引入Phase 2 renderer → 该测试挂；重建`consolidator.ts` → 该测试**现在**会挂（此前不会）；把mock的`isEnabled`翻成`false` → **以原始6个失败与原始原因**复现，证明mock现在真的生效
  - 仍不支持/未验证（#184，诊断为**文档化的平台缺口**，不是bug）：`apps/desktop/src/main/services/browser/cookie-importer.ts:187` 没有Linux分支（产品因此还**产不出**Linux Chrome cookie路径；#186只是让read-permission policy**认得**这类路径，是否加importer分支是另一个产品决定）；`cua-handlers.ts:212` 的CUA通道按设计（plan 575）仅Windows
  - 仍不支持/未验证（#184未动）：`packages/voice/tests/env.test.ts`（1）在#184**故意留红**，由#186的`env.ts`产品修复解除；`apps/desktop/src/main/ipc/__tests__/git-handlers.test.ts`（1）`git:review-diff`错误文本不同，需单独归因
  - 仍不支持/未验证（#185记录的归属边界）：`byte-budget.test.ts`最初跨到`@duya/plugin-core/mcp/core/projection`去重新断言最后一公里裁剪，那是测试文件新增的`pkg:agent -> pkg:plugin-core`边、`architecture-check`报"not in baseline"。**baseline不是本切片该重录的**，且plugin-core在自己的projection测试里已覆盖`projectForProvider`，故套件被收窄到AppConnectionTool拥有的那一半：注册时永不裁剪，且canonical schema逐字节存活
  - 仍不支持/未验证（#186未做）：`cookie-importer.ts`的Linux分支未加（见上）
Shim consumers + removal criterion:
  - #184/#185/#186 三个PR都**没有**改写或削弱任何断言去迁就漂移或损坏的源码：**测试对而产品错的地方，改的是产品**。被pin住的已移除行为的断言被repoint或**升级**（`config-agents`从精确相等换成更强的两半断言：`allow`仍**替换**coding base + 文档化的`BOT_TOOLSET`被追加；`runtime-closure`一个陈旧用例变成四个，现在守护**安全方向**；`useContextUsage`从硬编码`9200`换成"无live frame时本hook返回什么就比什么"，drift-proof）
Rollback/data compatibility: #183纯CI配置；#184/#185纯测试；#186改产品行为但**Windows行为不变**（每个生产调用点已传`process.platform`，故解析值归约为host自己的`path.delimiter`）。均无schema变更
Remaining blocker: 测试门禁**按设计仍然红**且可见。`architecture:baseline --write` **从未运行**（见下条）。`131 baseline fingerprint(s) no longer triggered`与`typecheck:evals`的"1 baselined key(s) shrank"被反复观测为既有漂移，无切片重录
Next task: 族F/G/I/J（#189、#192）；族A剩余文件与`git-handlers`（1）需单独归因
```

## CI 修复波 B：RAG hook、GrepTool 引擎、lobehub 解析、provider 合同与路由组（#189、#192）

```text
Task: G0.2 / CI fix wave B (I, F, G, J1) and routed groups (J3, J4, J5)
State: merged（#189 `f6a99dcc`、#192 `1ffabfc9`）；J2 与若干真实缺陷**刻意路由未修**
Head / branch / PR: 1ffabfc9 / fix/587-ci-remaining-families / fix/587-ci-routed-groups / #189 #192
Changed files and public entry: 族I改 `scripts/__tests__/memory-rag-hook.test.ts` 与 `memory-search-skill.test.ts`（**无产品代码**）；族F改 `packages/agent/src/tool/GrepTool` 的**生产**fallback；族G改 import path；J1改两个provider套件；J3/J4/J5共19个文件。#192含**两处生产修复**：`packages/agent/src/tool/registry.ts` 与 `packages/agent/src/tool/BrowserTool/DomainBlocker.ts`
Old caller → new caller / ownership:
  - 族I: 两个harness的spawn环境钉住`DUYA_MEMORY_ENABLED=1`，并在fail-open路径上断言`stderr === ''`，使memory gate与RAG-config gate保持可区分
  - 族F: Node fallback现在先`stat`参数路径，是文件就直接扫该文件；且**超出预算后继续计数、只停止保留**，使`truncated`诚实
  - 族G: `Mono`是全部18个icon条目的default export，所以直接import它在渲染上等价，并丢掉无用的`Avatar`/`Text`边——那是通往`@lobehub/ui`的**唯一**路径
  - J1: `useProvidersQuery`现在同时解析default provider与列表，两个`@/lib/ipc-client` mock factory都早于这第二次调用
Baseline failure set and new failure diff:
  - #189: 本PR这些文件的**局部**delta **31 → 0**；同树全量本地 **73 → 61**（33 → 32 files）。稳定比较为 **73 → 60**（`bash-task-store`与`RealTasks`两文件run间有别）
  - #192: **24个失败在19个文件里被修好**，外加**2个真实产品缺陷**被发现并修。分组：J3 7→0、J4 5→0、J5 13→0。全量本地 **34 failed / 12881 passed**
Checks:
  - #189 逐文件 before→after（对pristine代码测量）：memory-rag-hook **9 failed/3 passed → 13/13**；memory-search-skill **1/4 → 5/5**；GrepTool **6 failed (no `rg`) → 26/26**，且有`rg`时26/26；ProviderList **7 → 0**；ProviderManagement **6 → 0**
  - #189 族F的确定性复现：把ripgrep从`PATH`移除 → 26 passed → **6 failed**；装上则26 passed。修复后**26个测试在8/8次无ripgrep运行与5/5次有ripgrep运行下通过**。**未安装`rg`，未加依赖**
  - #189 归因：把7个改动文件还原到`bba7fbed`重跑`architecture:check` → 数字**完全相同**（16/25/460/227/146/811）
  - #192 逐文件 before→after：node-detail 12/13→13/13；SessionSearchTool 17/18→18/18；registry-unregister 23/24→24/24；config-agents 4/5→5/5；workflow-handlers 8/9→9/9；app-schema-marketplace 1/2→2/2；runtime-closure 22/23→**26/26**；server-integration 29/31→31/31；PlanTool.fallback 9/10→10/10；commsAndProfile 15/16→16/16；BrowserTool 0/1→1/1；stream-session-manager 32/33→33/33；MemoryRagCard 6/10→10/10；ContextUsageRing 8/10→10/10；workflow-run-card 17/19→19/19；HoverPopover 2/3→3/3；CompactSummary 6/7→7/7；useContextUsage 10/11→11/11；BotDirectChatView 23/24→24/24；AgentsSection 3/4→4/4。J5整组：**13 failed / 72 passed → 85/85**
  - #189/#192 `npm run typecheck:all` **PASS**（exit 0，无OOM）
  - #189/#192 `architecture:self-test` PASS（460/227/0/146/25/16）；`architecture:check` PASS（16/25/460/227/146/811）。#192 归因：把20个改动文件还原到`071b931d` → **数字完全相同**
  - #192 flake定案：在**两棵树**上单独跑都通过、只在全量负载下挂 —— `AgentTool.test.ts` 19/19、`coalescing-throughput.test.ts` 13/13、`app-connection-service.test.ts` 14/14
Capabilities actually verified / still unsupported:
  - 已验证（族I，**三个测试曾"因为错误的原因"通过**）：`isMemoryDisabled()`（`f51fdb8c`, 2026-09-23加入）默认**禁用**（除非`DUYA_DEV=1`），且在hook模式下两个脚本都在**读stdin之前**`process.exit(0)`。harness以`{ ...process.env }` spawn，所以套件能否到达retrieval取决于开发者的shell。**`runHook`（exit 0 + 空stdout + 无stderr）看到的就是一个早退的门**——诊断先手工跑hook确认它exit 0、什么都不写、**stderr也什么都不写**，所以"捕获stderr"这一步必要但不充分。修法是钉住环境变量；暴露真实stdout后又暴露`be95f2cf`（2026-08-22, "switch RAG hook output to line-windowed snippets"）刻意替换了plan-430/437的格式合同却从未更新本套件——4个陈旧断言各自被repoint到当前合同且理由写在代码里，其中3-hit-cap夹具用的是**1个term**的prompt（5篇文档全score 1.0，cut落到bm25文档长度归一化），而套件断言**rowid顺序**（`retrieve()`明确文档化了它不使用该顺序）；breadcrumb测试的"top hit"正文**两个term都不含**，所以该断言不可达，只是因为套件从未到达retrieval才"通过"
  - 已验证（族F，**修了生产fallback而不是收窄测试**，因为套件抓到两个真bug）：
    1. **裸文件路径静默返回nothing。** `walkDirectory` readdir()它的参数并吞掉`ENOTDIR`失败，所以`searchWithNode(path/to/file)`产出零匹配并报告为`success: true, message: "No matches found"`——**一个与真实未命中无法区分的假阴性**。ripgrep扫文件路径毫无问题，所以fallback现在先stat路径并直接扫文件
    2. **`max_results`让walk停止计数。** 51个匹配、上限10的搜索报告`total: 10, truncated: false`——**一边静默有损一边声称没丢东西**。ripgrep引擎自己的注释陈述了正确意图（"every match line increments the total counter so the report stays accurate even when the result budget is exceeded … rg runs to completion"）。fallback现在超出预算后继续计数、只停止保留，使`truncated`诚实；时间预算仍界定walk且仍报告明确的不完整警告
    另有两个测试在与host赛跑而非测任何东西：长行测试读`matches[0]`（依赖readdir顺序与ripgrep walk顺序一致，现按名定位）；两个时间预算测试在两文件walk上设1 ms预算（暖缓存下可在1 ms内完成，**实测6次运行里失败4次**，现改400个夹具文件使越过deadline成为必然）
  - 已验证（族G的完整链条，走16.5k文件的import图建立）：`PresetIcon.tsx` → `@lobehub/icons/es/<Name>`（barrel，**急切**re-export `.Avatar`）→ `es/<Name>/components/Avatar.js` → `es/features/IconAvatar/index.js`（为一个布局primitive import整个`@lobehub/ui` barrel）→ `es/Tooltip/TooltipInGroup.mjs` → import `'@base-ui/react/merge-props'`。断点在最后一步。**`resolve.alias`与`test.alias`都试过并被revert**：两者都不拦截该内部解析，而mock只会掩盖bug的形状。修好collection后又暴露13个底下既有的失败 → 路由到J1并在那里修
  - 已验证（#192的**两个真实产品缺陷**）：
    1. `packages/agent/src/tool/registry.ts:379`——运行时守卫**只**拒绝`'non-mcp'`，而错误消息与方法自身合同都承诺`'mcp' | connector:<id>`。任何其它值通过校验，然后在commit阶段**把prepared条目种到一个此后没有任何replace-set能再定位到的owner字符串下**——把它们永久孤立在catalog里。拼错的bucket名（`'connectr:slack'`）更糟：它被要求执行的移除**静默地什么都没做**。三个真实producer都显式构造owner（`'mcp'`在`DuyaAgent.ts:4696`，`` `connector:${connectionId}` ``在`AppConnectionTool/index.ts:306,368,375,379`），所以收紧守卫对它们是no-op。`registry-unregister.test.ts > throws on unsupported ownerId`**本来是对的**并断言了这点，现在未修改地通过
    2. `packages/agent/src/tool/BrowserTool/DomainBlocker.ts:27`——`isUrlBlocked`是一般的"这次导航该不该被拦"闸门，而它的第一步是`isSafeUrlSync` SSRF检查，该检查把**除http/https外每个scheme**都以`Unsupported protocol`拒绝。后果：**所有本地`file://`导航是死的**——`FallbackBrowser.navigateLocalFile`（限制在工作目录内、HTML扩展名白名单的本地reader）是**不可达代码**，而测试它的那个测试永远不可能通过。**面向用户的消息在撒谎**：`Navigation blocked: <url> is in the domain blocklist`被报告给那些没有任何domain list被查询过的URL，实际文本是`Navigation blocked: file:///...page.html is in the domain blocklist`。SSRF（私网IP、loopback、DNS rebinding）只关涉远程fetch目标，所以该检查现在**只作用于http(s)**，其它scheme由各自的per-scheme confinement治理。**远程URL保护逐字节未变**；`DomainBlocker.test.ts`、`navigation.test.ts`与`search.test.ts`全部仍然通过（51 tests）
  - 已验证（#192 J3里`SessionSearchTool`的一条）：`roleFilter`在搜索迁到IPC时变成**静默no-op**（源码自己这么写：`_roleFilter`、"no longer applied"），所以schema不再声明它。**advertise一个工具忽略的参数会让模型发出它并把未过滤结果读成已过滤**，因此诚实的合同是**该key不存在**，现在被断言；宽容的`execute({ roleFilter})`向后兼容用例未动
  - 仍不支持/未验证（J2 `WorkflowPanel.test.tsx` 12个失败，**查到根因但刻意不修**）：12个失败全来自两个缺失testid，而**两个testid都不是组件回归**。套件驱动的console被**整体搬家**：`WorkflowPanel.tsx:1148`现在标注`// ─── legacy panel entry ───`，导出的`WorkflowPanel`是个忽略props、只提供一个调`setCurrentView("workflow")`的按钮的stub；真正的console现在住在`components/workflow/`（`WorkflowPage`、`WorkflowLibraryView`、`WorkflowRunDetailView`、`run-display/*`），带**不同的testid词汇**（`workflow-run-history`、`workflow-history-row-<id>`、`workflow-library-embedded`、`workflow-run-node-graph`）；`workflow-tab-runs`与`workflow-tab-definitions`**在任何地方都不存在了**（tab bar已移除，故"repoint testid"这条路不存在），i18n key `workflow.panel.useMainPage`/`openPage`把这次搬迁**文档化**为刻意行为。**repoint那12个用例意味着对着被重写的UI、没有共享testid去重新撰写它们，即写新测试而不是修陈旧合同。** 路由给产品决定：要么对着`WorkflowPage`重写套件，要么用页面级套件取代它。同级`panel-zone-workflow-view.test.tsx`已覆盖panel当前合同
  - 仍不支持/未验证（`sync-protection.test.ts` 1个，**真实缺陷，需产品决定，刻意未修**）：`expected 'bundled' to be 'plugin'`。根因钉在`44109a68 feat(agent): add bot-scoped skills under each bot's own directory`——它把`plugin: 3 → 2`下调以插入`agent`层，**但没有顺移plain-bundled**，于是`plugin`与plain-bundled现在**都score 2**，胜者由**发现顺序**决定——那是文件系统意外，不是策略。模块头仍文档化`plugin (3) > plain bundled (2)`，而同级测试`skillService.test.ts:52-54`钉的是**冲突后的**数字（plugin 2、bundled-marked 2、bundled-unmarked 1）。两种读法各自自洽，所以这个阶梯需要owner：要么头要么那个测试是权威。**我不在猜测下重编号一个用户可见的策略**
  - 仍不支持/未验证（#192路由未修）：`DuyaAgent.plan315.test.ts` 2个（deferred tool follow-up投影；proactive compaction续写）；`DuyaAgent.plan486.test.ts` 2个（fork出的turn**正在**到达模型投影，而测试说它必须不到；`[In reply to root-1: ...]`注入缺失）——该feature仍存在（`THREAD_METADATA_KEY`在`message/threads.ts:29`，注入在`DuyaAgent.ts:4930-4978`）且`readThreadMeta`与测试的durable形状一致，所以这些是**投影路径的行为回归**，不是drift，需要自己的切片；`permissions-gate.test.ts` 2个，鉴于`askWithoutUser` fail-closed工作正在同一区域落地而刻意未动
  - 仍不支持/未验证（#189/#192明确out of scope的既有失败）：`slice-classification`（8，587自己陈旧的记录inventory）、`13-citation-drift`（1）、`workflow-store.test.ts > migration 30`（1）、`RealTasks`（1，经把`GrepTool.ts`还原到base复现相同失败而**证明**为既有）
  - 仍不支持/未验证（#192记录的装饰性遗留）：`HoverPopover.tsx:26-27, 121`的模块文档仍声称"Portal body into document.body"，且`wrapperRef`是portal回退后留下的**死代码**
Shim consumers + removal criterion: 无新增shim。族G去掉了通往`@lobehub/ui`的`Avatar`/`Text`边（`architecture:check`与master**逐字节相同**，deep-import仍是25，所以更深的子路径**不被**计为deep import）
Rollback/data compatibility: #189改生产fallback（GrepTool）——回退会恢复假阴性与不诚实的`truncated`；#192改registry守卫与DomainBlocker——回退会恢复owner拼写导致的静默不移除与`file://`导航之死。两者均无schema变更
Remaining blocker: 门禁仍红。已证flaky的三个文件在两棵树上单独跑都通过；已证确定性并在两棵树上同样复现的五个：WorkflowPanel 12、plan315 2、plan486 2、permissions-gate 2、sync-protection 1
Next task: 族A剩余文件与`git-handlers.test.ts`（1）需单独归因；`slice-classification` 8个失败有切片在飞（见下条）
```

## BashWorker 产物：清单里有、构建里没有（#191）

```text
Task: E4.4-B / BashTool worker artifact
State: merged（#191，`701e0011`）
Head / branch / PR: 701e0011 / fix/587-bashworker-artifact / #191
Changed files and public entry: `scripts/build-agent-bundle.mjs`（新增**第二个esbuild entry**，CJS，输出到 `packages/agent/bundle/BashTool/BashWorker.js`）；`scripts/after-pack.js`（在该worker未出现在打包resources时FATAL，并区分"从未构建"与"构建了但没拷贝"）；`scripts/check-packaged-artifacts.mjs` + 其测试；`scripts/packaged-artifact-baseline.json`（删除`BASHWORKER-NOT-BUNDLED`条目）
Old caller → new caller / ownership: `AGENTS.md` §"Agent Bundle (MUST FOLLOW)"的预发布清单（`AGENTS.md:562`、`:567`）点名`release/win-unpacked/resources/agent-bundle/BashTool/BashWorker.js`，**没有任何构建产出它**。`packages/agent/src/tool/WorkerPool.ts:52` **第一个**就解析`path.join(dirname, 'BashTool', 'BashWorker.js')`；`scripts/build-agent-bundle.mjs`只写入口、CJS marker与`assets/`；`scripts/after-pack.js`验证入口、`better_sqlite3.node`与playwright——**不验证worker**；也不存在`resources/agent/tool/`树来覆盖那4条fallback路径。所以`resolveBashWorkerPath()`告警并返回一个不存在的路径，Bash工具起不来。**因为`electron:dev`先跑`bundle:agent`且dev resolver优先bundle目录，这也在dev里坏，不只是release**
Baseline failure set and new failure diff: 该缺陷此前被登记为known defect（`BASHWORKER-NOT-BUNDLED`）而不是修复，因为修它改变**发布什么**。本切片就是那个修复
Checks:
  - `npm run bundle:agent`  exit 0；产出`BashTool/BashWorker.js`（**11.24 KB**）
  - 门禁 `static`：0 findings，**0 known defects**
  - 门禁 `--bundle`：0 findings
  - 门禁 `--packaged`：**未运行**——无package，会报`unverified`
  - `npx vitest run scripts/check-packaged-artifacts.test.ts`  **47 passed**（master: 32）
  - `npm run typecheck:all`  exit 0（17个子门禁；`typecheck:cli`无OOM）
  - `architecture:self-test` 460/227/0/146/25/16；`architecture:check` 874 total / 874 tolerated / baseline 811，无新违规
  - 归因：把5个改动文件移开到`origin/master`重跑`architecture:check` → 数字**完全相同**（460/227/0/146/25/16、874/874/811）——本变更不加import也不加边界边
  - 突变自证**三次**（每次`git checkout`还原，**从不`git stash`**）：1) 构建还原到修复前master → worker不再产出（`Test-Path` False），`--bundle` → **FAIL** `bundle-file-contract:bash-worker` exit 1，且因baseline条目已删除，这是**硬失败而非降级**；2) 给已构建的worker追加一个第三方require → 修复后**FAIL** `bash-worker-self-contained: the built BashWorker requires node-fetch…` exit 1，附全部literal require作为证据；3) `after-pack.js`还原 → 测试*"is verified by after-pack.js so a missing copy fails the release"* **FAIL**，1 failed / 46 passed，exit 1
  - 针对**真实已构建产物**（不是源码）的require清单：`child_process, fs, fs/promises, node:buffer, os, path, util`；非内建specifier `[]`、相对require `[]`；require调用总数 7、literal require 7
Capabilities actually verified / still unsupported:
  - 已验证（**为什么worker用`external: []`**）：被spawn的worker是**独立程序**，不是bundle内的模块。`WorkerPool`用`spawn(runtime, [workerScriptPath], { stdio: [..., 'ipc'] })`，**不是`fork`**，所以没有任何东西把入口的解析环境交给worker：无`NODE_PATH`、无`execArgv`、无自己的`node_modules`。在打包应用里它住在`resources/agent-bundle/BashTool/BashWorker.js`，那里唯一的`node_modules`是`after-pack.js`为满足**入口的**externals而拷贝的那一个。**入口可以合法保留的require正是worker无法解析的require。** 所以worker用`external: []`构建，**刻意不用**入口的六条目allowlist——复用那份列表会让esbuild发出运行时无人能解析的`require`，那正是被修的这一类bug。BashWorker的传递闭包只有Node内建，故全量打包使该文件真正自包含
  - 已验证：`electron-builder.yml`**未改**——既有`packages/agent/bundle/ -> agent-bundle/`的`extraResources`规则用`filter: ["**/*"]`，新子目录无需配置改动即被拷贝。`WorkerPool.ts`**未动**——第一个候选现在就是能解析到的那个，4条fallback路径未变且仍自洽。`BashWorker.ts`未动，**worker行为不变**，只改了它在哪里被构建与发布
  - 已验证：known-defect条目被删除是**满足它自己记录的移除条件**（"emitted by a build step, `after-pack.js` FATALs when it is missing, and this entry is deleted"）。它被删是因为门禁经突变检验过：还原构建会让`--bundle`硬失败，所以该条目**再也无法掩盖回归**
  - 仍不支持/未验证：**打包副本只被结构化验证，没有靠真实package。** 未跑`electron:pack`/`electron:build`（磁盘）。`electron-builder.yml`递归`**/*` filter与新的`after-pack.js` FATAL是**被读取和断言的，不是对真实`release/win-unpacked`树执行的**。`--packaged`模式仍为`unverified`
  - 仍不支持/未验证：不声称打包应用真的能spawn该worker。手上最强的证据是**该已构建文件在此处被spawn并执行过**：裸`node <file>`、无cwd无module提示，返回`ready`、解析出Git Bash、完成一条真实命令（`exitCode 0`）——**但那是在`node_modules`存在的检出里，故不是打包应用证明**
  - 仍不支持/未验证（#191自己发现的盲区）：`classifyRequires`跑一个状态机，而该lexer**在真实minified worker的中途（11529字节中的offset 1815，在minified的shell-detector代码里）失去同步**，然后**什么都不报**。那之后的每个`require`都不可见——包括追加在最后的一个。故worker检查不依赖它：literal specifier由**无状态文本扫描**决定，lexer只被咨询computed require。**该lexer失同步本身未在此修复**：它是共享helper里的既有盲点、影响入口bundle的`bundle-self-contained`检查、且修它可能改变属于门禁自己那个切片的结论。**被上报，不是被静默打补丁**
  - 仍不支持/未验证：static模式的producer测试是粗的——它在拼接的producer源码里搜路径，所以单靠`after-pack.js`的*验证*就能满足它。**只有`--bundle`能抓住真实产出回归**。既有粗粒度，未动
Shim consumers + removal criterion: `BASHWORKER-NOT-BUNDLED`已删除，其移除条件已满足（见上）。`resolveBashWorkerPath()`的4条fallback路径保留：第一个候选现在可用，fallback仍是**自洽的**兜底而非死代码
Rollback/data compatibility: 纯构建/打包脚本。`extraResources`已覆盖该子目录，故无打包配置不兼容
Remaining blocker: `architecture:check`建议重录陈旧baseline（`--write`）——**按指示未运行**，实门禁本身是绿的
Next task: 在有空间的机器上跑`check:packaged-artifacts:packaged`并接进release workflow（该workflow已在macOS上打包并验证）；`scripts/verify-packaged-parity.mjs`应补上BashWorker路径使两个检查一致
```

## notebook 读取能力恢复（#187）

```text
Task: capability restoration / ReadTool .ipynb
State: merged（#187，`85976376`）
Head / branch / PR: 85976376 / fix/587-restore-notebook-read / #187
Changed files and public entry: 恢复 `packages/agent/src/utils/notebook.ts`（同一路径，仍是无依赖的纯函数模块）；`ReadTool.readAsDocument` 现在对`.ipynb`在unsupported-binary拒绝之前调用它；新增 `packages/agent/src/utils/__tests__/notebook.test.ts`（8个单测）
Old caller → new caller / ownership: `86f68e9e`（2026-09-09, "chore: remove document parser service and Office panel"）把`packages/agent/src/file-parser/`与`packages/agent/src/utils/notebook.ts`连同Office面板一起删掉，**`.ipynb`读取路径是那次范围限定于document-parser-service的改动的附带损失**。该feature由`abd6bf21`/`ea80c577`加入并随v0.2.0-beta.1发布
Baseline failure set and new failure diff: #185**故意留红**的3个ReadTool测试就是本变更实现的合同
Checks:
  - BEFORE（`origin/master`）`Tests 3 failed | 20 passed (23)`：× routes .ipynb through the document parser (not text mode)；× routes .ipynb to document mode even when cell_range is set；× produces a stable serialized format for a sample notebook (snapshot) → `expected 'Error: Cannot read '…snapshot.ipynb'' to contain '[2 cells, kernel=python, …'`
  - AFTER `Tests 23 passed (23)`
  - ReadTool套件全体 + 新的notebook单测：`Test Files 6 passed (6)` / `Tests 131 passed (131)`
  - 新测试的归因（保留新测试、把reader还原到`origin/master`）：`Tests 7 failed | 20 passed (27)`——3个原本红的测试 + 4个新错误合同（非JSON、非notebook的JSON、装不下的`cell_range`、~50KB边界并指名续读cell）
  - 更广的agent套件（`packages/agent/tests` + `packages/agent/src/tool`）：BEFORE `Test Files 14 failed | 236 passed | 7 skipped (257)` → AFTER `12 failed | 238 passed | 7 skipped (257)`。**同样257个文件**。剩余15个测试失败全在同级切片拥有的既有族里（BrowserTool、AgentLoop、RealTasks、mcp runtime-closure、registry-unregister、SessionSearchTool、skills sync-protection、DuyaAgent.plan315/plan486、permissions-gate、agent-profile config-agents、PlanTool.fallback），**其中没有ReadTool或notebook文件**
  - `npm run typecheck:all` exit 0，无TS错误（`check:encoding`、`check:manifest-keys`、`check:test-coverage`、`check:no-ts-suppress`与`check:packaged-artifacts`全OK）
  - `architecture:self-test` OK；`architecture:check` **未变**（460/227/0/146/25/16、baseline 811、total 874、"OK — no new boundary violations"），把变更移开后**相同**。`ReadTool.ts`与`utils/notebook.ts`都是`pkg:agent`，故新import是同owner边，不计为跨边界边
  - `typecheck-electron-gate`的"1 baselined key(s) shrank or disappeared"经把变更移开后在`origin/master`上验证**相同**——既有漂移
Capabilities actually verified / still unsupported:
  - 已验证：**原实现是被恢复的，不是被重写的。** `git show 86f68e9e^:packages/agent/src/utils/notebook.ts` 在历史里完整存在（405行），`git show 86f68e9e^:packages/agent/src/file-parser/parsers/notebook.ts`（129行）持有`serializeCellForModel`。解析、cell-range、summary与序列化逻辑**就是那段原始代码**。适配它是显然正确的选择：**snapshot测试断言旧`serializeCellForModel`输出的精确字节格式**，故全新实现只能靠猜来匹配
  - 已验证：幸存下来的一切让该工具**自相矛盾**——`input_schema`仍向模型advertise`cell_range`（描述为"end of notebook"）；`isDocMode()`仍有活的`if (ext === '.ipynb') return true`分支，其注释写着".ipynb must always go through the document parser"；`dispatch()`仍在`.ipynb`时保留`cell_range`。**只有reader没了**，于是读取失败为`Error: Cannot read '...snapshot.ipynb' — unsupported binary format (.ipynb).`，而`cell_range`仍被接受与advertise
  - 已验证（对已删除代码的**两处刻意背离**）：**sidecar image提取器未恢复**——它写`<notebook>.cells/`目录到用户notebook旁边以喂给已删的`RawParse.images`→`result-builder`，而后者反正只告诉模型去调vision工具；恢复它会在用户工作区里造游离文件去服务一条已不存在的路径。图像输出被记为`hasImage`并报告为未包含，所以一个含plot的cell不会被读成没有输出——**旧代码是静默丢弃它们的**。`cell_range`改为**解析时**应用而非按序列化chunk过滤（旧`filterChunksByCellRange`的做法），这同时带来`validateCellRange`的范围错误，并让summary行描述的正是返回的那些cell而非整个notebook。值得注意：被删代码曾有**两套**cell-range语义实现——一个`parseNotebookJson`上从无调用者的`cellRange`选项，和`ReadTool`实际使用的chunk过滤器。**只有第二个是活的**，所以该feature端到端确实能工作；失去的是整条调用路径。本变更保留一套，且是带校验的那套
  - 已验证：`cell_range`现在的行为——1-based含区间；`end: -1`意为到notebook末尾；`end`超过最后一个cell被**截断**而非拒绝。**cell id保持整个notebook的编号**，故范围读取仍指名真实cell。由`packages/agent/tests/unit/tools/ReadTool.test.ts:189`（`routes .ipynb to document mode even when cell_range is set`）证明——3-cell notebook上`cell_range: {start: 2, end: 3}`返回`cell-2`与`cell-3`且不含`cell-1`——以及8个覆盖切片、`end: -1`、截断、范围下id稳定的单测
  - 已验证：畸形输入被以面向模型的消息拒绝，**从不**是stack，**也从不**是静默空读：非JSON → `Cannot read notebook: invalid notebook JSON: <reason>`；JSON但非notebook（数组/字符串/数字/`null`/对象）→ `Cannot read notebook: unsupported nbformat version 0 (only 3 and 4 supported). …`；未来nbformat → 指名它看到的版本；`cells`条目不是cell对象或无可读`source` → 指名1-based cell序号与它实际拿到的东西；装不下的`cell_range` → `cell_range invalid: …`/`exceeds notebook size (N cells)`。**最后一行是本实现中发现的真实缺口**：`cells: ["oops"]`否则会序列化成source为`undefined`的cell
  - 已验证：notebook读取像文本读取一样被界定在50KB、以**整个cell**发出（故结果永不以半个tag结束）、且边界会指名从哪个cell续读。notebook读取被记为**部分视图**，因为结果是JSON的投影而非磁盘上的字节。非notebook上的`cell_range`仍被忽略，带既有的`cell_range only applies to .ipynb files`注记；notebook上的`line_range`此前被静默忽略、现在会明说
  - 仍不支持/未验证：`86f68e9e`的**刻意**部分全部保留：没有document-parser service、没有Office面板、没有`file-parser/`注册表/worker pool、没有PDF/DOCX/PPTX/XLSX parser。**只恢复notebook读取路径**
  - 仍不支持/未验证：保留`readNotebook`内的内层`try/catch`部分是冗余的——`readAsDocument`既有的外层catch已经把throw变成干净的`Error reading file: …`。保留它是为了产出同级错误返回使用的`Error: `前缀，并让合同留在notebook路径本地而非依赖别处的catch-all
Shim consumers + removal criterion: 无shim；这是删除后的能力恢复
Rollback/data compatibility: 无schema变更、无数据迁移。回退恢复`86f68e9e`的状态（`.ipynb`读取失败而`cell_range`仍被advertise，即#187修掉的自相矛盾）
Remaining blocker: 无
Next task: `05-behavior-and-evals.md`归另一会话所有；本条只提供ReadTool合同恢复
```

## E4.4 bullet 1 合同结果：跑了，是红的（#188）

```text
Task: E4.4 / bullet 1 turn contract
State: merged（#188，`23864623`）；**E4.4仍未验收**——合同运行且失败
Head / branch / PR: 23864623 / test/587-e4-4-contract / #188
Changed files and public entry: `e2e/turn/electron-turn.spec.ts`（删掉`test.fixme(`、更新文件头、`openCoreDb`错误串）。**非注释改动恰好两处**：零个`expect(...)`被增删
Old caller → new caller / ownership: 不适用（测试合同）
Baseline failure set and new failure diff: 先前基线是 **1 passed, 1 skipped (16.9s)**；现在合同不再被skip、它**失败**
Checks:
  - `npm run test:e2e:turn`（真实`electron:build`）  **1 passed, 1 failed (35.0s)**
    `ok 1 [turn] › electron-turn.spec.ts:307:7 › the real boundary opens a durable run bound to this turn (15.0s)`
    `x  2 [turn] › electron-turn.spec.ts:375:7 › E4.4 contract: events, terminal and UI agreement (17.3s)`
  - `npm run typecheck:all` exit 0，302 known / 148 keys，无新错误
  - `architecture:self-test` OK（460/227/0/146/25/16/0）；`architecture:check` OK，无新边界违规
  - 归因守则：Playwright跑用的是真实`electron:build`（`dist-electron/main.js`带bundled preload），不是browser-only的Vite跑，故preload路径被真正exercise
Capabilities actually verified / still unsupported:
  - **已验证（合同失败在两条断言上，两条都陈述了真实产品没有的形状）**：
    1. `expect(turn.frameTypes[turn.frameTypes.length - 1]).toBe('done')` 收到 **`title_generated`**。真实终态序列是 `ready, appConnection:listDescriptors, status, token_usage, status, text, text, token_usage, token_usage, db_persisted, done, title_generated`——**session标题在turn完成后生成，所以`done`在wire上不是最后一个**
    2. `assistant.message_finalized`查找——**0行**。一个真实完成的turn持久化的是`assistant.text_block`事件
  - **已验证（这不是#182的不完整修复）**——从同namespace的SQLite读回：`status=completed terminal=completed started=1791102550927 finished=1791102557497`；`events(7): 1:run.started 3:assistant.usage 5:assistant.text_block 6:assistant.text_block 7:assistant.usage 8:assistant.usage 9:run.completed`；`first payload.manifestHash=5d4b76f7...`；`last payload={"type":"run.completed","status":"completed"}`。**`chat:start`被dispatch，turn到达终态，账本以递增唯一`seq`持久化，`run.started`为首并携带该行的manifest hash，`run.completed`为末且与该行一致。#182修掉的那一类缺陷穿过真实preload边界确实消失了**
  - 已验证（断言为何陈旧）：**在`openRun`拒绝期间，stream停在`ready`。** 没有文本、没有终态、没有账本——所以frame顺序与事件名**从未可观测**，那两条断言是猜的。合同被写成必然失败，它也确实失败了；**但它也猜错了远端，只有真实turn才能揭示**
  - 仍不支持/未验证：**E4.4 bullet 1 未满足**。没有live provider、没有packaged app（E4.4-B未达成）、`chat:start`**恰好一次**在此处**未**被断言（那条声明属于#182，在bridge层）、单轮纯文本、renderer一致性是对SSE帧而非像素检查
  - 仍不支持/未验证：`typecheck:all` **不覆盖**该文件。仓库中**16个tsconfig无一**引用`e2e/`（已核实），故那个门禁对本变更**不构成任何证据**；对所有既有e2e spec都是既有问题。`--project=turn`单独用会失败并报`Project(s) "turn" not found`；该项目只能经`--config=e2e/playwright.config.ts`到达，而`test:e2e:turn`提供了它
  - 仍不支持/未验证：E4.4 bullet 2（live provider turn / approval / stop 对真实凭证）**unsupported——无key**。E4.4 bullet 3的**packaged**副本只被结构化验证（见#191条）
Shim consumers + removal criterion: 不适用
Rollback/data compatibility: 不适用（只改测试）
Remaining blocker:
  - 刻意不做：**没有收窄任何断言**且**没有重新引入`fixme`**。被裁到绿的合同是橡皮图章，而这次失败是关于**哪些期望错了**的信息，不是该消音的噪声
  - 刻意不做：**没有改任何生产代码**。解决那两处不匹配是**对E4.4合同本身**的改动，属于拥有该bullet的人
Next task: ~~修正 `e2e/turn/electron-turn.spec.ts:375` 起的两条陈旧断言——末帧改断言 `title_generated`（或断言"`done`之后无终态"）并把事件查找改到 `assistant.text_block`；durable状态本身已正确，改完该测试应转绿~~ **已执行并部分撤回该建议**（详见下条记录）：末帧那条**测试错、产品对**，已改为断言真正成立的不变量；事件查找那条**断言对、产品缺**，故**不得**改到 `assistant.text_block`——那会把契约违规冻成绿灯
```

## `assistant.message_finalized`：哪一边错了，以及为什么不是"陈旧声明"（E4.4 bullet 1 裁定）

```text
Task: 裁定 `e2e/turn/electron-turn.spec.ts` 两条红断言各自谁错；不得靠改测试迁就现状
Status: 已裁定。末帧那条**测试错**，已修；finalized 那条**产品缺**，断言保留为红。缺口已入册并加门禁
Measurement（用生产 translator 喂真实帧序，非猜测）:
  - 帧序 `ready, appConnection:listDescriptors, status, token_usage, status, text, text,
    token_usage, token_usage, db_persisted, done, title_generated`
  - 产出协议事件 `assistant.status x2, assistant.usage x3, assistant.text_block x2, run.completed`
  - durable 子序列与E4.4读回的台账逐条一致（run_events 7 行，seq 有洞 = 合同 §F 的稀疏语义）
  - `assistant.message_finalized` 产出=false
  - 全树**没有任何构造点**：desktop / headless / CLI / subagent 全部汇入 `controller.ts:821` 的
    单一 `translateFrame` 接缝，故**无一条路径**产出它。统一缺失，不是部分路径缺失
Evidence for "registry 是对的，产品是缺的":
  - `registry.ts:202` 声明 durable；`required.ts:94` 要求 content+stopReason
  - `sse-event.ts:185-186` 自带存在理由："旧表面从不标记消息停止变化的那一点，所以 compaction
    只能猜边界" ——陈旧声明不会带理由
  - `07-agent-protocol-spec.md:244` 从 `AssistantMessage` 推导 payload
  - 合同 §F:64 要求断线文本靠 message snapshot + cursor 恢复
  - 消费者已按 authoritative 且 superseding 实现：`transcript-snapshot.ts:28-31, 195-200`
Why NOT a one-line translator fix:
  - `chat-event-translator.ts` 三条不可谈判规则第一条是"nothing is defaulted into existence"，
    且 `done` 分支注释明写 stopReason 缺失是观察、填一个就是编造
  - 唯一终态帧 `chat:done` = `{sessionId}`（`worker-protocol.ts:326-329`），两个 REQUIRED 字段都没有
  - 故补齐 = **扩 wire**（agent 必须带 finalized message），不是加分支
title_generated 裁定:
  - `router.ts:1708-1715` 注释明写"标题生成是 worker 里另一次不被 await 的异步 LLM 调用"
  - `router.ts:1716-1726` 5s 窗口后强关流 → 标题**可选**，故"末帧字面量"两种写法都不可靠
  - 规格 `07-agent-protocol-spec.md:278`、`:313` 归 host-only；translator 对它 unmapped
  - 结论：**运行时没有越契约，是断言写错了**。改为断言不变量（终态存在+带payload+其后只允许标题帧）
Fix: census 加 durable assistant 族 4 行 + 门禁（scope 从 registry 派生，非手列）
Gate mutation table:
  - M1 删掉 message_finalized 行 → RED（3 failed，点名该事件）
  - M2 声明一个新的 durable assistant 事件且不给行 → RED（3 failed，证明 scope 是派生的）
  - M3 把 NOT YET producer 改成真实文件 → RED（1 failed，unproduced 集合变空）
  - 三次还原全部 `git checkout HEAD -- <file>`，无 stash；还原后 70/70 绿
Still unsupported/unverified:
  - **spec 断言变更未经执行**：本轮未跑 `electron:build`（磁盘禁令），故
    `npm run test:e2e:turn` 未跑。已用 `tsc --strict` 单独类型检查该文件（exit 0），并用探针文件
    证明该检查非空（真类型错误 → exit 2）。**类型通过 ≠ 断言通过**
  - 仓库 **16个tsconfig无一**引用 `e2e/`，故 `typecheck:all` 对本文件**不构成任何证据**
  - 既有失败（与本切片无关，clean origin/master 上复现）：`13-citation-drift` 1 failed —
    5 条引用指向 monorepo 迁移前的 `router.ts` / `ai/src/types.ts` 路径
Next task: 补 `assistant.message_finalized` 需要**扩 worker wire**（让 agent 在 done 边界带上
finalized message），再在 translator 加分支；这是独立大切片，不属断言修正
```



```text
Task: 状态盘点 / open items after the E4 exit and the CI arc
State: 无代码改动（纯记录）
Head / branch / PR: 不适用（基线 `1ffabfc9` = master, PR #192）
Checks（CI实测，本切片亲自从job日志解码复核）:
  - 前波基线 ubuntu `5dc45fcf`（run `37180632253` job `111372319161`）**实测 72 failed files / 216 failed tests**（+1 error），collect 1091 files / 12890 tests
  - 修复波后 ubuntu `071b931d`（run `37192237325` job `111406687364`）**实测 37 failed files / 66 failed tests**（+1 error），collect 1096 files / 12997 tests
  - 修复波后 macos `071b931d`（run `37192237325` job `111406687285`）**实测 47 failed files / 105 failed tests**，collect 1096 / 12997
  - **`#192`（`1ffabfc9`）的run `37194425248` 写作时仍为 `queued`** → **修复波末端的CI数字未验证**
Capabilities actually verified / still unsupported:
  - 已验证：CI口径上 ubuntu **216 → 66**、**72 → 37文件**；macOS **仍是最差的一条腿**（105 vs ubuntu 66），**证实了诊断"macOS不是ubuntu"的判断在修复后依然成立**
  - 仍不支持/未验证：**`#192`状态下的ubuntu/macos数字没有已完成的run。** `34 failed / 12881 passed`是#192的**本地**全量套件计数，**不是CI数字**，不得与上面的216→66相加或混用（见下条流程规则）。任何声称"CI降到34"的说法都是把本地计数冒充CI口径
  - 仍不支持/未验证：E4.4 bullet 1（红，见上）、bullet 2（无key）、bullet 3的`--packaged`模式（无package）
Shim consumers + removal criterion: 不适用
Rollback/data compatibility: 不适用
Remaining blocker:
  1. **在飞未定：`slice-classification`（8个失败）**。分支 `fix/587-slice-classification-gate` 在其工作树里**尚无提交**（`origin/master..` 为空），故本条只作为**开放项**记录，不写成已完成。该测试是587**自己**陈旧的记录inventory（族H）
  2. 已路由未修，需产品决定（都不该在CI清理切片里猜）：`WorkflowPanel` 12（面板被刻意重写成legacy stub，见#192条）；`plan315` 2 + `plan486` 2（投影路径行为回归）；`permissions-gate` 2；`sync-protection` 1（`44109a68`造成`plugin`与plain-bundled同分2的真实优先级tie）
  3. 已证确定性且在两棵树上同样复现（既非flake也非本波造成）：`WorkflowPanel` 12、`plan315` 2、`plan486` 2、`permissions-gate` 2、`sync-protection` 1
  4. 已知既有、明确out of scope：`slice-classification` 8、`13-citation-drift` 1、`workflow-store > migration 30` 1、`RealTasks` 1
  5. 族A剩余未归因文件 + `git-handlers.test.ts`（1，`git:review-diff`错误文本不同）
  6. 报出但未修的代码问题：`packages/agent/src/tool/spec-budget.ts` **无生产import**（`downgradeToolSchemaForBudget`路径已被plan 580 D4的`projectForProvider`取代；`packages/plugin-core/src/mcp/core/projection.ts:67`只在一句注释里提到它）——但它**有两个测试import者**（`packages/agent/src/tool/__tests__/spec-budget.test.ts:2`、`packages/agent/tests/tool/byte-budget.test.ts:6`），故"死代码"的准确说法是"无生产import"，不是"无人import"；`apps/desktop/src/renderer/components/settings/ProviderManagement.tsx` 的delete守卫用**无appId**的`providersQueryKey()`读列表，而`ProviderList`读`providersQueryKey('duya')`（#189已把这点写进该测试的注释与种子数据）；`HoverPopover.tsx:26-27, 121`陈旧模块文档 + 死`wrapperRef`
  7. **两处工具本身的不确定性（尚未修）**：一个**共享lexer**在真实minified worker的offset ~1815处失同步并从此不再报告任何东西（#191绕过而非修复，且它也影响入口bundle的检查）；本机磁盘曾被两次打包打满（0.27 GB / 0.42 GB），故`electron:pack`至今未跑
  8. **两个来自其他会话的既有stash仍躺在 `refs/stash`**：`stash@{0}: WIP on master: 9a0817df …`、`stash@{1}: On master: !!GitHub_Desktop<master>`。它们对任何在worktree里`git stash`的人都是风险；本轮**从未在worktree里stash过**
Next task: 读 `run 37194425248`（`1ffabfc9`，`#192`）的 ubuntu 与 macos test job，解码其 vitest 汇总行，把**修复波末端**的CI数字记进本文件的"阶段证据账本"，并按该数字决定下一批路由项。理由：整个CI弧目前唯一的**CI口径**终点是`#190`的ubuntu 66 / macos 105，**`#192`之后没有任何已完成的run**，而把本地`34`当CI数字会重犯本文件开头禁止的那类错误（不同基线相加）。该动作是纯只读取证，不需要npm安装，也不触碰任何源码
```

## 跨切片流程规则（本轮学到，可复用）

1. **不同基线的增量不可相加，必须测量。** 本轮至少有四个不同口径：CI ubuntu（216→66）、CI macos（105）、#192的本地全量（34 failed / 12881 passed）、#190的本地全量（31 files / 58 tests）。把它们相减或相加会得到**任何一次run都没产出过的数字**。#192正文自己写了"sibling baseline was ~57 failed; that figure is approximate"。**每个数字都带口径标注。**
2. **`npm run architecture:baseline --write` 禁用。** `.architecture-baseline.json`的`meta.counts`仍写559/35/16/162，而实算为460/227/0/146；`architecture:check`持续报**131个baseline指纹不再触发**。每个切片都观测到同一漂移，**没有一个重录它**——这是对的。baseline不是清理CI的产物。
3. **会误报的门禁会被关掉，所以在落地前先证伪它。** #180的自包含扫描第一版是**正则**，它把一个**健康的**bundle报成缺五个模块（`ajv/dist/runtime/{equal,uri,ucs2length,validation_error}`、`ajv-formats/dist/formats`）——那些**不是require**，它们活在ajv的codegen字符串里（`equal.code = 'require("ajv/dist/runtime/equal").default'`），ajv在运行时把它们贴进生成的validator。正则分不清代码与字符串内容。扫描换成了只看代码位置`require(`的小lexer，并用**真实bundle文本**做回归测试钉住这一例。
4. **不能失败的门禁没有价值——用突变证明它能失败。** #180两次突变（externals加`'sharp'`；把`agent/process/…`提到`agent-bundle/…`之上）都exit 1；#191三次突变，其中**第二次真的抓到一个bug**（lexer失同步）。所有还原都用`git checkout`，**从不`git stash`**。
5. **测编码必须用绝对路径。** .NET的CWD与PowerShell的不同，一次先前会话的检查因此**静默读了错误的文件**并报告"clean"。本记录会话的BOM/NUL/U+FFFD/行尾检查全部用绝对路径完成。
6. **PowerShell写文件有三种破坏方式，每种都烧掉过一个切片**：`Set-Content`（BOM + CRLF改写）、`>`重定向（**UTF-16LE**，产出BOM与NUL交织的文本）、`WriteAllText`。**对含CJK的文件一律用 `write`/`edit` 工具；需要字节级操作（行尾归一、编码转换）时用 node 的 `fs` 配显式 `'utf8'`。** 同一编码陷阱也适用于CI证据：`gh api .../jobs/<id>/logs` 得到的日志是**UTF-16LE**，朴素UTF-8读会静默匹配不到任何东西。
7. **`push` 事件可靠地产生CI run；`pull_request` 事件不产生。** 本计划的CI数字只能从master push的run里取。
8. **worktree纪律**：**绝不在worktree里`git stash`**（本仓库有两个来自其他会话的既有stash）；**绝不在worktree里建指向共享检出的junction/symlink**；删除worktree只经 `scripts/remove-worktree.sh <name> [--delete-branch]` 且必须用 `C:\Program Files\Git\bin\bash.exe`（**不是** `C:\WINDOWS\system32\bash.exe`）。本轮未删除任何工作树，共享检出自始至终未被触碰。
9. **`fixme` 不是 `skip`。** #181对"修复bridge就会变绿"的合同用`test.fixme`而非`test.skip`表达：skip读成"无信息"，而`fixme`是一个有名字的可复现失败。#188删掉`fixme`并运行它，得到**红的合同**——那两条断言是在行为**不可观测**的时期写的猜测。

不要用"已定位/已改文件/已merge"替代runtimeverified。修改主Next时同步阶段入口，阻塞描述给下一agent一条具体可实施动作。
