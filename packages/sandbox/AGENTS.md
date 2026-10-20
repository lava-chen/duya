# @duya/sandbox

跨平台命令沙箱。拥有 provider 选择（Docker → bubblewrap → none）、沙箱策略词汇表、host↔container 路径翻译，以及 legacy `ISandboxManager` 兼容面。

## 1. 负责 / 不负责

**负责**

- 选沙箱 provider 并缓存（30 s）。
- 沙箱策略的默认值与合并（`mode` / `filesystem` / `network` / 内存 / 超时）。
- 允许根目录判定（含符号链接与跨盘符）、host↔container 路径映射。

**不负责**

- 命令级的灾难/只读判定 → `@duya/capabilities`（`packages/capabilities/src/permissions/policy.ts:837`）。
- 命令的实际执行与 shell 选择 → `@duya/capabilities`（`packages/capabilities/src/ShellCommandTool/BashTool.ts:268`）。
- 工具注册 → `@duya/agent-runtime`（`packages/agent-runtime/src/tools/catalog/registry.ts:247`）。

## 2. 关键文件

| 文件 | 作用 |
| --- | --- |
| `packages/sandbox/src/sandbox-adapter.ts:41` | `getActiveProvider()`：Docker（`:52`）→ bubblewrap（`:58`）→ none（`:64`），结果缓存 30 s（`:35`）。 |
| `packages/sandbox/src/sandbox-adapter.ts:93` | `executeIsolated()`——Docker 路径，直接在容器里执行。 |
| `packages/sandbox/src/sandbox-adapter.ts:125` | `wrapCommand()`——返回包装后的命令行；provider 为 `none` 时原样返回，只剩正则防线（`:140`）。 |
| `packages/sandbox/src/types.ts:21` | `DEFAULT_SANDBOX_POLICY`（默认 `network: 'none'`、`denyWrite: ['/etc','/sys','/proc','/dev']`）；`createSandboxPolicy` `:33`。 |
| `packages/sandbox/src/allowed-roots.ts:44` | `isPathWithinRoots()`：词法判定 + realpath 反符号链接 + Windows 跨盘符拒绝（注释在 `:36-42`）。 |
| `packages/sandbox/src/path-mapper.ts:24` | `PathMapper`——host 路径 ↔ 容器路径翻译。 |
| `packages/sandbox/src/sandbox-adapter.ts:280` | legacy `ISandboxManager` 接口；`SandboxManager` 常量 `:303`。 |

公共面：`packages/sandbox/src/index.ts`（单一 barrel）。legacy 策略形状另见 `packages/sandbox/src/sandbox-adapter-legacy-types.ts:1`。

## 3. 排障入口

| 症状 | 先看这里 | 为什么 |
| --- | --- | --- |
| 沙箱没生效 / 命令逃逸 | `packages/sandbox/src/sandbox-adapter.ts:41` + `packages/sandbox/src/allowed-roots.ts:44` | 先确认当时选中的 provider，再看根目录判定。 |
| 以为有沙箱，其实没有 | `packages/sandbox/src/bubblewrap-sandbox.ts:42` | `isBubblewrapPlatform()` 只在 Linux 为真；Windows 上 bubblewrap 不可用。 |
| Docker 起不来 / 镜像缺失 | `packages/sandbox/src/docker-sandbox.ts:26` | Windows 分支与镜像构建都在这里。 |
| 容器里找不到宿主文件 | `packages/sandbox/src/path-mapper.ts:24` | 路径翻译在这里。 |
| 策略默认值不对 | `packages/sandbox/src/types.ts:21` | `createSandboxPolicy` 只是浅合并 + filesystem 深合并。 |

## 4. 边界约束

- `architecture-policy.yaml:608-611`：模块 `sandbox`，`managed: true`，`requires: []`（零跨包依赖）。
- **Windows 上活跃 provider 可能是 `none`**：`isBubblewrapPlatform()` 在 `packages/sandbox/src/bubblewrap-sandbox.ts:42` 只对 Linux 为真，Docker 不可用时 `getActiveProvider()` 落到 `'none'`，此时只剩正则级防护。这是 provider 选择的结果，不是建议。
- 本包做 IO（fs 探测、docker / bwrap 进程探测），所以它不是纯层；不要把纯策略计算塞进有 IO 的文件。
