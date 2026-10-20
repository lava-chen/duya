# plan 615：统一 TUI 引擎（一条管线、一个输入驱动、退役 blessed）

把 `duya chat` 的 TUI 从「blessed 兜底 + 自有渲染器并行 + TUIApp 集中式组装」改造成一套引擎。13 个提交，每个都是可独立回滚的一步，描述里写清**为什么**而不只是改了什么。

计划文档：[`docs/exec-plans/active/615-cli-unified-tui-engine.md`](https://github.com/lava-chen/duya/blob/plan615-unified-tui-engine/docs/exec-plans/active/615-cli-unified-tui-engine.md)

---

## 为什么要做

TUI 的内部表示是**带 blessed 标签的字符串**。这个选择在下游是丢失信息的：画一个 cell 要把标签解析回样式，量宽度又要解析一次 —— 于是两个渲染器各养一个标签解析器，谁都不是权威。输入侧也有一条绕行：自有解析器解出按键后**重新注入** blessed 的事件管道，只为让 blessed 算出 `key.full`，绑定能不能命中完全取决于它。

于是有了这份改造：结构在**一处**降级一次，渲染和输入各自只有一条路。

```
tokens ──tokensToSpans──▶ StyledSpan[] ──┬─▶ spansToTags  → 标签（blessed 时代的词汇，已无生产消费者）
           （结构，只此一处）             └─▶ spansToAnsi  → 终端
字节流 ──input-driver──▶ InputEvent ──▶ TUIApp.dispatchInput
```

---

## 七个阶段

| # | 提交 | 做了什么 |
|---|---|---|
| 0 | `fbe5e3a8` `a6a0b334` `1e2ead54` | 基准 harness + own 转默认 + 修 parity 暴露的三处布局/输入缺口 |
| 1 | `f5cb040f` | `StyledSpan` + `core/color.ts` 唯一颜色词汇；标签串变成 Span 之上的一个视图 |
| 2 | `bffffa90` | 输入驱动：自有 `InputEvent` + 绑定表，blessed 不再参与输入 |
| 3 | `712ecac7` | Retained 组件树：`UIComponent` / `SceneCanvas` / VStack·HStack·Overlay |
| 4 | `56d93a86` | 可见窗口唯一查询 + 虚拟化 pane + `measure()` 记忆 |
| 5 | `abecbc91` | 两个 Output 一个输入格式、一个序列化器；D6 字符级 diff 裁定 No-Go |
| 6 | `1caa3459` | 组件接管状态：`TranscriptPane` 拥有文档缓存与窗口，`ActivityTracker` 拥有活动状态机 |
| 7 | `035311d7` | **退役 blessed**：`src/` 内零 blessed import |

---

## 三个不显然的设计决定

**① envelope（外层框）。** 块级样式先发、span 发**增量**。这是唯一能同时满足两条 pinned 断言的做法：`# 标题` → `{cyan-fg}{bold}…{/bold}{/cyan-fg}`（颜色在外），而 `` **`a `b` c`** `` → `{bold}a {gray-fg}b{/gray-fg} c{/bold}`（bold 在外，内层 code 替换自己的颜色）。两者扁平样式完全一样，区别只在嵌套顺序；事后包字符串做不到，因为「谁在外」会由拼接顺序决定。

**② 命名色与 256 索引不可压平。** 计划 §5.1 写的是 `fg?: number`，注释说「命名色已在 palette 阶段解析」——**这句话是错的**。SGR 36 是终端自有的 cyan（用户可重定义），不等于调色板第 6 项。改成 `{kind:'named'}` / `{kind:'indexed'}` 联合体，顺带把两份互相矛盾的着色表（一份键 `bright-black`、一份键 `brightgreen`）合并成一张。

**③ 画布存 cell，不存 span。** Span 是好的**存储**格式，是坏的**编辑**格式：overlay 要覆盖一条已有 span 的中间，HStack 要在 span 中间起笔。

---

## 三个「实测推翻了假设」的地方

**帧探针测错了东西。** `SYNC_BEGIN` 写在 `paint()` **开头**，早于任何一个 cell 被组合 —— 以它为准测的是「调度器决定画」，不是「用户看到」。而且两个渲染器都**不在 `SYNC_BEGIN…SYNC_END` 之间写像素**（blessed 缓冲进 `_buf` 等 `nextTick`，own 走微任务），所以按标记内统计字节，20KB 的屏读出 **0**。拆成 `dispatch`/`painted` 两栏、字节跨到下一帧标记才拿到真数。

**一次物理 Enter 派发两次。** `program.js:397-399` 让 `\r` 先以 `enter` 重发再落到 `return`；`CONTENDED_BINDINGS`/`CONTENDED_ALIASES` 全是为了压住这个重复。驱动让一次按键只产生一个事件，重复从**源头**消失而不是下游过滤。这个判断是测试逼出来的：接管后所有 Enter 用例瞬间全红。

**D6 字符级 diff：No-Go。** 计划原本写「P95 达标（<30ms）则降级」，而基线 P95 是 **32.0ms，没达标**，那条规则根本没触发。改看数据：流式一帧只重写 2 行、160 字节里只有 11 个不同（行内变更 6.9%，看着很值得做），但 `renderViewportFrame` 只花 **0.0067ms/帧**，整帧 **30.8ms** —— 写入路径不到帧成本的 0.03%。省下的 ~140 字节是噪声，而字符区间 patch 要处理宽字符、跨 span 的 SGR、以及「行尾擦除」这条现在保证不留残影的契约。**优化的是最便宜的一步。**

---

## 性能（Windows ConPTY，三次中位）

| | own（切换前基线） | 退役后 | blessed（切换前） |
|---|---|---|---|
| 输入 → 整帧 P50 / P95 | 30.8 / 32.0ms | **30.8 / 32.4ms** | 46.0 / 48.5ms |
| dispatch P50 | 0.22ms | 0.24ms | 0.29ms |
| 流式帧间隔 P50 | 76.6ms | 77.2ms | 77.2ms |
| `totalLines()` 200 / 2000 块 | 13.1 / 79.7ms | 16.5 / 87.1ms | 同一实现 |

净收益是切换渲染器时的 **约 33%**；退役本身没有引入回归。`totalLines()` 的两次读数差 3–8ms，该路径自 Phase 1 未改，判定为运行间浮动 —— 但要钉死它需要一次与延迟测量**分离**的独立轮次，这次没做。

---

## 门禁

- `packages/cli` `tsc -b --force` 干净
- `tui` **859 / 859** 全绿（计划阶段结果）
- Windows ConPTY PTY acceptance：`packages/cli/test/tui-pty.test.ts` **2 / 2** 通过。使用 80 列真实 `node-pty`、受控 Host 和 fake worker；分别走 allow/deny，验证一次物理 Enter 只创建一个 run、worker 收到实际决策、退出码为 0，并发出 mouse / bracketed-paste / alternate-screen 恢复序列。两条路径都先真实输入 `/rev`，再发 DEL (`0x7f`) 与 BS (`0x08`)：输出增量证明候选随 `/re`→`/r` 扩展（出现 `/rename`、`/read-file`），继续删掉 slash 后候选关闭；提交前 Host run 数保持为 0。
- `packages/cli/src/tui/__tests__/tui-completion-popup.test.ts` **14 / 14** 通过，覆盖 slash popup、键盘接受和继续输入时重新筛选；backspace/DEL 行为另由上述 PTY 字节输入验证。
- 历史 `packages/cli` **1070 / 1078** 的 8 个失败里，两个 `tui-pty` 失败来自测试把追加式 ANSI 字节流误当成当前屏幕、等待已清除的旧 composer 文本消失。改为等待 permission picker 并检查 Host run 数后，PTY 两例在当前分支通过；没有生产输入修复。剩余 6 个已知失败按 `(file, test, signature)` 与 baseline 对照仍属既有项：worker-path×3 / registry×1 / host-stop-continue×2；网络用例在沙箱中的 loopback `EACCES` 不计作产品断言结果。
- `npm run typecheck:all`：通过（Electron ratchet 无新错误）；`npm run architecture:check`：通过（0 新增违规）；`npm run bundle:verify`：通过（0/1064 worker bundle inputs changed）。
- `npm run electron:build`：本 worktree 两次都在 Vite `rendering chunks` 阶段 OOM，其中第二次已设 `NODE_OPTIONS=--max-old-space-size=6144`；Agent、CLI、Gateway bundles 在本地构建成功。另一个隔离 worktree 使用 Node v24.16.0 和相同 6144 MB heap 完整构建通过（Vite 46.54s），因此本 worktree 的 renderer build 仍需由 PR CI 验证；临时输出未纳入本次改动。
- 基准测试**刻意不做阈值断言**：阈值会把慢机器变成误报失败，改为断言不变量 + `DUYA_PERF_BASELINE=1` 输出 JSON 跨阶段对比

---

## 未完成的部分（有意留下，不是遗漏）

1. **`TUIApp` 仍 3250 行**，计划目标是 <1200。剩余部分不是「拼装」：键表与路由 397 行、chrome 绘制 496 行、调度与生命周期 380 行、选项 300 行。抽任何一块都要给约 35 个**私有**成员定义宿主接口，而把私有升成 public 来换行数是**净损失** —— 封装正是这次要保住的东西。判定：这是**职责边界**指标，需要一次独立计划先把「输入分发」和「chrome 组合」拆成各自持有状态的子系统。
2. **宽度表仍依赖 `blessed/lib/unicode.js`**（`terminal/cell-width.ts`）。它是数据表不是渲染器，保留是为了一致性：渲染器按这个数推进 cell、光标列也由它推导，换第二份表会在歧义宽度字符上让光标偏一列。彻底删依赖 = 内联约 800 行 MIT 范围表，是另一个决定。
3. **V10 部分未闭合**：Windows ConPTY 已验证全屏 composer 输入、一次 Enter、Host run、allow/deny、长工具参数换行，以及退出时终端模式恢复。仍未人工验证 inline 模式、中文 IME、真实鼠标点击/滚动、长会话与 10k block 的交互表现，也未测 tmux 和非 Windows PTY；这些不能由当前受控 Host PTY 用例替代。

## 审阅建议

按提交顺序看，每个提交都自带门禁结论。若只看三处：`f5cb040f`（Span 层与颜色词汇）、`bffffa90`（输入驱动与 Enter 去重）、`035311d7`（退役与模式序列）。
