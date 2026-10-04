# G0 — 当前基线与可信治理

前置：无。出口：后续实施可辨别新回归。Next：**G0.2 合同/迁移测试独立 CI job**（`test.yml` 现只有 `architecture`/`test`/`build`），其后才是 required checks。复用现有gate，不另造同功能脚本。
>
> **阶段状态（2026-10-04 对 `55384c55` 核对）**：G0.1–G0.4 的交付项都已合并；**本阶段仍是 In progress**，因为 G0.2 剩两件事没做——合同/迁移测试没有独立 job，required status checks 仍是空的（`gh api` 实测：ruleset `17257193` 的规则仍只有 `deletion` + `non_fast_forward`）。G0.2 曾经把 `architecture` 设为 required 又**回滚**，回滚原因（跨平台假阳性）已由 #146 修好，但**规则集没有再次落**。#193 把 slice inventory 从冻结树改成属性断言，陈旧记录漂移随之消解；`architecture:baseline --write` 仍从未运行。

## G0.1 接管与可重复基线

> G0.1执行于2026-10-03，分支`plan/587-g0-baseline` @ `0e13d4cd`。原始证据在忽略目录`.tmp-validation/587-g0/`，摘要见[执行日志](11-execution-log.md)。第3项仅**部分**满足，原因见执行日志"未达成项"。

- [x] 在隔离分支记录HEAD、工作树、已有PR/任务与package解析路径；workspace context工具可用时先读，缺失明确记录，不编造共享任务。
  HEAD `0e13d4cd`；工作树`.claude/worktrees/587-g0`；开放PR **0**（最近30个全MERGED/CLOSED）；远端129分支、`main`/`develop`不存在；12个`@duya/*`链接与4个起点`require.resolve`全部落在本工作树内。**workspace context工具不可用，已明确记录，未编造共享任务。**（`takeover-record.md`、`package-resolution.md`）
