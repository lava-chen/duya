export interface ParsedMCPConfig {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

interface MultipleConfigsResult {
  type: 'multiple';
  configs: ParsedMCPConfig[];
}

type ParseResult = ParsedMCPConfig | MultipleConfigsResult | { error: string };

function generateName(command: string, args: string[]): string {
  const segments = command.replace(/\\/g, '/').split('/');
  const lastSegment = segments[segments.length - 1] || command;

  if (args.length > 0) {
    const firstArg = args[0];
    if (firstArg === '-y' || firstArg === '--yes') {
      const secondArg = args[1];
      if (secondArg && !secondArg.startsWith('-')) {
        const pkgSegments = secondArg.split('/');
        const lastPkg = pkgSegments[pkgSegments.length - 1];
        return lastPkg.replace(/^mcp-server-/, '').replace(/^@/, '');
      }
    }
    if (!firstArg.startsWith('-')) {
      const pkgSegments = firstArg.split('/');
      const lastPkg = pkgSegments[pkgSegments.length - 1];
      return lastPkg.replace(/^mcp-server-/, '').replace(/^@/, '');
    }
  }

  return lastSegment.replace(/^mcp-server-/, '').replace(/^@/, '');
}

function parseCliLine(line: string): ParsedMCPConfig {
  let remaining = line.trim();
  const env: Record<string, string> = {};

  const envRegex = /^([A-Z_][A-Z0-9_]*)=([^\s]+)\s+/;
  let match = remaining.match(envRegex);
  while (match) {
    env[match[1]] = match[2];
    remaining = remaining.slice(match[0].length);
    match = remaining.match(envRegex);
  }

  const parts = remaining.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return { name: '', command: '', args: [], env };
  }

  const command = parts[0];
  const args = parts.slice(1);
  const name = generateName(command, args);

  return { name, command, args, env };
}

function tryParseJson(text: string): ParseResult | null {
  let trimmed = text.trim();

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') {
        const mcpServers = parsed.mcpServers || parsed.mcp_servers || parsed;
        if (mcpServers && typeof mcpServers === 'object') {
          const entries = Object.entries(mcpServers as Record<string, unknown>);
          if (entries.length === 0) {
            return { error: 'No MCP server configs found in JSON.' };
          }

          const configs: ParsedMCPConfig[] = [];
          for (const [key, value] of entries) {
            if (value && typeof value === 'object' && !Array.isArray(value)) {
              const cfg = value as Record<string, unknown>;
              const command = typeof cfg.command === 'string' ? cfg.command : '';
              if (!command) {
                return { error: `Server "${key}" is missing the "command" field.` };
              }
              configs.push({
                name: key,
                command,
                args: Array.isArray(cfg.args) ? cfg.args.filter((a): a is string => typeof a === 'string') : [],
                env: (cfg.env && typeof cfg.env === 'object' && !Array.isArray(cfg.env))
                  ? Object.fromEntries(
                      Object.entries(cfg.env as Record<string, unknown>)
                        .filter(([, v]) => typeof v === 'string')
                        .map(([k, v]) => [k, v as string])
                    )
                  : {},
              });
            }
          }

          if (configs.length === 1) {
            return configs[0];
          }
          return { type: 'multiple', configs };
        }
      }
    } catch {
      if (trimmed.length > 0 && (trimmed[0] === '{' || trimmed[0] === '[')) {
        let errorMsg = 'Cannot parse the JSON. Check for syntax errors.';
        try {
          JSON.parse(trimmed);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const lineMatch = msg.match(/line\s+(\d+)/i) || msg.match(/position\s+(\d+)/i);
          if (lineMatch) {
            errorMsg = `JSON parse error at ${lineMatch[0]}. Check your input.`;
          }
        }
        return { error: errorMsg };
      }
    }
  }

  return null;
}

function isCliLine(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return false;

  const knownCommands = ['npx', 'uvx', 'node', 'python', 'python3', 'docker', 'deno', 'bun'];
  const firstToken = trimmed.split(/\s+/)[0];
  if (knownCommands.includes(firstToken)) return true;

  const envPrefixRegex = /^[A-Z_][A-Z0-9_]*=/;
  if (envPrefixRegex.test(firstToken)) {
    const rest = trimmed.slice(firstToken.length).trim();
    const nextToken = rest.split(/\s+/)[0];
    if (knownCommands.includes(nextToken)) return true;
  }

  return false;
}

function looksLikeNaturalLanguage(text: string): boolean {
  const trimmed = text.trim().toLowerCase();
  const naturalIndicators = [
    'install', 'add', 'please', 'can you', 'could you', 'i want',
    'i need', 'set up', 'configure', 'help me', 'how to',
    'mcp server', 'connect to',
  ];
  const hasNatural = naturalIndicators.some(ind => trimmed.includes(ind));
  const wordCount = trimmed.split(/\s+/).length;
  return hasNatural || wordCount > 10;
}

export function parseMcpInput(text: string): ParseResult {
  if (!text || !text.trim()) {
    return { error: 'No config found in pasted text.' };
  }

  const jsonResult = tryParseJson(text);
  if (jsonResult) return jsonResult;

  if (looksLikeNaturalLanguage(text)) {
    return { error: 'Cannot parse natural language. Paste a JSON config or CLI command.' };
  }

  if (isCliLine(text)) {
    const lines = text.split('\n').filter(l => l.trim());
    for (const line of lines) {
      if (isCliLine(line)) {
        return parseCliLine(line);
      }
    }
  }

  return { error: 'Cannot parse the input. Paste a JSON MCP config block (with "mcpServers" key) or a CLI command (e.g., "npx -y @anthropic/mcp-server-brave").' };
}

export function isMultiConfig(result: ParseResult): result is MultipleConfigsResult {
  return typeof result === 'object' && result !== null && 'type' in result && (result as MultipleConfigsResult).type === 'multiple';
}