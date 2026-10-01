// Manually verify one claimed cycle: goal-mode -> ... -> goal-mode
import fs from "node:fs";
import path from "node:path";

const re = /(?:from\s+|import\s*\(|require\s*\()\s*["']([^"']+)["']/g;

function resolveFile(base) {
  const c = [];
  const e = path.extname(base);
  if (e === ".js" || e === ".mjs") { const s = base.slice(0, -e.length); c.push(`${s}.ts`, `${s}.tsx`, `${s}.js`); }
  else c.push(`${base}.ts`, `${base}.tsx`, `${base}.js`, base);
  c.push(`${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`);
  for (const x of c) { try { if (fs.existsSync(x) && fs.statSync(x).isFile()) return x; } catch {} }
  return null;
}

const norm = (p) => path.resolve(p).replace(/\\/g, "/");
const start = norm(process.argv[2]);
const target = norm(process.argv[3]);
// BFS from start to target over relative imports
const seen = new Set();
let frontier = [[start, [start]]];
const paths = [];
while (frontier.length && paths.length < 1) {
  const next = [];
  for (const [node, trail] of frontier) {
    if (node === target && trail.length > 1) { paths.push(trail); continue; }
    if (seen.has(node) || seen.size > 20000) continue;
    seen.add(node);
    const txt = fs.readFileSync(node, "utf8");
    let m; re.lastIndex = 0;
    while ((m = re.exec(txt))) {
      if (!m[1].startsWith(".")) continue;
      const t = resolveFile(path.resolve(path.dirname(node), m[1]));
      if (t) next.push([norm(t), [...trail, norm(t)]]);
    }
  }
  frontier = next;
}

console.log(`searching ${start} -> ${target}`);
if (paths.length) {
  for (const p of paths.slice(0, 3)) {
    console.log("\nCYCLE PATH FOUND:");
    for (const f of p) console.log("   ", f);
  }
} else {
  console.log("no path found (BFS explored", seen.size, "files)");
}
