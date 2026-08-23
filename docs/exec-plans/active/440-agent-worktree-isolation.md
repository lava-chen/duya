# 440 — Agent Worktree Isolation（子代理 worktree 隔离）

> 状态：实现中（Phase 1-2 本次落地）
> 优先级：P1
> 定位：让 SubagentTool 的 `isolation: 'worktree'` 从"schema 已声明、execute 未实现"
> 变成真正可用的并行写隔离能力（对齐 Claude Code Agent tool 同名参数的行为契约）。
> 关联：plan 415 workflow 节点级 `isolation?: 'worktree'` 直接复用本模块；
> plan 87 已预留 `WorktreeCreate` / `WorktreeRemove` hook 事件名，后续接线。

---

## 1. 背景与对齐研究

Claude Code 的 worktree 机制有六个值得照抄的设计点：

1. **双层控制 + 硬 gate**：普通会话 opt-in；后台/并行场景强制隔离，
   强制由工具执行层拒绝共享区写入保障（duya 对应物为 allowedRoots 沙箱）。
2. **三档粒度**：主会话级（显式工具）/ subagent 级（调用参数）/ 编排级（workflow 节点参数）。
3. **成本显式化**：文档写明隔离代价（setup 时间 + 磁盘），唯一正当理由是
   "多个 agent 并行改文件会冲突"。没有这条引导模型会滥用隔离。
4. **unchanged 自动回收**：零改动的 worktree 自动删除，消灭大部分垃圾。
5. **退出保护**：remove 遇脏状态拒绝，丢弃需显式确认。
6. **git 红线独立成段**：不碰 main / 不 force-push / 不 merge 是全局策略，
   与 worktree 功能正交。

## 2. 已定决策

| 决策点 | 结论 |
|--------|------|
| worktree 存放位置 | `<repoRoot>/.duya/worktrees/<name>`；自动把 `.duya/worktrees/` 追加进 `.git/info/exclude`（本地忽略，不改用户 .gitignore） |
| base ref | 默认 `'fresh'`（origin 默认分支 → origin/main → origin/master → 本地 main/master → HEAD 兜底）；`'head'` = 当前 HEAD |
| 分支命名 | `duya-worktree/<name>`；已存在则 `-2`、`-3` 后缀；路径冲突同样自动后缀（并行同名 spawn 是预期场景） |
| 名称约束 | `[A-Za-z0-9._-]`，≤64 字符；非法字符替换为 `-`；空则随机 |
| 创建失败语义 | **显式报错**，不静默降级 —— 模型主动要求隔离就是为了避免并行写冲突，降级等于骗它 |
| 自动回收判据 | `git status --porcelain` 非空 = dirty（含 untracked）；跑完 clean → 删树+删分支 |
| 后台子代理 | 复用 BackgroundAgentLifecycle 终态回调做同样的 dirty 检查与回收 |

## 3. 架构

```
packages/agent/src/worktree/
  worktree-manager.ts        # 纯 git 编排：create / dirty / cleanup，GitRunner 可注入
  __tests__/worktree-manager.test.ts   # 真实临时 git 仓库集成测试
```

SubagentTool 接线（不新增工具）：
- `input.isolation === 'worktree'` 时，在 DB session 创建前建树；
- 克隆 ToolUseContext，`options.workingDirectory` 替换为 worktree 路径
  （runAgent.ts:147 已消费该字段 → 子代理全部文件/Bash 工具落在树内）；
- 同步路径：runAgentSync 结束后 dirty 检查 → 零改动自动回收；
- 后台路径：`.finally()` 里做同样检查；
- 结果 JSON 增加 `worktree: { path, branch, kept, cleaned }` 字段。

## 4. Phases

### Phase 1 — WorktreeManager 地基 ✅

- [x] `createAgentWorktree({ repoDir, name?, baseRef? })` → `{ path, branch, baseCommit, name }`
- [x] 命名清洗 / 冲突自动后缀 / 分支冲突后缀
- [x] fresh base 解析链（symbolic-ref → 候选列表 → HEAD 兜底）
- [x] `.git/info/exclude` 幂等追加
- [x] `isAgentWorktreeDirty(path)`
- [x] `cleanupIfUnchanged(handle)` → `{ removed, reason? }`
- [x] GitRunner 注入点（默认 execFile('git')）
- [x] 单测：真实 tmpdir 仓库 ×8 场景

### Phase 2 — SubagentTool 接线 ✅

- [x] 读入 `isolation`，建树失败显式 error result
- [x] context 克隆替换 workingDirectory（session working_directory 同步落树内路径）
- [x] 同步/后台两条路径的回收逻辑
- [x] spawn notice 与终态结果携带 worktree 信息
- [x] schema description 补充成本提示（仅并行写冲突时使用）

### Phase 3 — 后续（未排期）

- [ ] plan 415 Workflow node-runner 复用 `createAgentWorktree`
- [ ] plan 87 `WorktreeCreate` / `WorktreeRemove` hook 触发
- [ ] 主会话级 EnterWorktree 式工具（UI 有诉求再做）

## 5. 测试矩阵

| 组 | 用例 |
|----|------|
| create | 正常建树 + 新分支；head/fresh 两 base；fresh 无 remote 兜底 HEAD |
| naming | 非法字符清洗；空名随机合法；同名路径 -2 后缀；同名分支 -2 后缀 |
| exclude | 首次写入；重复幂等 |
| dirty | 干净树 false；改文件 true；untracked 文件 true |
| cleanup | clean → removed 且分支已删；dirty → kept + reason |
| 边界 | 非 repo 目录 reject；worktree 内再建树（嵌套）行为明确报错或基于外层 root |

## 6. 开放问题

1. 回收时机是否需要宽限期（后台 agent 完成后用户可能想看树）？当前策略：
   只回收零改动树，dirty 树永远保留并在结果中报告路径，无需宽限。
2. Windows 长路径 / 中文仓库名：execFile 数组传参无 shell 注入面，
   路径长度风险低；如遇问题在 runner 层加 `core.longpaths` 处理。
