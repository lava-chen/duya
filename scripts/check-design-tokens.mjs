#!/usr/bin/env node
/**
 * check-design-tokens.mjs — 设计 token 的"用了但没注册"检查。
 *
 * 背景：Tailwind v4 只为 `@theme` 里声明的 key 生成工具类。写一个未声明的
 * 语义类（例如 `bg-chip`）**不会报错、也不会生成任何 CSS**，class 名照样
 * 出现在 DOM 上，元素只是默默继承了级联里的其它样式。于是代码里攒下了
 * 117 处这样的空操作类（bg-surface 76、bg-chip 19、bg-card 8 …），既没有
 * 编译期提示，review 也很难靠肉眼发现——因为"看起来是对的"。
 *
 * 本脚本把这条规则变成可执行的检查：
 *   1. 从 `src/styles/base.css` 收集所有已定义的 CSS 变量名（`--name`），
 *      这些是项目"承认存在"的语义名；
 *   2. 从 `src/styles/globals.css` 的 `@theme` 块收集已注册的 `--color-*`；
 *   3. 扫描 `src/**` 中的工具类用法，凡是 `bg-surface` 这种
 *      "变量存在但 @theme 未注册"的组合，一律报错。
 *
 * 为什么用"base.css 里定义过的变量名"做白名单，而不是列出所有 Tailwind
 * 内置色：后者需要维护一份永远落后的清单，且会把 `bg-cover`、`text-xs`、
 * `border-2` 这类非颜色工具类全拖进来。以项目自身的 CSS 变量为准，判别
 * 精度高且不需要维护。
 *
 * 用法：node scripts/check-design-tokens.mjs
 * 退出码：0 = 通过，1 = 存在未注册的 token。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const STYLES_DIR = join(ROOT, 'src', 'styles');
const SRC_DIR = join(ROOT, 'src');
const BASE_CSS = join(STYLES_DIR, 'base.css');
const GLOBALS_CSS = join(STYLES_DIR, 'globals.css');

/** 会消费 `--color-*` 语义色的工具类前缀。 */
const UTILITY_PREFIXES = [
  'bg', 'text', 'border', 'ring', 'fill', 'stroke',
  'from', 'via', 'to', 'outline', 'divide', 'decoration', 'accent', 'caret', 'shadow',
];

/** 这些名字即使是 CSS 变量，也不作为颜色工具类的语义名来校验。 */
const IGNORED_NAMES = new Set([
  'radius', 'shadow', 'font-sans', 'font-mono', 'font-serif',
]);

function readIfExists(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** 收集 CSS 中所有 `--name:` 定义的名字（去掉前导 `--`）。 */
function collectCssVariables(css) {
  const names = new Set();
  for (const match of css.matchAll(/--([a-z0-9-]+)\s*:/gi)) {
    const name = match[1];
    if (!IGNORED_NAMES.has(name)) names.add(name);
  }
  return names;
}

/** 从 globals.css 的 `@theme` 块里取出已注册的颜色 key。 */
function collectRegisteredThemeColors(css) {
  const registered = new Set();
  const themeBlocks = css.matchAll(/@theme\s*\{([\s\S]*?)\n\}/g);
  for (const block of themeBlocks) {
    for (const match of block[1].matchAll(/--color-([a-z0-9-]+)\s*:/gi)) {
      registered.add(match[1]);
    }
  }
  return registered;
}

function* walkSourceFiles(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      yield* walkSourceFiles(full);
      continue;
    }
    if (/\.(tsx?|jsx?)$/.test(entry) && !/\.test\.(tsx?|jsx?)$/.test(entry)) {
      yield full;
    }
  }
}

function main() {
  const baseCss = readIfExists(BASE_CSS);
  const globalsCss = readIfExists(GLOBALS_CSS);
  if (!baseCss || !globalsCss) {
    console.error('[design-tokens] cannot read style sources; expected src/styles/{base,globals}.css');
    process.exit(1);
  }

  const cssVariables = collectCssVariables(baseCss);
  const registered = collectRegisteredThemeColors(globalsCss);

  /** name -> [{ file, line, className }] */
  const violations = new Map();

  for (const file of walkSourceFiles(SRC_DIR)) {
    const content = readFileSync(file, 'utf8');
    const lines = content.split('\n');
    lines.forEach((line, index) => {
      // 跳过注释行，避免把文档里举例的类名当成真实用法。
      const trimmed = line.trim();
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return;

      // 前导 `(?<![\w-])` 很关键：CJK 代码里经常出现 `var(--text-muted)`、
      // `--border-weak` 这类 CSS 变量引用，它们和工具类长得一样，但前面是
      // `-`。不排除掉就会把 94 处 CSS 变量引用误报成"未注册的工具类"，
      // 使检查结果失去可信度——误报比不检查更糟，因为会诱导人去改错地方。
      for (const match of line.matchAll(/(?<![\w-])([a-z]+)-([a-z0-9-]+)\b/g)) {
        const [, prefix, name] = match;
        if (!UTILITY_PREFIXES.includes(prefix)) continue;
        // 只校验"项目自己的 CSS 变量名"——Tailwind 内置色不在此集合里。
        if (!cssVariables.has(name)) continue;
        if (registered.has(name)) continue;
        // 形如 `border-border/50`（带透明度）也走同一判断，name 已剥离。
        const list = violations.get(name) ?? [];
        list.push({ file: relative(ROOT, file).split(sep).join('/'), line: index + 1, className: match[0] });
        violations.set(name, list);
      }
    });
  }

  if (violations.size === 0) {
    console.log(
      `[design-tokens] OK — ${registered.size} color tokens registered, no undeclared usage found.`,
    );
    return;
  }

  console.error('[design-tokens] undeclared semantic color utilities found.\n');
  console.error(
    'These classes generate NO CSS because their token is missing from the\n' +
      '`@theme` block in src/styles/globals.css. Add `--color-<name>: var(--<name>);`\n' +
      'there, or stop using the class.\n',
  );
  for (const [name, usages] of [...violations.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.error(`  ${name}  (${usages.length} usage${usages.length === 1 ? '' : 's'})`);
    for (const usage of usages.slice(0, 5)) {
      console.error(`    - ${usage.file}:${usage.line}  ${usage.className}`);
    }
    if (usages.length > 5) console.error(`    … and ${usages.length - 5} more`);
  }
  console.error('');
  process.exit(1);
}

main();
