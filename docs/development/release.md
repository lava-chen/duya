# 版本与发布

发布必须已获用户授权；只要求推荐版本时，先给出具体数字、变更依据与待验收项，不执行 tag 或发布。
已有明确授权时沿用，不重复确认。

## 准备

1. 核对目标产品的版本文件、最近同产品已发布 tag 及其后提交，区分破坏性变化、功能与修复。
2. Desktop 与 CLI 使用独立版本线：Desktop 版本位于根 `package.json` 与 `apps/desktop/package.json`；CLI 版本位于 `packages/cli/package.json`。`0.x` 的 PATCH 与 MINOR 仍是不同位数，不把二者混用。
   已有策略不能确定候选时先确认版本，不在发布过程中悄悄改策略。
3. 用户要求 beta，或打包、安装、公开接口变化尚待实包验收时，推荐预发布版本并列出缺口。
4. Desktop 更新 `docs/release-notes/v<X>.md` 与根、Desktop 两个版本字段；CLI 更新 `docs/release-notes/cli-v<X>.md` 与 CLI 版本字段。按需同步锁文件；只暂存目标产品的发布改动。
5. 版本变更先在独立 worktree 经门禁、实包 smoke 与 PR 集成；发布授权不豁免 PR。tag 指向版本匹配的集成提交。

## 执行与验证

以下占位符替换为已授权版本；核对集成 SHA、远端同名 tag 与既有副作用后执行。Desktop 和 CLI 必须使用各自的版本字段与 tag：

```bash
git tag -a desktop/v<X> -F docs/release-notes/v<X>.md
git push origin desktop/v<X>
gh run list --workflow release-desktop.yml --limit 5
gh release view desktop/v<X>

git tag -a cli/v<Y> -F docs/release-notes/cli-v<Y>.md
git push origin cli/v<Y>
gh run list --workflow release-cli.yml --limit 5
gh release view cli/v<Y>
```

`.github/workflows/release-desktop.yml` 只处理 `desktop/v*`，`.github/workflows/release-cli.yml` 只处理 `cli/v*`。核对对应 tag 的 workflow 结果、Release、目标平台产物及可下载性；
仅 push 成功、CI 显示 success 或 `gh release view` 返回条目都不足以证明产物完整。

## 中断接续

先核对版本提交、tag 的本地 / 远端指向、workflow 和 Release，再决定补哪一步；不重复提交或覆盖已发布 tag。
把 tag、SHA、CI / Release 链接和实包验证范围写回本次计划。
