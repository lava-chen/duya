# footer 的用量区改成进度条 + 百分比

状态：active · 负责人：cli-footer-bar · 更新：2026-11-04
分支：codex-footer-capacity-bar · worktree：`C:/Users/lavachen/.duya/worktrees/duya-158718b0aef8/footer-capacity-bar` · base：`7ef8cbd0` · owner：cli-footer-bar

## 目标与边界

两件事，同一行：

1. footer 数字行的 `5%/1.0M` 换成「条 + 百分比」；
2. 这一行剩下的两组数字各自一个 `/settings` 开关：**速度默认开**、**三个统计数字默认关**。

改完默认看到的是

```
▰▱▱▱▱ 5% · 63.0 tok/s                              (deepseek) deepseek-flash • high
```

把 Token counters 打开后恢复成

```
↑49k ↓1.6k Σ51k · ▰▱▱▱▱ 5% · 63.0 tok/s            (deepseek) deepseek-flash • high
```

**不新增行**：footer 仍是原来那两行（路径行 + 数字行），条只是数字行里的一小块。用户明确要求
「不要做两行，就是一个小的区域，还是那一行里」。所以格数刻意压小（80 列 5 格、96 列 6 格、
64 列 4 格，再窄只剩百分比）—— 这一行右侧是 flush right 的模型名，条多占一列就是模型少一列。

`▰▱` 是 duya 自己 `/usage` 窗口一直在用的字符对（`TUIApp.contextBar`），不是 minimax-code 的
`█░`：同一读数用两套字形是本计划要消灭的问题之一。`/context` 面板（独立面板，不占 footer 预算）
是唯一用 12 格的地方。

开关的语义：profile（`/statusline` 的四档）决定这一行**有没有**这一组，开关决定**这一次要不要**。
两者是与关系，所以开关打不开 profile 已经去掉的组 —— 预设不能变成半真。

允许修改：`packages/cli/src/tui/{footer.ts,capacity-bar.ts,TUIApp.ts,preferences.ts}`、
`packages/cli/src/tui/slash/{settings.ts,types.ts,display.ts,session-info.ts}`、`packages/cli/src/chat.ts`
及对应测试。
本次不处理：`token_usage` 帧不携带 cache read/write，所以 pi 的 `R`/`W`/`CH` 三组暂时无法显示；
费用（`$0.123`）也不在 footer 里，它是 `/cost` 的读数，需要 pricing 查询。

关联：上一任务 `docs/exec-plans/active/2026-11-04-usage-row-persistence.md`（同一个 `/context` 读数问题，
它修的是「usage 从未落库」，本计划只改显示层）。

## 验收

| 命令 | 预期 |
| --- | --- |
| `vitest run packages/cli/src/tui/__tests__/capacity-bar.test.ts packages/cli/src/tui/__tests__/footer.test.ts` | 全绿 |
| `vitest run packages/cli/src/tui` | 除 Windows 权限位用例（`presets.test.ts` 的 `mode & 0o077`，基线即红）外全绿 |
| `npm run typecheck:all` | 退出码 0 |
| `npm run architecture:check` | 退出码 0，无新增指纹 |

## 进度

- [x] 三处参考实现对照（pi 无条；minimax-code 有 `[██░]`；duya 只在 `/usage` 有 `▰▱`）
- [x] 抽出 `capacity-bar.ts` 作为唯一实现
- [x] footer 第二行的 context 组改成「条 + 百分比」，格数按宽度分档
- [x] 按用户要求压小尺寸：不新增行，80 列只有 5 格（原方案 8 格会让 80 列零余量）
- [x] `/context` 面板加 12 格条；`TUIApp.contextBar` 改为委托
- [x] 用例：新增 `capacity-bar.test.ts`，更新 `footer.test.ts` / `slash-commands.test.ts`
- [x] 变异验证（三条）
- [x] 门禁 + commit（`eb082294`）+ PR #618
- [x] 第二段：速度 / 三个统计数字各一个 `/settings` 开关（默认 开 / 关），profile 与开关取与
- [x] 开关用例：preferences 解析、footer 单测两条 + profile 不可复活一条、面板真实按键两行、
      画出来的 footer 真的少一组（`tui-inline-mode` 改为断言默认无 `↑`，另加开着的用例）

