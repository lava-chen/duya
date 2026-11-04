# Plan 448: Read/Edit 新鲜度协议与写路径一致性（harness-comparison 调研落地）

> **Status**: Phase 1 complete（2026-08-26）；2026-11-04 补 428 遗留洞 + Task E/K 落地（见「Follow-up」）；Phase 2 其余（F/G/H/I）待开工
> **Priority**: P0（Phase 1）/ P1（Phase 2）/ P2（Phase 3）
> **Created**: 2026-08-24
> **Related**: [428-harness-signal-contracts](../completed/428-harness-signal-contracts.md)（read-state/mtime 追踪的由来）、[429-harness-gap-closure](./587-agent-harness-monorepo/history/429-harness-gap-closure.md)（建议 3 快照已落地，本 plan 复用 `FileSnapshotStore`）、[docs/references/harness-comparison/read-edit-tools-deep-dive.md](../../references/harness-comparison/read-edit-tools-deep-dive.md)（五 harness 调研依据）

---

## Problem

对照 pi / openclaw / codex / hermes-agent / claude-code-haha 五个 harness 的
Read/Edit 工具实现（详见 references 调研文档），duya 的底子已经比较完整：
plan 428 落了 read-first 门 + mtime 追踪、EditTool 有三级匹配阶梯和强诊断、
mutation queue 按 realpath 串行、快照存储复用 429。

剩余缺口集中在三处（均已 grep/读码核实）：

1. **新鲜度协议只覆盖一半**：`file-read-state.ts` 只记 `(mtimeMs, size)`；
   ApplyPatchTool 改文件后不 re-anchor read-state → apply_patch 后的下一次
   edit 必然被 "File was modified after the last read" 拒绝，模型被迫重读
   刚被自己改过的文件。Write 有 recordFileRead 但没有 read-first 门。
2. **Windows mtime 误伤无豁免**：EditTool 用浮点严格相等比 mtime，且 size
   存了从没用。OneDrive/杀软/索引器碰一下 mtime 就误判 stale。cc-haha 的
   full-view + 内容指纹豁免是验证过的解法，duya 是 Windows 优先产品，
   这不是可选项。
3. **三条写路径各自为政**：CRLF/BOM 处理仅 Edit 有；原子写仅 Edit 有
   （tmp+rename）；ApplyPatch 无两阶段校验（多 hunk 中途失败可能留半套修改）。

## Non-Goals

- 不在工具层做 workspace jail —— 五家一致上移到权限层，duya 的
  `allowedRoots` + `checkPathWritePermission` 位置正确。
- 不加 `replace_all` 参数 —— pi/openclaw 血统用唯一性报错替代。
- 不做 hermes 式九级模糊匹配 —— duya 三级阶梯 + ApplyPatch context 匹配已够。
- 不改 ReadTool "无 dedup stub 保 prompt cache" 的默认行为（Phase 3 只做
  连续重复读的折中方案，且可独立放弃）。

---

## Phase 1 — read-state 升级 + P0 修复（P0，约半天）

### Task A：file-read-state 条目升级（#1/#4 的前置）

- [x] `packages/agent/src/tool/file-read-state.ts`：条目扩展为
      `{ mtimeMs, size, isFullView, contentSha? }`。
      - `recordFileRead(absPath, entry)` 增加 optional 字段，保持旧调用兼容
        （缺省 `isFullView: true`？——否：缺省应保守为 `false`，
        由 ReadTool 显式传全读标记；旧调用方 Write/Edit re-anchor 场景
        传 `isFullView: true`，因为写后即视为已知全文）。
      - ReadTool 文本路径：line_range 读 → `isFullView: false`；全量读 →
        `true` + 计算 sha-256（内容已在内存，成本可忽略）。文档解析路径
        （PDF/docx）→ `isFullView: false`。
- [x] 导出 `computeContentSha(content)` 小工具（node:crypto，同步）。
- [x] 单测：全读/范围读/re-anchor 三种录入形态的状态断言。

