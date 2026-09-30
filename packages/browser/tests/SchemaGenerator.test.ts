/**
 * SchemaGenerator — regression tests for zod/v4 `z.preprocess()` handling.
 *
 * Background: z.preprocess() compiles to a ZodPipe whose def has
 *   { type: 'pipe', in: <transform>, out: <real schema> }
 *
 * The generator used to descend via `def.schema || def.innerType ||
 * def.type`, which on a ZodPipe returns the string `'pipe'` — a silent
 * dead end that fell through to `{ type: 'string' }`. That made the
 * browser tool emit `urls: { type: 'string' }` to the LLM, even though
 * the runtime schema is `z.array(z.string())`. The LLM then either
 * passed a stringified JSON array (working) or, in some
 * provider/tool-call layers, the array got wrapped as `{ item: [...] }`
 * (validation failed).
 *
 * These tests pin the fix: the LLM-visible schema for preprocessed
 * fields must match the OUTPUT type of the pipe.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod/v4';
import { SchemaGenerator } from '../../src/tool/BrowserTool/SchemaGenerator';
import type { ActionHandler } from '../../src/tool/BrowserTool/actions/types';

function makeAction(
  operation: string,
  schema: z.ZodType,
): ActionHandler {
  return {
    operation,
    schema,
    async execute() {
      return {};
    },
  };
}

describe('SchemaGenerator — z.preprocess handling', () => {
  it('emits array type for z.preprocess(fn, z.array(z.string()))', () => {
    const action = makeAction(
      'op',
      z.object({
        urls: z.preprocess(
          (val) => val,
          z.array(z.string()).describe('Array of URLs'),
        ),
      }),
    );
    const { inputSchema } = SchemaGenerator.generate([action]);
    const variant = (inputSchema as { anyOf: Array<{ properties: Record<string, unknown> }> })
      .anyOf[0];
    const urlsProp = variant.properties.urls as Record<string, unknown>;
    expect(urlsProp.type).toBe('array');
    expect((urlsProp.items as Record<string, unknown>).type).toBe('string');
    expect(urlsProp.description).toBe('Array of URLs');
  });

  it('emits number type for z.preprocess(fn, z.number())', () => {
    const action = makeAction(
      'op',
      z.object({
        n: z.preprocess((val) => (typeof val === 'string' ? Number(val) : val), z.number()),
      }),
    );
    const { inputSchema } = SchemaGenerator.generate([action]);
    const variant = (inputSchema as { anyOf: Array<{ properties: Record<string, unknown> }> })
      .anyOf[0];
    const nProp = variant.properties.n as Record<string, unknown>;
    expect(nProp.type).toBe('number');
  });

  it('emits boolean type for z.preprocess(fn, z.boolean())', () => {
    const action = makeAction(
      'op',
      z.object({
        b: z.preprocess(
          (val) => (typeof val === 'string' ? val.toLowerCase() === 'true' : val),
          z.boolean().optional().default(false),
        ),
      }),
    );
    const { inputSchema } = SchemaGenerator.generate([action]);
    const variant = (inputSchema as { anyOf: Array<{ properties: Record<string, unknown> }> })
      .anyOf[0];
    const bProp = variant.properties.b as Record<string, unknown>;
    expect(bProp.type).toBe('boolean');
  });

  it('marks preprocessed required fields as required', () => {
    const action = makeAction(
      'op',
      z.object({
        urls: z.preprocess((val) => val, z.array(z.string())),
        optionalUrls: z.preprocess(
          (val) => val,
          z.array(z.string()).optional(),
        ),
      }),
    );
    const { inputSchema } = SchemaGenerator.generate([action]);
    const variant = (inputSchema as { anyOf: Array<{ required: string[] }> }).anyOf[0];
    expect(variant.required).toContain('urls');
    expect(variant.required).not.toContain('optionalUrls');
  });
});

describe('SchemaGenerator — parallel_fetch urls field', () => {
  it('emits urls as an array of strings (not a string)', async () => {
    const { parallelFetchAction } = await import(
      '../../src/tool/BrowserTool/actions/parallel'
    );
    const { inputSchema } = SchemaGenerator.generate([parallelFetchAction]);
    const variants = (inputSchema as { anyOf: Array<{ properties: Record<string, unknown>; required: string[] }> })
      .anyOf;
    const parallel = variants.find(
      (v) => (v.properties.operation as { enum: string[] }).enum[0] === 'parallel_fetch',
    );
    expect(parallel).toBeDefined();
    const urls = parallel!.properties.urls as Record<string, unknown>;
    expect(urls.type).toBe('array');
    expect((urls.items as Record<string, unknown>).type).toBe('string');
    expect(parallel!.required).toContain('urls');
  });

  it('emits timeoutMs as a number (not a string)', async () => {
    const { parallelFetchAction } = await import(
      '../../src/tool/BrowserTool/actions/parallel'
    );
    const { inputSchema } = SchemaGenerator.generate([parallelFetchAction]);
    const variants = (inputSchema as { anyOf: Array<{ properties: Record<string, unknown> }> })
      .anyOf;
    const parallel = variants.find(
      (v) => (v.properties.operation as { enum: string[] }).enum[0] === 'parallel_fetch',
    );
    const timeoutMs = parallel!.properties.timeoutMs as Record<string, unknown>;
    expect(timeoutMs.type).toBe('number');
  });
});
