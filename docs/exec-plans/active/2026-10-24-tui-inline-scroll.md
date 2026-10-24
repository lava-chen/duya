# TUI inline 滚动：把滚轮交还终端，修掉会冻结流式输出的上滚入口

状态：active · 负责人：qoder-agent · 更新：2026-10-24
分支：codex/tui-inline-scroll · worktree：.claude/worktrees/tui-inline-scroll · base：686f3c81 · owner：qoder-agent

## 目标与边界

用户能观察到的变化：默认 inline 模式下，agent 运行期间滚轮和终端自身的 PgUp 能翻看已经滚过的内容（终端 scrollback 持有全部历史）；TUI 不再截获滚轮，也不会因为按 PgUp / F6 而停止提交、把正在输出的画面冻结住。fullscreen 行为不变。

关联：续 [2026-10-23 TUI 滚动锚定](2026-10-23-tui-scroll-anchor.md)（`aec08d75`，已并入 master）。那次把状态改成「绝对偏移 + 独立 follow」，但 inline surface 仍把窗口钉在尾部，且 `viewEnd` 语义与调用方相反。

允许修改：`packages/cli/src/tui/terminal/surface.ts`、`packages/cli/src/tui/TUIApp.ts` 的 inline 帧与滚动入口、相关注释、对应测试、本计划与 `README.md` 表格。

本次不做：
- fullscreen 路径（已能滚动，不动）。
- inline 的 app-owned 视口 / hold buffer（下面「发现与决策」给出它不成立的原因）。
- pi 的 `followSuppressedAtEnd` 与退出重打整份文档（duya 没有对应入口）。

## 验收

- `node node_modules/vitest/vitest.mjs run packages/cli/src/tui` 全绿（含新增用例）。
- surface：默认 inline 无 hold buffer —— 每一行要么已提交、要么在可见窗口内，且只打印一次。
- TUIApp（`inline: true`）：不写出 `\x1b[?1002h`（鼠标上报），fullscreen 写出，作为对照；按 PgUp 后 `follow` 仍为 true，随后追加的流式行继续出现在输出里。
- `npm run typecheck:cli`、`npm run architecture:check` 退出码 0。

## 进度

- [x] 删除 `InlineSurface` 的 `reserve` / hold buffer，提交边界固定为可见窗口起点
- [x] 删除 `viewEnd` / `viewTop` / `atBoundary` 这条不可达的 app 上滚路径
- [x] inline 不启用鼠标上报；fullscreen 保留
- [x] inline 下 PgUp/PgDn 与 `revealSelectedBlock` 不再改 `follow`（弹窗分页仍保留）
- [x] 单测 + inline 集成用例
- [x] `typecheck:cli`、`architecture:check`
- [x] commit（`816b110a`）、push、PR #455

## 发现与决策

- **`reserve > 1` 的 hold buffer 不成立**：commit 把行写在滚动区域底部并让区域滚动，
  真正进入 scrollback 的是区域**顶部**那一行。若 live 区只显示尾部、而
  `liveStart` 落后一屏，提交时被滚进 scrollback 的是用户正在看的尾部行，
  被提交的行则在同一帧的 paint 里被覆盖、从未打印——历史既丢失又乱序。
  基线 `surface.ts:213`（`aec08d75`）的 `liveRows * reserve` 就是这种形态；
  旧测试只从空屏跑一帧，所以没暴露。因此 reserve 被整体删除，而不是调大。
- **根因是 inline 没有可滚区间**：基线 `COMMIT_RESERVE_SCREENS = 1`
  （`aec08d75:surface.ts:87`）使 `liveStart = documentRows - liveRows`，
  再被 `Math.max(liveStart, desiredStart)` 钳回尾部——无论 `viewEnd` 传什么，
  inline 实际可上滚 0 行。pi 的答案是把这件事分给两种模式：regular（默认）由终端
  掌管 scrollback、不接管滚轮；fullscreen 才有 app-owned `ScrollView`。
- **`viewEnd` 语义相反**：surface 当排他下界、TUIApp 传窗口顶部。改名也救不了，
  因为 inline 根本不该有 app 视口——最终连同 `viewTop` / `atBoundary` 一起删除，
  避免留下第二个「语义不一致但测试是绿的」入口。
- **鼠标上报只在 fullscreen 开启**：开着 `?1002h?1006h` 时终端把滚轮变成 SGR 事件，
  不再滚自己的 scrollback；inline 依赖 scrollback，所以必须关。副作用是 inline 的
  弹窗失去滚轮，保留 PgUp/PgDn。
- **`follow = false` 在 inline 是毒药**：paintInline 只在 `follow` 时提交；一旦被
  PgUp / F6 置为 false，live 区冻结且不再提交，而 agent 还在输出。三个入口
  （滚轮、PgUp/PgDn、revealSelectedBlock）现在都按模式分流。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| 686f3c81 clean | Windows / Node 24 | 基线：`node node_modules/vitest/vitest.mjs run packages/cli/src/tui` | exit 0；718 tests passed；21 个文件收集失败（`@duya/ai` dist 缺失，共享 node_modules junction 指向主检出） | 修复前基线 |
| dirty（本 worktree） | Windows / Node 24 | `node node_modules/vitest/vitest.mjs run --config tmp/vitest-ai-source.config.mts packages/cli/src/tui`（`tmp/` 为 ignored 的临时 alias，把 `@duya/ai` 指到本检出源码） | exit 0；73 files / 940 tests passed | 全部 TUI 用例 |
| dirty（本 worktree） | Windows / Node 24 / heap 8G | `NODE_OPTIONS=--max-old-space-size=8192 npm run typecheck:cli` | exit 0 | 16 包构建 + `tsc --noEmit` |
| dirty（本 worktree） | Windows / Node 24 | `npm run architecture:check` | exit 0；无新增边界违规 | 仅有既有 baseline |

## 接续 / 结果

已实现、已验证，提交 `816b110a`，PR [#455](https://github.com/lava-chen/duya/pull/455)；未合并（等待用户授权）。
`tmp/vitest-ai-source.config.mts` 是 ignored 的本地验证辅助，不提交。
回收：PR 合并后按 worktree 指南核对 owner、成果可达与 ignored 文件。