### Task B：EditTool 陈旧检查补强（对应调研 P0-1）

- [x] mtime 比较：浮点严格相等改为容差比较（两侧 `Math.floor(x)` 相等或
      差值 ≤ 1ms 视为未变），消除 stat 精度抖动误报。
- [x] 同时比对 `size`（已有字段，零成本信号；不一致必 stale）。
- [x] Windows mtime 误报豁免：mtime/size 判定 stale 时，若
      `isFullView && contentSha === 当前内容 sha` → 放行（cc-haha 验证的
      云同步/杀软场景解法）。
- [x] 错误信息保持现状措辞（已含 re-read 指引）。
- [x] 单测：mtime 抖动放行、外部真修改拒绝、full-view 内容一致豁免、
      partial-view 不豁免。

### Task C：ApplyPatch 成功后 re-anchor read-state（对应调研 §A）

- [x] `ApplyPatchTool.ts`：每个 op 成功落盘后对该路径
      `stat` + `recordFileRead(path, { mtimeMs, size, isFullView: true })`
      （best-effort，失败不影响结果）——Add File 同样处理。
- [x] 效果验收：apply_patch 之后紧接着对同一文件 edit，不再要求重读。
- [x] 单测：apply_patch → edit 直通；bash 外部改动 → edit 仍拒绝。

### Task D：ReadTool 全文截断的字节边界修复（对应调研 P0-3）

- [x] `ReadTool.ts` 全文读取分支：`Buffer.subarray(0, FULL_READ_MAX_BYTES)`
      会劈开 UTF-8 多字节字符。改为在字节预算内回退到最后一个完整 `\n`
      （pi truncateHead 语义）；单行超预算时才允许行内截断并在 metadata 注明。
- [x] 顺带：文本输出剥前导 BOM（U+FEFF），metadata 记录 hadBom（调研 P2-10）。
- [x] 单测：中文长文件截断尾部无替换符（U+FFFD）；带 BOM 文件读取输出。

**Phase 1 验收**：上述四组 vitest 通过 + `npm run typecheck:all` 绿。

---

## Phase 2 — 缺失防线与写路径收拢（P1，约一天）

### Task E：WriteTool read-first 门（对应调研 P1-4）

- [x] 对已存在且非空的目标文件：无 read-state 条目 → 拒绝
      （"File has not been read yet..."，含 read 工具指引）；有条目但
      mtime/size stale 且不满足 Task B 豁免 → 拒绝。
- [x] 新文件 / 空文件 / 用户显式覆盖确认路径不受限（对齐 cc-haha errorCode
      2/3 的语义：空 old_string 建新文件的等价物 = write 新文件直通）。
- [x] 写成功后维持现有 re-anchor 行为（补 `isFullView: true`）。
- [x] 单测：盲写已存在文件被拒；读过之后写直通；新文件直通。

### Task F：ApplyPatch 两阶段校验（对应调研 P1-5，hermes overlay 方案）

- [ ] 解析全部 op 后先在内存 overlay（per-path pending content /
      removed set）上模拟应用，任一 hunk context 失配 → 整体失败，
      明确报 "no files were modified"。
- [ ] 全部通过后才逐文件落盘；落盘阶段失败如实告知可能的不一致状态
      （hermes 措辞："state may be inconsistent — run git diff"）。
- [ ] 与 Task C 协同：只有真实落盘的文件才 re-anchor。
- [ ] 单测：第二个 hunk 失配时第一个文件未被写；全成功路径不变。

### Task G：edit 输入垫片（对应调研 P1-6，openclaw prepareEditArguments）

- [ ] `validateEditInput`：接受 `edits` 为 JSON 字符串（parse 失败再报错）；
      剥离模型私加的元数据键（白名单外键忽略而非拒错）。
- [ ] 单测：JSON 字符串形态、带多余 `reason` 键的 edit 对象。

### Task H：共享 text-file-style helper（整体策略 C 的最小切片）

