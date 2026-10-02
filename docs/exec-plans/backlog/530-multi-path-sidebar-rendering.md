# Plan 530 — 多路径 Project 在侧栏文件树中的渲染策略

> **Status**: Draft · **Priority**: P2 · **Created**: 2026-09-13
> **Trigger**: 用户在 plan 525（Project 实体建模）落地后指出"现在 `projects.paths` 支持多路径，侧栏文件树该怎么显示是另一个问题"。
> **Out of scope alignment**: plan 525 §1.3 / §9 明确"UI 任何形式 — 用户指示暂不做"。本 plan **不修改 plan 525**，而是另立一份"启用 UI 时"的渲染策略文档，等用户决定启用 FileTreePanel 多路径渲染时再推进。

---

## 1. 背景与目标

### 1.1 触发原因

plan 525 把 `projects` 表升级为带 `paths: JSON` 列的实体，单个 project 可绑定多条文件系统路径：

```json
[
  { "path": "E:/Projects/duya",            "description": "duya 主仓库" },
  { "path": "E:/Projects/duya-website",    "description": "用户向官网" },
  { "path": "E:/Projects/duya-marketplace", "description": "插件市场" },
  { "path": "E:/Papers/duya-research",     "description": "研究笔记" }
]
```

侧栏文件树组件（`src/components/layout/panels/FileTreePanel.tsx`，registry 里 `pageId: 'files'`）**当前只能渲染一条路径**（通过 `useConversationStore` 里的 `workingDirectory`）。多路径后必须重新设计。

### 1.2 设计原则（已与用户对齐，2026-09-13）

| 维度 | 决策 |
|---|---|
| **顶层节点** | 每个 `paths[i]` 是一个顶层 repo 节点，按 `basename(path)` 命名（如 `duya`、`duya-website`） |
| **路径冲突** | 祖孙路径时**保留祖先，子路径丢弃**（"显示最大的"） |
| **加载时机** | 按需懒加载：每个 repo 节点初始不展开，点击才调 IPC 拉子目录 |
| **单路径 project** | 不显示 repo 包装层，直接以目录树呈现（避免视觉冗余） |
| **项目头** | 侧栏顶部固定显示 `project.name`（plan 525 新增字段），不显示每条 path 的 description |

### 1.3 与现有架构的边界

| 已有部件 | 本 plan 是否动 |
|---|---|
| `src/components/file-tree/FileTree.tsx`（节点树递归组件） | **不重写**，直接复用 `FileTreeNode` / `FileTree` / `RenderTreeNodes` |
| `src/components/layout/panels/registry.ts` 里的 `FileTreePanel` 注册项 | **不动**（pageId 仍是 `files`） |
| `electron/ipc/*.ts` 现有 fs 列举 IPC（`fs:list-children` 等） | **复用**，按 repo 节点 path 调用即可 |
| `useConversationStore.workingDirectory` | **补充**：保留单值兜底，多路径时取 `paths[0].path` 作为默认 cwd |
| `projects` 表的 `paths` JSON 列 | **数据源**，只读 |
| `CodeReviewPanel` 的 `code-review-file-tree`（改动文件扁平列表） | **完全独立**，与本 plan 无关 |
| `FilePreviewPanel`（点开文件后展示内容） | **不在本 plan 范围**，独立 plan |

---

## 2. 顶层结构

### 2.1 单路径 project（最常见）

```
侧栏（FileTreePanel）
└─ 项目头
   └─ 文件树根（src/、docs/、electron/、packages/...）
```

无 repo 包装层。视觉上与现状**完全一致**，避免给单路径用户带来回归感。

### 2.2 多路径 project

```
侧栏（FileTreePanel）
├─ 项目头（duya）
├─ ▸ duya                 ← paths[0]
│   ├─ ▸ src/
│   ├─ ▸ docs/
│   ├─ ▸ electron/
│   └─ ▸ packages/
├─ ▸ duya-website         ← paths[1]
│   └─ …
├─ ▸ duya-marketplace     ← paths[2]
│   └─ …
└─ ▸ Papers-research      ← paths[3]
    └─ …
```

