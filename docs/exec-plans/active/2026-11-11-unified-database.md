# 2026-11-11 Duya 统一应用数据库

状态：active · 负责人：当前 Codex 会话 · 更新：2026-11-11
分支：`codex/unified-database` · worktree：`/home/lavachen/.codex/worktrees/unified-app-database/duya` · base：`3e2390141` · owner：`/root`

## 目标与边界

将 Duya 应用级的结构化持久数据统一到一个 SQLite 数据库文件。默认沿用现有 `~/.duya/duya-main.db` 路径，避免破坏 `storage.database_path` 与数据库目录设置；文件名后续可单独评估。本次目标还包括 `duya-core.db`、`memory-state.db` 和会话 rollout JSONL 中的持久会话/消息数据。模块保留独立 store、表和版本化迁移，但共用一个数据库生命周期与事务边界。

附件二进制、用户工作区文件、运行日志、临时锁/WAL 文件、OS 钥匙串中的秘密继续留在文件系统或系统凭据库。用户自行创建的项目数据库保持隔离，不并入应用数据库。

关联：替代 [计划 534](534-projects-core-db-and-main-db-migration.md) 中“main/core 分库逐步迁移”的剩余方向；已完成迁移事实仍有效。当前数据边界见 `packages/data/AGENTS.md`、`packages/data/src/data-paths.ts`、`apps/desktop/src/main/memory-state/`、`packages/data/src/message-log.ts` 和 `packages/host/src/local-host.ts`。

## 验收

- Desktop 与独立 Host 均只创建/打开一个 Duya 应用 SQLite 文件；新安装不再生成 `duya-core.db` 或 `memory-state.db`。
- 所有应用级结构化表、会话与消息历史在同一文件中，跨领域关系可在同一事务内更新并可使用真实外键；rollout JSONL 只作可恢复/可移植镜像，SQLite 持有消息载荷、搜索文本与索引。
- 从当前三库 + rollout 文件迁移时可重试、不会重复写入或丢数据；验证失败时保留源文件并拒绝静默启动空库。
- 迁移完成后，旧库不再被应用打开；完成源/目标校验并保留可恢复备份后，源文件清理有明确记录。
- 数据库路径设置、`DUYA_DATA_ROOT`、测试 namespace、WAL checkpoint、单 Host owner lock、优雅关闭、打包版 better-sqlite3 ABI 均维持正确。
- `npm run typecheck:all`、`npm run architecture:check`、相关 Data/Desktop/Host 测试及真实 Desktop/Host 启动链通过；变更后核对 Git 状态，避免把构建产物误带入。

## 进度

- [x] 只读盘点：当前 master 为 `3e2390141`，共享检出干净；主检出本机数据为 `~/.duya/duya-main.db`、`duya-core.db`，core `meta.imported_from_legacy` 已记录导入版本。
- [x] 创建 managed worktree 与任务分支，确认工作区依赖边界和数据库 owner。
- [x] 建立统一数据库目标、迁移边界和验收标准。
- [x] S1.1：DataHost 支持 main/core 指向同一文件时共享一个 SQLite handle、owner lock 与 WAL checkpoint owner；Windows 路径比较忽略大小写，先关 core store 再关共享连接。
- [x] S1：Desktop 与独立 Host 收敛到一个 SQLite handle/owner lock；旧 `duya-core.db` 按目标 schema 列名幂等合并，冲突/未知 schema 时回滚并拒绝启动，成功后留 `.pre-unification` 备份。
- [x] S2：main/core 迁移与 store 在 `duya-main.db` 共用同一物理 schema/连接；memory-state 保留自己的校验账本但在同一连接迁移，复用正式 `projects` 表；旧 `memory-state.db` 表按主键合并、成功后留备份。
- [x] S3：`message_index.payload` 迁移保存完整 rollout 行；启动扫描旧 JSONL 回填缺行 payload，timeline/search 从 SQLite 读写，JSONL 保留为恢复镜像和导出格式。
- [ ] S4：验证升级、新安装与失败回滚；整理生成 bundle 差异、更新本计划并提交，随后按用户授权开 PR（不合并）。

## 发现与决策

