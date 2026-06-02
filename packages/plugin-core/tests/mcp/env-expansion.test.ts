import { describe, it, expect } from 'vitest';
import {
  expandEnvVarsInString,
  substitutePluginVariables,
  substituteUserConfigVariables,
  expandMcpServerConfig,
} from '../../src/mcp/env-expansion.js';

describe('expandEnvVarsInString', () => {
  it('substitutes ${VAR}', () => {
    const { expanded, missingVars } = expandEnvVarsInString('hello ${NAME}', { NAME: 'world' });
    expect(expanded).toBe('hello world');
    expect(missingVars).toEqual([]);
  });

  it('substitutes ${VAR:-default} when VAR is missing', () => {
    const { expanded, missingVars } = expandEnvVarsInString('hello ${NAME:-anon}', {});
    expect(expanded).toBe('hello anon');
    expect(missingVars).toEqual([]);
  });

  it('does NOT report ${VAR:-default} as missing even when VAR is absent', () => {
    const { missingVars } = expandEnvVarsInString('${X:-fallback}', {});
    expect(missingVars).toEqual([]);
  });

  it('reports ${VAR} as missing when VAR is absent and there is no default', () => {
    const { expanded, missingVars } = expandEnvVarsInString('${MISSING}', {});
    expect(expanded).toBe('${MISSING}');
    expect(missingVars).toEqual(['MISSING']);
  });

  it('handles the $$ escape', () => {
    const { expanded } = expandEnvVarsInString('price: $$5', {});
    expect(expanded).toBe('price: $5');
  });

  it('does not read process.env implicitly (an empty environment yields no expansion)', () => {
    const { expanded, missingVars } = expandEnvVarsInString('${PATH}', {});
    expect(expanded).toBe('${PATH}');
    expect(missingVars).toEqual(['PATH']);
  });

  it('handles unterminated ${ gracefully', () => {
    const { expanded } = expandEnvVarsInString('hello ${unterminated', {});
    expect(expanded).toBe('hello ${unterminated');
  });

  it('deduplicates missing var reports', () => {
    const { missingVars } = expandEnvVarsInString('${A} ${A} ${B}', {});
    expect(missingVars.sort()).toEqual(['A', 'B']);
  });

  it('falls back to environment for bare $NAME form', () => {
    const { expanded } = expandEnvVarsInString('hi $NAME', { NAME: 'alice' });
    expect(expanded).toBe('hi alice');
  });

  it('does not expand bare $1 or other non-identifier sequences', () => {
    const { expanded, missingVars } = expandEnvVarsInString('cost: $1.50', {});
    expect(expanded).toBe('cost: $1.50');
    expect(missingVars).toEqual([]);
  });
});

describe('substitutePluginVariables', () => {
  it('substitutes ${DUYA_PLUGIN_ROOT} and ${DUYA_PLUGIN_DATA}', () => {
    const { expanded, missingVars } = substitutePluginVariables(
      'root=${DUYA_PLUGIN_ROOT} data=${DUYA_PLUGIN_DATA}',
      { root: '/p', dataPath: '/d' },
    );
    expect(expanded).toBe('root=/p data=/d');
    expect(missingVars).toEqual([]);
  });

  it('reports missing plugin fields as missing vars', () => {
    const { expanded, missingVars } = substitutePluginVariables(
      'r=${DUYA_PLUGIN_ROOT}',
      {},
    );
    expect(expanded).toBe('r=${DUYA_PLUGIN_ROOT}');
    expect(missingVars).toEqual(['DUYA_PLUGIN_ROOT']);
  });
});

describe('substituteUserConfigVariables', () => {
  it('substitutes ${user_config.KEY}', () => {
    const { expanded, missingKeys } = substituteUserConfigVariables(
      'api=${user_config.API_KEY}',
      { API_KEY: 'abc' },
    );
    expect(expanded).toBe('api=abc');
    expect(missingKeys).toEqual([]);
  });

  it('reports missing user_config keys', () => {
    const { expanded, missingKeys } = substituteUserConfigVariables(
      'api=${user_config.API_KEY}',
      {},
    );
    expect(expanded).toBe('api=${user_config.API_KEY}');
    expect(missingKeys).toEqual(['API_KEY']);
  });

  it('deduplicates missing key reports', () => {
    const { missingKeys } = substituteUserConfigVariables(
      '${user_config.X} ${user_config.X} ${user_config.Y}',
      {},
    );
    expect(missingKeys.sort()).toEqual(['X', 'Y']);
  });
});

describe('expandMcpServerConfig', () => {
  it('expands command, args, and env with explicit environment', () => {
    const { expanded, missingVars, missingKeys } = expandMcpServerConfig(
      {
        command: 'node',
        args: ['./${BIN_NAME}.js', '--name', '${SERVICE_NAME:-default}'],
        env: { TOKEN: '${API_KEY}' },
      },
      {
        environment: { BIN_NAME: 'server', SERVICE_NAME: 'svc', API_KEY: 'k' },
      },
    );
    expect(expanded.command).toBe('node');
    expect(expanded.args).toEqual(['./server.js', '--name', 'svc']);
    expect(expanded.env).toEqual({ TOKEN: 'k' });
    expect(missingVars).toEqual([]);
    expect(missingKeys).toEqual([]);
  });

  it('aggregates missing vars across command/args/env', () => {
    const { missingVars } = expandMcpServerConfig(
      {
        command: '${X}',
        args: ['${Y}'],
        env: { Z: '${Z}' },
      },
      { environment: {} },
    );
    expect(missingVars.sort()).toEqual(['X', 'Y', 'Z']);
  });

  it('applies plugin and user-config substitutions before env', () => {
    const { expanded } = expandMcpServerConfig(
      {
        command: '${DUYA_PLUGIN_ROOT}/${BIN}',
        args: [],
        env: { KEY: '${user_config.K}' },
      },
      {
        environment: { BIN: 'server.js' },
        plugin: { root: '/plug', dataPath: '/plug-data' },
        userConfig: { K: 'v' },
      },
    );
    expect(expanded.command).toBe('/plug/server.js');
    expect(expanded.env).toEqual({ KEY: 'v' });
  });

  it('does not read process.env when environment is empty', () => {
    // PATH and HOME are not present unless explicitly passed.
    const { expanded, missingVars } = expandMcpServerConfig(
      { command: 'x', args: ['${PATH}'], env: {} },
      { environment: {} },
    );
    expect(expanded.args).toEqual(['${PATH}']);
    expect(missingVars).toEqual(['PATH']);
  });
});