- 顶层每个 repo 节点 **未展开** 时只渲染折叠箭头 + 名字 + 小图标（仓库 / 红色挂载点 / 文件图标，区分见 §4）
- 节点类型扩展：现有 `FileTreeNode` 只支持 `path / name / children?`，本 plan 引入新字段 `kind: 'repo' | 'directory' | 'file'`（不破坏现有类型，向后兼容）
- repo 节点 `kind: 'repo'`，`children` 由 IPC 异步填充

### 2.3 与 worktree 的关系（plan 496 占位）

plan 496 规划了主会话 `EnterWorktreeTool` / `ExitWorktreeTool`，路径规范未决（`.duya/worktrees/` vs `E:/Projects/duya-wt/`）。

**本 plan 不依赖 worktree**。多 path 仅基于文件系统层"该 project 挂载了哪些目录"渲染。worktree 切换属于会话级事件，由单独 plan 接入到 sidebar 顶部（不在本 plan 范围）。当 plan 496 落地后另起 plan 文档描述两者集成。

---

## 3. 重叠与嵌套处理

### 3.1 规则：保留最长祖先

```ts
// src/lib/projectPaths.ts（新文件，纯函数，可单测）
export function dedupeByContainment(paths: string[]): string[] {
  const sorted = [...paths].sort((a, b) => b.length - a.length); // 长路径在前
  const kept: string[] = [];
  for (const candidate of sorted) {
    const isContained = kept.some((ancestor) => isPathInside(candidate, ancestor));
    if (!isContained) kept.push(candidate);
  }
  return kept.sort(); // 显示按字母序
}

function isPathInside(child: string, parent: string): boolean {
  // 跨平台路径包含判断,Windows 不区分大小写,POSIX 区分
  // 真实实现见下方 §3.3 边界条件
}
```

### 3.2 去重后的视觉

**输入**：
```json
[
  { "path": "E:/Projects/duya" },
  { "path": "E:/Projects/duya/docs" },
  { "path": "E:/Projects/duya/docs/exec-plans" },
  { "path": "E:/Projects/duya-website" }
]
```

**去重结果**：
```json
[
  "E:/Projects/duya",
  "E:/Projects/duya-website"
]
```

**侧栏显示**：
```
├─ ▸ duya
└─ ▸ duya-website
```

### 3.3 边界条件（覆盖"各种情况"）

| 场景 | 行为 |
|---|---|
| `paths` 为空 | 侧栏显示"该 project 没有挂载任何路径，请编辑 `~/.duya/projects/<id>/project.json`"（占位文案，禁用 `paths[]` 编辑 UI，按 plan 525 §1.3） |
| 只有一个 path | 无 repo 包装层，扁平呈现 |
| path 指向不存在的目录 | repo 节点灰显 + 红色 error 图标 + tooltip 显示 stat 错误；点击展开时 toast 提示 |
| path 指向文件而非目录 | repo 节点灰显 + tooltip "不是一个目录"；不允许展开（叶子节点语义） |
| path 间祖孙关系 | 保留祖先，丢弃子路径（§3.2） |
| path 间完全独立（互不嵌套） | 全部保留，按字母序 |
| 同一目录重复（两条 path 指向相同 absolute path） | 保留第一条（按 plan 525 `paths[]` 顺序），其余丢弃，**不**给用户报错 |
| Windows 盘符大小写（`e:/Projects/duya` vs `E:/Projects/duya`） | 视作同一路径（Windows 不区分大小写） |
| POSIX 大小写敏感（`/home/user/a` vs `/home/user/A`） | 视作不同路径（POSIX 区分） |
| path 含尾随分隔符（`E:/Projects/duya/`） | 规范化时去除 |
| path 是 UNC / 网络盘（`\\nas\repo`） | 支持正常显示，加载状态可能慢；按 lazy 加载语义不阻塞 UI |
| path 是 symlink / junction | 不做特殊处理，按 stat 结果展示；symlink 环由现有 fs 遍历组件自带的循环检测处理（不在本 plan 范围） |
| path 不存在但用户中途创建 | repo 节点刷新（订阅 fs watch 或下次 sidebar 进入时重 stat）—— 本 plan Phase 3 决定 |
| 用户修改 `projects.paths` JSON 后 | 侧栏订阅 `projects` 表变更，重新去重 + 渲染（plan 525 Phase 2 已规划 `registerProject` 读写 `projects.paths`） |

