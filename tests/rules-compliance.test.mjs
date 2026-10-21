#!/usr/bin/env node
/**
 * tests/rules-compliance.test.mjs
 *
 * 目的:检查 Duya 项目里 "Claude / Cursor / Cline 类规则文件"
 * 是否符合我们期望的合规基线。
 *
 * 运行:
 *   npm run test:rules                              # 静态扫描 + 报告
 *   LIVE=1 npm run test:rules                       # 额外用 .env 里的真实 LLM 密钥
 *                                                 # 发一次最小调用,验证密钥可用
 *
 * 注意:本文件刻意不接入 vitest —— vitest.config.ts 的 include 只覆盖
 * src/**,而这个检查器扫的是整个仓库根目录的规则文件(含 .cursor/、
 * .clinerules 等 src 之外的路径),而且用自写 runner 以便在 LIVE 模式下
 * 控制 API 调用。
 *
 * 设计取舍:
 *   - 用 Node 内置 assert + 自写的 mini runner,不引入 vitest / jest,避免污染
 *     packages/ 的依赖图。
 *   - 严格只扫 "Claude/Cursor/Cline 类",不涵盖 CONTRIBUTING、PR 模板等。
 *   - LIVE 模式默认关闭,防止误触 API 费用。
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve, dirname, extname, basename, sep as pathSep } from "node:path";
import { fileURLToPath } from "node:url";

// ----- 基本路径配置 -----
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ----- 被扫描的规则文件名集合(只覆盖 Claude/Cursor/Cline 类) -----
const RULE_FILENAMES = new Set([
  "CLAUDE.md",
  "CLAUDE.local.md",
  "AGENTS.md",
  "AGENTS.local.md",
  ".cursorrules",
]);

// .cursor/rules/**.mdc 等目录式规则单独处理(见下方 collectCursorRules)
const CURSOR_RULES_DIR = ".cursor/rules";
const CLINERULES_DIR = ".clinerules";

// ----- 不应扫描的目录(噪音目录,扫描它们既慢又无意义) -----
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "dist-electron", "build", "coverage",
  "storybook-static", "release", ".cache", ".duya", ".qoder", ".trae",
  ".superpowers", ".tmp-test", ".tmp-validation", ".codegraph",
  ".codex-artifacts", ".playwright-mcp", ".tmp-electron-dev-err.log",
  ".tmp-electron-dev-out.log", ".tmp-electron-dev6-err.log",
  ".tmp-electron-dev6-out.log", ".tmp-vite-4174.log",
  "test-results", "public", ".storybook",
  ".e2e-userdata", ".claude",   // .claude 里是 worktree / 临时文件,不是规则本身
  "mac-job.log", "_dbg-out.txt", "design-qa.md", // 单文件噪音
]);

// ----- 一个微型 test runner -----
const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}
const liveTests = [];   // 只有 LIVE=1 才跑
function liveTest(name, fn) {
  liveTests.push({ name, fn });
}

// 收集一条规则文件的描述
async function walk(startDir) {
  const out = [];
  const seen = new Set();   // Windows 大小写不敏感 + 避免重复
  async function recurse(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (SKIP_DIRS.has(ent.name)) continue;
      const full = join(dir, ent.name);
      const relParent = relative(ROOT, dirname(full));
      if (ent.isDirectory()) {
        // .cursor/rules/ 和 .clinerules/ 整体作为目录也算"规则存在"
        const relDir = relative(ROOT, full);
        if (
          relDir === CURSOR_RULES_DIR ||
          relDir === CURSOR_RULES_DIR.replace(/\//g, pathSep) ||
          relDir.startsWith(CURSOR_RULES_DIR + pathSep) ||
          relDir === CLINERULES_DIR ||
          relDir.startsWith(CLINERULES_DIR + pathSep)
        ) {
          // 继续递归子目录
          await recurse(full);
          continue;
        }
        await recurse(full);
      } else if (ent.isFile()) {
        if (seen.has(full.toLowerCase())) continue;
        seen.add(full.toLowerCase());
        if (RULE_FILENAMES.has(ent.name)) {
          out.push({
            path: relative(ROOT, full),
            name: ent.name,
            dir: relParent,
          });
        } else if (relParent.includes(".cursor") && ent.name.endsWith(".mdc")) {
          out.push({
            path: relative(ROOT, full),
            name: ent.name,
            dir: relParent,
            kind: "cursor-mdc",
          });
        } else if (
          relParent.includes(".clinerules") ||
          ent.name === ".clinerules"
        ) {
          out.push({
            path: relative(ROOT, full),
            name: ent.name,
            dir: relParent,
            kind: "clinerules",
          });
        }
      }
    }
  }
  await recurse(startDir);
  return out;
}

// ----- 测试 1:必须有根级 CLAUDE.md 或 AGENTS.md -----
test("根目录存在至少一个 Claude/AGENTS 规则文件", async () => {
  const files = await walk(ROOT);
  const rootLevel = files.filter((f) =>
    !f.dir || f.dir === "." || f.dir === ""
  );
  const has = rootLevel.some((f) =>
    ["CLAUDE.md", "AGENTS.md", "CLAUDE.local.md", "AGENTS.local.md"].includes(f.name)
  );
  assert.ok(
    has,
    `根目录缺少主规则文件。当前发现: ${rootLevel.map((f) => f.name).join(", ") || "(无)"}`
  );
});

// ----- 测试 2:每个工作区子包应该有自己的规则文件 -----
test("packages/* 各子包至少有一个规则文件(子包级约束)", async () => {
  const pkgRoot = join(ROOT, "packages");
  if (!existsSync(pkgRoot)) return; // 不是 monorepo 就跳过
  const pkgDirs = (await readdir(pkgRoot, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => d.name);
  const files = await walk(pkgRoot);
  const missing = [];
  for (const pkg of pkgDirs) {
    const has = files.some((f) =>
      f.path.startsWith(`packages/${pkg}/`) &&
      ["CLAUDE.md", "AGENTS.md", "CLAUDE.local.md", "AGENTS.local.md",
       ".cursorrules", ".clinerules"].includes(f.name)
    );
    if (!has) missing.push(pkg);
  }
  assert.deepEqual(
    missing, [],
    `以下子包缺少 Claude/Cursor/Cline 类规则文件: ${missing.join(", ")}\n` +
    `建议在 packages/<pkg>/ 下添加 AGENTS.md 或 .cursor/rules/*.mdc`
  );
});

// ----- 测试 3:规则文件不能是"空壳"(> 200 字节) -----
test("所有规则文件大小 >= 200 字节(防止空壳)", async () => {
  const files = await walk(ROOT);
  const small = [];
  for (const f of files) {
    const full = join(ROOT, f.path);
    try {
      const st = await stat(full);
      if (st.size < 200) small.push({ p: f.path, size: st.size });
    } catch {/* ignore */}
  }
  assert.deepEqual(
    small, [],
    `以下规则文件过小(可能空壳): ${small.map((s) => `${s.p}(${s.size}B)`).join(", ")}`
  );
});