- [ ] 抽 `packages/agent/src/tool/text-file-style.ts`：
      `detectStyle(content) -> { hasCRLF, hasBOM }` +
      `restoreStyle(result, style)`。Edit 先迁移，Write/ApplyPatch 落盘前
      也走 restore（当前两者直写模型 LF，会静默把 CRLF 文件改成混合换行）。
- [ ] Edit 的原子写抽成 `atomicWriteFile(path, content)`（tmp+rename），
      Write 迁移；ApplyPatch 多文件写入同样收敛。
- [ ] 单测沿用 Edit 现有 EOL/BOM 用例 + 新增 Write 写 CRLF 文件保风格用例。

### Task I：rename 失败回读契约（对应调研 P1-7，openclaw didEditLikelyApply）

- [ ] Edit/Write 的 catch 分支：写失败时回读目标文件，若内容与期望结果
      一致 → 报成功（附 note 说明回读确认），否则按原错误返回。
- [ ] 单测：mock rename 抛错 + 内容实际已写入 → 成功路径。

**Phase 2 验收**：vitest 全绿 + `npm run typecheck:all` + 手动会话冒烟
（apply_patch → edit 连招、CRLF 仓库往返编辑）。

---

## Phase 3 — 体验增强（P2，择机，各项独立可砍）

### Task J：连续重复读取 stub（折中方案）

- [ ] file-read-state 增加 per-file 连续相同读取计数；同一
      `(path, line_range)` 第 2 次读取且 mtime 未变 → 返回
      FILE_UNCHANGED_STUB（"refer to that instead of re-reading"），
      第 3+ 次升级为硬错误（hermes 惩罚模型）。首次照常返回保 prompt cache。
- [ ] 可配置关闭（config.toml `[tools].read_dedup = false` 默认关？——
      实现时定夺，倾向默认开但 killswitch 必须有）。
- [ ] 单测：首读正常 / 二读 stub / 三读 BLOCKED / mtime 变后重置。

### Task K：not-found 诊断附现场

- [x] Edit 的 `buildNotFoundDiagnostic` 末尾追加当前文件相关片段
      （closest match 行 ±5 行，≤800 字符，UTF-16 安全截断）——模型零
      往返自愈（openclaw 内容附录方案）。
- [x] 单测：诊断包含片段且不超长。

---

## Testing（汇总）

- [ ] 各 Task 内列出的 vitest 用例（新增/扩充
      `packages/agent/src/tool/__tests__/`、`EditTool/__tests__/`、
      `ReadTool/__tests__/`）。
- [ ] 回归：现有 EditTool.test.ts（320 行）必须全绿——Task B 改变陈旧判定
      语义，注意既有 "modified after read" 用例需同步更新预期。
- [ ] `npm run typecheck:all` 提交前必跑。
- [ ] Phase 2 结束做一次 Electron renderer 手动冒烟（browser-only Vite 无法
      验证 preload 链路；本 plan 不涉 UI，ChatView 工具行展示即可）。

## 排期逻辑

```
Task A（结构前置）→ Task B/C/D（P0 收口，A/B 有依赖，C/D 可并行）
→ Phase 2（E 依赖 A；F/I 独立；G/H 独立）
→ Phase 3（J/K 完全独立，可随任意 plan 搭车）
```

Phase 1 四个 task 合计约半天；Phase 2 约一天；Phase 3 择机。

---

## Follow-up 2026-11-04：read-first 门的三个真实缺陷

起因是一次设计复核（"是否该删掉这个门、向 codex 靠拢"）。结论是不删：codex 不是
没有读的要求，而是把要求内嵌进了补丁协议（hunk context 只能由看过内容的人写出），
删门只会把可诊断失败降级成 `old_string not found`。但复核暴露了三处实现缺陷。

### 1. compaction 之后门失效（428 的原始 bug 仍可复现）

