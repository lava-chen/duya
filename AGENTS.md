# AGENTS.md

Duya：本地优先的 agent 工作台。此文件只放全仓约束；细节按链接读取。

## 开始

1. 读 [计划入口](docs/exec-plans/README.md)，定位用户本次任务；不要自动接手无关的队首任务。
2. 只读核对共享状态后，先分配自己的独立 managed worktree；所有编辑、计划记录、构建与提交都在该检出进行。
3. 读目标子树的 `AGENTS.md`；多步骤任务先写计划，跨会话任务使用[计划模板](docs/exec-plans/template.md)。
4. 阅读下表中本任务涉及的指南，再执行操作；普通链接不保证自动加载，不能省略读取。

| 本次操作 | 必须读取 |
| --- | --- |
| 每个 agent 开工及 worktree 全生命周期 | [worktree](docs/development/worktree.md) |
| 跨会话任务、派工或集成 | [工程闭环](docs/development/engineering-loop.md) |
| 测试、UI、IPC 或运行时修改 | [测试](docs/development/testing.md) |
| main / preload、bundle、依赖或打包修改 | [构建](docs/development/build.md) |
| 日志修改 / Code Review 面板修改 | [日志](docs/development/logging.md) / [面板契约](docs/development/code-review.md) |
| 版本、tag 或发布 | [发布](docs/development/release.md) |

架构与定位：[ARCHITECTURE.md](ARCHITECTURE.md) · [ARCHITECTURE_MAP.md](ARCHITECTURE_MAP.md)；[排障](docs/development/footguns.md)按症状查。

## 定位

| 范围 | 入口与边界 |
| --- | --- |
| UI | `packages/ui/` 共享 renderer；`apps/desktop/`、`apps/web/` 挂载 |
| Harness | `agent-protocol` 线上契约；`agent-core` 零 IO 推理；`agent-runtime` 执行引擎 |
| Host / CLI | `packages/host/` 管产品 worker、工具与 DB 桥；`packages/cli/` 管 CLI / TUI 与 worker 构建入口 |
| 遗留层 | `packages/agent/` 正在退役，不新增实现 |
| Slash 命令 | 只在 `packages/command-catalog/` 定义，Desktop / TUI 从其投影 |

## 开发

```bash
npm run dev                  # Vite :3000
npm run electron:dev         # Vite + Electron
npm run build:packages       # workspace build order
npm run build:cli-dev        # build before dev:tui in a new checkout
npm run dev:tui              # runs packages/cli/bundle/cli.cjs
npm run typecheck:all
npm run architecture:check
npm test
npm run electron:build       # required before test:e2e
```

- 缺依赖先确认 `node_modules` 是否为共享 junction；禁止穿过共享链接运行安装。
  独立依赖目录可 `npm install` 后重试一次，仍失败就报告首个可执行错误。
- TypeScript strict；用 `unknown` 窄化外部数据，边界使用已有 schema helper 或 zod。
- 注释用英文。日志用所属包的结构化 logger，禁止生产代码 `console.log/warn/error`，不记录密钥或消息正文。
- UI 使用 `globals.css` 的主题变量，适配 light / dark。

## 验证

- 提交前运行 `npm run typecheck:all` 和 `npm run architecture:check`。
  架构门禁只允许既有 baseline；不得加指纹掩盖新增违规，managed 模块零容忍。
- 先记录相关测试的基线失败，再比较改动；失败按文件、用例、错误签名比较，不能只报数量。
- 从当前检出根目录先跑相关测试；失败先定位，不吞退出码、不跳过用例或放宽断言换绿。
- UI 改动用 Playwright MCP 真跑；MCP 连接器改动过 conformance L1–L9
  （`packages/agent/tests/integration/mcp-conformance.test.ts`）。
- main / preload 修改后重建 Electron；UI 服务与构建产物必须来自当前检出，mock 通过不能代替真实 IPC / worker 链路验收。
- 打包或懒加载边界变化时，推送前跑 `npm run electron:build`；架构变化同步 `ARCHITECTURE.md`。
- 验证记录带 SHA、dirty 范围、环境、命令和退出码；区分已实现、已验证、已合并。
  细则见[测试](docs/development/testing.md)与[构建](docs/development/build.md)。

## 隔离与接续

- 每个 agent 必须使用独立 worktree：主 agent、子 agent、单 agent、文档与小修复均无例外；优先 managed worktree。仅在 Harness 创建工具不可用时，才按 [worktree 指南](docs/development/worktree.md)手工创建独立检出；共享检出只读。
- 完整流程：分配并登记 owner/base → 配置依赖 → 修改 → 验证 → commit → PR → review/CI → 授权集成 → 重验 → 安全回收并核对清单。
- 新 worktree 不包含主检出的未提交改动；依赖这些改动时先保存并核对任务切片，再选择 base。
- PR 未集成或验证失败就保留分支、worktree 与接续记录。回收前核对 owner 已退出、成果可达和 ignored 文件；managed 走管理工具，手工走 `scripts/remove-worktree.sh`，禁止递归删除或强制清理。
- 中断后先核对 Git、PR 与已发生的副作用；先保存剩余成果，禁止用整树 restore / reset 试探恢复。
- 停下前更新同一计划：分支与 base/当前 SHA、未提交路径、验证命令与结果、外部副作用、阻塞和下一条动作。

## 交付

- 一个 commit 一个逻辑变更；只暂存本任务文件，不提交密钥或临时产物。
- Conventional Commits，英文、祈使句、小写、无句号、标题不超过 72 字符。
- 所有变更只通过 PR 交付；禁止直接 push `master` / `main`，无文档或小改例外。任务分支发布只用于本任务 PR。
- 未经用户授权不合并；只有最新 PR head 上的必需 review 和必需 CI 检查全部通过，才可集成；非必需检查失败须记录并由获授权的集成者评估，不自动等同于阻断，也不得绕过必需检查。未满足验收或仍有未评估风险时保留 draft。获集成授权后用 merge commit 合并，再同步、重验与回收。GitHub 操作优先 `gh`。
- 发布须有用户授权；tag 必须指向版本匹配的提交，由 release workflow 发布，并核验 Release 与产物。

## 文档与工具

- 写文档前读 [docs/AGENTS.md](docs/AGENTS.md)；原始调查报告和截图放 `docs-local/research/<topic>/`，恢复材料并入所属计划，不新建 docs 顶层分类。
- `.codegraph/` 存在时，理解或定位代码先用 CodeGraph；未索引的文档、配置可直接读。
- 涉及共享任务或 handoff 时，先用 `workspace_get_context` 读取状态；工具不可用时从版本化计划与 Git 对账并说明限制。
- Workspace：建任务或记忆前先搜索；进度用 activity 工具记摘要，不存原始日志、凭据或未经验证的结论。
