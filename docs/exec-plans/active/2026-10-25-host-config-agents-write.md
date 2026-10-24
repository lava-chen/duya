# 把 config.toml 写侧下沉到 packages，支撑 worker 的 config:agents:create / update

状态：active · 负责人：mavis 会话 `mvs_ae3b38275b13437883faa5ef6f4d518c` · 更新：2026-10-25
分支：`codex/host-config-write` · worktree：`E:\Projects\duya\.claude\worktrees\host-db-actions` · base：`59c15bda` · owner：mavis

## 目标与边界

用户可观察到的变化：独立 Host（CLI / TUI）里，模型的 `create_agent` / `update_agent` 工具不再报
`unimplemented_domain`，而是真正写入 `~/.duya/config.toml` 的 `[agents.*]` 并落 `agents/<id>/profile.json`。

允许修改的路径：

- `packages/host/src/config-agents/**`（新增：共享纯逻辑 + TOML 写原语）
- `packages/host/src/agent-profile-config.ts`（`CustomAgentConfig` 统一到一份定义）
- `packages/host/src/worker-db-bridge.ts`（新增 `config:agents:create` / `config:agents:update`）
- `packages/host/package.json`（新增 `./config-agents` 子路径导出）
- `apps/desktop/src/main/config/{agent-id,bot-profile,agent-paths,agents}.ts`（收敛到共享实现，行为不变）

本次不做：删除 / 软删 agent 的写侧（`deleteConfigAgent` / `softDeleteConfigAgent`）、provider 与
vision 等其它 `config:*` 写 action、`automation:cron:*`、`channel:deliver`。

关联：PR #420（Host worker db bridge，已合并 `71bb9c88`）、PR #381（性能线，已合并 `18aace89`）。
本计划是 #420 遗留的 5 个未接 action 中的 2 个。

## 验收

1. `npm run typecheck:all` 退出码 0。
2. `npm run architecture:check` 退出码 0，不新增 tolerated。
3. `npm run bundle:verify` 为 `FRESH`（改了 `packages/host/src/**` 后必须同变更重建 bundle）。
4. `packages/host` 与 `apps/desktop` 相关测试全绿，且不吞退出码、不放宽断言。
5. 新增测试覆盖不变量：Host 写侧产出的 `config.toml` 含 `[agents.<id>]`；`update` 保留
   `model` / `provider` / `reasoning` / `prompt` / `tools` / `plugins`；软删 agent 拒绝重建；
   `profile.json` 首次创建后不被覆盖。

## 进度

- [x] `packages/host/src/config-agents/` 模块（bot-id / bot-paths / bot-profile / schema / core / config-file / api）
- [x] `packages/host/src/agent-profile-config.ts` 的 `CustomAgentConfig` 改用共享定义
- [x] `worker-db-bridge.ts` 接上两个 action
- [x] Desktop 侧 `agent-id` / `bot-profile` / `agent-paths` / `agents` / `schema` 收敛
- [x] 测试（packages/host 新增 2 个文件 15 条断言；Desktop config 16 文件 147 条全绿）
- [x] 门禁：typecheck:all exit 0、architecture:check exit 0、bundle 重建 + `bundle:verify` FRESH 0/927
- [x] PR #433（未合并，等授权）
- [ ] CI 五个 job 全绿
- [ ] 授权后合并

## 发现与决策

- **两边 config root 是同一个目录**：`apps/desktop/src/main/config/compass.ts:19` 与
  `packages/host/src/agent-profile-config.ts:42` 都返回 `resolveDataRoot()`（`@duya/data/data-paths`），
  所以 Desktop 与 Host 读写的是同一份 `~/.duya/config.toml`。
- **写侧不引入新的保真度损失**：Desktop 的 `ConfigStore` 已经用 `@iarna/toml` parse→stringify 落盘
  （`apps/desktop/src/main/config/store.ts:13,335`），注释与换行本来就会丢。Host 侧沿用同一机制，
  `packages/host` 已有 `@iarna/toml` 依赖；`write-file-atomic` 不在 packages 依赖里，因此原子写
  直接用 `fs` 实现（tmp + rename + Windows EPERM 的 copy 兜底），不新增第三方依赖。
- **TOML 往返已实测**：`@iarna/toml` 的 `parse` 返回普通对象（`Object.prototype`），
  `stringify` 静默跳过 `undefined` 值——共享的 `buildUpsertedAgent` 可以安全地写 `undefined` 表示缺省。
- **Host 侧只改 `[agents]` 表，其余字段原样保留**：Host 不读 `secrets.json`、不分离密钥，
  密钥本来就不在 `config.toml` 里（Desktop 落盘时已分离），所以 Host 写回不会丢密钥，也不会把密钥搬进 TOML。
- **写侧核心逻辑必须只有一份**：`upsert` 的字段保留规则、`slugify` / `allocateBotId` 的取名规则、
  bot id 合法性、bot 目录路径最容易漂移，因此下沉为 packages 纯函数，Desktop 改为委托。
- **`packages/host/src/worker-config/**` 的“只读”约定要正式修订**：那条约定的原文是
  “`config.toml` 是手工编辑的，坏写会抹掉所有 provider”（`worker-config/provider-catalog.ts:27`）。
  写侧限定为「只改 `[agents]` 表、原子写、解析失败先备份再抛错」，并改为引用新的 config-agents 模块。
- **既有风险（不在本次解决）**：Desktop 的 `ConfigStore` 与 Host 可能同时写 `config.toml`，
  Desktop 侧本身没有跨进程锁。Host 侧每次写都重新从盘读，窗口最小；Desktop 侧靠既有 watcher
  （400ms debounce）热加载。彻底解决需要双侧共同加锁，属独立任务。
