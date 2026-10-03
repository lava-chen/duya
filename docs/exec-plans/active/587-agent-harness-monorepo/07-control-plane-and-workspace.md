# C6 — 持久化 ControlPlane 与本地 Workspace

前置：R2、E4；最终切换依M5。Next：C6.1。不另造Project数据源，不与534/525竞争迁移。

## C6.1 所有权收口

- [ ] repositoryport覆盖RunStore、transcript/artifacts、approval、Goal/Task、checkpointindex；SQLite实现复用existingconnection/migrationowner。
- [ ] CPservice是durable决策owner，main composition创建并通过db/control桥服务server；纯manifestbuilder可以复用，但来源/执行进程与权限明确。
- [ ] 跨runstart/terminal调度不由runtime自行持久化第二套Goal/Task状态；workerhandles/AbortController留hostmap，并记录durable关联。
- [ ] commandreceipt有schema、sender/auth、typedfailure；outbox投递与terminaltransaction明确，不能ack后吞失败。

## C6.2 Workspace 稳定身份与迁移

V1采用device-localUUID Workspace，可绑定Project或scratch；Root稳定UUID、alias、role、access、canonicalrealpath；cwd为rootId+relativePath。Project保留UUID/canonicalroot/私有配置及Memory，旧paths[]通过兼容resolver映射，不立即删。

- [ ] 盘点projects.paths/descriptions、alias/override、reverse lookup、additionaldirectories、sessioncwd、CLI/workflow/terminal/extension全部consumer。
- [ ] 增加本地Workspace/root存储与sessionbinding，schemaexpand；旧session首次显式解析产生legacybinding并可重复映射。rename/relocate改revision不重keyProject。
- [ ] oldmultipathProject默认生成含同一组root的Workspace；access沿现有授权保留并提示来源，不默许新增写权限。新加root默认read。
- [ ] dry-run输出mapping/重复/不存在路径/conflict；备份并在隔离DBrehearsal，再实施；绝不删Project私有plans/AGENTS/Memory。
- [ ] 534/525既有DBowner迁移先读取对应阶段证据；使用同一repository/schema序列，不创建另一个projects表或Shadow真相。

## C6.3 Context Resolver / policy

- [ ] 一个resolver在runstart materialize身份、合法root/cwd、effectivepermission/tool/catalog/model、context source和revision；manifest绑定输入。
- [ ] 复用AGENTS嵌套loader，global/project/root/nested优先级和来源可追溯；动态上下文按轮记录digest/选择/截断原因。
- [ ] filetools在执行时realpath+access校验，测试junction/symlink/traversal/drivecase/rootprefix、撤销及TOCTOU。lexical“是否询问”不替代执行边界。
- [ ] shell/MCP/plugin/connector按真实能力检查，不把allowedroots当万能sandbox。Terminal直接shell与agent运行不同政策，不能伪装同隔离。
- [ ] workflow/CLI/chat/research/subagent消费同resolver；workflowagentnode共享runcontract，其workflowRunId独立关联。

## C6.4 用户可见 V1 字段

| 字段 | 决策 |
| --- | --- |
| name、Project | name建议首root名；Project可选，scratch可用 |
| root/alias/role | 至少一个root，aliasworkspace内唯一；role默认source可改 |
| access、cwd | 新root默认read；primaryroot沿现有授权/用户明确选择；cwd默认defaultRoot |
| Trust | 新workspace默认restricted；已有配置迁移保持已明确授权并显示来源 |
| shell/network/MCP/connector | 各自deny/ask/allow，只展示已经强制执行的旋钮 |
| indexing/sandbox | 没有backend不展示“已索引/已沙箱”；不增加无效开关 |
| ID/revision/device | 系统字段不要求用户填写 |

restricted对repo提供的可执行hooks/config/MCP需要显式批准；trusted不自动无限授予外部root/network。六类能力分别测试：read/write/shell/network/MCP-plugin/connector。系统沙箱能力另有provider声明，不能用Trustlabel替代。

## C6.5 Goal、Task、Wake 和自动化

- [ ] durableGoal/Task关联Run、完成证据、下一动作与失败原因；statefulmode纯reducer仍core，执行tool/hook仍runtime。
- [ ] TODO、subagentexecution、Bashbackgroundjob保留不同subject，统一关联/查询和命名，不能把processhandle写SQL。
- [ ] cron、workflow、wake作为不同triggeradapter投递统一RunIntent，key/idempotency/queuepolicy清楚；解wake↔automation依赖，不删除活着的automation栈。
- [ ] 复用既有memorytier/Projectscope，Memory检索/保留IO通过repository；不要因Workspace重key丢scope。
- [ ] permissiondeadline/grant/revocation由CPdurableowner；重启pending请求状态可读，具体执行恢复D7。

## PR 与验收

C6-Aservice/repositoryowner；C6-Bworkspaceidentity/schema+compatresolver；C6-C全consumer传播与安全矩阵；C6-DcreationUI；C6-Escheduler/Goal/Task收口。

测试：旧DBclone → migrate →旧reader、新reader、reopen、relocate；session无Project、multipath、missingroot、root撤销；chat/CLI/workflow/terminal来源映射一致；UIPlaywright及ElectronIPC；DB类型/build/全量setdiff。

回退：compatcolumns和旧映射保留，关新creation不删除identity/记录；数据迁移只add/映射不重key。出口：resolver/owner无竞争真相，creation配置确实执行，Project数据完整，所有入口传播有证据。
