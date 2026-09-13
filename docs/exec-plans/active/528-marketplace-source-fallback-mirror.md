# Plan 528: Marketplace Source Fallback / Mirror

> **Status**: Planning
> **Priority**: P1
> **Created**: 2026-09-13
> **Companion**: [455-codex-marketplace-and-install](./455-codex-marketplace-and-install.md)(现状:单 `url` 字段,无 fallback)、[455-open-connector-registry](./455-open-connector-registry.md)(registry 已支持多源 schema,本计划补 git-source 路径)
> **Source evidence**: 2026-09-13 用户反馈:"gitee 在国内国外都能有很好的连接,把它作为第一来源";plan 28 历史背景(app 升级源曾有过 github → gitee fallback,后被简化移除)

---

## 1. Problem & Goal

### 现状

`MarketplaceSourceConfig` 是单 URL schema:

```typescript
// electron/plugins/marketplace/git-source.ts:54-58
export interface MarketplaceSourceConfig {
  source: 'git' | 'local';
  url?: string;
  path?: string;
  ref?: string;
}
```

- `DEFAULT_OFFICIAL_SOURCE` 写死 `https://github.com/lava-chen/duya-marketplace.git`
- `cloneMarketplace` / `updateMarketplace` / `refreshMarketplace` 都只用一个 URL
- 网络不通 → warn + 不阻塞;但用户实际体验是"装了 marketplace 看不到插件"
- plan 28 的 app 升级源曾有 GitHub → Gitee fallback,后被简化,**marketplace 源从未有过 fallback**

### 用户感知的问题

国内用户连 github 慢/不稳;国外用户连 gitee 反而快。
用户原话:"gitee 在国内国外都能有很好的连接,甚至可以作为第一来源"。

### Goal

- 一个 marketplace source 可以配**多个 URL**(主备顺序),clone/update 按顺序尝试,先成功先赢
- 默认官方源升级为:**gitee 优先,github 镜像**(gitee 在国内外的连接都好,但 gitee 优先更符合国内主用户群)
- 完全向后兼容:旧 config 里 `url` 字段继续有效,内部归一化为 `urls: [url]`
- 错误消息包含"是哪个 URL 失败",便于排查

### Non-goals(本计划不做)

- ❌ Npm registry 形式的 marketplace(plan 455 已声明不做)
- ❌ 远端 connector directory / 24h 自动同步(plan 455 已声明不做)
- ❌ 把 UI MarketplaceModal 改造成多源卡片(单源显示更简洁;多 URL 在 source view 内显示)
- ❌ SSH git URL 支持(plan 455 仍仅 https)
- ❌ 改写 manifest schema / 改 plan 455 文档里关于"single source URL"的措辞

---

## 2. Design

### Schema

`MarketplaceSourceConfig` 扩展:

```typescript
export interface MarketplaceSourceConfig {
  source: 'git' | 'local';
  /** Single URL, kept for back-compat with existing configs and UI forms. */
  url?: string;
  /** Ordered list of clone URLs (primary → mirror). Wins over `url` when set. */
  urls?: string[];
  path?: string;
  ref?: string;
}
```

读取侧统一用 helper:

```typescript
export function resolveSourceUrls(source: MarketplaceSourceConfig): string[] {
  if (source.urls?.length) return source.urls;
  if (source.url) return [source.url];
  return [];
}
```

写入侧(manager.ts 的 `addMarketplace`):
- 新建时优先写 `urls`
- 旧 `url` 字段**保留**(以兼容外部脚本读 config.toml)

### Clone fallback(串行,先成功先赢)

`cloneMarketplace` 改为接受 `urls: string[]`,按顺序试:

