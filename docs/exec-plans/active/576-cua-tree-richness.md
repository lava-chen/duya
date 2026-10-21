# Plan 576 — Windows CUA 树信息丰富度（depth 层级 + 静态文本 + 容器采样）

> **Status**: Phase 1+2 已落地未提交（2026-09-29，ps1 真机冒烟 PASS：duya 自身窗口 98 元素 / depth 最大 13 / 16 label / 62 description / Document 在列；contract 34 测 + protocol 18 测 + cua-service + som + OSTool 全绿；typecheck:all exit=0）
> **Priority**: P1
> **定位**: plan 575 §0 评审认定的**最大差距**（差距：大）——两边读的是同一棵 UIA 树，差在上游
> probe 提供什么。本计划把 probe 从「平铺交互元素表」升级为「有层级、有标签、有容器语义的树」。
> 涉及 ps1 C# walk 改动 + 契约 + normalize/format/diff 连锁，**必须独立执行、独立验证**。
> **上游**: 575（CUA 面 + 状态位已就绪）、562（enumerate 管线）、564（invoke 缓存槽）

## 1. 差距清单（ZCode → duya 现状）

| 维度 | ZCode | duya 现状 | 补齐成本 |
|---|---|---|---|
| 层级 | 全树 walk，元素带 depth，裁剪保留祖先 | 平铺交互表（562 白名单），无 depth/容器 | 中 |
| 文本 | 静态文本 merge 进兄弟/标题——无标签 Edit 能看到旁边文字 | 只出控件自身 Name；whitelist 排除 Text | 中 |
| 容器采样 | children_total/shown/offset（"showing 100-117 of 184"） | 只有整树 truncated | 中 |
| 新启动窗口 | 树稳定轮询（settle） | 无 | 小 |
| 附加面板 | surface_kind（attached_dialog/popover/open_panel） | 无（模型自己 list_windows 再指定 windowId） | 小（可后置） |

## 2. Phases

### Phase 1 — probe walk 带 depth 与静态文本（ps1 C#）✅ 2026-09-29
- [x] `EnumerateWindow` walk 输出节点带 `depth`（相对窗口根）。
      **实现发现（关键坑）**：.NET 托管 `System.Windows.Automation.TreeWalker`
      **不应用环境 CacheRequest**——GetFirstChild/GetNextSibling 返回 current
      形态，`.Cached` 直接抛「不能请求未缓存的属性或模式」。最终走**两段式**：
      BFS 逐层 `FindAll(Children)`（每次调用返回缓存子节点，每节点 1 次 COM
      往返，562 性能修复证明可靠）+ 内存 wrapper 树，再 DFS 按文档序发射
      （属性全缓存命中，发射零跨进程）。
- [x] 白名单加 `Text` 的**挂靠方案**（Text 不占交互槽红线达成）：Text 节点
      在 walk 中吸收进 pending run，前向挂到下一个发射元素的 `label` 字段
      （容量上限 8 段/200 字符，穿容器传递）；白名单本身加入 ZCode 内容/
      行词表：DataItem/TreeItem/Document/SplitButton/Spinner。
- [x] 预算语义改为 **VISITED 节点**（Text/容器都计数，防虚拟化列表 flooding）；
      offscreen 子树发射为带 `offscreen:true` 的叶子但**不下潜**（预算保护）。
      **红线修订**：maxNodes 500→1500——2026-09-29 缓存遍历修复后每节点成本
      已是一次 COM 导航调用，且 1500 对齐模型面渲染上限；时间预算
      （1500ms 暖/8s 冷）不变。value 加 400 字符 wire 截断（Document 防爆）。
- [x] Gate：ps1 编译冒烟 + apps/windows/enumerate 实测
      （`scripts/smoke-uia-probe-576.ps1`，多窗口轮询直到非空树）。

### Phase 2 — 契约与适配 ✅ 2026-09-29
- [x] protocol：`EnumeratedElementSchema` 补 `depth?/label?/checked?/description?/offscreen?`
      （childrenTotal 等属 Phase 3）；`EnumeratedElement`/`EnumeratedElementDescriptor` 同步。
- [x] `adaptEnumerated`/`CuaElement`/`UiaTreeElement`（tree 动作链路）透传；
      invoke 的 1-based 槽语义**保持不变**（Text 不进 Elements 列表——
      元素表与槽 1:1，resolveIndex/ledger 零改动）。
- [x] normalize：merge 语义在 ps1 侧以 label 挂靠实现（TS 树管线保留）；
      format 行渲染对齐 ZCode（depth 缩进、`(pressable)(editable)(checked)(offscreen)`
      caps、label 身份回落、actions 原样渲染只滤 ubiquitous）；**裁剪祖先保留
      改为真实 depth 回溯**（替换矩形包含启发式）；评分表加 label +40 /
      selected +240 / offscreen −150。
