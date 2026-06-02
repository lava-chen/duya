// packages/plugin-core/src/mcp/env-expansion.ts
// Pure env-variable substitution for plugin MCP server configs. All
// environment is passed in explicitly — this module does NOT read
// `process.env`, the plugin registry, or any DB. Per Rev 5 note 6, the
// pure-function boundary is preserved so plugin-core stays dependency-free.

/**
 * Substitute ${VAR} and ${VAR:-default} in `value` against the given
 * environment record. Returns the expanded string and a list of
 * `missingVars` (i.e. referenced variables that are not present AND have
 * no default). Pure function; same input always yields same output.
 *
 * Recognized syntaxes:
 *   - ${VAR}            replaced with env[VAR]; tracked as missing if absent
 *   - ${VAR:-default}   replaced with env[VAR] if present, otherwise 'default'
 *   - $$                literal '$' (escape)
 *   - $NAME             only expanded when the next char is one of {}_:-/\
 *                       and the name matches [A-Za-z_][A-Za-z0-9_]*
 *
 * Variables with default syntax are NEVER tracked as missing; the default
 * is the desired behavior.
 */
export function expandEnvVarsInString(
  value: string,
  environment: Record<string, string>,
): { expanded: string; missingVars: string[] } {
  const missingVars: string[] = [];
  let out = '';
  let i = 0;
  while (i < value.length) {
    const ch = value[i];
    if (ch !== '$') {
      out += ch;
      i++;
      continue;
    }
    // '$$' is a literal '$' escape.
    if (value[i + 1] === '$') {
      out += '$';
      i += 2;
      continue;
    }
    // '${...}' form.
    if (value[i + 1] === '{') {
      const close = value.indexOf('}', i + 2);
      if (close === -1) {
        // Unterminated; emit verbatim and stop.
        out += value.slice(i);
        break;
      }
      const inner = value.slice(i + 2, close);
      // `${user_config.X}` is handled by `substituteUserConfigVariables`,
      // not by env expansion. Pass it through verbatim and do not track
      // it as a missing env var. (Bare `$user_config.X` form is a no-op
      // here; that pattern is not part of the user_config contract.)
      if (inner.startsWith('user_config.')) {
        out += value.slice(i, close + 1);
        i = close + 1;
        continue;
      }
      const sep = inner.indexOf(':-');
      let varName: string;
      let defaultValue: string | undefined;
      if (sep === -1) {
        varName = inner;
        defaultValue = undefined;
      } else {
        varName = inner.slice(0, sep);
        defaultValue = inner.slice(sep + 2);
      }
      if (Object.prototype.hasOwnProperty.call(environment, varName)) {
        out += environment[varName];
      } else if (defaultValue !== undefined) {
        out += defaultValue;
      } else {
        out += value.slice(i, close + 1);
        if (!missingVars.includes(varName)) missingVars.push(varName);
      }
      i = close + 1;
      continue;
    }
    // Bare '$NAME' form. Only treat as expansion when the next char is a
    // valid identifier start AND the name is a valid identifier. We also
    // skip names beginning with `user_config` because those are handled
    // by `substituteUserConfigVariables` (and only in the ${...} form).
    const next = value[i + 1];
    if (next === undefined) {
      out += ch;
      i++;
      continue;
    }
    if (!/[A-Za-z_]/.test(next)) {
      out += ch;
      i++;
      continue;
    }
    let j = i + 1;
    while (j < value.length && /[A-Za-z0-9_]/.test(value[j])) j++;
    const varName = value.slice(i + 1, j);
    if (varName === 'user_config' || varName.startsWith('user_config_')) {
      // Bare-form `user_config` references are not a recognized syntax;
      // emit verbatim and do not track as a missing var.
      out += value.slice(i, j);
      i = j;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(environment, varName)) {
      out += environment[varName];
    } else {
      out += value.slice(i, j);
      if (!missingVars.includes(varName)) missingVars.push(varName);
    }
    i = j;
  }
  return { expanded: out, missingVars };
}

/**
 * Substitute plugin-specific variables in `value`:
 *   - ${DUYA_PLUGIN_ROOT}  → plugin.root
 *   - ${DUYA_PLUGIN_DATA}  → plugin.dataPath
 *
 * Pure. If either field is missing from `plugin`, the corresponding
 * variable is reported in `missingVars` and the literal text is left
 * unexpanded.
 */