`clearFileReadState()` 此前在生产代码里零调用点。summary compaction 会把旧 read
结果整段替换成摘要，而 read-state 条目仍在，于是门放行"读过但上下文里已经没有原文"
的编辑——正是 428 要拦的场景。同时确认：`compressProjectedToolMessages`（offload
投影压缩）在 agent-runtime 里**没有任何生产调用点**，428 当年观察到的占位符来自
legacy 链路，所以真正的失效面是 summary compaction，不是 offload。

- `CompactionManager.compact()` 成功后 `clearFileReadState()`
  （`onCompactionSuccess()` 之前，与 `ledger.beginEpoch('compaction')` 同处）。
- 不 re-anchor reinjected 文件：reinject 是 2000-token 预算内的片段，不是全文，
  给不了 full-view sha 豁免，按既有"partial view 不免责"原则一律要求重读。

### 2. 状态没有 session 边界

`readStates` 是模块级 Map，worker 进程复用时会继承上一个 session 的条目。新增
`beginFileReadSession(sessionId)`：key 变化才清空，同 session 重复调用是空操作；
在 `createWorkerSessionFactory` 里绑定。子会话（`createChildSession`）刻意不走这里
——子会话共享父时间线，每次 spawn 都清空会逼父会话重读整个工作集。

### 3. 写路径三套判定

抽出 `evaluateReadFreshness(absPath, current, content)` 作为唯一判据（`fresh` /
`never-read` / `stale`），`edit` 与 `write` 共用，`isMtimeWithinTolerance` 一并搬进
`file-read-state.ts`。`WriteTool` 从此有了 Task E 的门；`ApplyPatchTool` **不加门**，
理由写进该文件头注释：补丁协议本身要求真实上下文，加门只会多一次往返。

### 4. killswitch

`[tools] read_first_gate` / `DUYA_TOOLS_READ_FIRST_GATE`（默认 true，经
`readToolExposureConfig()` 在 session 工厂注入）。只关"从未读过"的硬门；**stale
永远不关**——那是数据一致性检查，关掉会让陈旧 `old_string` 静默覆盖别人的改动。

### 改动清单

| 文件 | 改动 |
| --- | --- |
| `packages/capabilities/src/file-read-state.ts` | `evaluateReadFreshness`、`beginFileReadSession`、gate 开关、`isMtimeWithinTolerance` 迁入 |
| `packages/capabilities/src/EditTool/EditTool.ts` | 门改用统一判据；not-found 附 ±5 行片段（≤800 字符，UTF-16 安全） |
| `packages/capabilities/src/WriteTool/WriteTool.ts` | Task E 门（新文件/空文件直通） |
| `packages/capabilities/src/ApplyPatchTool/ApplyPatchTool.ts` | 只加设计定案注释 |
| `packages/capabilities/src/index.ts` | 导出新 API |
| `packages/agent-runtime/src/context/compact/CompactionManager.ts` | compaction 成功后清空 read-state |
| `packages/host/src/worker-config/tool-exposure.ts` | `readFirstGate` 配置项 + env |
| `packages/host/src/worker-tools/assembly.ts` | session 工厂绑定 gate 与 session key |

### 验证

worktree `.claude/worktrees/edit-read-gate`，分支 `codex/edit-read-gate-fixes`，
base `7ef8cbd0`。命令与结果：