### 3.4 不在本 plan 范围

- 路径编辑 UI（plan 525 §1.3 明确不做 `manage_project` 工具 / UI）
- `canonical_root` 与 `paths[0]` 的语义边界（plan 525 §7 已决定 `canonical_root` 沿用 NOT NULL，新 project 通过 `paths[0].path` 派生，本 plan 不引入额外字段）

---

## 4. 按需懒加载

### 4.1 数据流

```
用户点击 ▸ duya
   ↓
FileTreePanel 检测 kind === 'repo'
   ↓
调 IPC: fs:list-children({ path: "E:/Projects/duya" })
   ↓
渲染前: 折叠箭头变 spinner
   ↓
拿到结果后:
   ├─ 成功 → 折叠箭头变 ▾ + 渲染 FileTreeFolder / FileTreeFile 子节点
   ├─ 部分失败（权限拒绝）→ 折叠箭头变红 + toast 提示
   └─ 全部失败 → repo 节点保持 ▸ 状态 + tooltip 错误
```

### 4.2 复用现有 IPC

`electron/ipc/__tests__/` 与现有 fs 列举 IPC 已有 `fs:list-children`（沿用）。**不**新增 IPC 通道，repo 节点和普通目录节点共享同一调用。

如检索发现现有 IPC 不存在或命名不符，**先在 plan 526 / 527 / 528 中找类似实现**，不要拍脑袋新建 IPC。

### 4.3 缓存策略

- 已展开的 repo 节点缓存在 React state，**不主动失效**
- 用户显式刷新按钮（FileTreePanel 顶部已有 `ArrowsClockwiseIcon`）时，清空缓存重新拉取
- 用户切换 project 时，整棵 tree 销毁重建（不跨 project 缓存）
- fs watch：plan 530 落地初期**不接入** fs watch；用户自己点刷新。后续独立 plan 引入

---

## 5. 与 `FileTreePanel` 的集成点

### 5.1 当前形态（master HEAD 引用）

```tsx
// src/components/layout/panels/FileTreePanel.tsx
function FileTreePanel({ tab, embedded }: { tab: PageTab; embedded: boolean }) {
  // ... 使用 useConversationStore.workingDirectory 作为唯一根
}
```

### 5.2 改造后形态（计划）

```tsx
function FileTreePanel({ tab, embedded }: { tab: PageTab; embedded: boolean }) {
  const projectId = useActiveProjectId(); // 新 hook,见 §5.3
  const project = useProject(projectId);  // 新 hook,从 store / IPC 拿 project row
  const paths = useMemo(() => 
    project ? dedupeByContainment(project.paths.map(p => p.path)) : []
  , [project]);
  
  if (paths.length === 0) return <EmptyState />;
  if (paths.length === 1) return <SingleTree rootPath={paths[0]} />;
  return <MultiTree repos={paths.map(toRepoNode)} />; // 顶层 repo 节点 + 子懒加载
}
```

- `useActiveProjectId` 与 `useProject` 是新 hook，在本 plan Phase 1 落 stub，Phase 2 接真实数据源
- `SingleTree` 是把现有渲染路径包一层（基本不动）
- `MultiTree` 是新增组件，负责顶层 repo 节点 + 按需 IPC 拉子节点

### 5.3 数据源

