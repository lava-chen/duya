# 测试与验证

在当前检出根目录执行，先选择能验证本次变化的最小范围。相关测试通过不代表整仓门禁通过。

| 要回答的问题 | 验证方式 | 入口 |
| --- | --- | --- |
| 纯逻辑、状态、适配器是否正确 | `npx vitest run <test-files>` | `vitest.config.ts`、包内 / colocated 测试 |
| Electron main / preload / IPC 是否接通 | 先 `npm run electron:build`，再 `npm run test:e2e:ipc` 或 `test:e2e:smoke` | `e2e/playwright.config.ts`、`e2e/helpers.ts` |
| 真实 worker turn 是否闭环 | `npm run test:e2e:turn`，核对所改生产链路 | `e2e/turn/` |
| UI 行为、状态或样式是否正确 | Playwright MCP 操作受影响流程并保留结果 | 浏览器预览或真实 Electron，按能力选择 |

## 环境与隔离

- 测试、服务和构建产物来自同一检出；E2E 的 `reuseExistingServer` 可能复用别的 Vite，先核对 URL 与服务根。
- Electron 测试使用独立 namespace / userData；只读 `window.electronAPI` 不能证明页面挂载或 onboarding 已完成。
- 浏览器预览可以检查 renderer；涉及 preload、IPC 或 worker 时使用真实 Electron / 子进程。
- 缺 dist 时按[构建指南](build.md)准备；不要用旧构建产物或共享工作区状态解释测试成功。

## IPC mock

共享状态放在 `vi.hoisted` 中；`vi.mock` 路径相对测试文件，logger mock 返回同一个实例。
参考 `apps/desktop/src/main/ipc/__tests__/url-safety.test.ts` 与 `logger-handlers.test.ts`。
mock 验证局部行为，不能替代上表的真实接线验收。

## 基线与交付

改动前或独立基线检出记录 SHA、OS、Node、构建状态及失败；改动后用同一条件比较文件、用例与错误签名。
并发或负载相关失败先单独复现；不要为取基线自动 stash 他人的工作。
把命令、退出码、关键结果与未覆盖范围写回任务计划，原始日志留本地。
纯文档整理检查链接、Git 可见性、编码和 diff；代码行为变化执行根 AGENTS 的交付门禁。

## 套件本身

| 想知道的 | 去读 |
| --- | --- |
| 套件里有什么、多贵、风险在哪 | [Test Inventory](test-inventory.md) |
| 哪些检查在 PR / 夜间 / 发版前跑 | [CI 分层](ci-layers.md) |
| 测试的缺陷检测能力被验证到什么程度 | [故障注入报告](test-fault-injection-report.md) |
| 这轮审计的完整结论与技术债 | [测试质量审计](test-quality-audit.md) |

改测试前先看 Inventory 里那个文件的风险标记；删测试前先确认它的验证能力没有被别处覆盖。
