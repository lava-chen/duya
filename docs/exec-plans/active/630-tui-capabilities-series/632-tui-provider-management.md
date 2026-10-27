# 632 TUI provider 与模型管理

状态：active · 负责人：Qoder agent（PR A Host 写面）· 更新：2026-10-26
分支：`codex/632-provider-write-routes`（PR A）· worktree：`.claude/worktrees/632-provider-host` · base：d80ca3c6（master，不含 630a） · owner：本 agent

## 目标与边界

用户在 TUI 输入 `/provider` 得到管理面板：provider 列表（当前默认标记、masked apiKey 详情行）、分步新增向导（名称 → Base URL → API 格式 → 模型 → API Key，密钥遮罩输入）、编辑表单（API Key / Base URL / Models / 别名，保存前先测连）、`r` 拉取远端模型列表合并、`t` 连通测试、设为默认、删除。`/model` 增加分组视图并可跳入 `/provider`。全程经 Host HTTP，无 Electron。

允许修改：`packages/host/src/`（provider 写路由）、`packages/cli/src/tui/slash/`（新 `provider.ts` + `model.ts` 分组）、`packages/command-catalog/src/index.ts`（`/provider` 新 spec；`login`/`logout` 的 desktop-only 声明维持）。
本次不处理：keychain（沿用 `secrets.json`）、OAuth 登录流、models.dev 远端目录（duya 已有 AI model catalog，见 499 线）。

关联：[系列](README.md)；依赖 630a；写侧下沉样板见 [config 写侧下沉](../2026-10-25-host-config-agents-write.md)（PR #433 已合并）。

## 现状事实（2026-10-26 核对）

- 配置真源 `~/.duya/config.toml [providers.*]`（`ProviderEntry`，`apps/desktop/src/main/config/schema.ts:22`、`:336`）；apiKey 分离存 `~/.duya/secrets.json`（同文件头注释 `:4`，`:32` 明示故意不含 key）。
- 读写在 `ConfigStore`（原子写，`apps/desktop/src/main/config/store.ts:152/:379`）与 `ProviderStore`（`apps/desktop/src/main/services/providers/provider-store.ts:133`）；变更入口只有 Desktop IPC：`provider:upsertLlm` / `deleteLlm` / `setDefaultLlm` / test / syncModels（`provider-ipc-handlers.ts:81-218`）。
- Host 只读投影：`packages/host/src/worker-config/provider-catalog.ts` → `GET` catalog（`http-client.ts:1495`）；Host 侧仅有 model override 写（`http-client.ts:1524/1539`）。
- TUI：`/model` 能切 session.model+providerId（`packages/cli/src/tui/slash/model.ts:338/:385`），不能增删改；`duya provider` 只读 list/info。
- Host 已有外科式 TOML 命名空间替换原语：`packages/host/src/config-agents/config-file.ts:83`；provider 写面复用该形状（泛化后共用），没有再开一条整文件重写路径。`config-agents-api.ts` 只是写侧模块，不是路由——见「发现与决策」第 1 条。

## 验收

- 无 Electron：`duya tui` 内新增一个 OpenAI-compatible provider（含遮罩密钥）、测连、拉模型、设为默认、新会话用其模型跑一轮、编辑 Base URL、删除。`config.toml` 与 `secrets.json` 落点正确，Desktop 设置面板同刻读到一致数据。
- 任何对外响应与日志只出现 masked key；错误信息剔除刚提交的 key。
- `typecheck:all`、`architecture:check`、`npm test -- packages/host packages/cli apps/desktop` 相对基线零新增失败。
- PR A 的判据：路由与写面测试全绿，且 Desktop IPC 行为回归不变（组装只新增一个 option）。
- PR B 的判据：上面第一条在真机 `duya tui` 走完。

## 进度

