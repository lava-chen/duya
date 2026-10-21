# Duya

<p align="center">
  <img src="assets/icon.png" width="120" alt="Duya Logo">
</p>

<p align="center">
  <strong>一个本地优先的桌面 AI 智能体，用于研究、文件、代码与可视化工作流。</strong>
</p>

<p align="center">
  Duya 让 AI 智能体在你的桌面工作区中运作 —— 使用你的浏览器、本地文件、终端、项目引用、插件、技能与 MCP 风格的工具 —— 同时让重要操作可见，并基于权限进行控制。
</p>

<p align="center">
  <a href="https://github.com/lava-chen/duya/releases">下载</a>
  ·
  <a href="#demo">Demo</a>
  ·
  <a href="#duya-能做什么">Duya 能做什么</a>
  ·
  <a href="#快速开始">快速开始</a>
  ·
  <a href="#隐私与控制">隐私与控制</a>
  ·
  <a href="#开发">开发</a>
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

> Duya 目前处于公开测试阶段。它可用，但仍较粗糙。请预期快速迭代、可见的 bug 与频繁的发布说明。

---

## Demo

![Duya demo](assets/demo.gif)

Duya 不仅仅是另一个聊天框。它是一个桌面工作区，智能体可以浏览网页、读写文件、编辑代码、运行命令、查阅项目引用、创建可视化产物，并在执行敏感操作前请求许可。

一个不错的首次任务示例：

```text
研究本地优先的 AI 智能体与云智能体有何不同。
使用浏览器收集资料，然后在本项目中创建一份 markdown 笔记。
```

---

## 为什么选择 Duya？

大多数 AI 智能体工具可以归入三类中的一类。

有些工具功能强大，但活在终端里。它们对开发者很好用，对普通用户却很 intimidating。

有些工具以聊天优先。它们易用，但无法真正进入你的本地工作区操作。

还有些是云智能体。它们能跑长任务，但常常隐藏执行细节，并把敏感工作从你自己的电脑上移走。

Duya 走了一条不同的路。

它把智能体工作流带进一个本地优先的桌面应用，配合可见的工具执行、浏览器自动化、文件访问、终端集成、项目引用、插件、技能与权限提示。

目标不是盲目的自主。

目标是受控的能动性（controlled agency）。

---

## Duya 能做什么

### 用真实浏览器做研究

Duya 可以使用浏览器操作，而不只是抓取静态 HTML。

它能打开页面、点击元素、在输入框中输入、滚动、管理标签页、截屏、读取网络输出，并使用浏览器快照来理解页面。

这使得它适合那些需要智能体像用户一样与网页交互、而不是只调用搜索 API 的研究任务。

任务示例：

```text
使用浏览器研究三款近期出现的 AI 编码智能体工具。
创建一份 markdown 对比，包含链接、优势、劣势，以及 Duya 可以从中学到什么。
```

### 处理本地文件

Duya 可以在你的本地工作区中读取、搜索、写入与编辑文件。

它支持常见的编码智能体工具，如 read、grep、glob、edit、write、bash、PowerShell，以及文件预览面板。它还能从工具卡片中打开生成或修改过的文件。

任务示例：

```text
读取这个项目文件夹，创建一份简短的项目简介：
- 项目做什么
- 重要文件
- 如何运行
- 潜在风险或 TODO
```

### 使用项目引用

Duya 支持项目级的引用文件。

你可以挑选对智能体重要的文件，例如项目笔记、`.duya` 文件、`.agents` 文件、`.claude` 文件、设计文档或任务上下文。智能体可以把这些引用作为工作上下文的一部分，而不是从散落的文件中猜测。

任务示例：

```text
使用项目引用，总结当前的产品方向。
然后为公开测试发布建议接下来的三个任务。
```

### 预览文档与代码

Duya 包含用于文件预览与文档工作的面板。

它可以通过应用侧边栏预览本地文件、源代码、Office 类文档与 notebook，这样你就不必为了查看上下文而离开智能体工作区。

任务示例：

```text
阅读这份报告草稿与源数据文件。
总结缺失的部分，然后建议在提交前的修改。
```

### 运行终端工作流

Duya 通过桌面工作区集成了一个终端面板。

智能体可以在被允许时运行 shell 命令、查看输出，并把终端结果作为任务循环的一部分。敏感命令可以被权限门控。

任务示例：

