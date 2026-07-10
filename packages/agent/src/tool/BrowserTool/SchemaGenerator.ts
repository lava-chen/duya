import { z } from 'zod/v4';
import type { ActionHandler } from './actions/types.js';

/**
 * Auto-generates JSON Schema from ActionHandlers' zod schemas.
 *
 * The schema is structured as `anyOf` — one variant per `operation` — so the
 * LLM can see which fields are required for which operation. A flat merged
 * `properties` map (the previous shape) hid the per-operation required
 * fields, causing the agent to omit `url` / `urls` and fail zod validation.
 */
export class SchemaGenerator {
  static generate(allActions: ActionHandler[]): {
    inputSchema: Record<string, unknown>;
    operations: string[];
  } {
    const operations = allActions.map(a => a.operation);

    const variants = allActions.map((action) => {
      const shape = this.extractShape(action.schema as any) || {};
      const required = this.extractRequired(action.schema as any);
      return {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: [action.operation] },
          ...shape,
        },
        required: ['operation', ...required],
      };
    });

    // Merge every operation-specific field into the top-level properties map
    // as well. Some provider/tool-call layers flatten or ignore `anyOf` and
    // only honor top-level `properties`; without `url` / `urls` / `ref` etc.
    // visible there, the model omits them and the action fails zod validation.
    // The `anyOf` variants still enforce per-operation required fields for
    // providers that do support them.
    const mergedProperties: Record<string, unknown> = {};
    for (const variant of variants) {
      for (const [key, value] of Object.entries(variant.properties)) {
        if (key === 'operation') continue;
        if (!mergedProperties[key]) {
          mergedProperties[key] = value;
        }
      }
    }

    return {
      inputSchema: {
        type: 'object',
        // anyOf forces the LLM to pick one variant and include its required
        // fields. The top-level `operation` enum lists every supported value
        // so the model can still discover the full operation surface.
        anyOf: variants,
        properties: {
          operation: {
            type: 'string',
            enum: operations,
            description: 'Browser operation to perform',
          },
          ...mergedProperties,
        },
        required: ['operation'],
      },
      operations,
    };
  }

  /**
   * Extract the list of required field names from a zod schema by walking
   * its top-level ZodObject shape and collecting keys whose schema is not
   * ZodOptional / ZodDefault.
   */
  private static extractRequired(schema: any): string[] {
    const rawShape = this.extractRawShape(schema);
    if (!rawShape) return [];
    const required: string[] = [];
    for (const [key, prop] of Object.entries(rawShape) as [string, any][]) {
      if (this.isRequiredField(prop)) {
        required.push(key);
      }
    }
    return required;
  }

  /**
   * Extract the raw zod field map (before converting to JSON Schema) so the
   * required-field check sees the original ZodOptional/ZodDefault wrappers.
   */
  private static extractRawShape(obj: any): Record<string, unknown> | null {
    if (!obj) return null;
    const probes: Array<() => unknown> = [
      () => obj?._def?.shape?.(),
      () => obj?._def?.shape,
      () => obj?.def?.shape,
      () => obj?.shape,
    ];
    for (const probe of probes) {
      try {
        const candidate = probe();
        if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
          return candidate as Record<string, unknown>;
        }
      } catch {
        // try the next path
      }
    }
    return null;
  }

  /**
   * Check whether a property's zod schema is optional or has a default.
   * Walks through ZodOptional / ZodDefault / ZodEffects wrappers to find
   * the underlying schema and detect an inner ZodOptional.
   */
  private static isRequiredField(prop: any): boolean {
    let cur = prop;
    for (let i = 0; i < 4 && cur; i++) {
      const def = cur?._def || cur?.def || {};
      const typeName = def?.typeName || def?.type || '';
      if (typeName === 'ZodOptional' || typeName === 'optional') return false;
      if (typeName === 'ZodDefault' || typeName === 'default') return false;
      // ZodPipe (z.preprocess on zod/v4): the required-ness of the field
      // is determined by the OUTER (output) schema, not the inner
      // transform. Walk def.out so a required array wrapped in preprocess
      // is still reported as required.
      if (typeName === 'ZodPipe' || typeName === 'pipe') {
        cur = def?.out;
        continue;
      }
      if (typeName === 'ZodEffects' || typeName === 'ZodTransform' ||
          typeName === 'ZodCatch' || typeName === 'ZodReadonly' || typeName === 'ZodLazy' || typeName === 'ZodPromise' ||
          typeName === 'transform' || typeName === 'catch' || typeName === 'readonly' || typeName === 'lazy' || typeName === 'promise') {
        cur = def?.schema || def?.innerType || def?.type;
        continue;
      }
      return true;
    }
    return true;
  }

  /**
   * Extract the top-level object shape from a zod schema.
   *
   * zod v3 exposes `_def.shape()` (a function); zod v4 uses `def.shape` (a
   * plain object) and also `schema.shape`. We probe all known paths so the
   * generator works regardless of which zod major version is in use.
   */
  private static extractShape(obj: any): Record<string, unknown> | null {
    if (!obj) return null;
    const probes: Array<() => unknown> = [
      () => obj?._def?.shape?.(),       // zod v3 ZodObject._def.shape()
      () => obj?._def?.shape,           // zod v3 fallback
      () => obj?.def?.shape,            // zod v4 ZodObject.def.shape
      () => obj?.shape,                 // zod v4 / some adapters
    ];
    for (const probe of probes) {
      try {
        const candidate = probe();
        if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
          const result: Record<string, unknown> = {};
          for (const [key, prop] of Object.entries(candidate) as [string, any][]) {
            result[key] = this.zodToJsonSchemaProp(prop);
          }
          return result;
        }
      } catch {
        // try the next path
      }
    }
    return null;
  }

  private static zodToJsonSchemaProp(prop: any): Record<string, unknown> {
    const def = prop?._def || prop?.def || {};
    const description = prop?.description || def?.description || '';
    const base: Record<string, unknown> = description ? { description } : {};

    // Determine type. zod v3 uses `def.typeName` ("ZodString", "ZodNumber", ...).
    // zod v4 uses `def.type` ("string", "number", "boolean", "array", ...) and
    // also exposes `prop.type` directly. Probe all known paths.
    const typeName = def?.typeName || def?.type || prop?.type || prop?._type || '';

    // z.preprocess() compiles to a ZodPipe on zod/v4 (def.in = transform,
    // def.out = real schema). We want the LLM to see the OUTPUT type (the
    // real schema after preprocessing), not the transform input. Descend
    // into def.out first so e.g. `z.preprocess(fn, z.array(z.string()))`
    // emits `type: 'array'` instead of the silent `type: 'string'`
    // fallback we used to hit when we walked def.schema/innerType.
    if (typeName === 'ZodPipe' || typeName === 'pipe') {
      const out = def?.out;
      if (out) {
        const resolved = this.zodToJsonSchemaProp(out);
        if (resolved.type === 'string' && !description) {
          return { ...base, type: 'string', description: 'JSON string – pass a stringified JSON array, e.g. \'["url1","url2"]\'' };
        }
        return resolved;
      }
    }

    if (typeName === 'ZodString' || typeName === 'string') {
      const hasUrl = def?.checks?.some?.((c: any) => c.kind === 'url') || def?.format === 'url';
      return { ...base, type: 'string', ...(hasUrl ? { format: 'uri' } : {}) };
    }

    if (typeName === 'ZodNumber' || typeName === 'number') {
      return { ...base, type: 'number' };
    }

    if (typeName === 'ZodBoolean' || typeName === 'boolean') {
      return { ...base, type: 'boolean' };
    }

    if (typeName === 'ZodArray' || typeName === 'array') {
      const itemType = def?.typeName === 'ZodArray' ? def?.type : def?.element;
      return {
        ...base,
        type: 'array',
        items: itemType ? this.zodToJsonSchemaProp(itemType) : { type: 'string' },
      };
    }

    if (typeName === 'ZodEnum') {
      return { ...base, type: 'string', enum: def?.values || def?.options || [] };
    }

    if (typeName === 'ZodUnion') {
      const options = def?.options || [];
      const types = new Set<string>();
      for (const opt of options) {
        const resolved = this.zodToJsonSchemaProp(opt);
        if (resolved.type) {
          if (Array.isArray(resolved.type)) {
            for (const t of resolved.type) types.add(t as string);
          } else {
            types.add(resolved.type as string);
          }
        }
      }
      return { ...base, type: types.size === 1 ? [...types][0] : [...types] };
    }

    if (typeName === 'optional') {
      const inner = def?.innerType || def?.type;
      if (inner) return this.zodToJsonSchemaProp(inner);
      return { ...base };
    }

    if (typeName === 'default') {
      const inner = def?.innerType || def?.type;
      if (inner) return this.zodToJsonSchemaProp(inner);
      return { ...base, default: def?.defaultValue?.() ?? def?.defaultValue };
    }

    // z.preprocess wraps the real schema in a ZodEffects/ZodTransform on
    // zod/v4. Descend into the inner schema to recover the real type.
    if (typeName === 'ZodEffects' || typeName === 'ZodTransform' || typeName === 'ZodPipe' ||
        typeName === 'ZodCatch' || typeName === 'ZodReadonly' || typeName === 'ZodLazy' || typeName === 'ZodPromise') {
      const inner = def?.schema || def?.innerType || def?.type;
      if (inner) return this.zodToJsonSchemaProp(inner);
    }

    // Fallback for unknown types
    return { ...base, type: 'string' };
  }
}
