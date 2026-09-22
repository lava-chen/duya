#!/usr/bin/env node
/**
 * verify-design-tokens-compiled.mjs — 编译级 token 校验。
 *
 * `check-design-tokens.mjs` 做的是**静态**检查（"用到的类是否在 @theme 里
 * 声明过"）。本脚本补上另一半：真的跑一遍 Tailwind 编译管线，确认这些语义
 * 类能产出 CSS。
 *
 * 两者不能互相替代。静态检查查不出下面这种情况：`@theme` 里声明了
 * `--color-foo: var(--foo)`，但 `--foo` 这个真实变量根本不存在——工具类会
 * 生成一条 `background-color: var(--foo)` 的规则，浏览器解析失败后回退到
 * 透明，看起来仍然是"没生效"，而静态检查会一路绿灯。
 *
 * 用法：node scripts/verify-design-tokens-compiled.mjs
 * 退出码：0 = 全部编译成功，1 = 有类没有产出 CSS。
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 覆盖 @theme 里登记的全部颜色 key（新增 token 时这里会因遗漏而失败）。 */
const TOKENS = [
  'foreground', 'muted', 'muted-foreground', 'text', 'border', 'background',
  'surface', 'surface-hover', 'surface-solid', 'chip', 'card', 'popover',
  'menu', 'input', 'accent', 'accent-soft', 'success', 'success-soft',
  'warning', 'warning-soft', 'error', 'error-soft',
];

const probes = TOKENS.flatMap((token) => [`bg-${token}`, `text-${token}`, `border-${token}`]);

const workDir = mkdtempSync(join(tmpdir(), 'duya-token-probe-'));
const contentFile = join(workDir, 'probe.html');
const entryFile = join(workDir, 'probe.css');

writeFileSync(contentFile, `<div class="${probes.join(' ')}"></div>`);
// @source 用绝对路径指向探针文件；globals.css 用绝对路径导入，避免相对
// 解析受临时目录影响。
writeFileSync(
  entryFile,
  `@import ${JSON.stringify(join(ROOT, 'src', 'styles', 'globals.css').replace(/\\/g, '/'))};\n` +
    `@source ${JSON.stringify(contentFile.replace(/\\/g, '/'))};\n`,
);

let output;
try {
  const result = await postcss([tailwind()]).process(readFileSync(entryFile, 'utf8'), {
    from: entryFile,
  });
  output = result.css;
} catch (error) {
  console.error('[design-tokens:compile] Tailwind failed to compile the stylesheet.');
  console.error(error instanceof Error ? error.message : error);
  rmSync(workDir, { recursive: true, force: true });
  process.exit(1);
}

rmSync(workDir, { recursive: true, force: true });

const missing = probes.filter((cls) => !output.includes(`.${cls}`));

if (missing.length === 0) {
  console.log(
    `[design-tokens:compile] OK — ${probes.length} utilities compiled from ${TOKENS.length} tokens.`,
  );
  process.exit(0);
}

console.error('[design-tokens:compile] these classes produced no CSS:\n');
for (const cls of missing) console.error(`  ${cls}`);
console.error(
  '\nEither the token is missing from the `@theme` block in src/styles/globals.css,\n' +
    'or it maps to a CSS variable that does not exist in src/styles/base.css.\n',
);
process.exit(1);
