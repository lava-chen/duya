/**
 * expr.ts — restricted expression language for workflow `when` / `map.over`
 * (plan 415 §4.1 as amended by plan 552 §4.2).
 *
 * Four legal expression classes and nothing else (no eval, no functions,
 * no member calls — prompt-injection / arbitrary-code defense):
 *
 *   1. References   `nodeId.output` `nodeId.succeeded` `nodeId.failed`
 *                   `nodeId.count` `params.<name>` — plus, for decision
 *                   nodes, the typed answers scope `nodeId.<questionId>`
 *                   (plan 551 Phase 4: decide answers enter the when scope).
 *   2. Comparisons  `==` `!=` `>` `<` `>=` `<=`
 *   3. Logic        `&&` `||` `!`
 *   4. Aggregates   `any(ref)` `all(ref)` `count(ref)` over map result arrays
 *
 * Implementation: tokenizer + recursive-descent parser → AST; the same
 * AST drives evaluation, static reference extraction (validate.ts) and
 * template interpolation (`${...}` inside string fields). Determinism
 * rule (plan 552 §6.5): the language has NO clock / random / sleep
 * constructs — durations and waits live in host code only.
 */

/** Sentinel returned by a scope when a reference cannot be resolved. */
export const NOT_FOUND = Symbol('expr.not_found');

export type BinaryOp = '==' | '!=' | '>' | '<' | '>=' | '<=' | '&&' | '||';

export type ExprNode =
  | { kind: 'literal'; value: unknown }
  | { kind: 'ref'; path: string[] }
  | { kind: 'binary'; op: BinaryOp; left: ExprNode; right: ExprNode }
  | { kind: 'unary'; op: '!'; operand: ExprNode }
  | { kind: 'aggregate'; fn: 'any' | 'all' | 'count'; operand: ExprNode };

/** Reference resolver. Returns NOT_FOUND for unresolvable paths. */
export interface ExprScope {
  resolve(path: readonly string[]): unknown;
}

export class ExprError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExprError';
  }
}

// ─── Tokenizer ───

type Token =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'null' }
  | { t: 'ident'; v: string }
  | { t: 'op'; v: string }
  | { t: 'lparen' }
  | { t: 'rparen' }
  | { t: 'dot' };

const OPS = ['==', '!=', '>=', '<=', '>', '<', '&&', '||', '!'] as const;

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== quote) {
        if (src[j] === '\\' && j + 1 < src.length) {
          out += src[j + 1];
          j += 2;
        } else {
          out += src[j];
          j++;
        }
      }
      if (j >= src.length) throw new ExprError(`unterminated string literal in expression: ${src}`);
      tokens.push({ t: 'str', v: out });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^[0-9]+(\.[0-9]+)?/.exec(src.slice(i));
      if (!m) throw new ExprError(`malformed number in expression: ${src}`);
      tokens.push({ t: 'num', v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      // Identifiers allow kebab-case (workflow node ids are kebab-case) —
      // there is no arithmetic in the language, so `-` is unambiguous.
      const m = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(src.slice(i))!;
      if (m[0] === 'true' || m[0] === 'false') tokens.push({ t: 'bool', v: m[0] === 'true' });
      else if (m[0] === 'null') tokens.push({ t: 'null' });
      else tokens.push({ t: 'ident', v: m[0] });
      i += m[0].length;
      continue;
    }
    if (c === '(') {
      tokens.push({ t: 'lparen' });
      i++;
      continue;
    }
    if (c === ')') {
      tokens.push({ t: 'rparen' });
      i++;
      continue;
    }
    if (c === '.') {
      tokens.push({ t: 'dot' });
      i++;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) {
      tokens.push({ t: 'op', v: op });
      i += op.length;
      continue;
    }
    throw new ExprError(`illegal character "${c}" in expression: ${src}`);
  }
  return tokens;
}

// ─── Parser (recursive descent) ───

export const AGGREGATE_FNS = ['any', 'all', 'count'] as const;
export type AggregateFn = (typeof AGGREGATE_FNS)[number];

function isAggregateFn(s: string): s is AggregateFn {
  return (AGGREGATE_FNS as readonly string[]).includes(s);
}

