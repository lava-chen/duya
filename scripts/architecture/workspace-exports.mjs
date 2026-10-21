/** Resolve manifest exports without consulting compiled output or node_modules. */
export function workspaceExportTargets(manifest, exportKey) {
  const declared = manifest.exports;
  if (declared === undefined) {
    return exportKey === '.' && typeof manifest.main === 'string'
      ? [manifest.main] : [];
  }
  let value;
  let wildcard;
  if (typeof declared === 'string' || Array.isArray(declared) || declared === null) {
    if (exportKey !== '.') return [];
    value = declared;
  } else if (Object.keys(declared).every((key) => !key.startsWith('.'))) {
    if (exportKey !== '.') return [];
    value = declared;
  } else if (Object.hasOwn(declared, exportKey)) {
    value = declared[exportKey];
  } else {
    const matches = Object.keys(declared).filter((key) => {
      const star = key.indexOf('*');
      return star >= 0 && exportKey.length >= key.length - 1
        && exportKey.startsWith(key.slice(0, star))
        && exportKey.endsWith(key.slice(star + 1));
    }).sort((a, b) => b.indexOf('*') - a.indexOf('*') || b.length - a.length);
    const key = matches[0];
    if (!key) return [];
    const star = key.indexOf('*');
    wildcard = exportKey.slice(star, exportKey.length - (key.length - star - 1));
    value = declared[key];
  }
  const targets = [];
  function collect(candidate) {
    if (typeof candidate === 'string') {
      const target = wildcard === undefined ? candidate : candidate.replaceAll('*', wildcard);
      // Invalid package targets must never become public source escape edges.
      if (target.startsWith('./') && !target.split('/').slice(1).some(
        (part) => part === '..' || part === '.' || part === 'node_modules',
      )) targets.push(target);
    } else if (Array.isArray(candidate)) {
      for (const item of candidate) collect(item);
    } else if (candidate && typeof candidate === 'object') {
      for (const [condition, item] of Object.entries(candidate)) {
        if (['types', 'node', 'import', 'require', 'default'].includes(condition)) collect(item);
      }
    }
  }
  collect(value);
  return targets;
}