- [x] diff：materialFieldDiff 加入 label（title||label 复合）与 checked 字段。
      **与原条目的刻意偏离**：`stableNodeId` 保持 ZCode 原样
      （winTitle+role+title，不加 depth/label）——depth 随布局抖动漂移会把
      身份打碎成 removed+added 风暴；ZCode 内核源码实证也未含 depth。

### Phase 3 — 容器采样与新窗 settle（未开工）
- [ ] 容器节点发 `children_total/shown/offset`（"showing 100-117 of 184" 文本由 format 渲染）
- [ ] 新启动窗口：get_app_state 对 enumerate 结果为 0/骤变的窗口做一次 settle 轮询（≤2 次，间隔 ~400ms）
- [ ] surface_kind 家族：先只发 `surface_kind: "top_level" | "attached_dialog"`（attached dialog 由
      owner hwnd 关系判定），popover/open_panel 后置

## 3. 范围红线

- invoke 1-based 槽序（564 缓存）与 token 台账语义**不可变**——Text/容器一律不占交互槽 ✅（label 挂靠实现天然满足）
- 不改 575 已落地的审批/截图/状态位行为；只增信息量 ✅
- ~~walk 预算（1500ms/500 节点）不放宽~~ → **2026-09-29 修订**：时间预算不变；
  节点预算改 VISITED 语义并提至 1500（理由见 Phase 1，对齐 ZCode 渲染上限）
- 分两段提交：Phase 1+2 一段（契约+probe 同步改），Phase 3 一段

## 4. 验收

- [x] 真机 get_app_state 管线（smoke 直驱 probe）：无标签控件能看到旁侧文字
      （16 个 label 挂靠）、层级注记正确（depth 0-13 全覆盖）、invoke 槽不漂移
      （元素表=槽表 1:1）
- [ ] duya 自身 + 记事本 + 设置（ApplicationFrameHost）三窗真机 get_app_state
      （需重启 electron:dev 后人工跑——probe 是持久子进程，改 ps1 后必须重启）
- [x] 计算机使用包全套单测绿；format/diff 快照测试更新
      （contract 34、protocol 18、cua-service 20、som、OSTool 69）

## 5. 长期立项（本计划之外）

- C++ Node-API addon（in-process UIA COM + WGC 单窗截图）——一次性解决
  PS 子进程预算压力、属性面、层级与性能；见 zcode-cua-implementation-anatomy
  可抄清单 ①②。TreeWalker/CacheRequest 托管层陷阱（不缓存导航结果）是
  迁移 C++ COM 的又一个理由。

## 6. 录制 overlay 零紫框修复（2026-09-29 追加，同日落地）

用户报告：录制时文件资源管理器一个紫框都没有。根因链（确定性复现）：
1. `ENUMERATE_CACHE_TTL_MS = 5min` 且 `enumerateCached` **把空结果也缓存**；
2. 最小化窗口整棵 UIA 子树 IsOffscreen=true → 枚举返回 0（新旧行为皆然）；
3. 录制中最小化/恢复 Explorer → 焦点变化的枚举拿到 0 → **缓存钉死 5 分钟**；
4. 恢复可见后再聚焦 → (hwnd,title) 缓存命中 → 空树 → overlay 清空 → 零紫框。

修复（全部已落地+测试绿）：
- `uia-probe.ts`：空树改 2s 短 TTL（`ENUMERATE_EMPTY_CACHE_TTL_MS`，
  EnumerateCacheEntry.ttlMs 每条目覆盖）；非空树仍 5min。
- `overlay/geometry.ts`：`selectVisibleOverlayElements` 增加目标 display
  边界相交过滤（iconic 坐标 -25600 不再画、跨屏元素不再编号占位），
  签名升级为完整 DisplayBounds；白名单镜像同步 plan 576 词表。
- ps1：`PruneOffscreen = !IsIconic(hwnd)`——最小化窗口不做 offscreen 下潜
  剪枝（plan 578 契约）；实测 Win11 Explorer（WinUI 宿主）最小化时
  provider 只物化浅层子树（visited 2→7、仍 0 发射），**最小化树丰富度是
  provider 侧上限**，诚实记录。
- `recorder/service.ts`：overlay 快照链路加 INFO 日志（count/app/pid），
  零紫框从此可从日志直接归因（枚举 0 vs 全被过滤）。

真机实证：可见的 Explorer 文件夹窗口枚举 **102 元素**（Button 14/Edit 64/
ListItem 16/SplitButton 4/RadioButton 2/TreeItem 1/MenuItem 1，label 挂靠
正常，如 RadioButton 详细信息 label="73 个项目"）。探针无存活进程即懒启动，
**改 ps1/electron 后必须重启 electron:dev**。

附带发现：`overlay/geometry.ts` 有第二份白名单镜像（与 overlay/index.ts
PAGE_WHITELIST、protocol DEFAULT_INTERACTIVE_CONTROL_TYPES 三处），后续
应收敛到单一来源。

