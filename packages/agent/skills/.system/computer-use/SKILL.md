---
name: computer-use
title: computer-use — Windows 系统级电脑操作（CUA 14 工具面）
description: "Use when a task needs a native desktop app's own UI or the OS on Windows: read a window's accessibility tree with get_app_state, act on element indices (left_click / set_value / perform_action / select_text ride UIA patterns on background windows), or send global input (type / key / scroll / paste). 对标 ZCode/Codex CUA 的 14 工具面。For anything inside a web page, use Browser Use instead. 主 agent 直接用，不要委托 subagent。"
when-to-use: "任务目标在原生桌面应用或 OS 层（资源管理器、设置、自绘 GUI 程序、Electron 窗口外框）。网页内操作走 Browser Use；截图给模型看的纯视觉兜底走 computer_use 的 capture/click。"
---

# Windows 系统级电脑操作（computer_cua）

`computer_cua` 是 ZCode/Codex CUA 对齐的 14 工具面（plan 575）：无障碍优先、
按窗语义、结构化收据。核心循环：**观察一次 → 对元素索引做动作 → 再观察确认**。

## 工具面（tool 参数取值）

观察类：
- `list_apps` — 运行中应用（pid / exe / 标题 / active）
- `list_windows` — 顶层窗口（windowId / pid / 标题 / bounds / minimized / cloaked）
- `get_app_state` — 核心：按 app_ref 读窗口的**索引元素树**；`includeScreenshot: true`
  附带窗口截图并**解锁坐标点击**；窗口没变时返回 delta（只给变化）
- `request_access` — 就绪检查（Windows 无 TCC；UIPI 提示）

动作类（元素目标走 UIA pattern，后台窗口可用、动作后回读验证）：
- `left_click` — 元素目标 → pattern 链（auto）；坐标目标 → 真实光标
- `set_value` — ValuePattern 写值（绕 IME，中文输入首选）
- `perform_action` — 派发元素声明过的语义动作（树里 actions=[...] 的那些：AXPress / AXToggle / AXExpand / AXCollapse / AXSelect / AXSetValue / AXShowMenu）
- `select_text` — TextPattern 定位并选中元素内文本
- `type` / `key` / `paste` / `scroll` / `left_click_drag` — 全局输入
- `stop_computer_control` — 丢弃本会话全部观察状态（急停/换会话）

## 铁律

1. **无障碍优先**。能点 `[n]` 就不要用坐标；能 `set_value` 就不要 `type`。
   坐标是最后手段——且必须先有 `get_app_state(includeScreenshot=true)` 的帧。
2. **动作 ≠ 生效**。`left_click` 坐标路径返回 `dispatch_status: possibly_sent`；
   元素路径返回 `target_verification_status`。收到 possibly_sent / mismatched /
   unavailable 时**先重新观察再决定**，绝不盲目重试非幂等动作。
3. **索引是会话作用域的**。`[n]` 绑定你最后一次 `get_app_state` 的那次观察 +
   app_ref（pid/name/windowId）。导航后、收到 ELEMENT_UNAVAILABLE / STALE_STATE
   后，重新观察拿新树。
4. **错误分类是行动指令**：
   - `ELEMENT_UNAVAILABLE` / `STALE_STATE` → reobserve（重新 get_app_state）
   - `ACTION_UNAVAILABLE` / `NOT_SETTABLE` / `NOT_SELECTABLE` → 换方法（如改坐标点击或视觉兜底）
   - `PERMISSION_DENIED`（UIPI，目标窗口是管理员权限）→ 停止并告知用户
   - `CONTROLLER_BUSY` / `NOT_AUTHORIZED` → never retry，报告并停止
   - `action_sent: true` 的失败 → 动作可能已落地，只能观察，不能重放
5. **空树不是失败信号**。自绘窗口（游戏/部分浏览器内容）树是空的：退回
   `computer_use` 的视觉循环（capture somMode=true → click），别反复重试。

## 目标写法

```
元素目标：{ "type": "element", "index": 0 }        // get_app_state 树里的 [0] 行
坐标目标：{ "type": "coordinate", "x": 120, "y": 45 } // 你收到的最后一张截图的像素
app_ref：{ "pid": 48412 } 或 { "name": "DUYA" } 或 { "windowId": 62459564 }
```

- 元素索引从 `[0]` 开始，作用域 = app_ref 的最后一次观察
- `name` 用 contains 匹配，多窗命中会拒绝——用 pid 或 windowId 消歧
- 坐标越界 / 没有帧 → `STALE_STATE`，重截图

## 观察结果怎么读

```
app: pid=48412 "DUYA"
window: "DUYA" window_id=62459564 bounds=[511,73,1493,1217]
elements (2):
 [0] button OK (pressable) actions=[AXPress]
 [1] textfield 搜索 = http://... actions=[AXSetValue]
```

- 行格式：`[索引] kind 标题 = 值 (focused) (pressable) (has_menu) actions=[...]`
- 树超过 1500 条会按优先级裁剪并标注 "indices are sparse"——隐藏的索引不可猜测，重新观察
- delta 模式只在末尾追加 `+ / ~ / - / focus:` 变化行；要全树就基于同一 app_ref 再观察一次
- 密码框的 value 永远不出现

## 典型流程

启动→操作一个后台应用：
1. `list_apps` 找 pid → `get_app_state {pid, includeScreenshot: true}`
2. 树里找目标行 → `perform_action {appRef, target:{type:"element",index:n}, action:"AXPress"}`
   或 `set_value {target:{type:"element",index:n}, value:"文本"}`
3. 再 `get_app_state`（同 app_ref，delta 很便宜）确认落地，再下一步

验证点：动作收据里的 `element` 字段是动作后的回读（name/value/controlType），
拿它和你期望的状态对照，而不是凭记忆断言成功。