- [x] PR A · Host 写面（已实现于 `222f7e2f`，已验证，未合并）：
  `agent-protocol` 新增 `HostLocalProviderManagementApiV1` 与 `maskProviderApiKey`；
  `packages/host/src/provider-management/`（文件层 / 探测 / 规则层）；
  `GET /v1/local/providers` 与 `upsert`/`delete`/`set-default`/`test` 四条 POST；
  `http-client` 五个方法；`local-host.ts` 与 `desktop-host-api.ts` 组装；
  新测试 `provider-config-write.test.ts`（33）+ `provider-management-http.test.ts`（16）；
  worker bundle 同提交重建。
- [ ] PR B · TUI 面（依赖 630a 合入）：`/provider` 列表 / 向导 / 编辑三界面接 630a 面板原语；`command-catalog` 新 `/provider` spec 与桌面平价、可用性测试；`/model` 按 provider 分组并与 `/provider` 互跳。
- [x] 计划里的 syncModels 独立路由取消：与连通测试合并成一次探测（见下）。

## 发现与决策

- 计划原文假设 `config-agents-api.ts` 是 HTTP 写侧样板：不成立。config-agents 的写入只经 `worker-db-bridge.ts` 的 `config:agents:*` 动作到达，`http-server.ts` 里没有对应路由。provider 写面因此按 `/v1/local/*` 的 if 链新增路由，标识走 body 参数而不是路径段，未组合该能力时回 404 `provider_management_api_unavailable`（与"写失败"是两句话）。
- 计划原文假设并发用 revision 乐观锁：配置里没有可随内容变化的 revision（`_config_version` 是 schema 标记）。改成两件事：`expectedRevision` 取两个文件内容的 sha256 短哈希（可选守卫，不符则 409 `provider_revision_conflict`；`''` 表示"还没有配置"），加包内一条 promise 链覆盖 read-modify-write 窗口。守卫是检查而不是锁：不带它仍可盲写。
- 测连与拉模型合并成一次探测：模型列表就是这类端点唯一能被问的请求，两条路由会把同一个 URL 抓两次并对同一端点给出两个结论。探测失败仍是 200，`ok:false` 加一个 code——"那个密钥不对"报 500 读起来像 Host 坏了。
- 探测的端点与鉴权要按两个字段的职责分别解析，不能都按 catalog id：`providerType` 决定鉴权，且必须用 worker 自己的 `mapProviderType`，否则探测用的头和真实运行用的头不是一回事；表键决定列表端点，沿用 `worker-config/provider-catalog.ts:171` `findPresetEntry` 的"精确 id，再取第一个扩展 id"。catalog 的 id 与 config 的 providerType 不是同一个命名空间（`anthropic` 是十几个条目共享的 `legacyProtocol`，不是 id）。
- 本地运行时不给密钥就拨号：ollama / lm-studio 或 base URL 指向本机时报 `no_api_key` 等于让人去给 Ollama 申请 API key。环境凭证型（bedrock / vertex）给 `not_testable` 且不发起请求。
- 密钥的两种拼法都要读写：`getSecret`（`worker-config/file-config.ts:152`）先查扁平点号键、再走嵌套回退。只读扁平会让手写的嵌套文件显示 `hasApiKey: false` 而回合正常应答；只清扁平会让用户看到"已删除"而 worker 仍读得到。
- 落盘顺序是先 `secrets.json` 再 `config.toml`：半途失败留下的是一个没有行的孤立键（每个读者都从行开始，看不见），反过来会把一个 `hasApiKey: false` 的 provider 摆上屏幕，读起来像密钥丢了。
- 写面只重写被点名的命名空间：移动默认指针不碰 `[providers.*]` 一个字节；声明过的字段是替换，没声明的（`options.model_context`、`alias`、注释）原样带过。TOML 表里已存在的 `apiKey` 在写入时搬进 secrets 而不是直接删——删掉等于把用户没要求改的 provider 静默解除配置。
- 测试当场抓到一个真 bug：`readProviderSnapshot` 用同一套"每个值必须是表"的校验同时读 `[providers.*]` 和 `[model]`，而 `[model]` 的值是标量（`default = "gpt-4o-mini"`），于是任何带 `[model]` 的文件都被判为不可写。已拆成 `readProviderEntries`（逐值校验）+ `readConfigNamespace`（整表带过）。
- 本次不写 SQLite 的 model capability 覆盖表：`/v1/local/provider-model-capability/*` 已经管这件事，写两处会分叉。