class Parser {
  private pos = 0;
  constructor(
    private readonly tokens: Token[],
    private readonly src: string,
  ) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token | undefined {
    return this.tokens[this.pos++];
  }

  private expectOp(v: string): void {
    const tok = this.next();
    if (!tok || tok.t !== 'op' || tok.v !== v) {
      throw new ExprError(`expected "${v}" in expression: ${this.src}`);
    }
  }

  parse(): ExprNode {
    const node = this.parseOr();
    if (this.pos !== this.tokens.length) {
      throw new ExprError(`unexpected trailing tokens in expression: ${this.src}`);
    }
    return node;
  }

  private parseOr(): ExprNode {
    let left = this.parseAnd();
    while (this.peekOp('||')) {
      this.next();
      const right = this.parseAnd();
      left = { kind: 'binary', op: '||', left, right };
    }
    return left;
  }

  private peekOp(v: string): boolean {
    const tok = this.peek();
    return tok !== undefined && tok.t === 'op' && tok.v === v;
  }

  private parseAnd(): ExprNode {
    let left = this.parseCmp();
    while (this.peekOp('&&')) {
      this.next();
      const right = this.parseCmp();
      left = { kind: 'binary', op: '&&', left, right };
    }
    return left;
  }

  private parseCmp(): ExprNode {
    const left = this.parseUnary();
    const tok = this.peek();
    if (tok && tok.t === 'op' && ['==', '!=', '>', '<', '>=', '<='].includes(tok.v)) {
      this.next();
      const right = this.parseUnary();
      return { kind: 'binary', op: tok.v as BinaryOp, left, right };
    }
    return left;
  }

