# Plan 519 — Computer Use Mode 7 项 Hermes 对齐(文档本体补写)

> **Status**: 实现完成(代码在库,本文件为 2026-09-20 补写的文档本体 — plan 552 Phase 0 第 4 项)
> **Priority**: P0
> **定位**: plan 454(computer-use mode)的 harness 差距整改;与 551(Jev decide 通道)协同。
> 本文按"代码即事实"原则记录已落地内容与遗留项。

## 背景

454 落地了单工具 + 9 动作枚举的 `computer_use` 工具(capture / click / type / key / scroll /
drag / set_value / wait / zoom)。519 针对 Hermes 对比审计出的 7 项 harness 差距逐项整改。

## 已落地(代码出处)

| # | 项 | 实现 | 出处 |
|---|-----|------|------|
| 1 | Verify→Escalate Ladder | 动作结果带三态 verdict:`confirmed / unverifiable / suspected_noop`(+ `escalation` 建议通道,只推荐不重试) | `packages/computer-use/src/verdict/`(builder.ts / types.ts) |
| 2 | conditional inject `computer_use_context` | 兄弟工具 `computer_use_context`(`list_apps` / `focus_app`),默认 background focus;粘性触发器注册表(0 元素 SOM capture / suspected_noop click / 显式 prior call 时武装),mode 退出时 disarm | `packages/agent/src/tool/OSTool/context-tool.ts`、`constants.ts`(COMPUTER_USE_CONTEXT_ACTIONS) |
| 3 | 提示词分通道 | 长 SOP 从 mode prompt 移入 `computer-use` skill;mode prompt 只留操作循环 / 坐标规则 / verdict / 拒答策略 / 节奏 | `packages/agent/src/modes/computer-use-mode.ts`(COMPUTER_USE_PROMPT) |
| 4 | decide 通道(jev-browser 模式,551 Phase 3) | `computer_use_decide` 委托工具:settle → capture → describe → 一次 fan-out(target/value/done/error/blocked/irreversible)→ 代码门控 → act;八态 status 契约 `done | likely_done | needs_confirmation | error | stuck | ambiguous | blocked | max_actions`;仅当决策后端配置时注入(无 key 零变化) | `packages/computer-use/src/decide/`、`packages/agent/src/tool/OSTool/ComputerUseDecideTool.ts` |
| 5 | 审批门 | 不可逆动作经既有审批管线(Electron `computer-use:execute` 弹审批卡;bridge gate / executor gate / 无人值守 policy gate) | `packages/computer-use/src/decide/confirm-gate.ts`、`unattended.ts`(552 Phase 0) |
| 6 | 背景优先 / target HWND | 后台窗口 SendInput 目标化、raise=false 阻止抢焦点(Windows 侧 backend 行为) | `packages/computer-use/src/backend/`(平台实现) |
| 7 | AX tree 第二通道 | 打开的 daemon 已采 UIA/MSAA inputs 作为 SOM capture 的补充通道(daemon 侧) | `packages/computer-use-demo/`(daemon) |

## 遗留 / 交接

- **平台抽象 MCP over stdio(cua-driver)**:macOS 路线先走 MCP cua-driver;二进制随包分发
  尚未落地(见 552 Phase 0 第 5 项与 `docs/product-specs/computer-use-macos-permissions.md`)。
- **daemon spawn 路径去硬编码**:552 Phase 0 已修(`electron/main.ts` `resolveComputerUseDaemonEntry`,
  env `DUYA_COMPUTER_USE_DEMO_ENTRY` + 兄弟目录发现,移除 `E:/Projects` 硬编码)。
- **workflow 消费**:`computer_use` / `computer_use_decide` 现已注册进全局 ToolRegistry
  (`exposeMode: 'hidden'`,552 Phase 0),workflow tool/gui 节点可枚举直调,LLM 表面零变化。