## 发现与决策

1. **pi 没有进度条。** `FooterComponent.render`（`pi-coding-agent/dist/bundle/chunks/chunk-66G7ITPS.js`）
   的 stats 段是 `↑in ↓out Rcache Wcache CH92.3% $cost` 最后拼 `${percent}%/${formatTokens(window)}`。
   所以「和 pi 一样」在条这件事上无参照，条的参照只有 minimax-code
   `packages/tui/src/tui/transcript/capacity-meter.ts`（`[` + `█`×f + `░`×(w-f) + `]`，默认 24 格）。
2. **字形受宽度表约束。** `▰`/`▱`（U+25B0/U+25B1）经 `width.ts` → blessed `unicode.js` 实测 1 列。
   `⚡` 当年测 1 画 2，后果是 footer 最后一列被裁（见 `footer.ts` 的 `formatTokensPerSecond` 注释）。
   任何新字形必须先过 `visibleWidth(glyph) === 1` 断言。
3. **非零比例至少填一格。** 8 格下 `Math.round` 把 5% 变成全空，紧挨着 `5%` 打印会被当成坏掉的控件；
   向上取整最多多报一格，而「条少报了占用」才是让人撞上意外压缩的方向。
4. **空单元格不跟着告警色。** 满格红、空格 muted；整条染红会同时说「快满了」和「空的地方快满了」。
   这条由 `{yellow-fg}▰▰▰▰{/yellow-fg}{gray-fg}▱{/gray-fg}` 的断言钉住。
5. **格数按宽度分档而非连续。** 连续伸缩会让整行随每次 resize 重排。
6. **尺寸被用户否掉一次。** 首版 80 列 8 格，实测该行正好占满 80 列、模型名零余量，用户要求
   「不要做两行，就是一个小的区域，还是那一行里」→ 改成 5 格（96 列 6 格、64 列 4 格、<64 无条）。
   教训：footer 这一行的预算不是「够不够放」，而是「模型名还剩几列」。
7. **开关是与不是或。** `footer.ts` 里是 `profileAllows && input.flag !== false`：profile 已经去掉的组，
   开关打不开。否则 `/statusline location` 就变成半真，选了它的读者也无法判断哪一半是生效的。
   `undefined` 保持 profile 说了算，这样 footer 的其他调用方（测试、Desktop 侧复用）行为不变。
8. **默认值是按「这一行在回答什么」定的。** 条和速度说的是正在跑的这一轮；三个计数器说的是
   整个会话的账单，`/cost` 也报。所以 counters 默认关、rate 默认开。
9. **菜单插入位置改了三条靠下移次数定位的用例。** `tui-settings-panel.test.ts` 里那几条注释明说
   「The count is the assertion」，插入两行后必须同步改 7/6/5，并且那条「列表能画值列」的用例
   原本断言 `Completion rows`，行数变多后它落到可视窗口之外，改成滚到底再看（注意列表会环绕）。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| 工作区（5 格版） | Windows / Node 22.22.2 | `vitest run capacity-bar.test.ts footer.test.ts` | 0 / 45 passed | 10 + 35 |
| 工作区（5 格版） | 同上 | `vitest run packages/cli/src/tui` | 1 / 1471 passed, 1 failed | 失败是 `presets.test.ts` 的 `mode & 0o077`，Windows 权限位，基线即红 |
| 工作区（5 格版） | 同上 | `env -u CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR npm run typecheck:all` | 0 | 类型门禁 |
| 工作区（5 格版） | 同上 | `npm run architecture:check` | 0 | 无新增越界（49 条 baseline 指纹已不再命中） |
| 工作区（变异） | 同上 | 去掉 `Math.max(1, ...)` 下限 | 3 用例转红 | `expected +0 to be 1` / `▱▱▱▱▱ 5%` |

## 接续 / 结果

已提交：`eb082294`（实现 + 用例 + 计划），PR https://github.com/lava-chen/duya/pull/618 （draft）。
未做：真实 TUI 目视验收（需重建 CLI 产物并起 TUI）。

下一步：构建包后复跑两个文件级失败项与全量门禁，再 commit。
