#!/usr/bin/env node
/**
 * Compare every resolved cross-owner source import visible to the slice graph
 * against audit-imports.mjs over their shared apps/ and packages/ roots.
 * Duplicates are preserved: the unit is an import occurrence, keyed by
 * (from, specifier, target), not a deduplicated graph adjacency.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, buildGraphs, importsOf, ownerOf, resolveTarget } from "./import-graph.mjs";

const COMMON_ROOTS = ["apps/", "packages/"];
const isCommonRoot = (file) => COMMON_ROOTS.some((root) => file.startsWith(root));
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const triple = (from, spec, to) => JSON.stringify([from, spec, to]);

function unmatched(left, right) {
  const counts = new Map();
  for (const key of right) counts.set(key, (counts.get(key) ?? 0) + 1);
  const extra = [];
  for (const key of left) {
    const count = counts.get(key) ?? 0;
    if (count === 0) extra.push(JSON.parse(key));
    else counts.set(key, count - 1);
  }
  return extra;
}

export function compareCrossBoundaryImports() {
  const graph = buildGraphs();
  const graphTriples = [];

  for (const from of graph.files.filter(isCommonRoot)) {
    const fromOwner = ownerOf(from);
    for (const { spec } of importsOf(path.join(ROOT, from))) {
      if (!spec.startsWith(".") && !spec.startsWith("@duya/")) continue;
      const to = resolveTarget(spec, from);
      if (to === null || ownerOf(to) === fromOwner) continue;
      graphTriples.push(triple(from, spec, to));
    }
  }

  const auditJson = execFileSync(
    process.execPath,
    [path.join(ROOT, "scripts/architecture/audit-imports.mjs"), "--json"],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  const audit = JSON.parse(auditJson);
  const auditTriples = audit.crossBoundaryEdges
    .filter((edge) => isCommonRoot(edge.from) && ["public", "deep", "relative"].includes(edge.kind))
    .map((edge) => triple(edge.from, edge.spec, edge.to));

  graphTriples.sort(compare);
  auditTriples.sort(compare);
  return {
    graphCount: graphTriples.length,
    auditCount: auditTriples.length,
    graphOnly: unmatched(graphTriples, auditTriples),
    auditOnly: unmatched(auditTriples, graphTriples),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = compareCrossBoundaryImports();
  if (result.graphOnly.length > 0 || result.auditOnly.length > 0) {
    process.stderr.write(
      `cross-owner import mismatch: graph=${result.graphCount}, audit=${result.auditCount}\n` +
      `graph only (first 10): ${JSON.stringify(result.graphOnly.slice(0, 10))}\n` +
      `audit only (first 10): ${JSON.stringify(result.auditOnly.slice(0, 10))}\n`,
    );
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `resolved cross-owner triples: ${result.graphCount}\n` +
      `audit-imports resolved cross-boundary triples: ${result.auditCount}\n` +
      "tuple disagreements: 0\n",
    );
  }
}