## 发现与决策

- 参考实现（minimax-code）把 key 明文进 config.yaml 靠 0600 兜底；duya 已有 secrets.json 分离，保持现契约，只把 Desktop 的写入语义搬到 Host，不迁 key 存储位置。
- 测连先于落盘（参考实现 editor 的 save 流程），避免坏配置进入 catalog 投影。

## 验证记录

2026-10-26，检出 `.claude/worktrees/632-provider-host`，分支 `codex/632-provider-write-routes`，base `d80ca3c6`，HEAD `222f7e2f`（提交后工作树只剩本计划文件），win32 / Node v24.16.0。dirty 范围即 PR A 的 16 个文件。

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npx vitest run packages/host/tests/provider-config-write.test.ts packages/host/tests/provider-management-http.test.ts` | 0 | 2 files / 49 tests 全绿（新增面） |
| `npx vitest run packages/host/tests/config-agents-write.test.ts packages/host/tests/agents-md-http.test.ts` | 0 | 15 全绿，外科写原语泛化未回退 config-agents |
| `npx vitest run packages/host` | 0 | 231 passed / 1 skipped（文件），2063 passed / 5 skipped（用例），零失败 |
| `npx vitest run packages/cli apps/desktop` | 0 | 424 passed / 1 skipped（文件），4972 passed / 9 skipped（用例），零失败——Desktop IPC 回归不变 |
| `npm run typecheck:all` | 0 | 含 encoding / manifest-keys / test-coverage / no-ts-suppress / packaged-artifacts；electron gate "OK — no new type errors (206 known across 102 key(s))" |
| `npm run architecture:check` | 0 | "OK — no new boundary violations"；本次只增加 16 条 `module-dependency-permitted` 边 |
| `npm run bundle:verify` | 0 | `FRESH 0/992`，bundle commit = `222f7e2f` |

两条与本次无关的告警在主检出 `e9391659` 上逐字复现（同一命令、同一计数），故为主干既有而非本次引入，且两者都只是提示收紧基线、退出码为 0：`architecture:check` 的 "3 baseline fingerprint(s) no longer triggered"（主检出同样 3 条，cycle / module-dependency / package-boundary-escape 计数一致），以及 `typecheck:evals` 的 "9 baselined key(s) shrank or disappeared"（主检出同样 9 条、206 known across 102 keys）。

构建对 `packages/capabilities/src/ModuleTool/inline-content.ts` 和 `packages/host/bundle/package.json` 只做 CRLF 触碰，用 `git diff --ignore-cr-at-eol` 核对后 `git checkout --` 还原。

未验证：真机 `duya tui` 端到端（第一条验收），属于 PR B 的面板；PR A 没有可点入口。

## 接续 / 结果

PR A 已实现并验证，未合并（等待 review/CI 与用户集成授权）。下一步：PR B 的 TUI 面需要 630a 的面板原语，两种走法任选——等 #512 合入后以 master 为 base，或以 `222f7e2f` 为 base 叠加 630a 分支；后者要求 630a 与 PR A 都合入时才成立，堆叠顺序记在 [系列 README](README.md)。

PR B 开工时要接住的三件事：`/provider` 编辑表单的"测连"只能对已保存的 provider 发起（`/test` 只接 providerId，密钥不下发到客户端），所以流程是保存→测试→失败可回滚；列表要显示 `HostProviderList.error`，它比空列表更有解释力；写操作要带 `expectedRevision`，面板里正在编辑时 Desktop 可能同时在改同一行。
