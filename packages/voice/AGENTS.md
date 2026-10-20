# @duya/voice

> 语音输入：麦克风 → 流式 STT → 文本。

## 1. 负责 / 不负责

负责：
- STT 引擎工厂（本地 / 云端）（`packages/voice/src/stt/engine.ts:20`）
- 语音活动检测 VAD（`packages/voice/src/vad.ts:46`）
- 本地 whisper 环境检测与模型校验（`packages/voice/src/env.ts:206`、`checkModel` `:233`）
- 模型下载目录与模型目录（`packages/voice/src/model-manager.ts:31`）
- 配置解析（`packages/voice/src/config.ts`）

不负责：
- 麦克风采集与录音 UI → `@duya/ui` / 桌面主进程
- 语音命令的语义执行 → 智能体运行时
- 云端凭据管理 → 桌面主进程的 provider 设置

## 2. 关键文件

| 文件 | 作用 |
| --- | --- |
| `packages/voice/src/stt/engine.ts:20` | `createSttEngine` — 选本地还是云端引擎 |
| `packages/voice/src/vad.ts:46` | `Vad` 类；采样率固定 16 kHz（`VAD_SAMPLE_RATE` `:12`） |
| `packages/voice/src/env.ts:206` | `collectEnvReport` — 本地 whisper 可用性体检 |
| `packages/voice/src/model-manager.ts:31` | `MODEL_CATALOG` — 可下载的本地模型清单 |
| `packages/voice/src/worker.ts` | STT worker 入口 |

## 3. 排障入口

| 症状 | 先看这里 | 为什么 |
| --- | --- | --- |
| 没有文字返回 | `packages/voice/src/stt/engine.ts:20` | 引擎选择在这里，先确认走的是本地还是云端 |
| 一直检测不到人声 | `packages/voice/src/vad.ts:46` | VAD 阈值与采样率都在这 |
| 本地模型不可用 | `packages/voice/src/env.ts:206` | 环境体检；模型校验在 `:233` |
| 模型下载失败 | `packages/voice/src/model-manager.ts:31` | 目录与下载地址在这 |

## 4. 边界约束

- 架构层 `runtime`（`scripts/architecture/boundary-gates.mjs:67-75`），模块 `legacy-voice` `managed: false`。
- **worker 的 import graph 要窄**：worker 入口直接引入 `src/stt/engine`，`runtime-manager`
  （会带 `extract-zip`）**不能**进入 worker 的依赖图。改动 import 时注意这条。
- `managed: false`：本包的架构违规不阻断门禁。
