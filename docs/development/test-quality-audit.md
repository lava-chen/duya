# Test Quality Audit

审计日期：2026-10-22。基线：`origin/master` @ `b6f69507`。所有数字都在这台机器、同一条件下测得；CI 数字注明来自哪个 run。

## 结论

套件的数量不是问题：**1,178 个测试文件、13,401 个用例里没有一个是精确重复，也没有一个 `.only` 残留**。真正的问题是三件可量化的：

1. **PR 关键路径被重复构建吃掉 187s。** `npm test` 的 `pretest` 钩子会再跑一次 `build:packages` 加重建 worker bundle，而 CI 在它前面已经构建过同一个工作区。
2. **单测只需要 19 个包的 `dist/`，CI 构建了 22 个。** 多出来的 `@duya/ui` 是一次完整的渲染层 `tsc`。
3. **每个测试文件有约 370ms 的固定开销**，与用例数无关：1,178 个文件 × 370ms ≈ 436s CPU，占全量运行墙钟的 45%。

## 基线怎么量的

| 项 | 值 | 来源 |
| --- | --- | --- |
| 被跟踪的测试文件 | 1,195 | `git ls-files` |
| vitest 实际收集 | 1,178 | 全量 run |
| 用例 / 断言 | 13,401 / 31,803 | vitest JSON reporter |
| 全量运行墙钟（改前） | 440.24s | `--maxWorkers=2`（与 CI 同） |
| 全量运行墙钟（改后） | 420.79s | 同上 |
| 其中：collect | 237.38s | vitest 阶段分解 |
| 其中：tests | 354.31s | vitest 阶段分解 |
| 其中：environment | 37.22s | 118 个 jsdom 文件 |
| 其中：setup | 64.42s | 全局 setup 文件，每个文件都付 |
| 其中：prepare | 58.44s | 每个文件都付 |
| CI：test job 步骤 | install 54s · build 183s · pretest 187s | run 39653107412 / 39655210137 |

`collect + setup + prepare + environment + transform` = 458s 的 CPU，对 354s 的用例体。**开销比被测代码还多。**

## 发现

### F1 · 重复构建（已修）

`pretest` = `bundle:agent` = `build:packages` + 重建 worker bundle。CI 的 "Run tests" step 前一个 step 已经跑过 `build:packages`。run 39653107412 的日志里 `pretest` 花了 **186.8s**（18:34:09 → 18:37:16），期间 vitest 一个用例都没跑。

worker bundle 那一半同样是多余的：`packages/host/bundle/` 是 git 跟踪的产物（57 个文件），checkout 里已经带着它，而 `architecture` job 的 `bundle:verify` 门禁用 git 历史判定它是否过期。bundle 过期时 PR 本来就是红的——测试 job 重建一遍等于把那个红信号盖过去。

### F2 · 构建了用不上的包（已修）

`build:packages` 构建 22 个包，单测真正从 `dist/` 解析的只有 19 个。从干净的 `dist/` 与 `tsconfig.tsbuildinfo` 测：

| | 包数 | 耗时 |
| --- | ---: | ---: |
| 全量构建 | 22 | 151.8s |
| `unit-suite` 档位 | 19 | 39.8s |

省下的 112s 几乎全部来自 `@duya/ui`——一次完整的渲染层 `tsc`，而单测通过 vitest 别名直接读它的源码。

**一个反直觉的依赖**：`@duya/host` 不被任何测试文件 import，但档位里必须有它。`packages/host/tests/worker-product-runtime/agent-runtime-real-worker.mjs` 是子进程传输测试真正拉起的程序，它加载 `packages/host/dist/worker-transport.js`；架构门禁要求这个 import 留在拥有 worker 的模块内，所以它不能搬走。档位少了它，全量跑会少 8 个断言变绿——`subprocess-framing.test.ts` 与 `transport-equivalence.test.ts` 拉起的 worker 没有输出。套件自带的守卫（"needs the built worker, and says so rather than skipping"）如实报了出来，这正是它存在的意义。

**推论**：单测的构建需求**不能**只从测试文件的 import 推导，跨进程边界的 fixture 会引入 import 图看不见的依赖。

**而且这个依赖会漂**：审计进行期间，master 把这个 fixture 从 agent 层挪到了 host 层（#341），档位里的 `@duya/agent` 随之变成 `@duya/host`。档位是测出来的，不是推出来的，所以它必须被重新测。

### F3 · 每个文件都付的固定成本（部分已修）

`test-setup.ts` 无条件 `import '@testing-library/jest-dom/vitest'`。DOM 匹配器只有在 jsdom 环境下才有意义，而 1,178 个文件里 1,060 个跑在 node 环境。30 个探针文件实测：

| | setup | collect | 合计 |
| --- | ---: | ---: | ---: |
| 带导入 | 1.69s | 496ms | 3.45s |
| 不带导入 | 0.32s | 300ms | 2.68s |