- **首选**：`projects` 表（plan 525 升级后）→ IPC `projects:get(id)` → 直接读 `paths` JSON
- **过渡态**：plan 525 Phase 2 未完成时，`projects.paths` 可能是空数组；此时侧栏 fallback 到 `useConversationStore.workingDirectory`（单路径，行为与现状一致）
- **不引入新 IPC**：只新增 renderer 端的 hook + 纯函数 `dedupeByContainment`

### 5.4 不动的部分

- `FileTree.tsx`：`FileTreeNode` 类型扩展 `kind` 字段但向后兼容；`FileTreeFolder` / `FileTreeFile` 不变
- `registry.ts`：`files` 注册项不变（`multiInstance: true` / `minWidth: 300` / `preferredWidth: 320`）
- `CodeReviewPanel` 与 `code-review-file-tree` 完全独立
- `PanelZone` 的多 panel 并存逻辑不变

---

## 6. Phases

### Phase 1 — 纯函数 + 单测（无 UI）

- [ ] 1.1 新文件 `src/lib/projectPaths.ts`：
  - `dedupeByContainment(paths: string[]): string[]`
  - `isPathInside(child: string, parent: string): boolean`（跨平台、Windows case-insensitive、POSIX case-sensitive）
  - `normalizePath(path: string): string`（去尾随分隔符、POSIX → POSIX、Win → Win）
- [ ] 1.2 单测 `src/lib/__tests__/projectPaths.test.ts`：
  - 祖孙路径 → 留祖先
  - 兄弟路径 → 全部保留，字母序
  - 完全重复 → 留第一条
  - 空数组 → 返回空
  - 单元素 → 原样返回
  - Windows 大小写折叠 / POSIX 大小写敏感
  - 尾随分隔符不影响
- [ ] 1.3 提交 `test(lib): add dedupeByContainment with cross-platform path rules`

### Phase 2 — 数据接入（仍无 UI 改动）

- [ ] 2.1 新 hook `src/hooks/useActiveProjectId.ts`：从 session / conversation store 拿当前 project_id（plan 525 Phase 2 完成后才能写，依赖 `registerProject` 切换到 `projects.paths`）
- [ ] 2.2 新 hook `src/hooks/useProject.ts`：
  - 内部用 `useEffect` + IPC `projects:get(id)` 拉 project row
  - 缓存到 `useProjectsStore`（zustand store，新文件）
  - 监听 `projects` 表变更（plan 525 Phase 2 提到的订阅机制）刷新缓存
- [ ] 2.3 `useProjectsStore`：纯 zustand store，记录 `Record<projectId, Project>`；不持久化（每次会话重启重新拉）
- [ ] 2.4 单测：`src/hooks/__tests__/useProject.test.ts` 模拟 IPC 返回，验证 JSON 损坏降级空数组（plan 525 §2.4 已要求）

### Phase 3 — FileTreePanel 改造（UI 落地）

- [ ] 3.1 `FileTreePanel.tsx` 拆分为 `FileTreePanel`（顶层判断）+ `SingleTree`（现状不动）+ `MultiTree`（新增）
- [ ] 3.2 新增 `MultiTree.tsx`：渲染顶层 repo 节点 + 折叠展开 + 调 `fs:list-children`
- [ ] 3.3 `FileTreeNode` 类型扩展 `kind: 'repo' | 'directory' | 'file'`，`directory`/`file` 现有数据视为 `'directory'`/`'file'`，向后兼容
- [ ] 3.4 错误态：repo 节点路径不存在 / 不是目录 / IPC 失败的视觉与交互（按 §4.1）
- [ ] 3.5 空态：`paths = []` 显示"该 project 没有挂载任何路径"占位（不写文档引导用户编辑 JSON，按 plan 525 §1.3 决定）
- [ ] 3.6 单测：
  - `MultiTree.test.tsx`：repo 节点渲染 / 展开调 IPC / 失败态 / 缓存
  - `FileTreePanel.test.tsx` 更新：单路径 vs 多路径分支、空态、单路径 fallback