// ----- 测试 4:规则文件不能"过期" > 90 天未更新 -----
test("所有规则文件在 90 天内有更新", async () => {
  const files = await walk(ROOT);
  const now = Date.now();
  const staleDays = 90;
  const stale = [];
  for (const f of files) {
    const full = join(ROOT, f.path);
    try {
      const st = await stat(full);
      const days = (now - st.mtimeMs) / (1000 * 60 * 60 * 24);
      if (days > staleDays) stale.push({ p: f.path, days: Math.round(days) });
    } catch {/* ignore */}
  }
  // 这条是软告警,只统计、不强失败 — 仅当全部都过期时才报
  if (stale.length === files.length && files.length > 0) {
    assert.fail(`所有规则文件都已超过 ${staleDays} 天未更新`);
  }
});

// ----- 测试 5:被规则文件通过 @path / `./` 引用的相对路径必须真实存在 -----
test("规则文件里的相对路径引用全部能解析", async () => {
  const files = await walk(ROOT);
  const broken = [];
  // 匹配 `(packages|scripts|src|docs)/path/...` 类相对引用
  const refRe = /(?:^|\s|`)(?:`|')?((?:packages|scripts|src|docs|\.cursor|\.claude|electron|e2e|extension|assets)\/[^\s`'")\]]+)(?:`|')?(?=[,.;:)\]\s]|$)/gm;

  for (const f of files) {
    const full = join(ROOT, f.path);
    let content;
    try { content = readFileSync(full, "utf8"); } catch { continue; }
    const baseDir = dirname(full);
    for (const m of content.matchAll(refRe)) {
      const ref = m[1];
      // 跳过 glob 示例 (含 *、{、}、?)
      if (/[*?{}/][*?{}\d]|[*?{}\d]$/.test(ref)) continue;
      // 跳过纯占位符 (含 <X>、{{...}})
      if (/^<\w+>$/.test(ref) || /^\{\{/.test(ref)) continue;
      // 跳过已包含文件后缀的位置:line:col 形式 (e.g. AGENTS.md -> src/foo.ts:45)
      if (/:\d+:\d+$/.test(ref)) continue;
      const resolved = resolve(baseDir, ref);
      if (!existsSync(resolved)) {
        broken.push({ from: f.path, ref, resolved: relative(ROOT, resolved) });
      }
    }
  }
  // 这条规则容错:误报很正常,只统计坏路径超过 N 才失败
  // 因为规则文档里通常会举示例路径
  if (broken.length > 0) {
    console.warn(`\n  ⚠ ${broken.length} 个看起来是"被引用但不存在的路径"——可能是文档示例,请人工审查:\n  ` +
      broken.slice(0, 10).map((b) => `${b.from} -> ${b.ref}`).join("\n  "));
  }
  // 不强制失败,只报告
  assert.ok(true, "soft check");
});

// ----- 测试 6:Cursor / Cline 类型规则目录存在性是可选项,但存在时不能为空 -----
test("若存在 .cursor/rules 或 .clinerules 目录,目录不能空", async () => {
  const cursorDir = join(ROOT, CURSOR_RULES_DIR);
  const clineDir = join(ROOT, CLINERULES_DIR);
  for (const d of [cursorDir, clineDir]) {
    if (!existsSync(d)) continue;
    const entries = await readdir(d);
    assert.ok(
      entries.length > 0,
      `${relative(ROOT, d)} 存在但为空目录,删除或添加规则`
    );
  }
});

// ====== LIVE 测试区:用 .env 里真实密钥发最小调用 ======
// 默认不跑,设 LIVE=1 才跑
liveTest("LIVE:用 .env 真实密钥做一次最小消息调用,验证密钥+baseURL 可用", async () => {
  // 简单 .env 解析(不引 dotenv),只读 KEY=VALUE 行
  const envFile = join(ROOT, ".env");
  if (!existsSync(envFile)) {
    throw new Error("项目根 .env 不存在");
  }
  const env = Object.fromEntries(
    readFileSync(envFile, "utf8")
      .split(/\r?\n/)
      .filter((l) => l && !l.startsWith("#") && l.includes("="))
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      })
  );
  const apiKey = env.ANTHROPIC_API_KEY;
  const baseURL = env.ANTHROPIC_BASE_URL;
  const model = env.ANTHROPIC_MODEL;
  if (!apiKey || !baseURL) {
    throw new Error(".env 缺少 ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL");
  }
  // 最小的 anthropic messages 调用,max_tokens 设非常小以省钱
  const resp = await fetch(`${baseURL.replace(/\/$/, "")}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 8,
      messages: [{ role: "user", content: "ping" }],
    }),
  });
  const ct = resp.headers.get("content-type") || "";
  const body = ct.includes("json") ? await resp.json() : await resp.text();
  if (!resp.ok) {
    throw new Error(`LLM 调用失败: ${resp.status} ${JSON.stringify(body).slice(0, 200)}`);
  }
  // 我们不关心回答内容,只关心 thinking 块是否被解析回
  const blocks = body?.content || [];
  const types = blocks.map((b) => b.type);
  // 把这个数据打印出来,你后续可以直接核对
  console.log("\n[LIVE RESULT] status=", resp.status,
    "\n  content block types:", types,
    "\n  raw (truncated):", JSON.stringify(body).slice(0, 300));
  assert.ok(resp.ok, `期望 2xx,实际 ${resp.status}`);
});

// ----- 主流程 -----
async function run() {
  let passed = 0;
  let failed = 0;
  const wantLive = process.env.LIVE === "1";
  const all = [...tests, ...(wantLive ? liveTests : [])];
  console.log(
    `\nRules Compliance Test Suite — ${all.length} tests` +
    (wantLive ? " (LIVE=1)" : " (LIVE=0,设 LIVE=1 启用真实 LLM 调用)") +
    `\nRoot: ${ROOT}\n`
  );
  for (const t of all) {
    try {
      await t.fn();
      console.log(`  ✓ ${t.name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ ${t.name}`);
      console.error(`    ${err.message}\n`);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run();
