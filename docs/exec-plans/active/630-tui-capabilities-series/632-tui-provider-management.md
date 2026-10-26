# 632 TUI provider 与模型管理

状态：active · 负责人：未认领 · 更新：2026-10-26
分支：未建 · worktree：未建 · base：master（需含 630a） · owner：无

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
- Host 已有外科式 TOML 命名空间替换原语：`packages/host/src/config-agents/config-file.ts:83` 及写侧样板 `config-agents-api.ts:69/113`，provider 写路由应复用该形状而不是再开一条整文件重写路径。

## 验收

- 无 Electron：`duya tui` 内新增一个 OpenAI-compatible provider（含遮罩密钥）、测连、拉模型、设为默认、新会话用其模型跑一轮、编辑 Base URL、删除。`config.toml` 与 `secrets.json` 落点正确，Desktop 设置面板同刻读到一致数据。
- 任何对外响应与日志只出现 masked key；错误信息剔除刚提交的 key。
- `typecheck:all`、`architecture:check`、`npm test -- packages/host packages/cli apps/desktop` 相对基线零新增失败。

## 进度

- [ ] Host provider 写路由（list/upsert/delete/setDefault/test/syncModels 的 HTTP 面），复用 config-agents 外科写 + secrets 分文件；并发用 revision 乐观锁。
- [ ] `http-client` 对应方法 + TUI 面板三界面（列表/向导/编辑）接 630a 原语。
- [ ] catalog 加 `/provider` spec，桌面平价与可用性测试更新。
- [ ] `/model` 按 provider 分组并与 `/provider` 互跳。

## 发现与决策

- 参考实现（minimax-code）把 key 明文进 config.yaml 靠 0600 兜底；duya 已有 secrets.json 分离，保持现契约，只把 Desktop 的写入语义搬到 Host，不迁 key 存储位置。
- 测连先于落盘（参考实现 editor 的 save 流程），避免坏配置进入 catalog 投影。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| 待执行 | win32 / Node 24 | 验收清单全部命令 | — | 基线在开工检出重记 |

## 接续 / 结果

下一步：等 630a 合入后建实现 worktree，先做 Host 写路由 + 单测（不依赖面板）；完成判据是路由测试全绿且 Desktop IPC 行为回归不变。阻塞：630a。