- Desktop 启动顺序是 main 后 core；独立 Host 在 `packages/host/src/local-host.ts` 也分别打开两套 DB。仅改路径到同一文件会造成重复 handle、owner lock 和 checkpoint，因此目标是一个共享 handle 与统一生命周期。
- 当前这台电脑的只读 SQLite census：main 有 60 张表，core 有 58 张表；core 有 6 条 session 且 `meta.imported_from_legacy` 为 `v46@2026-11-11T05:17:13.971Z`，main 的旧 `chat_sessions/messages/tasks/permission_requests/session_runtime_locks` 计数为 0。`~/.duya/memory-state.db` 当前不存在，但代码仍保留该 DB 的 schemas/importer，迁移设计须覆盖未来由其写入的数据形态。
- 当前 main/core 实际有 18 个同名表；多数列定义一致，`permission_requests` 在 core 多 `mode/expires_at/reason`，`session_runtime_locks` 在 core 多 `origin`，`research_memory_objects` 有列顺序差异。源库合并必须按列名构造迁移并以 core 活跃 schema 为准，不能用整表覆盖或只按列序 `SELECT *`。
- 现有 main/core 有表名冲突，尤其 research 与历史会话/消息副本；不能直接把表逐个 `ATTACH`/复制，必须以当前活跃 store schema 为准，显式映射后再核验行数和关键字段。
- 历史 rollout JSONL 仍是回填与手动导出镜像；新写入事务把 payload 与 SQLite index/search 一起提交，读取和搜索以 SQLite 为准。用户删除外部镜像后，已迁入的时间线仍可在数据库读取。
- `memory-state.db` 作为新安装活跃文件已取消；原有数据库作为导入来源，错误时保留并安全停机。
- 本计划优先保留现有配置的数据库路径，统一的是文件与生命周期；密钥、二进制附件、用户项目数据仍按其安全与所有权边界保存在外部。
- 根仓库要求所有改动经 PR 集成；本轮在当前授权下可实现、验证和开 Draft PR，不会直接合并。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `3e2390141` / 无 | Linux x64，工作区主检出 | `git status --short`; 只读路径/源码/schema 核对 | 0 / 主检出干净；`~/.duya` 有 main/core 数据；core 导入标记存在 | 当前会话只读调查 |
| `3e2390141` / 计划、入口、3 个 DataHost 文件 | Linux x64，Node 当前版本，managed worktree | `npm run typecheck:all` | 0 / 通过；构建 22 个 workspace 包，静态门禁无新 findings；Electron typecheck 保留 164 个已登记基线错误；build 有既存 Vite chunk/注释警告 | 独立 `npm ci` 需设 `PUPPETEER_SKIP_DOWNLOAD=1`（仓库外的 Chrome 缓存目录存在但 executable 缺失） |
| `3e2390141` / 同上 | Linux x64，managed worktree | `npm run architecture:check` | 0 / 通过；0 个新边界违规，全部 3203 findings 已在 baseline | 架构门禁提示 60 个旧指纹不再触发，未执行 `--write` |
| `3e2390141` / 同上 | Linux x64，managed worktree | `git diff --check` | 0 / 通过 | 构建后仅计划/入口和本次 3 个源码文件 dirty；生成产物未进入 Git diff |
| `3e2390141` / main/core/memory-state 导入与 SQLite payload 变更 | Linux x64，Node 26，managed worktree | `npm run typecheck:all` | 0 / 22 个 workspace 包构建通过；无新增类型错误；Electron 164 个登记基线错误 | Vite 有既存 chunk/comment 警告；21 个基线项已收敛，未重写 baseline |
| `3e2390141` / 同上 | Linux x64，managed worktree | `npm run architecture:check` | 0 / 无新增违规，均在既存 baseline | 60 个旧 fingerprint 不再触发；未写 baseline |
| `3e2390141` / DB 导入、消息读写、memory-state 迁移 | Linux x64，managed worktree | `npx vitest run apps/desktop/src/main/memory-state packages/data/tests/message-log-read-range.test.ts packages/data/tests/message-log-append-index.test.ts packages/data/tests/core-data-host.test.ts packages/data/tests/legacy-core-database-import.test.ts packages/data/tests/data-paths.test.ts` | 0 / 18 文件、185 项通过 | 包括旧 memory-state 合并、主连接借用、JSONL 回填、缺失镜像读取 |
| `3e2390141` / Data/Desktop 主路径 | Linux x64，managed worktree | `npm run electron:build` | 0 / Electron main/preload 与 worker bundle 构建完成 | 生成并检查 tracked Host bundle；存在既存 Vite 大 chunk 与 esbuild `require.resolve` 警告 |
| `3e2390141` / 真实 Desktop IPC 与归档 | Linux x64，managed worktree | `npx playwright test --config=e2e/playwright.config.ts --project=ipc e2e/ipc/bot-delivery.spec.ts e2e/ipc/session-archive.spec.ts` | 7 项通过；Playwright 进程需 SIGINT 才退出 | Electron 日志确认测试数据目录内只打开 `duya-main.db`；未见用例失败 |
| `3e2390141` / 当前 dirty tree | Linux x64，managed worktree | `git diff --check -- . ':!packages/host/bundle/worker-entry.js'` | 0 | worker minified bundle 中有生成器保留的模板字面量尾随空格；未手工改生成内容 |

## 接续 / 结果

已实现：任务计划、数据库目标盘点；DataHost 已具备当 main/core 文件路径相同时复用一个 handle、owner lock 和 WAL checkpoint owner 的基础，并按平台安全比较路径及关闭共享连接。已验证：主检出干净、当前数据导入 marker 和 source ownership；全量类型/包构建门禁及 Data 包类型、架构门禁通过。已合并：否。

下一步：核对最终 dirty 文件与生成 bundle，提交完整变更并开 PR；PR 开出后把 PR 链接、head SHA 和检查状态补回本计划。不合并，等待集成授权。

回收：保留 managed worktree，直到 PR 合并并完成合并后验证；ignored 依赖和构建产物需在回收前单独核对。
