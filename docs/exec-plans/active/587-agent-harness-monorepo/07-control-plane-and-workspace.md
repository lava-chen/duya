# C6 — 持久化 ControlPlane 与本地 Workspace

前置：R2、E4；最终切换依M5。Next：**C6.1 跨 run start/terminal 单一 owner**（#169 自评 partial，只做到 `HostMap`）；C6.3 resolver 五条、C6.5 Goal/Task 未开始。不另造Project数据源，不与534/525竞争迁移。
>
> **阶段状态（2026-10-04 对 `55384c55` 核对）**：C6.1 #169、C6.2 #176 已合并，**仍是 In progress**。C6.3/C6.4/C6.5 一条未开始——C6.3 的单 resolver 是 C6.4 用户可见字段与 C6.5 Goal/Task 的前置，本阶段最靠前的下一步仍是补齐 C6.1 的第3条。

## C6.1 所有权收口

> 已合并，PR #169（`f0e017de`）。4 条中 3 条 done，**第3条自评 partial**。

- [x] repositoryport覆盖RunStore、transcript/artifacts、approval、Goal/Task、checkpointindex；SQLite实现复用existingconnection/migrationowner。
  `control-plane/repository-port.ts:214` + `sqlite-repository.ts:132`。port 覆盖 runs、transcript（`run_events`）、artifacts（`attachments`）、approvals、goals+tasks，以及 checkpoint index（`mailbox`）。`ownership` 是**数组**不是单值——因为诚实的答案是两个连接。
- [x] CPservice是durable决策owner，main composition创建并通过db/control桥服务server；纯manifestbuilder可以复用，但来源/执行进程与权限明确。
  `control-plane-service.ts:118` + `main/index.ts:307` + `agents/db-bridge.ts:305`。`run-store.ts` **什么都没搬**：经 port 到达而非重定位（理由见 M5.5）。**纯 core 提取两处**：trusted-sender 判定（此前经 adapter 可达 `window-manager` → `electron`，使该判定从 Control Plane 不可达）与 repository 的连接访问器（改为注入）。
- [ ] 跨runstart/terminal调度不由runtime自行持久化第二套Goal/Task状态；workerhandles/AbortController留hostmap，并记录durable关联。
  **#169 自评 partial**：只有 `control-plane-service.ts:60` 的 `HostMap` 与 `:171`。durable 关联已记录，但"runtime 不再自行持久化第二套 Goal/Task 状态"这一半未完成。下一动作：把跨 run 的 start/terminal 决定收进 CP（这是 C6.5 Goal/Task 收口的前置），并为"runtime 侧不再有第二份状态"补一条 census 断言——T3.2 已建的 `control-plane-census.ts` 是现成的落点。
- [x] commandreceipt有schema、sender/auth、typedfailure；outbox投递与terminaltransaction明确，不能ack后吞失败。
  `command-receipt.ts:60,186,296`。**这条随后被 #182 的真实缺陷反向验证**：wire 序列化器原在 `run-control-plane.ts` 的私有 `onWire` 里，边界消费侧根本没有办法构造 wire receipt，于是 `run:create` 的 `{ok, state, runId}` 被解析成 typed 联合（无 `ok`、也无 `written`）再原样返回——**每一个** Desktop chat turn 都被静默丢弃。修复后序列化器与读取方并排住在 `run-receipt.ts`。

## C6.2 Workspace 稳定身份与迁移

> 已合并，PR #176（`902cff84`）。**纯 additive**：`projects`、`projects.paths`、`project_id`、`canonical_root` **从不写入**，旧 `paths[]` 被**映射而非消费**。

V1采用device-localUUID Workspace，可绑定Project或scratch；Root稳定UUID、alias、role、access、canonicalrealpath；cwd为rootId+relativePath。Project保留UUID/canonicalroot/私有配置及Memory，旧paths[]通过兼容resolver映射，不立即删。

- [x] 盘点projects.paths/descriptions、alias/override、reverse lookup、additionaldirectories、sessioncwd、CLI/workflow/terminal/extension全部consumer。
  13 个 consumer 面逐条记录读取点：Project entity store、entity service（IPC 后面，持有 `~/.duya/projects/<id>/` 的 plans 与 AGENTS）、entity IPC、registry resolver、aliases/overrides、525 先例、catalog sync、reverse lookup + fan-out、agent router（→ `permissions.additionalDirectories`）、agent core、session cwd、sidebar sections、manifest；另有 **terminal**（裸 cwd 字符串，从不针对 Project 解析）、**CLI**（`ctx.options.cwd`，只做相对解析）、**workflow**（根本没有 cwd→Workspace 路径）。
- [x] 增加本地Workspace/root存储与sessionbinding，schemaexpand；旧session首次显式解析产生legacybinding并可重复映射。rename/relocate改revision不重keyProject。
  排练证明（`workspace-rehearsal.test.ts`）：建 6 个 Project 的语料、**关闭**、`copyFileSync`、在**副本**上重开——旧 reader 迁移后 `paths` 逐字节不变、`findByPath` 不变、`additionalDirectories` fan-out 不变；新 reader 拿到 workspace + roots + grant 来源；reopen 后两个 reader 都成立、binding 存活；**迁移一个 root → revision 1 → 2 而 `workspace_id`/`root_id`/`project_id` 不变**，旧 cwd 重新解析到新位置；第二次 apply 是 no-op；另有独立断言证明**源文件逐字节未变**。
- [x] oldmultipathProject默认生成含同一组root的Workspace；access沿现有授权保留并提示来源，不默许新增写权限。新加root默认read。
  多路径 Project → 一个 Workspace，同 roots 同顺序。**access 不猜**：`resolveAdditionalRoots` 本就把每个非 cwd 路径注入为可写，所以所有 root 保留 `write` 并带 `access_source` `project_canonical_root` / `project_additional_path`；新 root 默认 `read` / `new_root_default`。**撤销是 `access='none'` 且保留该行**——撤销不能删掉审计链指向的东西。
- [x] dry-run输出mapping/重复/不存在路径/conflict；备份并在隔离DBrehearsal，再实施；绝不删Project私有plans/AGENTS/Memory。
  dry-run 形状：`total_projects, total_roots, would_create_workspaces, would_create_roots, would_skip_projects, duplicate_paths[], missing_paths[], conflicts[]`（四类 kind），外加每 Project 的 roots 与 `access`/`access_source`。**对真实 `duya-core.db` 的一个副本跑过**（10.5 MB、只读、23 个 Project）→ 23 workspaces、23 roots、**0 冲突、0 重复、1 缺失**（`e:/Projects/pi-dag`）。**第一次运行是错的并已修**：它报 23 个 `duplicate_within_project`——假阳性，因为 `paths[0] === canonical_root` 是**每条健康行**的形状；canonical 配对现在静默，只报真正的重复。
- [x] 534/525既有DBowner迁移先读取对应阶段证据；使用同一repository/schema序列，不创建另一个projects表或Shadow真相。
  525 先例**会删掉自己的表**，C6.2 禁止那样做，所以本切片**严格 additive**。binding **不带指向 `sessions` 的 FK**：级联会在 legacy-import 替换行时删掉 binding，下一次解析就会铸出**另一个** workspace——正是本切片要防的 re-key。`workspaces.project_id` 是 `ON DELETE SET NULL`，删 Project 降级为 scratch 而非孤儿。

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