```typescript
export async function cloneMarketplace(opts: {
  urls: string[];
  name: string;
  ref?: string;
  rootOverride?: string;
}): Promise<MarketplaceCloneResult & { originUrl: string }> {
  const errors: Array<{ url: string; error: string }> = [];
  for (const url of opts.urls) {
    try {
      const result = await tryCloneOne({ url, name: opts.name, ref: opts.ref, rootOverride: opts.rootOverride });
      return { ...result, originUrl: url };
    } catch (err) {
      errors.push({ url, error: err instanceof Error ? err.message : String(err) });
    }
  }
  throw new Error(
    `all ${opts.urls.length} mirror(s) failed for "${opts.name}":\n` +
    errors.map(e => `  - ${e.url}\n    ${e.error}`).join('\n'),
  );
}
```

每个 `tryCloneOne` 内部跟现有 `cloneMarketplace` 一样(staging + rename + 检查 destination)。

### Origin URL tracking

Clone 成功后,记下实际成功的 `originUrl`。两种方案选 A:

**A. git-level 改 origin**(推荐)
- clone 时第一个 URL 是 `origin`
- 镜像 URL 也作为 remote(名为 `mirror`),但只在 fallback 用了之后添加
- 失败列表串行:clone 主 URL 失败 → 清理 staging → clone 镜像 URL → 把镜像 remote rename 为 `origin`
- `updateMarketplace` 只需 `git fetch origin` —— 因为永远有 origin

**B. 应用层记一个 `lastSuccessfulUrl` 文件**
- 简单但需要额外 IO 和配置管理
- update 时要先 cat 文件决定 fetch 哪个 URL

选 A,实现细节:

```typescript
async function tryCloneOne(opts) {
  const { url, name, ref, rootOverride } = opts;
  const stagingDir = ...; const destination = ...;
  await runGit(['clone', '--depth', '1', ...args, url, stagingDir]);
  // If this URL is not the primary, ensure 'origin' points to it (so updateMarketplace just works).
  if (url !== expectedPrimaryUrl) {
    await runGit(['remote', 'set-url', 'origin', url], { cwd: stagingDir });
  }
  fs.renameSync(stagingDir, destination);
  return { dir: destination, commit: readHeadCommit(destination) };
}
```

### update fallback

`updateMarketplace` 保持单 `origin` 简单:

```typescript
export async function updateMarketplace(opts: { dir: string; ref?: string; rootOverride?: string }): Promise<MarketplaceCloneResult> {
  // unchanged: fetch origin + reset --hard origin/<ref> | FETCH_HEAD
}
```

失败由 `refreshMarketplace` 处理(已有 re-clone fallback):

```typescript
} catch (err) {
  // current: re-clone from cfg.url
  // new: re-clone using cfg.urls (full fallback chain)
  removeMarketplaceClone(name);
  await cloneMarketplace({ urls: resolveSourceUrls(cfg), name, ref: cfg.ref });
}
```

### Default official source

```typescript
// electron/plugins/marketplace/manager.ts
export const DEFAULT_OFFICIAL_SOURCE: MarketplaceSourceConfig = {
  source: 'git',
  urls: [
    'https://gitee.com/lava-chen/duya-marketplace.git',   // primary — 国内国外连接都好
    'https://github.com/lava-chen/duya-marketplace.git',  // mirror — 海外兜底
  ],
};
```

迁移:`ensureOfficialMarketplace` 第一次启动会写入新 `urls` 字段;**已有用户的旧 `url` 配置保留**(后续 sync 走 `resolveSourceUrls`,优先取 `urls`,fallback 到 `url`)。

### UI / telemetry 影响

- MarketplaceModal 显示 source 时,展示 `urls[0]` 作为主 URL;展开可以看全部
- `ensureOfficialMarketplace` 的日志写入 `urls[0]`(主 URL)作为 log 字段,不变 schema
- `MarketplaceSyncOutcome` 不动

---

## 3. Implementation Steps

1. **`electron/plugins/marketplace/git-source.ts`**
   - `MarketplaceSourceConfig` schema 加 `urls?: string[]`(line 54-58)
   - 新增 `resolveSourceUrls(source): string[]`
   - `cloneMarketplace` opts 改 `url: string` → `urls: string[]`,内部循环 try,返回 `originUrl`
   - 加 helper `tryCloneOne({ url, ... })`(从现有 clone 逻辑抽取)
   - `updateMarketplace` 不改
