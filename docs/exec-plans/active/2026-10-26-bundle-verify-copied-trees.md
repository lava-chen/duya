# bundle:verify 覆盖构建复制的两棵目录树

状态：active · 负责人：Code 桌面会话（bundle-verify-copied-trees） · 更新：2026-10-26
分支：worktree-bundle-copied-trees · worktree：E:\Projects\duya\.claude\worktrees\bundle-copied-trees · base：e9391659 · owner：Claude Code 桌面会话

## 目标与边界

`npm run bundle:verify` 判定已提交的 worker bundle 是否还对应它的源码。当前它只看 esbuild 的 metafile 输入集（TypeScript 闭包），漏掉了构建用 `fs.cpSync` 复制进 bundle 的两棵目录树：

- `packages/host/src/worker-prompts/assets/**` → `packages/host/bundle/assets/**`（37 个 .hbs）
- `packages/host/skills/**` → `packages/host/bundle/skills/**`（15 个文件）

这两棵树不在 metafile 里，所以「改了 .hbs 不重建」时两道门禁全绿，而仓库里那份 bundle 带的是旧 prompt。已提交 bundle 正是被测对象：`evals/agent/performance/runtime-fixture.ts:474`、`scripts/acceptance/web-agent-loop.mjs:233`、`packages/host/tests/run-turn-provider-integration.test.ts:208` 都直接跑 checkout 里那一份（`eval:agent:core` 不跑 `bundle:worker`）。

允许修改：`scripts/architecture/bundle-verify.mjs`、`scripts/architecture/bundle-verify.test.ts`、`.gitattributes`、`.gitignore`、`docs/exec-plans/README.md`、本计划文件。
不处理：跟踪面本身（`packages/host/bundle` 仍跟踪，`packages/cli|gateway|agent/bundle` 仍忽略）；把复制树摘出跟踪（会撞上 `HbsPromptSystem.resolvePromptAssetsRoot()` 在 bundle 里只能命中 `./assets`）。

关联：610 §19 T01b 行已记「门禁自印的修法 `build:packages --target @duya/host` 无效」；本次一并修正该提示。

## 验收

- `node scripts/architecture/bundle-verify.mjs` 在未改动的检出上 exit 0（fresh），并打印两行 copy tree。
- `npx vitest run scripts/architecture/bundle-verify.test.ts` 全绿；新增用例覆盖：源改镜像未改 / 镜像缺文件 / 镜像多文件 / 源改镜像同步改 → fresh。
- 改一个 .hbs 而不重建 → `npm run bundle:verify` exit 1 且指名该文件。
- `npm run architecture:check` exit 0。

## 进度

- [x] 定位缺口与影响面（复制树无门禁；已提交 bundle 是 eval / 验收 / 集成测试的被测对象）
- [x] `bundle-verify.mjs` 增加 COPY_TREES 判定（missing / differing / extra 三种，换行符归一化）
- [x] 修正门禁自印的重建命令（`build:packages --target @duya/host` → `npm run bundle:worker`）
- [x] `bundle-verify.test.ts` 补 4 条用例；fixture 物化两棵树；live-tree 断言按 copy tree 修正
- [x] `.gitattributes` 给 bundle 的 .js/.json 钉 `eol=lf`；`.gitignore` 用说明替换重复的空注释块
- [x] 计划记录落盘 + `docs/exec-plans/README.md` 入链
- [ ] 跑测试与门禁（被工具侧阻塞，见「接续」）
- [ ] commit + PR

## 发现与决策

- **复制树按内容比对，不按 git 历史**：git 判定回答「源码在 bundle 之后动过没有」，对编译产物是对的；复制树可以直接问「镜像里是不是当前源码」。直接比对还额外抓住「重建了但没提交」「复制步骤漏了文件」「源码删了镜像还在」，且不依赖提交顺序。
- **比对前归一化换行符**：Windows checkout 给 CRLF、索引里是 LF，逐字节比会让每个贡献者都红。含 NUL 的二进制只按字节比。
- **源文件集合取 git 的 tracked + untracked-not-ignored**：构建是整目录复制，新增文件也必须进镜像；被 ignore 的文件不是源码，不能让门禁红。
- **copy tree 漂移不并入 `staleInputs`**：那串路径是 metafile 输入集，分母是输入数；混在一起会让 summary 谎报自己数了什么。两类漂移分列报告，`copySummary` 单独一行。
- **门禁自印的重建命令是错的**：`build:packages --target @duya/host` 只跑 `tsc -b`，不产出 bundle（`scripts/build-packages.mjs` 只 spawn `npm run -w <pkg> build`）。照提示做的人会重跑一次 host 的 tsc，然后看到同样的 STALE。已改为 `npm run bundle:worker`（`docs/development/build.md` 的规范命令）。
- **跟踪面维持现状**：三条无 build 直读路径（打包成 `resources/harness-bundle/`、CLI 从 checkout spawn、desktop dev）都要求 bundle 在仓库里；`packages/cli|gateway|agent/bundle` 被忽略是对的，因为消费方都先 build。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| e9391659 + 4 文件未提交 | Windows 11 / worktree | `node scripts/architecture/bundle-verify.mjs` | 未执行 | 工具侧分类器不可用，命令被拒 |
| 同上 | 同上 | `npx vitest run scripts/architecture/bundle-verify.test.ts` | 未执行 | 同上 |

## 接续 / 结果

已实现（**未验证、未提交**）：4 个文件的改动都在 worktree 内，未提交、未推、未开 PR。改动经逐段复核（diff 通读 + 语法结构核对），但**没有跑过任何一条命令**。

外部副作用：无（未改共享检出；未动 `packages/host/bundle` 的任何产物；未产生提交）。

阻塞：本会话的工具分类器（`claude-sonnet-5`）持续不可用，Bash / 终端面板 / 子 agent 三个执行入口全部被拒，只有文件读写与只读 Git 可用。解除条件：分类器恢复。

回收：未回收（成果未提交，worktree 保留在 `.claude/worktrees/bundle-copied-trees`）。

下一步：分类器恢复后，在 worktree 根依次执行 `node scripts/architecture/bundle-verify.mjs`、`npx vitest run scripts/architecture/bundle-verify.test.ts`、`npm run architecture:check`；三条都绿后 `git add -A && git commit`，再开 PR。PR 正文写明两件事：复制树此前完全无门禁，以及门禁自印的重建命令此前无效。