```text
运行测试套件，检查第一个失败的测试，并提出一个最小修复。
在编辑文件前先问我。
```

### 在运行中继续下指令

Duya 包含一种 Agent Mailbox 风格的交互模型。

当智能体正在运行时，你可以向当前任务发送后续指令，而不必等整个运行结束。这让长任务更容易被引导。

示例：

```text
实际上请多关注 onboarding 流程，暂时忽略支付功能。
```

### 创建可视化产物

Duya 可以在聊天中渲染 widget、图表、仪表盘、图形与小型可视化。

生成的 widget 会经过一个可视化自检流程，让智能体可以检视并改进渲染结果，而不是只生成原始 markup。

任务示例：

```text
创建一个可视化流程图，展示桌面智能体在使用本地工具前应如何请求许可。
```

### 使用 Conductor 画布工作流

Duya 包含一个实验性的 Conductor 模式，用于基于画布的智能体工作。

Conductor 技术栈支持画布元素、智能布局、视口感知的打包、对齐优先的吸附、碰撞处理、自动布局工具，以及智能体驱动的画布操作。

这是实验性的，但它指向 Duya 更长期的方向：不只是与智能体聊天，而是在一个桌面空间里协调任务、产物、上下文与可视化工作流。

---

## Duya 有什么不同

| 类型       | 擅长           | 局限                          | Duya 的方向                       |
| ---------- | -------------- | ----------------------------- | --------------------------------- |
| 聊天助手   | 轻松对话       | 本地操作有限                   | 给智能体真正的桌面工具            |
| 编码智能体 | 代码库任务     | 常以终端或 IDE 为主            | 让智能体工作在桌面应用中可见      |
| 浏览器智能体 | 网页交互     | 常与文件和项目脱节             | 结合浏览器与本地工作区            |
| 云智能体   | 长任务         | 本地控制与可见性较弱           | 把用户的电脑作为主要工作区        |
| Duya       | 桌面智能体工作流 | 仍是 beta                     | 本地优先、可见、基于权限的能动性  |

---

## 快速开始

### 1. 下载

从以下地址下载最新 beta：

```text
https://github.com/lava-chen/duya/releases
```

### 2. 安装

支持的安装包目标：

| 平台    | 安装包                             |
| ------- | ---------------------------------- |
| Windows | `.exe`                             |
| macOS   | `.dmg`                             |
| Linux   | `.AppImage` / 相关 Linux 目标      |

Windows 是目前测试最多的路径。macOS 与 Linux 构建可能需要更多冒烟测试。

### 3. 配置模型服务商

打开 Duya，配置一个 AI 服务商。

Duya 支持多服务商设置。你可以添加服务商凭证、选择默认服务商、在支持的情况下拉取可用模型列表，并按工作流切换服务商。

你的 API key 本地存储，使用操作系统级保护，并在 UI 中脱敏显示。

### 4. 运行第一个任务

先试试下面这些任务：

```text
使用浏览器研究一个主题，并创建一份 markdown 笔记。
```

```text
读取这个项目文件夹，总结项目做什么。
```

```text
检查这个小型代码库，如有需要运行测试，并建议一个安全的修复。
在编辑文件前先问我。
```

### 5. 审阅工具操作

当 Duya 使用工具时，它会渲染可见的工具卡片。

对于敏感操作，如终端命令、文件编辑、浏览器操作或权限相关的工具，Duya 可以在继续前请求批准。

---

## 任务示例

### 研究

```text
研究本地优先 AI 智能体的现状。
使用浏览器资料，对比几款工具，并创建一份带链接的 markdown 笔记。
```

### 文档审阅

```text
阅读这个文件夹中的报告。
找出缺失的章节、不清晰的论证、格式问题与数据处理缺口。
返回一份简明的修订清单。
```

### 代码任务

```text
检查这个仓库。
找出应用如何启动，识别关键模块，并建议一个小的改进。
在我批准前不要编辑文件。
```

### 文件整理

```text
读取这个文件夹中的文件。
按用途分组，总结每组，并创建一份清理 TODO 清单。
```

### 可视化解释

```text
创建一个图表，解释这个流程：
用户请求 → 智能体规划 → 工具权限 → 本地操作 → 产物审阅。
```

---

## 隐私与控制

Duya 被设计为一个本地优先的桌面应用。

你的对话与工作区数据默认存储在本地。Duya 不需要 Duya 云工作区来承载你的本地智能体会话。

