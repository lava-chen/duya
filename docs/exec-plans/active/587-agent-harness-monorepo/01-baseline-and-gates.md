# G0 — 当前基线与可信治理

前置：无。出口：后续实施可辨别新回归。Next：G0.1。复用现有gate，不另造同功能脚本。

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

- [ ] 将architecturecheck作为独立可读CI job；resolver变化运行self-test。保持managed三包zero新增容忍。
- [ ] 在cleanjob验证从无dist/tsbuildinfo状态构建；显式topologicalscripts或projectreferences二选一维护，不引入并存的不同顺序。
- [ ] 将合同/迁移相关测试接入独立job，保持完整testjob的红色真实可见。
- [ ] 处理既有测试债并收敛fullsuite；在此之前如需迁移ratchet，必须以具体失败签名比较且对新增失败失败，不能`|| true`、glob跳过或只比较总数。
- [ ] required checks采用可稳定通过且不能掩盖回归的job。仓库设置变更前先给出具体job名和rulesetdiff，按权限工具执行；没有管理权限标blocked并保留本地/CI实施证据，不能称强制合并门禁已完成。
- [ ] 故意新增一条禁止import和一个新增失败fixture验证gate失败；清除探针后恢复。artifact保存实际检查了多少测试和文件，零collection必须失败。

出口：clean类型/构建通过；architecture与关键回归CI确实执行；完整测试债有签名且没有新回归；required enforcement的已验证范围准确。fullsuite红不能要求agent为了绿色扩大业务重构，债按接管表分批解决。

## G0.3 审计与baseline纪律

- [ ] 分清package build DAG、type graph、runtimevalue graph、host import。现有SCC仅是扫描口径，不能要求每个小PR都严格少一个SCC。
- [ ] 对resolver变更导出旧/新fingerprints分类：解析变化、移除债、真实新增。先修真实新增；审查后再更新selftest与baseline，不能整批`--write`吸收新违规。
- [ ] 协议预算测试的walker复用可信workspace/exportsresolver与剥注释逻辑。leaf指protocol没有反向实现依赖，不是没有consumer；core/runtime/CLI/host正常公开import必须允许。
- [ ] 跨平台失败按Windows/Linux/macOS各自HEAD与具体签名记录；优先核对权限行为差异和AGENTS加载相对路径收敛，不以修改安全断言或删测试修绿色。
- [ ] protocol/core/runtime零容忍；legacy允许旧baseline但不得引入新增反向边。新port/slice的graph有明确方向。
- [ ] publicexport对应真实消费者与runtimebuild。Nodepackage `exports`限制package-name访问；相对越界需resolver管，不能用`main:src`解释全部问题。

## G0.4 文档事实与交接

- [ ] 修正rootAGENTS及ARCHITECTURE中的CItrigger、mainratchet、Electron版本、server子进程和当前observer状态；源码为准，runtime能力未实现不写完成。
- [ ] ledger登记旧ISS与PP接管情况，区分already-landed、needs-revalidation、open、deferred/external、disproved。没有证据不继承历史“MERGEABLE/全绿”。
- [ ] 每次PR更新日志和主Next；本次计划整合本身不勾选G0运行期验收。

## 推荐 PR

G0-A clean/gates事实与CI接线；G0-B 新旧失败签名与gate regression；G0-C ruleset收口与债清零。与活跃CI修复PR重叠时合并接管，禁止平行复制。

## 验证与回退

运行`npm run architecture:check`、`npm run architecture:self-test`、`npm run typecheck:all`、完整`npm test`，保存首次及末次setdiff；gate自身测试按现有脚本tests路径定位。文档修订跑UTF8/link/计划接管检查。CI配置可gitrevert；baseline恢复必须与resolver版本一起恢复。