- [ ] 3.7 Playwright 验证（`npm run test:e2e:smoke`）：开 dev server，模拟多路径 project，截图

### Phase 4 — 文档 + 完成判据

- [ ] 4.1 `ARCHITECTURE.md` 增加 "Project paths 多路径渲染" 一节，简述 §1.2 / §3.1 / §4.1 数据流
- [ ] 4.2 `AGENTS.md` 不动（本 plan 与 AGENTS.md 总纲无关；只在 §Map 提一句"FileTreePanel 行为由 plan 530 控制"）
- [ ] 4.3 dogfood：用 duya 自身 project（`e4e2b217`，plan 525 Phase 3.5 已建骨架）走通单路径 → 多路径 → 重叠去重三个 case
- [ ] 4.4 完成判据勾完，移到 `docs/exec-plans/completed/`，更新 `docs/exec-plans/README.md`

---

## 7. 风险与开放问题

| 项 | 风险 / 决策点 | 处置 |
|---|---|---|
| **plan 525 Phase 2 未完成时落地本 plan** | `projects.paths` 仍可能是空，侧栏会 fallback 到 `workingDirectory`，多路径能力不显现 | Phase 1 / 2 可独立推进（纯函数 + 数据 hook），Phase 3 强依赖 plan 525 Phase 2 |
| **plan 496 worktree 集成** | worktree 路径规范未定，sidebar 顶部是否加 worktree 切换器未定 | 本 plan 不动 worktree 区域；plan 496 落地后另起 plan |
| **路径去重的可逆性** | 用户给 `paths = [a, b]` 其中 a 是 b 的父，去重后剩 a；如果用户**确实**想让 b 作为独立根显示，会发现消失 | 在 §3.2 例子旁加注释：本规则下"显示最大的"，需要独立显示子路径时请用更具体的命名 |
| **`description` 字段何时用** | plan 525 §2.4 `description` 可为 NULL，UI 是否在 repo 节点显示 description tooltip | Phase 3 决定：暂不显示（侧栏宽度 320px 放不下），后续需要时在 `MultiTree` 节点 hover 时 tooltip 弹 |
| **多路径项目路径巨多（>10）** | 侧栏顶部 repo 列表会变长，超出可视区域需要滚动 | 侧栏原生支持滚动，不需额外设计 |
| **`fs:list-children` 在网络盘慢响应** | 折叠箭头长时间显示 spinner，用户误以为卡死 | Phase 3 加 timeout（5s）+ 失败提示；与现有 IPC 错误处理一致 |

---

## 8. 完成判据

- [ ] Phase 1 纯函数 `dedupeByContainment` 单测通过，覆盖 §3.3 所有边界条件
- [ ] Phase 2 `useProject` hook 接 IPC `projects:get`，JSON 损坏降级空数组
- [ ] Phase 3 FileTreePanel 多路径渲染落地，Playwright 验证三种 case：
  - 单路径 → 无 repo 包装层
  - 多路径独立 → 顶层 N 个 repo
  - 多路径祖孙 → 只显示祖先
- [ ] Phase 4 文档完成，dogfood 通过，移入 `completed/`

---

## 9. Out of scope（明确延后）

- ❌ **路径编辑 UI** — plan 525 §1.3 明确不做
- ❌ **worktree 切换器集成** — 独立 plan（依赖 plan 496）
- ❌ **`description` 在 repo 节点显示** — 暂不需要，后续 plan
- ❌ **fs watch 自动刷新** — 暂不需要，后续 plan
- ❌ **多路径统一搜索**（跨 repo grep） — 暂不需要
- ❌ **`CodeReviewPanel` 改动文件列表** — 与本 plan 无关
- ❌ **文件点开后的编辑器（`FilePreviewPanel` 集成）** — 独立 plan
- ❌ **`manage_project` 工具** — plan 525 §1.3 明确不做
- ❌ **path 冲突检测 UI** — 用户手动管理 paths，命令/JSON 编辑自负