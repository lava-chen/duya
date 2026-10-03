/**
 * The digest that identifies a run's input (contract §B).
 *
 * ## Why it lives in the protocol and not in the runtime
 *
 * Plan 587 R2.2 made the worker VERIFY this digest. Verification only means
 * anything if both sides derive it the same way, and until this move the one
 * implementation lived in `@duya/agent-runtime` — a package the worker
 * process does not depend on and must not. Two consequences of that, both bad:
 * the worker could only carry the digest without checking it, or it would have
 * had to reimplement the hash.
 *
 * So the canonical implementation sits next to `canonicalJson` / `sha256Hex`,
 * in the one layer both the Control Plane and the executor can already reach.
 * `@duya/agent-runtime` re-exports it, so every existing import is unchanged
 * and there is still exactly one derivation.
 *
 * ## What is deliberately NOT hashed
 *
 * **Attachment payloads.** The contract carries attachments by REFERENCE — a
 * stored object id, not the bytes — and this digest has to respect that. A
 * chat turn may carry 50 MB of base64 (`DUYA_MAX_CHAT_PAYLOAD_SIZE`), and
 * canonicalising that into a string to hash it would make the run layer copy
 * every attachment in memory for a value that decides nothing about object
 * identity. What is hashed instead is the attachment DESCRIPTOR: how many, and
 * which ids. Two turns with the same five attachments hash the same; two turns
 * with different files do not, which is the property §C's "same manifest/input
 * may return the existing record, different content is refused" needs.
 *
 * ## Why it throws instead of guessing
 *
 * An input that cannot be canonicalised is a host bug, and the two convenient
 * alternatives are worse than a failure: dropping the field would let two
 * different inputs hash the same (a silent collision on the exact property this
 * digest exists for), and coercing it would hash a value the run never saw.
 * So it throws, and `RunController` reports the refusal as a start that was
 * not accepted.
 */

import { canonicalJson, sha256Hex } from './hash.js';
import type { JsonObject, JsonValue } from './hash.js';

export function runInputRevision(input: {
  readonly sessionId: string;
  readonly prompt: string;
  readonly options: Readonly<Record<string, unknown>>;
}): string {
  const canonical = canonicalJson({
    sessionId: input.sessionId,
    prompt: input.prompt,
    options: asJson(optionsWithAttachmentRefs(input.options), 'options'),
  });
  return sha256Hex(canonical);
}

/**
 * Replace attachment payloads with their descriptor before hashing.
 *
 * Returns a new object; the caller's options are not touched, because the very
 * next thing that happens is the adapter handing those options to the executor
 * byte for byte.
 */
function optionsWithAttachmentRefs(
  options: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const files = options['files'];
  if (files === undefined) return { ...options };
  const rest: Record<string, unknown> = { ...options };
  delete rest['files'];
  rest['attachmentRefs'] = attachmentRefs(files);
  return rest;
}

/**
 * `{ count, ids }` for an attachment list, and `{ count: 0 }` for anything that
 * is not one.
 *
 * An id that is absent becomes `null` rather than being dropped, so the array's
 * LENGTH is preserved. Dropping it would make a one-attachment turn and a
 * two-attachment turn with no ids hash identically.
 */
function attachmentRefs(files: unknown): JsonObject {
  if (!Array.isArray(files)) return { count: 0 };
  return {
    count: files.length,
    ids: files.map((file) => {
      if (typeof file !== 'object' || file === null) return null;
      const id = (file as { readonly id?: unknown }).id;
      return typeof id === 'string' ? id : null;
    }),
  };
}

/**
 * Narrow an arbitrary option bag to something `canonicalJson` can serialise,
 * or fail loudly.
 *
 * `undefined` is dropped rather than rejected: `JSON.parse` never produces it,
 * but a host that spreads an object with an absent optional key does, and
 * refusing to start a chat over a key with no value would be absurd. Everything
 * else that is not JSON — a `Map` (which serialises to `{}` and would make a
 * populated map indistinguishable from an empty one, the exact trap
 * `manifest-factory.ts` documents), a function, a `Symbol`, `NaN` — is a
 * programming error and is named.
 */
function asJson(value: unknown, path: string): JsonValue {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`runInputRevision: ${path} is not a finite number`);
      return value;
    case 'undefined':
      return null;
    case 'object':
      break;
    default:
      throw new TypeError(`runInputRevision: ${path} is a ${typeof value}, which is not JSON`);
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => asJson(item, `${path}[${index}]`));
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(
      `runInputRevision: ${path} is a ${value.constructor?.name ?? 'non-plain object'}, which has no canonical JSON form`,
    );
  }
  const out: Record<string, JsonValue> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (nested === undefined) continue;
    out[key] = asJson(nested, `${path}.${key}`);
  }
  return out;
}