- **`seedBotProfileIfMissing` 依赖 `<agentsRoot>` 目录布局**：Desktop 的 `getDuyaAgentsRoot` 默认根是
  `resolveConfigRoot()`，与 Host 的 `resolveDataRoot()` 同源，目录布局一致，可以直接复用。

### 2026-10-25 复核后的修正

- **写侧改成「只替换 `[agents]` 命名空间」的定点编辑，不是整份 parse→stringify**。
  实测 `@iarna/toml` 的往返**语义无损**（值都还在：整数变 `1_700_000_000_000` 但等价、
  inline table 展开成子表但等价、datetime 归一到毫秒），但**注释会全部丢失**。
  `config.toml` 是被官方文档标注为「手工编辑」的文件，Desktop 的 `ConfigStore` 已经在每次写入时
  归一化整份文件；Host 没有理由比它更粗。
  定点编辑只替换 `[agents…]` 表所在的行区间，其余字节原样保留；写前把结果重新 parse，
  并与目标 agent map 逐字段比对，**不一致就退回整份重写**，绝不落一个语义不对的文件。
- **TOML 里没有 null**：`deleted_at` 的「live = null」只是 JSON 往返后的内存形态，
  落到文件上就是「字段不存在」。定点编辑不需要额外处理 null 语义。
- **`CustomAgentConfig.name` 不带 `| undefined`**：`packages/capabilities` 的端口类型写的是
  `readConfigAgents(): Promise<Record<string, { name?: string }>>`，而 `packages/host` 开了
  `exactOptionalPropertyTypes`，`name?: string | undefined` 与 `name?: string` 不是同一个形状。
- **Host 写侧的根固定用 `resolveDataRoot()`**：Host 自己的读侧（`readConfigAgents`）也用它，
  两者必须同源；`StartLocalHostOptions.dataRoot` 这个程序化覆盖**读侧本来就不认**，
  写侧若认就会写到一个读不到的地方。这是既有分叉，不在本次修。
- **双写者 lost update 在实践上被数据目录锁挡住**：Desktop 拓扑下 worker 的 `db:request`
  由 Electron Main 的 `dispatchDbAction` 应答（`packages/host/src/worker-db-bridge.ts` 文件头），
  独立 Host 拓扑下才走 Host bridge，两边不会同时写同一个 `config.toml`；
  Desktop 与独立 Host 同时开则由数据目录 owner 锁挡住。仍按「Host 每次重新从盘读」缩小窗口。

### 留给后续（不在本次范围）

- `packages/host/src/worker-hooks/config.ts:85` 自带一份 `resolveConfigRoot()`，只认 `DUYA_TEST`
  与 `DUYA_TEST_NAMESPACE`，不认 `DUYA_DATA_ROOT` —— 第三份分叉实现，读侧，应收敛到 `@duya/data`。
- Host 的 `StartLocalHostOptions.dataRoot` 与 `resolveDataRoot()` 的分叉（读侧不认覆盖）。
- Desktop `ConfigStore` 与 Host 写侧统一成单一写者（跨进程锁 / 版本号）。
- Desktop 的 `apps/desktop/src/main/ipc/db-handlers.ts` 与 `apps/desktop/src/main/cli/handlers/config.ts`
  走同域的另外两条入口，本次未改（它们在 Desktop 进程内，仍是同一个写者）。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| 59c15bda（clean） | Windows / Node 24.16 | `node` 探测 `@iarna/toml` parse/stringify | 0 | 往返语义无损、注释丢失、整数下划线化 |
| dirty（packages/host + apps/desktop） | Windows / Node 24.16 | `npm run build:packages -- --target @duya/host` | 0 | 12 个包构建通过 |
| dirty | Windows / Node 24.16 | `npm run typecheck:all` | 0 | 含 check:encoding / manifest-keys / electron gate / cli / web / voice / evals |
| dirty | Windows / Node 24.16 | `npm run architecture:check` | 0 | tolerated 2567（master 上 2553，新增 3 条 permitted），无新增违规 |
| dirty | Windows / Node 24.16 | `npx vitest run packages/host/tests/config-agents-write.test.ts packages/host/tests/worker-db-bridge-config-agents.test.ts` | 0 | 2 文件 15 断言全过 |
| dirty | Windows / Node 24.16 | `npx vitest run apps/desktop/src/main/config/__tests__` | 0 | 16 文件 147 断言全过 |
| 3ddbbfaf + dirty | Windows / Node 24.16 | `npx vitest run --changed=origin/master --maxWorkers=2` | 0 | 216 文件 / 2095 passed / 6 skipped |
| 9df284bd（clean） | Windows / Node 24.16 | `npm run bundle:verify` | 0 | FRESH 0/927，bundle commit = 9df284bd |

## 接续 / 结果

已实现：`packages/host/src/config-agents/`（8 个文件）、Host bridge 两个 action、
Desktop 侧 `agent-id` / `bot-profile` / `agent-paths` / `agents` / `schema` 收敛到共享实现。
已验证：门禁全绿（typecheck / architecture / bundle:verify），受影响测试集 216 文件 2095 断言全绿。
PR：#433（https://github.com/lava-chen/duya/pull/433），base `master`，**未合并**。

分支：`codex/host-config-write`（worktree `E:\Projects\duya\.claude\worktrees\host-db-actions`，
base `3ddbbfaf`）。三个 commit：`0149eebb` 源码、`9df284bd` bundle 重建、最后一个是本计划更新。

未提交路径：无（worktree 干净，提交信息与 PR 正文在 gitignored 的 `docs-local/`）。
副作用：无外部副作用。
阻塞：无。等 CI 五个 job 全绿 + 用户授权后合并。
下一步：`gh pr checks 433` 看 CI；全绿后向用户申请合并授权，授权则 `gh pr merge 433 --merge`。