- `node node_modules/vitest/vitest.mjs run packages/capabilities/tests/EditTool.test.ts packages/capabilities/tests/ApplyPatchTool.test.ts` -> 46 passed
- `... fileReadState.gate.test.ts WriteTool.read-first.test.ts` -> 17 passed（新增）
- `... EditTool.diagnostic.test.ts` -> 3 passed（新增）
- `... CompactionManager.compaction-epoch.test.ts tool-exposure.test.ts` -> 15 passed
- `npm run typecheck:all` -> exit 0
- `npm run architecture:check` -> no new boundary violations
- PR: [#616](https://github.com/lava-chen/duya/pull/616)

初次全量跑 capabilities 时有 1 个失败：`file-diff-metadata.test.ts` 覆盖已存在
文件但没有先读——正是新 `write` 门在起作用；该用例已补上 read anchor。

### 遗留（2026-11-04 已全部结清，见下节）

- 父子会话仍共享 `readStates`：子 agent 读过的文件会让父会话的 edit 通过（误放，
  安全侧但不等价于"父自己也读过"）。彻底修需要工具调用携带 session identity，
  超出本切片。
- `compressProjectedToolMessages` 仍是未接线状态。若之后把它接进请求组装，需要在
  投影压缩后对 offload 掉的 read 路径 `invalidateFileRead`——否则会出现"投影里是
  占位符、账本说读过"的新一轮错配。

## Phase 4：账本按会话来分（2026-11-04）

### 1. 父子会话不再共享账本

`file-read-state.ts` 从"一个全局 Map"改为"按 session 分桶的 Map"。scope 由
`readScopeFromContext(context)` 统一派生（`ToolUseContext.options.sessionId`），
四个读写路径（read/write/edit/apply_patch）都必须走这一个函数：它们各自内联派生
会让同一 agent 刚读过的文件被自己的 edit 判成 never-read，比门关着更糟。

链路已核实打通：子会话 `WorkerSession.sessionId`（`service.ts` 里
`crypto.randomUUID()`）→ `TurnAssembler` 写入 `turnContext.sessionId` →
`buildTurnPipeline` 写入 `ToolUseContext.options.sessionId` → 工具。因此父/子天然
落在不同桶，不需要 AsyncLocalStorage（异步生成器跨越 `next()` 时上下文不可靠）。

- 无 scope 的调用落到"当前活跃会话"桶，覆盖测试与 legacy 无 context 调用。
- `beginFileReadSession(id)` 会**清掉其它所有桶**：顶层新会话不继承任何东西，同时
  给长驻 worker 进程的内存封顶。子会话不调用它（否则每次 spawn 清空父账本）。
- `clearFileReadState(scope)` 带 scope 只清一个桶；不带 scope 清全部。summary
  compaction 走不带 scope 的那种——过度失效只是多一次读，失效不足就是 428 的错改。

### 2. 投影压缩子系统已删除

原"遗留"第二条要求"以后接线时必须 invalidate"。核查后改为删除，依据：

- `compressProjectedToolMessages` 在生产路径零调用点；`git log -S` 显示最后一次
  删掉的调用点全在 `packages/agent` 的测试里（`7c62d533`），Host 迁移
  （`8f7f5032`）没有把它接回来。
- 五个变换（shared/offload/reformat/micro/imageTruncation）只能经由该 fold 到达，
  即整个子系统的唯一消费者是它自己的单测。
- 真实会话日志里 "truncated by projection-compress" 占位符出现 0 次。

删除范围：agent-runtime 的 6 个源文件 + agent 包的 6 个兼容 re-export + 5 个单测文件；
`compact/index.ts` 两处导出改为说明性注释；`port-guards.ts` 里引用
`projectionCompress.ts:44-48` 的等价性论证改为"该 pass 已随 legacy 组装退役，
结论 a fortiori 成立"。`noteProjectionShrink` 保留但注明"当前无人 arm"——读者
（`wasLastObservationPostShrink`）仍在生产路径上，且默认 false 本身是正确的。

若确实想要"旧工具结果压缩成占位符"省 token，那是一个独立计划：它会改变每个请求的
字节，必须单独验证 cache 命中与恢复路径，不能夹在门禁修复里。

### 3. 验证补充

- `... packages/capabilities/tests` -> 357 passed / 2 skipped
- `... fileReadState.gate.test.ts WriteTool.read-first.test.ts` -> 25 passed（新增 8 个分桶用例）
- `... packages/agent-runtime/test/context packages/host/tests/runtime-context-contracts` -> 205 passed
- `npm run check:encoding` / `npm run check:test-coverage` -> OK
- `node scripts/architecture/architecture-check.mjs` -> no new boundary violations
- `docs/development/test-inventory.{json,md}` 手工扣掉删除的 5 个测试文件与其
  22 个 case / 37 个断言（脚本 `--write` 需要 vitest json 报告，否则会丢测量值）