export function substitutePluginVariables(
  value: string,
  plugin: { root?: string; dataPath?: string },
): { expanded: string; missingVars: string[] } {
  const missingVars: string[] = [];
  const env: Record<string, string> = {};
  if (plugin.root !== undefined) env.DUYA_PLUGIN_ROOT = plugin.root;
  if (plugin.dataPath !== undefined) env.DUYA_PLUGIN_DATA = plugin.dataPath;
  const result = expandEnvVarsInString(value, env);
  // The 'missing' report from the inner pass is already accurate.
  return result;
}

/**
 * Substitute ${user_config.KEY} in `value` against the userConfig map.
 *
 * `userConfig` is the per-plugin user-supplied key/value map. Missing
 * keys are tracked in `missingKeys` (not `missingVars` — they are a
 * distinct class of miss).
 */
export function substituteUserConfigVariables(
  value: string,
  userConfig: Record<string, string>,
): { expanded: string; missingKeys: string[] } {
  const missingKeys: string[] = [];
  // Inline minimal ${user_config.X} handling: find every occurrence, look
  // up, replace or report missing.
  const pattern = /\$\{user_config\.([A-Za-z0-9_]+)\}/g;
  let out = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    out += value.slice(lastIndex, match.index);
    const key = match[1];
    if (Object.prototype.hasOwnProperty.call(userConfig, key)) {
      out += userConfig[key];
    } else {
      out += match[0];
      if (!missingKeys.includes(key)) missingKeys.push(key);
    }
    lastIndex = match.index + match[0].length;
  }
  out += value.slice(lastIndex);
  return { expanded: out, missingKeys };
}

/**
 * Apply env expansion + plugin-variable + user-config substitution to a
 * single string field. Pure; uses the supplied context only.
 */
function expandField(
  value: string,
  ctx: {
    environment: Record<string, string>;
    plugin?: { root?: string; dataPath?: string };
    userConfig?: Record<string, string>;
  },
): { expanded: string; missingVars: string[]; missingKeys: string[] } {
  const missingVars: string[] = [];
  const missingKeys: string[] = [];
  let current = value;
  if (ctx.plugin) {
    const r = substitutePluginVariables(current, ctx.plugin);
    current = r.expanded;
    for (const v of r.missingVars) if (!missingVars.includes(v)) missingVars.push(v);
  }
  // Always run user-config substitution, even when the caller passes
  // `undefined`. This is what makes `${user_config.X}` references show up
  // as `missingKeys` issues at resolution time. If the value contains
  // NO `${user_config.X}` references, the call is a no-op (the pattern
  // is a single regex scan that finds nothing).
  const userConfigMap = ctx.userConfig ?? {};
  const userResult = substituteUserConfigVariables(current, userConfigMap);
  current = userResult.expanded;
  for (const k of userResult.missingKeys) if (!missingKeys.includes(k)) missingKeys.push(k);
  const r = expandEnvVarsInString(current, ctx.environment);
  current = r.expanded;
  for (const v of r.missingVars) if (!missingVars.includes(v)) missingVars.push(v);
  return { expanded: current, missingVars, missingKeys };
}

/**
 * Expand env vars in every field of a server config: `command`, `args[]`,
 * `env{}`. Returns the expanded record plus the aggregated missing vars
 * and missing user-config keys. Pure.
 */
export function expandMcpServerConfig(
  config: { command: string; args?: string[]; env?: Record<string, string> },
  ctx: {
    environment: Record<string, string>;
    plugin?: { root?: string; dataPath?: string };
    userConfig?: Record<string, string>;
  },
): {
  expanded: { command: string; args: string[]; env: Record<string, string> };
  missingVars: string[];
  missingKeys: string[];
} {
  const missingVars: string[] = [];
  const missingKeys: string[] = [];
  const command = expandField(config.command, ctx);
  missingVars.push(...command.missingVars);
  missingKeys.push(...command.missingKeys);
  const args: string[] = [];
  for (const a of config.args ?? []) {
    const r = expandField(a, ctx);
    args.push(r.expanded);
    missingVars.push(...r.missingVars);
    missingKeys.push(...r.missingKeys);
  }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(config.env ?? {})) {
    const r = expandField(v, ctx);
    env[k] = r.expanded;
    missingVars.push(...r.missingVars);
    missingKeys.push(...r.missingKeys);
  }
  return {
    expanded: { command: command.expanded, args, env },
    missingVars,
    missingKeys,
  };
}
