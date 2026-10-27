/**
 * Declarative payload filters for the generic webhook channel.
 *
 * A generic webhook endpoint receives every event of every integration that
 * points at it. Without filters the bot wakes up for irrelevant traffic (CI
 * noise, ping events, bot's own comments) and burns tokens on it.
 *
 * Filter shapes (a single object or an array meaning AND):
 *   { "field": "action", "equals": "opened" }
 *   { "all": [ { "field": "pull_request.draft", "equals": false },
 *              { "field": "headers.x-github-event", "equals": "pull_request" } ] }
 *   { "any": [ { "field": "action", "in": ["opened", "reopened"] } ] }
 *   { "not": { "field": "sender.type", "equals": "Bot" } }
 *
 * Field prefixes: `payload.` (default), `event.`, `headers.`. Operators are
 * evaluated in a fixed order and the first present one decides.
 */

const FIELD_PREFIXES = ['payload', 'event', 'headers'] as const;

function getPath(root: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc === null || acc === undefined) return undefined;
    if (Array.isArray(acc)) {
      const index = Number(key);
      return Number.isInteger(index) ? acc[index] : undefined;
    }
    if (typeof acc === 'object') return (acc as Record<string, unknown>)[key];
    return undefined;
  }, root);
}

function resolveField(spec: string, payload: unknown, headers: Record<string, string>): unknown {
  const [head, ...rest] = spec.split('.');
  const path = rest.join('.');
  if ((FIELD_PREFIXES as readonly string[]).includes(head)) {
    if (head === 'headers') return path ? headers[path.toLowerCase()] : undefined;
    if (head === 'event') return path ? getPath(payload, path) : payload;
    return path ? getPath(payload, path) : payload;
  }
  return getPath(payload, spec);
}

function asString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function equalsLoose(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  if (typeof expected === 'boolean') {
    return asString(actual).toLowerCase() === String(expected);
  }
  if (typeof expected === 'number') return Number(actual) === expected;
  return asString(actual) === asString(expected);
}

type FilterNode = Record<string, unknown>;

function evaluateNode(node: FilterNode, payload: unknown, headers: Record<string, string>): boolean {
  if (Array.isArray(node['all'])) {
    return (node['all'] as FilterNode[]).every((child) => evaluateNode(child, payload, headers));
  }
  if (Array.isArray(node['any'])) {
    return (node['any'] as FilterNode[]).some((child) => evaluateNode(child, payload, headers));
  }
  if (node['not'] && typeof node['not'] === 'object') {
    return !evaluateNode(node['not'] as FilterNode, payload, headers);
  }

  const field = typeof node['field'] === 'string' ? node['field'] : '';
  const actual = field ? resolveField(field, payload, headers) : payload;

  if ('exists' in node) {
    const present = actual !== undefined && actual !== null && actual !== '';
    return node['exists'] === false ? !present : present;
  }
  if ('equals' in node) return equalsLoose(actual, node['equals']);
  if ('not_equals' in node) return !equalsLoose(actual, node['not_equals']);
  if ('contains' in node) {
    const needle = asString(node['contains']);
    if (Array.isArray(actual)) return actual.some((item) => equalsLoose(item, node['contains']));
    return asString(actual).includes(needle);
  }
  if ('in' in node && Array.isArray(node['in'])) {
    return (node['in'] as unknown[]).some((candidate) => equalsLoose(actual, candidate));
  }
  if ('regex' in node) {
    try {
      return new RegExp(asString(node['regex']), 'i').test(asString(actual));
    } catch {
      return false;
    }
  }
  // A node with only `field` means "truthy field".
  if (field) return Boolean(actual);
  return true;
}

/**
 * Evaluate the configured filters. `undefined`/`null` means "accept everything";
 * an empty array also accepts everything (AND over nothing).
 */
export function matchesFilters(
  filters: unknown,
  payload: unknown,
  headers: Record<string, string>,
): boolean {
  if (filters === undefined || filters === null) return true;
  const nodes = Array.isArray(filters) ? filters : [filters];
  return nodes.every((node) =>
    node && typeof node === 'object'
      ? evaluateNode(node as FilterNode, payload, headers)
      : true,
  );
}

/**
 * Render a prompt template. Supports `{payload.a.b}` / `{headers.x-event}` /
 * `{event.type}` placeholders; a template without placeholders is passed
 * through, which keeps the simple case simple.
 */
export function renderTemplate(
  template: string,
  payload: unknown,
  headers: Record<string, string>,
): string {
  return template.replace(/\{([a-z0-9_.-]+)\}/gi, (match, spec: string) => {
    const value = resolveField(spec, payload, headers);
    if (value === undefined || value === null) return match;
    return asString(value);
  });
}

/** Default prompt body: a fenced JSON block, capped so a huge payload cannot blow up the prompt. */
export function defaultPrompt(payload: unknown, maxChars = 4000): string {
  const json = JSON.stringify(payload, null, 2) ?? '';
  const body = json.length > maxChars ? `${json.slice(0, maxChars)}\n… (truncated)` : json;
  return `Webhook event received:\n\`\`\`json\n${body}\n\`\`\``;
}