- [x] 读取项目baseline，保存完整`npm test`的失败文件/测试名/错误签名、退出码、环境/ABI和flake分类。日志在忽略的验证目录，执行日志只记摘要/路径；禁止将敏感消息原文存入共享活动。
  WARM口径（build后、clean依赖）45失败文件/101失败测试/**103个(file,test,signature) tuple**，exit 1；collect 1009文件/11873测试（非零collect）。分类77 deterministic / 25 environment-infra / **1已证flake**（经二次运行证实）。环境：Windows、Node 24.16.0、sqlite ABI **137实测加载成功**、clean安装。未存任何用户消息原文或凭据。（`test-failure-set.md`、`test-results-warm.json`）
- [ ] `npm ci`的清洁checkout或真正独立依赖安装，运行typecheck/build；检查@duya/*实际解析到该checkout。主检出junction暖产物不能当clean证据。
  **仅部分满足。** 依赖树确为clean：无junction、无暖`node_modules`、无dist/tsbuildinfo（安装前已枚举），1043个顶层条目，12个`@duya/*`全部内部解析。`typecheck:all` exit **0**（154s）、`build` exit **0**（87s）均在此树上跑出。**但`npm ci`进程exit 1**：`puppeteer` postinstall因本机缓存缺`chrome.exe`失败（重试时按其自身提示设`PUPPETEER_SKIP_DOWNLOAD=1`），随后仓库自身`postinstall`的`node-pty`编译报**MSB8040**（本机VS 18缺Spectre缓解库）。属环境/工具链问题，非仓库缺陷；`better-sqlite3`已成功重建。需装该VS组件或提供匹配`node-pty`预编译产物后重跑取得exit 0。（`npm-ci.log`、`npm-ci-retry.log`、`npm-ci-evidence.md`、`sqlite-abi.md`）
- [x] 对照最新CI：trigger、typecheck包含范围、Node heap、实际通过/失败/取消步骤。2026-10-03的dist次序修复和heap修复已有提交，重新验证而不是重复实施。
  原引用的37095446083/37095893167**已非最新**（其后还有8次）；最新为**37099318050**（master push，SHA `0e13d4cd`，failure），上一次37098693756。`gh`已认证。typecheck三OS**全绿**→heap修复**已验证有效**；`npm test`红；其余OS为**cancelled**（未设`fail-fast:false`），不得记为通过；`build` job因`needs:test` **skipped**，故`electron:build`在CI**从未执行**。heap为`NODE_OPTIONS: --max-old-space-size=6144`且**仅typecheck步骤**。trigger配置`[master,main,develop]`但远端只有`master`。dist次序修复亦由本任务实测佐证（见下方架构节与执行日志"构建次序"）。（`ci-runs.md`）
- [x] 验证architecturecheck/self-test输出和typecheckelectron ratchet。main/preload已有ratchet，禁止继续使用“完全没有typegate”的旧事实。
  `architecture:check` exit **0**：total 802 = tolerated 802 = baseline 802，新增**0**；`self-test` exit **0**，7类期望计数合计802独立复现同一数字。ratchet**确实存在且在跑**：`scripts/typecheck-electron-gate.mjs` + 已提交`scripts/typecheck-electron-baseline.txt`，基线**303 errors / 148 (file,code) keys**，在`typecheck:all`内输出 `OK — no new type errors (303 known across 148 key(s))`，与CI同一行逐字一致、零漂移。“没有typegate”已按源码与CI日志证伪。补充：零容忍managed模块实为**4个**（含`legacy-plugin-core`）。（`architecture-and-ratchet.md`）

失败记录例：`{head,platform,node,sqliteAbi,suite,test,errorCode,signature,classification}`。相同总数不能证明集合相同；新增失败必须定位并修复或证明不可归因。

> G0.1附带发现（交G0.2/G0.3，非本阶段完成项）：构建次序**只存在于`typecheck:all`的一个`&&`链**里，仓库无npm拓扑依赖、无TS project references。单跑`typecheck:electron`在clean检出上产生49个假`TS2307`；`npm test`在未build时产生250个假解析失败。

## G0.2 CI 与 required checks

范围：`.github/workflows/test.yml`、`scripts/architecture/*`、现有Electron类型门禁及仓库ruleset。

> **跨平台门禁缺陷（G0.2-C 的真实阻塞项）**：`architecture:check` 在 Windows 绿、在 ubuntu 红。根因已定位为门禁自身缺陷，而非代码分歧——共享的 import 正则 `/(?:from\s+|import\s*\(|require\s*\()\s*["']([^"']+)["']/g`（`audit-imports.mjs:170`、`audit-modules.mjs:67`、`verify-cycle.mjs:5`、以及 `strip-comments.test.ts` 的本地副本）里 `[^"']` **允许跨越 CR/LF**，于是匹配会从代码里某个引号一路吃到几十行外的另一个引号，把文件自身代码当成 import specifier；且该 specifier 里**嵌入了真实换行符**。`.gitattributes` 的 `* text=auto` 使 Windows 检出 CRLF、Linux/macOS 检出 LF，于是同一处假违规在两个平台产生**不同指纹**：基线是 Windows 录的，Linux 上匹配不上→既报"新增违规"又报"1条基线不再触发"。
> 实证（`apps/desktop/src/renderer/components/layout/panels/code-review-diff.ts`，约181行有 `line.startsWith('diff --git ')`）：CRLF输入得到假specifier `.length);\r\n    else if (line.startsWith(`，LF输入得到 `.length);\n    else if (line.startsWith(`。这同时说明**现有架构baseline是Windows口径**，与项目索引记录的"Linux上多出一批失败"属同一类跨平台漂移。
> 修复中：所有正则副本统一禁止specifier跨行，并加一条在旧代码上会失败的回归测试。`architecture:baseline`（`--write`）**禁止**在此状态下运行——门禁自述的"用--write缩小债"提示在此处正是陷阱。

- [x] 将architecturecheck作为独立可读CI job；resolver变化运行self-test。保持managed三包zero新增容忍。
  PR #140（`42cef0f0`）新增独立`architecture` job（ubuntu），跑`architecture:check` + 按路径过滤的`self-test`（`scripts/architecture/**`、policy、baseline变更时触发，base sha不可用时fail-safe为运行）。**实测该门禁不需要`dist/`**：resolver读的是各package.json声明的`exports`，不是构建产物；clean树上`check`=0（802/802/802）、`self-test`=0（548/35/16/162/25/16/0）。因此该job刻意**不**先build——先build只会增加耗时，并把将来意外的dist依赖藏进缓存命中后面。零容忍managed模块仍为**4个**（含`legacy-plugin-core`），一个都没放松；`architecture:baseline`（`--write`）未出现在CI任何位置。
- [x] 在cleanjob验证从无dist/tsbuildinfo状态构建；显式topologicalscripts或projectreferences二选一维护，不引入并存的不同顺序。
  **已定方向：显式topological scripts，不引入TS project references。** 三条实测依据：①真正的消费点是esbuild——`scripts/build-agent-bundle.mjs`与`scripts/build-electron.mjs`都无alias，经`node_modules`解析到`dist/*.js`，且都不对消费端跑tsc，`tsc -b`的次序对它们是装饰性的；②`packages/agent/src/journal/Journal.ts:29`自引用`@duya/agent/message`（解析到自身`dist/message/index.d.ts`），project references无法表达该环；③`apps/desktop/src/main`有约153处`packages/agent/src/...`源码相对深引，绕过任何tsconfig图。另：11个包中4个已`composite: true`、7个没有，且无任何`references`——这个半迁移状态正是计划禁止的"并存的不同顺序"，不得扩大。仓库无turbo/nx/lerna/npm-run-all。
  目标不是"顺序写对"，而是**每个入口自给自足**：`typecheck:electron`、`bundle:agent`、`npm test`、`npm run electron:build`都必须能在无任何`dist/`的树上单独跑通。同时修两处实证缺陷：`build:agent`漏掉`voice`与`gateway`（现由electron脚本临时构建），`bundle:agent`只build了`ai`而esbuild还要解析`plugin-core`/`cli/contract`/`computer-use`，clean树下**必然失败**。
  **已完成（PR #143，`adb7b78c`）。** 顺序的唯一事实源是`scripts/build-packages.mjs`的`BUILD_ORDER`数组（4层：L1 `ai/agent-protocol/plugin-core/conductor/gateway/voice`；L2 `agent-core/computer-use/cli`；L3 `agent-runtime`；L4 `agent`），每包仍用自己package.json里的`build`脚本，命令与次序分离。未加`references`、未加新的`composite`、未引入turbo/nx/lerna。
  干净树实测（每次先移走全部`dist/`与`*.tsbuildinfo`并核验为0，再单跑入口，不手工还原）：`typecheck:electron` 修复前exit 1/**153个新错误**（113个假TS2307）→ 修复后exit 0、29.1s、`OK — no new type errors (303 known across 148 key(s))`；`bundle:agent` 修复前exit 1/**14个esbuild解析错误**→ 修复后exit 0、24.4s、5.04MB、0 unresolved；`electron:build` exit 0、70.8s、三个bundle齐备；`npm test` collect与修复前完全一致。
  无回归：`typecheck:all`=0；`architecture:check`=0且**802/802/802零新增**，且是在**无`dist/`**的树上跑的（证明`exports` resolver不依赖构建产物）；`architecture:self-test`=0；四个`check:*`全0。
  **失败总数会漂移，不属本次改动**：无代码改动的重跑给出43 vs 基线41，其中40个失败文件稳定，`RealTasks`/`GrepTool`/`app-connection-service`抖进、`bash-task-store`抖出。末次干净树跑与基线精确一致（41文件/96测试）。仓库失败总数本身不是稳定量,需独立任务,这也是计划禁止按总数比较的原因。
  已知代价（有意接受）：①`@duya/agent`既是最后一位又是自身前置，拓扑runner会判为环，显式数组靠约定吸收，重排无人拦截——这是scripts相对references最锐利的弱点；②`typecheck:all`现在把整个次序构建3次（经`typecheck:web`/`typecheck:electron`/`typecheck:agent`，各约25s），staleness跳过可回收，但手写mtime判断可能跳过必要重建并**静默放行typecheck门禁**，故选择正确性优先；③`build:agent`已是误名（实建全部11个），待CI在范围内时改名并去掉别名。
- [ ] 将合同/迁移相关测试接入独立job，保持完整testjob的红色真实可见。
  PR #140已让`test` job与`build`解耦，`npm test`的红色保持完整可见（未减少collect、未加`|| true`/glob跳过）。合同/迁移测试的独立job仍待做。
- [ ] 处理既有测试债并收敛fullsuite；在此之前如需迁移ratchet，必须以具体失败签名比较且对新增失败失败，不能`|| true`、glob跳过或只比较总数。
  **未完成，且已从"尚未开始"推进很远。** G0.1 的基线是 45 文件/101 测试/103 tuple（Windows warm）。CI 口径（master push，collect 三OS相同才可比）：ubuntu **72 文件/216 测试 → 19/42**，macos **80/247 → 28/80**，windows **49/123 → 13/34**。驱动的合并切片：#183（`build` job heap + 测试前 `bundle:agent`）、#184（族A 跨平台夹具，20 文件 93 个失败）、#185（族C/D/E）、#186（POSIX 产品缺陷 `env.ts` 分隔符 + cookie 路径）、#187（恢复 notebook 读取）、#189（族F/G/I/J1）、#192（J3/J4/J5 + 两个真实产品缺陷）、#193（inventory 属性断言）。
  **仍是红的，且 macOS 是最差的一条腿**（80 vs ubuntu 42）。已证确定性、需产品决定而**刻意未修**的：WorkflowPanel 12（面板被重写成 legacy stub）、plan315 2 + plan486 2（投影路径行为回归）、permissions-gate 2、sync-protection 1（`44109a68` 造成 plugin 与 plain-bundled 同分 2 的真实 tie）。未归因：族A 剩余文件 + `git-handlers.test.ts`（1，`git:review-diff` 错误文本不同）。**本条不因数字下降而勾选**——fullsuite 未绿。
- [ ] required checks采用可稳定通过且不能掩盖回归的job。仓库设置变更前先给出具体job名和rulesetdiff，按权限工具执行；没有管理权限标blocked并保留本地/CI实施证据，不能称强制合并门禁已完成。
  **权限已确认**：`gh api repos/lava-chen/duya` 返回 `admin: true`，本项**不blocked**。现状：仓库已有1条active ruleset `Protect master branch`（id `17257193`，target `~DEFAULT_BRANCH`，规则仅 `deletion` + `non_fast_forward`），**required status checks 为空**。
  **已加过一次并回滚。** 按用户确认在既有ruleset上追加 `required_status_checks: [{context: "architecture"}]`（未另建ruleset）。随后master最新提交 `026d3c1e` 的 `architecture` job **failure**——该job在真实runner上**不是稳定绿**，按本条"可稳定通过"的判据本就不该设required。**已把ruleset回滚为原状**（只剩 `deletion` + `non_fast_forward`），仓库未被卡住。本项保持开放。
  **回滚原因是一个真发现**：`architecture:check` **Windows 绿（802/802/802零新增）而 ubuntu 红（801 tolerated + 1个新增违规）**。定位为门禁自身的跨平台解析缺陷（详见下方"跨平台门禁缺陷"）。在新 `architecture` job 成为 required 之前必须先修好它，否则一个假阳性会变成永久阻断所有合并的门禁。
  **修好后的执行方案**：仍只把 `architecture` 设为required。`test` 现在就是红的，设为required会永久阻断合并；不设它不隐藏任何东西，红色仍完整可见，只是当前无法当门禁。执行前仍先给出job名与rulesetdiff。
  **2026-10-04 复核：前置已满足，规则集仍未落。** #146 修掉了那个跨平台假阳性（`[^"']` 允许跨 CR/LF，六份正则副本统一后另加一条在旧代码上会失败的回归测试），`architecture` job 自 #140 起在真实 runner 上稳定绿（最近一次已结束 run 的 `architecture` job = `success`）。`gh api repos/lava-chen/duya/rulesets` 复核：仍只有 `17257193` 一条，**required status checks 为空**。下一动作明确：把 `required_status_checks: [{context: "architecture"}]` 追加到既有 ruleset（不新建），然后用一次 master push 复核该 job 仍绿。
- [x] 故意新增一条禁止import和一个新增失败fixture验证gate失败；清除探针后恢复。artifact保存实际检查了多少测试和文件，零collection必须失败。
  PR #140已做。**边界探针**：在`packages/agent-protocol`（managed、`requires: []`）内`import { isTerminal } from "@duya/agent-core"` → `architecture:check` exit 1，并指名文件、两条规则与原因。**测试探针**：`expect(1+1).toBe(3)` → `npm test` exit 1，collect由1009→1010文件。**两探针均已删除**，`git status`只剩`test.yml`，两个路径`Test-Path`为False，两个architecture门禁回到0。
  零collection防护：`architecture-check.mjs`只要`blocking.length===0`就exit 0，而这在**完全没扫到任何东西时同样成立**——若将来模块根匹配被打坏，`total`塌成0，门禁会一边报告"OK 无新增违规"一边什么都没拦。两个新job都断言非零扫描；test侧还覆盖"12文件但0测试"与摘要不可读两种情形。architecture侧guard还区分了checker的exit 1（查到违规，上一步已红）与exit 2（引擎故障），避免在真实失败上再叠一个更含糊的红。
  运行期实测：`npm test` exit 1，collect **1009文件/10709测试**（本worktree为junction依赖，与G0.1的clean-install口径不可直接比较，但红色一致、collect未被削减）。

出口：clean类型/构建通过；architecture与关键回归CI确实执行；完整测试债有签名且没有新回归；required enforcement的已验证范围准确。fullsuite红不能要求agent为了绿色扩大业务重构，债按接管表分批解决。

## G0.3 审计与baseline纪律

- [x] 分清package build DAG、type graph、runtimevalue graph、host import。现有SCC仅是扫描口径，不能要求每个小PR都严格少一个SCC。
  #143 把 build DAG 收成唯一事实源（`scripts/build-packages.mjs` 的 `BUILD_ORDER`，4 层），并明说不用 TS project references（`packages/agent/src/journal/Journal.ts:29` 自引用成环，project references 表达不了）；#166 导出 value call graph 与跨包边；#173 把 layer-IO 变成可执行门禁而不是 M5.1 的手写清单。
- [x] 对resolver变更导出旧/新fingerprints分类：解析变化、移除债、真实新增。先修真实新增；审查后再更新selftest与baseline，不能整批`--write`吸收新违规。
  #148 第2项做了完整分类：两条不再触发的指纹证明是**移除债**而非解析变化（复现 pre-#147 状态确认指纹当时存在），且**手工删除**而非 `--write`——因为 `--write` 会连带吸收 #147 新增的两条 `module-dependency-permitted`（该规则从不阻断，记录它们正是本条禁止的整批吸收）。801 → 799，违规数不变、blocking 0。
- [ ] 协议预算测试的walker复用可信workspace/exportsresolver与剥注释逻辑。leaf指protocol没有反向实现依赖，不是没有consumer；core/runtime/CLI/host正常公开import必须允许。
  未完成：没有任何切片动过协议预算测试的 walker。#171 S4 处理的是 `package-boundary-escape`（162 → 146）与 `deep-import`（持平 25），不是这条预算测试的 walker 复用。
- [x] 跨平台失败按Windows/Linux/macOS各自HEAD与具体签名记录；优先核对权限行为差异和AGENTS加载相对路径收敛，不以修改安全断言或删测试修绿色。
  #184 是本条的样板：族A 20 个文件的夹具改为经 `os.tmpdir()` / `vi.importActual` 解析 temp、盘符夹具按平台派生、host 语义改为派生；四处 `describe.skipIf` 每一处都**配一个新的对偶合同断言**，没有 `.skip`、没有 xfail、没有文件排除；#186 修的是**产品**（`packages/voice/src/env.ts:190` 硬编码 `;`、`permissions/policy.ts:707` 只认 AppData 布局），测试被**故意留红**直到产品修好。跨平台 CI 数字按OS分别记录（见 G0.2 测试债条）。
- [x] protocol/core/runtime零容忍；legacy允许旧baseline但不得引入新增反向边。新port/slice的graph有明确方向。
  2026-10-04 在 `55384c55` 实测：`architecture:check` exit 0，total **874** = tolerated **874** = baseline **811**，**零新增**；`architecture:self-test` exit 0（460/227/0/146/25/16/0）。零容忍 managed 模块仍是 4 个（`agent-protocol`、`agent-core`、`agent-runtime`、`legacy-plugin-core`），#143/#171/#173/#175 都没放松过任何一个。**131** 条基线指纹不再触发，`--write` 仍从未运行。
- [ ] publicexport对应真实消费者与runtimebuild。Nodepackage `exports`限制package-name访问；相对越界需resolver管，不能用`main:src`解释全部问题。
  未完成：#171 S4 只把 plugin-core 的 **16** 处 host 相对越界改到 7 个已声明 subpath（escape 162 → 146）；其余包的 public export 与真实消费者/runtime build 的逐项对应没有系统核对。

## G0.4 文档事实与交接

- [x] 修正rootAGENTS及ARCHITECTURE中的CItrigger、mainratchet、Electron版本、server子进程和当前observer状态；源码为准，runtime能力未实现不写完成。
  #139 改了 Electron 版本（28 → 44）、Agent Server 实为 spawn 子进程的进程拓扑、包图；#148 第4项把 `CLAUDE.md:483` 的陈旧 ABI 断言按**实测**更正（解出缓存的 `electron-v44.2.0-win32-x64.zip` 跑 `ELECTRON_RUN_AS_NODE=1` 得 `modules: 149`，本地 Node 137）——必须实测，因为 `scripts/ensure-sqlite-abi.mjs:166-173` 是**探测**目标二进制而非查表。
- [ ] ledger登记旧ISS与PP接管情况，区分already-landed、needs-revalidation、open、deferred/external、disproved。没有证据不继承历史"MERGEABLE/全绿"。
  未完成：[接管表](10-legacy-crosswalk.md) 与 [旧任务清单](legacy-task-inventory.md) 已建立**归属映射**，但四类状态（already-landed / needs-revalidation / open / deferred-external / disproved）尚未逐条标注。已按本条精神处理过两例：#148 第3项删除了不可复现的 "112 tests" 而不是替换它并写明理由；诊断自身的两个数字漂移（`..` 深度、`@lobehub/ui` 归因）被 #185/#189 证伪后**记录在案**而没有抹掉。
- [x] 每次PR更新日志和主Next；本次计划整合本身不勾选G0运行期验收。
  过程规则，已实际执行：[执行日志](11-execution-log.md) 逐切片记录 commit/PR、命令退出码、环境口径、能力边界与下一任务；本文件与各阶段文件的 `Next：` 随合并推进。G0 的**运行期**验收仍未勾选（见上）。

## 推荐 PR

G0-A clean/gates事实与CI接线；G0-B 新旧失败签名与gate regression；G0-C ruleset收口与债清零。与活跃CI修复PR重叠时合并接管，禁止平行复制。

## 验证与回退

运行`npm run architecture:check`、`npm run architecture:self-test`、`npm run typecheck:all`、完整`npm test`，保存首次及末次setdiff；gate自身测试按现有脚本tests路径定位。文档修订跑UTF8/link/计划接管检查。CI配置可gitrevert；baseline恢复必须与resolver版本一起恢复。