  private parseUnary(): ExprNode {
    if (this.peekOp('!')) {
      this.next();
      return { kind: 'unary', op: '!', operand: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): ExprNode {
    const tok = this.next();
    if (tok === undefined) throw new ExprError(`unexpected end of expression: ${this.src}`);
    switch (tok.t) {
      case 'num':
      case 'str':
        return { kind: 'literal', value: tok.v };
      case 'bool':
        return { kind: 'literal', value: tok.v };
      case 'null':
        return { kind: 'literal', value: null };
      case 'lparen': {
        const inner = this.parseOr();
        const close = this.next();
        if (!close || close.t !== 'rparen') {
          throw new ExprError(`missing closing parenthesis in expression: ${this.src}`);
        }
        return inner;
      }
      case 'ident': {
        // Aggregate call: any(ref) / all(ref) / count(ref).
        if (isAggregateFn(tok.v)) {
          const lp = this.next();
          if (!lp || lp.t !== 'lparen') {
            throw new ExprError(`aggregate "${tok.v}" requires a parenthesized reference: ${this.src}`);
          }
          const operand = this.parseOr();
          const rp = this.next();
          if (!rp || rp.t !== 'rparen') {
            throw new ExprError(`aggregate "${tok.v}" missing closing parenthesis: ${this.src}`);
          }
          if (operand.kind !== 'ref') {
            throw new ExprError(`aggregate "${tok.v}" operand must be a reference: ${this.src}`);
          }
          return { kind: 'aggregate', fn: tok.v, operand };
        }
        // Dotted reference: ident(.ident)*
        const path = [tok.v];
        while (this.peek() && this.peek()!.t === 'dot') {
          this.next();
          const seg = this.next();
          if (!seg || seg.t !== 'ident') {
            throw new ExprError(`malformed reference path in expression: ${this.src}`);
          }
          path.push(seg.v);
        }
        return { kind: 'ref', path };
      }
      default:
        throw new ExprError(`unexpected token in expression: ${this.src}`);
    }
  }
}

/** Parse an expression string into an AST. Throws `ExprError` on any syntax error. */
export function parseExpr(src: string): ExprNode {
  if (typeof src !== 'string' || src.trim() === '') {
    throw new ExprError('empty expression');
  }
  return new Parser(tokenize(src), src).parse();
}

// ─── Evaluation ───

function isComparable(v: unknown): v is number | string {
  return typeof v === 'number' || typeof v === 'string';
}

function compare(op: BinaryOp, left: unknown, right: unknown): boolean {
  if (op === '==') return left === right;
  if (op === '!=') return left !== right;
  if (!isComparable(left) || !isComparable(right)) return false;
  if (typeof left !== typeof right) return false;
  switch (op) {
    case '>': return left > right;
    case '<': return left < right;
    case '>=': return left >= right;
    case '<=': return left <= right;
    default: return false;
  }
}

export function isTruthy(v: unknown): boolean {
  if (v === NOT_FOUND) return false;
  if (typeof v === 'string') return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return Boolean(v);
}

function evalNode(node: ExprNode, scope: ExprScope): unknown {
  switch (node.kind) {
    case 'literal':
      return node.value;
    case 'ref': {
      const value = scope.resolve(node.path);
      if (value === NOT_FOUND) {
        throw new ExprError(`unresolvable reference "${node.path.join('.')}"`);
      }
      return value;
    }
    case 'unary':
      return !isTruthy(evalNode(node.operand, scope));
    case 'binary': {
      if (node.op === '&&') return isTruthy(evalNode(node.left, scope)) && isTruthy(evalNode(node.right, scope));
      if (node.op === '||') return isTruthy(evalNode(node.left, scope)) || isTruthy(evalNode(node.right, scope));
      return compare(node.op, evalNode(node.left, scope), evalNode(node.right, scope));
    }
    case 'aggregate': {
      const list = evalNode(node.operand, scope);
      if (!Array.isArray(list)) {
        throw new ExprError(`aggregate ${node.fn}() requires an array (map results), got ${typeof list}`);
      }
      if (node.fn === 'count') return list.length;
      if (node.fn === 'any') return list.some(isTruthy);
      return list.every(isTruthy);
    }
  }
}

/** Evaluate a parsed expression against a scope. */
export function evaluateNode(node: ExprNode, scope: ExprScope): unknown {
  return evalNode(node, scope);
}

/** Parse + evaluate in one call. Throws `ExprError` on syntax or reference failure. */
export function evaluateExpr(src: string, scope: ExprScope): unknown {
  return evaluateNode(parseExpr(src), scope);
}

// ─── Reference extraction (static validation) ───

function collectRefRoots(node: ExprNode, roots: Set<string>): void {
  switch (node.kind) {
    case 'ref':
      roots.add(node.path[0]);
      break;
    case 'binary':
      collectRefRoots(node.left, roots);
      collectRefRoots(node.right, roots);
      break;
    case 'unary':
      collectRefRoots(node.operand, roots);
      break;
    case 'aggregate':
      collectRefRoots(node.operand, roots);
      break;
    case 'literal':
      break;
  }
}

/** Roots referenced by an expression (first path segment of every ref). */
export function exprRefRoots(src: string): Set<string> {
  const roots = new Set<string>();
  collectRefRoots(parseExpr(src), roots);
  return roots;
}

// ─── Template interpolation ("${expr}" inside string fields) ───

const TEMPLATE_RE = /\$\{([^}]*)\}/g;

/**
 * Interpolate a template string against a scope. A template that is EXACTLY
 * one interpolation yields the raw value (preserving type — an input field
 * referencing a node output stays an object/array); mixed templates stringify.
 * Throws `ExprError` on syntax/reference failures inside any hole.
 */
export function interpolate(template: string, scope: ExprScope): unknown {
  if (!template.includes('${')) return template;
  const exact = /^\$\{([^}]*)\}$/.exec(template);
  if (exact) {
    return evaluateExpr(exact[1], scope);
  }
  return template.replace(TEMPLATE_RE, (_m, inner: string) => {
    const value = evaluateExpr(inner, scope);
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  });
}

/**
 * Deep-interpolate a node's input/prompt structure: strings become
 * templates; objects/arrays recurse; everything else passes through.
 */
export function interpolateDeep<T>(value: T, scope: ExprScope): T {
  if (typeof value === 'string') return interpolate(value, scope) as T;
  if (Array.isArray(value)) {
    return value.map((v) => interpolateDeep(v, scope)) as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = interpolateDeep(v, scope);
    }
    return out as T;
  }
  return value;
}

/** Roots referenced by every `${...}` hole in a template string (may be empty). */
export function templateRefRoots(template: string): Set<string> {
  const roots = new Set<string>();
  if (!template.includes('${')) return roots;
  const re = /\$\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template)) !== null) {
    for (const root of exprRefRoots(m[1])) roots.add(root);
  }
  return roots;
}
