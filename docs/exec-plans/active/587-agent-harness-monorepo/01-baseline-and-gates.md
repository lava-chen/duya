# G0 — 当前基线与可信治理

前置：无。出口：后续实施可辨别新回归。Next：G0.1。复用现有gate，不另造同功能脚本。

## G0.1 接管与可重复基线

- [ ] 在隔离分支记录HEAD、工作树、已有PR/任务与package解析路径；workspace context工具可用时先读，缺失明确记录，不编造共享任务。
- [ ] 读取项目baseline，保存完整`npm test`的失败文件/测试名/错误签名、退出码、环境/ABI和flake分类。日志在忽略的验证目录，执行日志只记摘要/路径；禁止将敏感消息原文存入共享活动。
- [ ] `npm ci`的清洁checkout或真正独立依赖安装，运行typecheck/build；检查@duya/*实际解析到该checkout。主检出junction暖产物不能当clean证据。
- [ ] 对照最新CI：trigger、typecheck包含范围、Node heap、实际通过/失败/取消步骤。2026-10-03的dist次序修复和heap修复已有提交，重新验证而不是重复实施。
- [ ] 验证architecturecheck/self-test输出和typecheckelectron ratchet。main/preload已有ratchet，禁止继续使用“完全没有typegate”的旧事实。

失败记录例：`{head,platform,node,sqliteAbi,suite,test,errorCode,signature,classification}`。相同总数不能证明集合相同；新增失败必须定位并修复或证明不可归因。

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
