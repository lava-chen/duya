// Identity-usage census: which identifiers are used where, and how far do they spread?
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const norm = (p) => path.relative(ROOT, p).split(path.sep).join("/");
const SKIP = new Set(["node_modules", "dist", "bundle", "build", "release", ".git",
  "coverage", "storybook-static", ".e2e-userdata", "__tests__", "tests"]);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    e.isDirectory() ? walk(full, out) : /\.(ts|tsx)$/.test(e.name) && out.push(full);
  }
  return out;
}

const files = ["src", "electron", "packages"].flatMap((r) => walk(path.join(ROOT, r)));

const IDENTS = {
  sessionId: /\bsessionId\b|\bsession_id\b/g,
  runId: /\brunId\b|\brun_id\b/g,
  projectId: /\bprojectId\b|\bproject_id\b/g,
  agentId: /\bagentId\b|\bagent_id\b/g,
  taskId: /\btaskId\b|\btask_id\b/g,
  goalId: /\bgoalId\b|\bgoal_id\b/g,
  workspaceId: /\bworkspaceId\b|\bworkspace_id\b/g,
  channelId: /\bchannelId\b|\bchannel_id\b/g,
};

function group(rel) {
  if (rel.startsWith("apps/desktop/src/renderer/")) return "src(renderer)";
  if (rel.startsWith("apps/desktop/src/preload/")) return "electron/preload";
  if (rel.startsWith("apps/desktop/src/main/")) return `electron/${rel.split("/")[4]}`;
  const m = rel.match(/^packages\/([^/]+)\/src\/(?:([^/]+)\/)?/);
  if (m) return m[2] ? `pkg:${m[1]}/${m[2]}` : `pkg:${m[1]}/`;
  if (rel.startsWith("packages/")) return "pkg:(root)";
  return "other";
}

const out = {};
for (const [name, re] of Object.entries(IDENTS)) {
  const byGroup = new Map();
  let total = 0, fileCount = 0;
  for (const f of files) {
    const t = fs.readFileSync(f, "utf8");
    re.lastIndex = 0;
    const n = (t.match(re) ?? []).length;
    if (!n) continue;
    total += n; fileCount += 1;
    const g = group(norm(f));
    byGroup.set(g, (byGroup.get(g) ?? 0) + n);
  }
  out[name] = {
    total, fileCount,
    spread: [...byGroup.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10),
  };
}

for (const [name, v] of Object.entries(out)) {
  console.log(`\n=== ${name}  total ${v.total} refs in ${v.fileCount} files ===`);
  for (const [g, n] of v.spread) console.log(`   ${String(n).padStart(6)}  ${g}`);
}
