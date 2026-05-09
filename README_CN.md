# DUYA

<p align="center">
  <img src="assets/icon.png" width="120" alt="DUYA Logo">
</p>

<p align="center">
  <strong>AI 智能体，就在你的桌面上。不是浏览器标签页，不是命令行。一个真正的应用，给真正使用的人。</strong>
</p>

<p align="center">
  <a href="https://github.com/lava-chen/duya/releases">
    <img src="https://img.shields.io/github/v/release/lava-chen/duya?style=flat-square" alt="GitHub release">
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square" alt="MIT License">
  </a>
  <a href="https://github.com/lava-chen/duya/actions">
    <img src="https://img.shields.io/github/actions/workflow/status/lava-chen/duya/ci.yml?style=flat-square" alt="CI">
  </a>
</p>

***

## 为什么选择 DUYA？

市面上的 AI 智能体大多活在终端或浏览器里 —— 那是给开发者用的工具。DUYA 不一样。它是一个**真正的桌面应用**，支持 Windows、macOS、Linux。双击安装，不需要命令行。

| 其他智能体       | DUYA                                        |
| ----------- | ------------------------------------------- |
| 命令行或网页聊天    | **真正的桌面应用** —— 原生窗口、系统托盘、桌面通知               |
| 顶多抓个网页文本    | **真正的浏览器自动化** —— 导航、点击、输入、截图。23 种操作，3 套后端引擎 |
| 一个进程跑所有会话   | **Multi-Agent 进程池** —— 每个会话独立进程。一个崩溃，其他不受影响 |
| 数据在云端       | **100% 本地** —— SQLite 存在你的硬盘上。不上云，不追踪       |
| 改配置文件、设环境变量 | **引导式上手** —— 选语言、粘贴密钥，一分钟内开始聊天              |
| 权限控制薄弱      | **全面审批** —— 每次工具操作先问你。没有偷偷执行的               |

***

## 下载

从 [Releases](https://github.com/lava-chen/duya/releases) 下载安装包。双击，安装，完成。

| 平台          | 文件                                 | 安装方式                      |
| ----------- | ---------------------------------- | ------------------------- |
| **Windows** | `DUYA Setup x.x.x.exe`             | 双击，按向导操作                  |
| **macOS**   | `DUYA-x.x.x-arm64.dmg` / `x64.dmg` | 打开 `.dmg`，拖入 Applications |
| **Linux**   | `DUYA-x.x.x.AppImage`              | `chmod +x` 后直接运行          |

> **Beta 阶段**：DUYA 仍在积极开发中，会有不完善的地方。你的反馈能帮它变得更好。

***

## 三步上手

### 安装 → 配置 → 聊天

**安装。** 下载安装包，运行。就这么简单。

**配置。** 首次启动引导你三步完成：选择语言 → 选择 AI 服务商 → 输入 API 密钥。密钥使用操作系统级加密保护，除了与你选择的服务商通信外，不会离开你的设备。

**聊天。** 输入消息，回车。你的智能体回答提问、浏览网页、读写文件、执行命令、安排定时任务 —— 每一次操作都会先弹出权限确认，由你决定是否执行。

***

## DUYA 凭什么不一样

**真正的浏览器自动化。** AI 智能体最难的事是什么？真正"用"网页 —— 不只是抓取 HTML，而是点击按钮、填写表单、截取屏幕。DUYA 内置完整的浏览器引擎（Playwright + Chrome DevTools Protocol）。你的智能体可以导航页面、点击元素、输入文字、滚动、悬停、选择下拉框、执行 JavaScript、管理多个标签页、截屏 —— 23 种操作，3 套后端引擎。SSRF 防护默认拦截 localhost 和内网 IP。

**可视化 UI，让你看清每一步。** 不是满屏文字。每次工具操作渲染成独立的状态卡片 —— 终端、文件、搜索、浏览器、子智能体各有专属图标，运行中旋转加载，成功绿色对勾，失败红色叉号。点击可展开查看完整输出。权限确认内联弹出，展示智能体要做什么、操作哪个文件。上下文用量条用绿/黄/红渐变显示 LLM 窗口消耗，暗色模式跟随系统。瞟一眼就懂，不用猜。

**Multi-Agent 多角色。** 不同任务需要不同的智能体。DUYA 内置 5 种预设角色 —— 通用、编程、研究、探索、规划 —— 每种配备不同的工具权限和人格。按会话切换角色。需要专家？智能体可以生成子智能体，并行做研究、代码审查或任务拆解。

**进程隔离，真隔离。** 每个对话跑在独立进程里。一个 Agent 崩了？其他会话照常工作。Resource Governor 自动控制 CPU 占用，不卡你电脑。没有单点故障。

**消息先落库，丢不了。** 每条消息在 Agent 处理前就已经写进数据库。崩溃、断电、强制退出 —— 对话历史完好无损。重开后从断开处无缝继续。

**隐私默认开启。** 不联网。不遥测。不分析。你的数据就是一个本地 SQLite 文件。唯一的网络通信只发给你选的 AI 服务商。API 密钥使用操作系统级 safeStorage 加密。

***

## 安全

| 层级          | 保护措施                               |
| ----------- | ---------------------------------- |
| **API 密钥**  | 操作系统级加密（safeStorage），界面脱敏显示        |
| **Bash 命令** | 默认沙箱运行、清除敏感环境变量、系统路径写入保护           |
| **网页浏览**    | 默认禁止访问 localhost 和内网 IP（防 SSRF 攻击） |
| **文件访问**    | 系统目录（`/etc`、`C:\Windows`）不可写       |
| **权限控制**    | 默认模式 = "ask" —— 每次工具操作由你审批         |

***

## 开发

DUYA 使用 TypeScript、React 19、Electron 28 和 SQLite 构建。完整的开发环境搭建指南见 [CONTRIBUTING.md](CONTRIBUTING.md)。

```bash
git clone https://github.com/lava-chen/duya.git
cd duya && npm install
npm run electron:dev
```

| 命令 | 用途 |
|------|------|
| `npm run electron:dev` | 开发模式 |
| `npm run electron:build` | 生产构建 |
| `npm run typecheck:all` | TypeScript 类型检查 |
| `npm run test` | 运行测试 |

***

## 许可证

MIT —— [LICENSE](LICENSE)