你选择自己的模型服务商与 API key。模型请求只会发送给你配置的服务商。

工具操作是可见的。敏感操作可以要求明确的批准。

Duya 使用本地持久化，因此会话、工具输出与任务状态不会绑定到一个脆弱的进程上。

当前的控制面包括：

* 本地 SQLite 工作区数据
* 可见的工具卡片
* 敏感操作的权限提示
* 服务商凭证脱敏
* 项目级引用
* 本地文件预览与生成产物检查
* 面向高级用户的 CLI 控制面操作

安全不会被当作一个开关来对待。Duya 的方向是让智能体操作可见、可检查、可控。

---

## 当前 beta 状态

Duya 处于活跃 beta 中。

近期落地的内容包括：

* 多服务商架构
* 用于运行中指令更新的 Agent Mailbox
* 类型化的权限流程
* 对齐 Codex 的聊天 composer
* 右侧多标签工作区面板
* Office 与 notebook 预览工作区
* 终端面板
* 项目引用面板
* 插件 / 技能 / MCP 导向的扩展层
* CLI 控制面
* widget 渲染与可视化自检
* Conductor 画布智能布局
* 跨 LLM 客户端、智能体核心、工具、worker/IPC、数据库与研究模式的稳定性审计

已知的 beta 注意事项：

* onboarding 仍需真实用户测试
* 部分工作流较粗糙或为实验性
* macOS 与 Linux 安装包可能需要更多冒烟测试
* Conductor / 画布功能为实验性
* 企业工作区功能不是当前公开测试的重点

---

## 架构

Duya 被构建为一个桌面应用，分离了 UI、Electron 主进程、本地持久化与隔离的智能体运行时包。

核心技术栈：

* Electron
* Vite
* React
* TypeScript
* SQLite / better-sqlite3
* 基于 child process 的智能体运行时
* HTTP + SSE / IPC 桥
* 浏览器自动化后端
* 插件 / 技能 / MCP 导向的扩展层
* `@duya/agent`
* `@duya/cli`
* `@duya/conductor`
* `@duya/gateway`

总体结构：

```text
Renderer UI
  ↕
Electron Main Process
  ↕
Agent Server / IPC / SQLite
  ↕
Isolated Agent Worker Processes
  ↕
Tools: browser, files, shell, memory, skills, MCP, conductor
```

这种结构的设计目的是让智能体运行可以被隔离、持久化、中断与恢复，比单一进程内的聊天循环更可靠。

---

## 开发

安装依赖：

```bash
npm install
```

在开发模式下运行桌面应用：

```bash
npm run electron:dev
```

构建应用：

```bash
npm run electron:build
```

为当前平台打包：

```bash
npm run electron:pack
```

运行类型检查：

```bash
npm run typecheck:all
```

运行测试：

```bash
npm run test
```

常用脚本：

```bash
npm run build:agent
npm run build:cli
npm run build:conductor
npm run build:gateway
npm run electron:verify:packaged
npm run diagnose:env
```

---

## 仓库结构

```text
src/                  渲染器 UI
electron/             Electron 主进程、IPC、本地服务
packages/agent/       智能体运行时、工具、提示词、模式
packages/cli/         桌面控制面 CLI
packages/conductor/   画布 / conductor 子系统
packages/gateway/     外部渠道网关包
scripts/              构建、打包、诊断脚本
docs/                 架构、执行计划、发布说明
```

---

## 路线图

近期重点：

* 改善首次运行的 onboarding
* 让第一个成功任务更容易完成
* 打磨浏览器与文件工作流
* 改进错误信息与恢复
* 增加更多真实场景的 demo 任务
* 精炼权限提示
* 稳定公开测试安装包

更长期方向：

* 更深度的本地工作流编排
* 更好的项目记忆与引用管理
* 更强的可视化自检循环
* 更可靠的长任务
* 通过受控的企业插件实现团队 / 工作区集成

---

## 反馈

Duya 正在寻找愿意测试真实任务并报告粗糙边缘的早期用户。

最有用的反馈是：

* 安装失败
* 模型服务商配置令人困惑
* 第一个任务没完成
* 工具权限感觉不安全或不清晰
* 浏览器自动化失败
* 文件预览或文件编辑令人困惑
* 你不会第二次打开 Duya，以及为什么

请提一个 issue、发起一个 discussion，或带着一个具体失败任务联系维护者。

---

## 许可证

MIT