2. **`electron/plugins/marketplace/manager.ts`**
   - `DEFAULT_OFFICIAL_SOURCE`: `url` → `urls: [gitee, github]`
   - `refreshMarketplace`: 把 `cfg.url!` 换成 `resolveSourceUrls(cfg)`,re-clone fallback 路径同步
   - `addMarketplace`: 旧 codex `parseMarketplaceSource` 返回单 URL 时,**新写 config 同时包含 `url` 和 `urls: [parsedUrl]`**(向后兼容);如果有 `urls` 路径(将来),优先写
3. **`packages/plugin-core/src/marketplace/source-parse.ts`** —— **本计划不动**
   - 用户输入层仍接受单 URL(UI 形式 / `marketplaces add <src>` CLI)
   - 多 URL 通过 config.toml 直接配置,或未来加 UI 步骤
4. **`electron/plugins/marketplace/git-source.test.ts`**
   - 新增 describe:`cloneMarketplace with urls fallback`
   - 测试用例:
     - `urls: [good, bad]` → 返回 `good`,`originUrl === good`
     - `urls: [bad, good]` → 返回 `good`,`originUrl === good`,且 `git remote get-url origin === good`
     - `urls: [bad, bad]` → 抛错,error 包含两个 URL 信息
     - 镜像模式(update 后主 URL 死掉): `urls: [primary, mirror]`,先 clone primary,手动破坏 primary,re-clone → 走 mirror
5. **`.claude/`(可选)** —— 不动

---

## 4. Verification

### Unit / type

- `npm run typecheck:all`(pre-commit gate,必须通过)
- `npx vitest run electron/plugins/marketplace/git-source.test.ts`(新测试 + 旧测试回归)

### Manual electron:dev

- 清空 `~/.duya/plugins/cache/marketplaces/duya-official`(模拟首次启动)
- 启动 `npm run electron:dev`
- 观察 `app.log`:
  - `Seeded default official marketplace { url: 'https://gitee.com/...' }` — 写入 logs 用 `urls[0]`
  - `Marketplace cloned { name: 'duya-official', url: 'https://gitee.com/...' }` — 实际用的是 gitee
- 模拟 gitee 挂掉:在 hosts 里加 `127.0.0.1 gitee.com` 阻断;重启观察 `Marketplace update failed, re-cloning ... marketplace: duya-official`,最后 `Marketplace cloned { url: 'https://github.com/...' }` — fallback 到 github

### Non-regression

- 旧 `url` 单字段的 config 必须仍能 sync(sanity test in test file)

---

## 5. Risks

- **风险 1**: `clone --depth 1` 后 `git remote set-url` 失败怎么办?(极小概率,git 都成功了 set-url 也会成功)
- **风险 2**: 已有用户的 `~/.duya/config.toml` 里只写 `url`,新代码读 `urls` 为空时 fallback 到 `url` — 已设计好,但需要测试覆盖
- **风险 3**: gitee 项目可能跟 github 不同步——本计划不解决 sync 问题,假设两边都正常 push;**owner 责任**:本仓库已 push 到 github + gitee 双远程(commit 7cadae3 / 0765696 / 4078675 都已双推送)
- **风险 4**: `ensureOfficialMarketplace` 升级:旧用户有 `url` 字段时,新写入不会覆盖(因为 `if (configs[name]) return`)——这是 by design(不破坏现有 config),但意味着老用户用 `url` 单字段工作。要让所有用户都升级到 `urls`,需要一次性 migration:**本计划不实现**,接受"渐进式迁移"

---

## 6. Out of Scope(明确不做)

- ❌ Npm registry / 远端 directory / 24h 自动同步
- ❌ UI 上"多源卡片"显示
- ❌ SSH git URL
- ❌ plan 455 文档措辞改写
- ❌ 自动迁移旧 `url` 单字段到 `urls`(渐进式)
- ❌ `MarketplaceSyncOutcome` schema 扩展