即每个文件约 52ms。已改为按环境条件加载。

### F4 · 质量信号（未处理，见技术债）

| 信号 | 文件数 |
| --- | ---: |
| `mock-heavy`（mock 数 ≥ 用例数） | 34 |
| `stdout-write`（测试直接写 stdout/stderr） | 11 |
| `skipped`（自己跳过自己的用例） | 4 |
| 精确重复的文件 | 0 |
| `.only` 残留 | 0 |

`mock-heavy` 的 34 个文件里最极端的是 `packages/ui/src/components/extensions/__tests__/ExtensionsPage.test.tsx`（18 个 mock / 3 个用例）。**这不是判决**——mock 密集在 UI 组件测试里是常态，判定要靠故障注入，不是靠计数。

## 改动的效果

同一台机器、同一条件（`--maxWorkers=2`，与 CI 同），两次运行都只构建 `unit-suite` 档位：

| | 改前 | 改后 | 变化 |
| --- | ---: | ---: | ---: |
| 全量运行墙钟 | 440.24s | 420.79s | −4.4% |
| — collect | 237.38s | 242.53s | +5.15s |
| — setup | 64.42s | 14.22s | **−50.20s** |
| — environment | 37.22s | 37.74s | +0.52s |
| — tests | 354.31s | 349.68s | −4.63s |
| 工作区构建 | 151.8s | 39.8s | **−73.8%** |

改后那次运行是 **1,176 个文件全绿、2 个跳过、0 失败**。改前那次有 1 个文件红——是编码门禁正确地报出了**测量脚本自己**用 PowerShell `Set-Content -Encoding utf8` 写进 `test-setup.ts` 的一个 UTF-8 BOM（PowerShell 5.1 的 `-Encoding utf8` 带 BOM）。不是仓库的问题，但也不是一次干净的对照，所以下面这张表里的"改前"用的是这次运行的耗时、而不是它的通过状态。

映射到 PR 关键路径（"改前"来自当前 master 的真实 run，"改后"是把本机实测的差值按本地/CI 比值换算）：

| 环节 | 改前 | 改后 | 依据 |
| --- | ---: | ---: | --- |
| 安装依赖 | 54s | 54s | 不变 |
| 构建工作区 | 183s | 48s | run 39655210137 实测 183s；档位是全量的 39.8/151.8 = 0.262 |
| `pretest` 重复构建 | 187s | 0.1s | run 39653107412 的日志：pretest 18:34:09 → 18:37:16，其中 `ensure-sqlite-abi` 只占 0.08s |
| vitest | 457s | 437s | 本机 440.24s → 420.79s，按 CI/本地 1.039 换算 |
| 其余 | 11s | 11s | 不变 |
| **test job** | **892s** | **550s** | |
| **PR 关键路径** | **906s** | **564s（−37.8%）** | |

`typecheck` job 是 374s，仍短于 test job，所以关键路径没有换人。

**这是投影，不是实测。** 投影的每一步都来自本机实测或真实 run 的日志；这个 PR 自己的 run 出来之后，"改后"一列会被实测值替换。

## 故障注入

见 [test-fault-injection 报告](test-fault-injection-report.md)。抽样的 6 个缺陷覆盖 5 类核心契约，**6 个全部被现有套件杀死**：协议兼容的 MINOR 下限、canonical JSON 键序、SHA-256 填充、持久化的 bot 会话前缀、bypass 模式下的 config 硬边界、以及 `WorkerEvent` 联合类型少一个成员。

## 剩余技术债

| # | 债 | 影响 | 建议 |
| --- | --- | --- | --- |
| D1 | 34 个 `mock-heavy` 文件的检测能力未经抽样验证 | 未知 | 扩展故障注入的抽样面 |
| D2 | 11 个测试直接写 stdout/stderr | 污染 CI 日志，失败可能被淹没 | 改用注入的 logger |
| D3 | 4 个文件跳过自己的用例 | 覆盖面上的空洞 | 逐个确认是"暂缓"还是"永不" |
| D4 | `collect` 仍是最大单项（237s） | 每文件 202ms 的模块图加载 | 按包压测 import 图，找可裁剪的重依赖 |
| D5 | 118 个 jsdom 文件，每次环境初始化 315ms | environment 阶段 37s | 评估更轻的 DOM 实现，或减少真正需要 DOM 的文件数 |
| D6 | E2E 不在 PR 路径上 | 真实链路无 PR 级信号 | 重建套件后恢复 |
| D7 | `unit-suite` 档位是测出来的，不是推出来的 | master 把 fixture 挪个层，档位就过期 | 每次改到跨进程 fixture 都要重测档位 |
| D8 | `packages/agent/tests/process/fixtures/real-worker.mjs` 已无人引用 | 退役层里留着一份死 fixture | 随 agent 层一起退役 |
