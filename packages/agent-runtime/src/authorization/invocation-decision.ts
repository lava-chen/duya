import { canonicalJson, type JsonValue } from '@duya/agent-protocol';

export type InvocationDecisionEvaluator<T> = (
  toolName: string,
  input?: Record<string, unknown>,
) => Promise<T>;

export type InvocationDecisionReader<T> = (
  toolName: string,
  input?: Record<string, unknown>,
  invocationId?: string,
) => Promise<T>;

function isJsonValue(value: unknown, ancestors: Set<object>): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype
    && Object.getPrototypeOf(value) !== null) return false;
  ancestors.add(value);
  const valid = Object.values(value).every((item) => isJsonValue(item, ancestors));
  ancestors.delete(value);
  return valid;
}

/**
 * Share one decision between dispatch and execution for the same invocation.
 * The owner creates this reader per turn; it is not a persistent permission
 * grant. Reusing an identity with changed arguments or a different tool fails
 * before the evaluator can consume another one-shot approval.
 */
export function memoizeInvocationDecision<T>(
  evaluate: InvocationDecisionEvaluator<T>,
): InvocationDecisionReader<T> {
  const decisions = new Map<string, { binding: string; result: Promise<T> }>();
  return (toolName, input, invocationId) => {
    if (invocationId === undefined) return evaluate(toolName, input);
    const argumentsValue = input ?? {};
    if (!isJsonValue(argumentsValue, new Set())) {
      return Promise.reject(new TypeError('Tool invocation arguments must be JSON values'));
    }
    const binding = canonicalJson({ toolName, input: argumentsValue });
    const existing = decisions.get(invocationId);
    if (existing !== undefined) {
      if (existing.binding !== binding) {
        return Promise.reject(new Error('Tool invocation identity was reused with different arguments'));
      }
      return existing.result;
    }
    // Capture the checked arguments before yielding; a caller may reuse its object.
    const stableInput = input === undefined ? undefined : structuredClone(input);
    const result = Promise.resolve().then(() => evaluate(toolName, stableInput));
    decisions.set(invocationId, { binding, result });
    return result;
  };
}
