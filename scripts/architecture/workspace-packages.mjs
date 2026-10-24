import fs from "node:fs";
import path from "node:path";

/** Load the workspace package registry from each package manifest. */
export function loadWorkspacePackages(root) {
  const registry = new Map();
  const packagesDir = path.join(root, "packages");
  if (!fs.existsSync(packagesDir)) return registry;

  for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = `packages/${entry.name}`;
    const manifestPath = path.join(root, dir, "package.json");
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (typeof manifest.name !== "string" || manifest.name.length === 0) continue;
    registry.set(manifest.name, { dir, manifest });
  }

  return registry;
}
