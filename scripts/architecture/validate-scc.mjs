// Validate Tarjan SCC output against an independent BFS reachability check.
import fs from "node:fs";
import path from "node:path";

const SKIP = new Set(["node_modules", "dist", "dist-electron", ".git", "bundle", "build", "release", "__tests__", "tests"]);
function walk(d, o = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(d, e.name);
    e.isDirectory() ? walk(p, o) : [".ts", ".tsx"].includes(path.extname(e.name)) && o.push(p);
  }
  return o;
}
// CR/LF excluded: a specifier is never multi-line, and allowing them let a
// match start inside ordinary code and capture a slice of the file. Same regex
// as the audit scripts — see scripts/architecture/audit-imports.mjs.
const re = /(?:from\s+|import\s*\(|require\s*\()\s*["']([^"'\r\n]+)["']/g;
function res(base) {
  const c = []; const e = path.extname(base);
  if (e === ".js") { const s = base.slice(0, -3); c.push(`${s}.ts`, `${s}.tsx`, `${s}.js`); }
  else c.push(`${base}.ts`, `${base}.tsx`, `${base}.js`, base);
  c.push(`${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`);
  for (const x of c) { try { if (fs.existsSync(x) && fs.statSync(x).isFile()) return x; } catch { /* ignore */ } }
  return null;
}

const norm = (p) => path.resolve(p).replace(/\\/g, "/");
const files = walk("packages").map(norm);
const g = new Map();
for (const f of files) {
  const txt = fs.readFileSync(f, "utf8");
  const ds = []; let m; re.lastIndex = 0;
  while ((m = re.exec(txt))) {
    if (!m[1].startsWith(".")) continue;
    const t = res(path.resolve(path.dirname(f), m[1]));
    if (t) { const r = norm(t); if (r.startsWith(norm("packages"))) ds.push(r); }
  }
  g.set(f, ds);
}

// BFS reachability
function reaches(src, dst) {
  if (src === dst) return true;
  const seen = new Set([src]);
  let q = [src];
  while (q.length) {
    const nq = [];
    for (const n of q) {
      for (const w of g.get(n) ?? []) {
        if (w === dst) return true;
        if (!seen.has(w)) { seen.add(w); nq.push(w); }
      }
    }
    q = nq;
  }
  return false;
}

// Tarjan
const idx = new Map(), low = new Map(), on = new Set(), st = [], sccs = [];
let c = 0;
function sc(v) {
  idx.set(v, c); low.set(v, c); c += 1; st.push(v); on.add(v);
  for (const w of g.get(v) ?? []) {
    if (!idx.has(w)) { sc(w); low.set(v, Math.min(low.get(v), low.get(w))); }
    else if (on.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
  }
  if (low.get(v) === idx.get(v)) {
    const comp = []; let w;
    do { w = st.pop(); on.delete(w); comp.push(w); } while (w !== v);
    if (comp.length > 1) sccs.push(comp);
  }
}
for (const f of files) if (!idx.has(f)) sc(f);
sccs.sort((a, b) => b.length - a.length);

console.log("Tarjan SCC count:", sccs.length);
// Validate a sample of members of each SCC for mutual reachability
let bad = 0, checked = 0;
for (const comp of sccs.slice(0, 5)) {
  const a = comp[0];
  for (const b of comp.slice(1, 4)) {
    checked += 1;
    if (!reaches(a, b)) { bad += 1; console.log(`  FALSE POSITIVE: ${a} cannot reach ${b}`); }
  }
}
console.log(`validated ${checked} pairs, false positives: ${bad}`);

// Ground truth: brute-force SCC by mutual-reachability closure
const comp0 = sccs[0] ?? [];
const truth = comp0.filter((x) => comp0.every((y) => x === y || reaches(x, y)));
console.log(`\nSCC#1 claimed size ${comp0.length}; BFS-confirmed mutually reachable: ${truth.length}`);
if (truth.length < comp0.length) console.log("=> Tarjan over-merged; BFS is authoritative");
