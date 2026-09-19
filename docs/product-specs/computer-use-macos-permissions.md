# Computer Use — macOS 权限引导与 cua-driver 分发(plan 552 Phase 0 第 5 项)

> 定位:computer-use 在 macOS 上的两项前置:系统权限引导 + MCP cua-driver 二进制分发路线。
> Windows 侧 backend(UIA/MSAA + SendInput)不受本文影响。

## 1. macOS 系统权限

computer-use 的屏幕读取与输入注入依赖两项系统权限,**首次使用必须引导用户授予**:

| 权限 | System Settings 路径 | 缺失时的表现 |
|------|---------------------|--------------|
| **Accessibility**(辅助功能) | System Settings → Privacy & Security → Accessibility → 添加 DUYA(Electron 主程序) | `click` / `type` / `key` / `drag` / `set_value` 静默无效或报错;`AXUserScenario`/AX 元素读取失败(SOM 0 元素) |
| **Screen Recording**(屏幕录制) | System Settings → Privacy & Security → Screen Recording → 添加 DUYA | `capture` 返回空白/黑屏图像;SOM 描述为空 |

### 引导策略(实现约定)

- 权限探测放在 GUI 工具执行路径上:第一次 `capture` 返回 0 元素且图像为空 →
  结构化错误 `PERMISSION_SCREEN_RECORDING`;第一次 `click/type` 无效果(backend 报
  accessibility 未授权)→ 结构化错误 `PERMISSION_ACCESSIBILITY`。
- 错误信息按 codex-skill 风格直接给用户路径指引(打开对应 System Settings 面板),
  不重试不猜测——权限是用户动作,不是代码动作。
- 授权后 macOS 不回收已运行进程的旧状态,需重启 DUYA 才生效;错误文案须提示这一点。

## 2. cua-driver 二进制分发(遗留基建项)

**现状**:macOS 的确定性桌面驱动(AX tree / 元素定位 / 输入注入)计划走 **MCP over stdio
的 cua-driver** 独立二进制(对齐 plan 519 的平台抽象层);当前 macOS 上 `computer_use`
的 capture/click 依赖 Electron 主进程自身权限,确定性元素通道未接入。

**分发方案(对齐 better-sqlite3 模式,待立项实施)**:

1. cua-driver 构建产物放入 `resources/cua-driver/`(electron-builder `extraResources`,
   按平台二进制:`cua-driver-darwin-arm64` / `cua-driver-darwin-x64`)。
2. 主进程以 stdio spawn + MCP 握手接入;路径解析 `process.resourcesPath/cua-driver/`,
   dev 走 `DUYA_CUA_DRIVER_ENTRY` env(与 `DUYA_COMPUTER_USE_DEMO_ENTRY` 同约定,
   兄弟目录发现兜底,禁止机器特定绝对路径)。
3. afterPack 校验 darwin 产物存在(同 `resources/agent-bundle/` 的 release 检查模式);
   缺失时降级为 vision-only 路径并 WARN,不阻断启动。
4. 二进制签名/公证随 electron-builder `mac.notarize` 流程走,否则 Gatekeeper 拦截
   stdio spawn。

**验收**:打包版在 macOS 上 `capture` 能返回带元素的 SOM 图像、`click(element)` 命中
真实控件;未装 cua-driver 时降级路径可用。
