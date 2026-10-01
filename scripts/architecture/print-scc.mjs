// Print SCC composition grouped by package/src-module, for the audit doc.
import { execFileSync } from "node:child_process";

const out = execFileSync(process.execPath, ["scripts/architecture/audit-modules.mjs", "--json"], {
  encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
});
const r = JSON.parse(out);

console.log("SCC count:", r.meta.cyclicGroups);
console.log("agent/src top-level modules:", r.meta.agentSrcModules);
console.log("agent/src files (no tests):", r.meta.agentSrcFiles);
console.log("agent/src LOC (no tests):", r.meta.agentSrcLoc);
console.log("");
for (const c of r.cycles.slice(0, 6)) {
  const d = {};
  for (const f of c.files) {
    const p = f.match(/^packages\/([^/]+)\/src\/([^/]+)/);
    const k = p ? `${p[1]}/${p[2]}` : "other";
    d[k] = (d[k] ?? 0) + 1;
  }
  console.log(`SCC size ${c.size}:`);
  for (const [k, n] of Object.entries(d).sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(n).padStart(3)}  ${k}`);
  }
  console.log("");
}
