import fs from 'node:fs';
import path from 'node:path';

/** Resolve declared workspace exports from this checkout, including junction worktrees. */
export function workspacePublicSources(root = process.cwd()) {
  const packages = new Map();
  for (const directory of fs.readdirSync(path.join(root, 'packages'), { withFileTypes: true })) {
    if (!directory.isDirectory() || directory.name === 'node_modules') continue;
    const base = path.join(root, 'packages', directory.name);
    const manifest = path.join(base, 'package.json');
    if (!fs.existsSync(manifest)) continue;
    const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    packages.set(pkg.name, { base, exports: pkg.exports });
  }
  return {
    name: 'workspace-public-sources',
    setup(builder) {
      builder.onResolve({ filter: /^@duya\// }, ({ path: specifier }) => {
        const match = /^(@duya\/[^/]+)(.*)$/.exec(specifier);
        const pkg = packages.get(match?.[1]);
        if (!pkg) return { errors: [{ text: `Unknown workspace package: ${specifier}` }] };
        const subpath = match[2] ? `.${match[2]}` : '.';
        const entries = typeof pkg.exports === 'string'
          ? [['.', pkg.exports]]
          : Object.entries(pkg.exports ?? {});
        entries.sort(([a], [b]) => Number(a.includes('*')) - Number(b.includes('*')) || b.length - a.length);
        for (const [key, entry] of entries) {
          let capture = '';
          if (key.includes('*')) {
            const [prefix, suffix] = key.split('*');
            if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
            capture = subpath.slice(prefix.length, suffix ? -suffix.length : undefined);
          } else if (key !== subpath) continue;
          const target = typeof entry === 'string' ? entry : entry.import ?? entry.default ?? entry.require;
          if (typeof target !== 'string') continue;
          const source = path.resolve(pkg.base, target.replaceAll('*', capture).replace(/^\.\/dist\//, './src/').replace(/\.js$/, '.ts'));
          if (!fs.existsSync(source)) return { errors: [{ text: `Missing source for ${specifier}: ${source}` }] };
          return { path: source };
        }
        return { errors: [{ text: `Undeclared workspace export: ${specifier}` }] };
      });
    },
  };
}
