/**
 * conductor.test.ts — zod schema validation for the group tool actions.
 *
 * The ConductorActionRequestSchema is a discriminated union on the
 * `action` field. The group.* variants enforce:
 *   - memberIds: non-empty array (z.array(z.string()).min(1))
 *   - groupId: non-empty string (z.string().min(1))
 *
 * These tests verify that invalid inputs are rejected so the executor
 * never receives a malformed group request.
 */
import { describe, it, expect } from 'vitest';
import { ConductorActionRequestSchema } from '../conductor';

describe('ConductorActionRequestSchema — group tool validation', () => {
  // ── group.create ──────────────────────────────────────────────

  it('group.create rejects an empty memberIds array', () => {
    const result = ConductorActionRequestSchema.safeParse({
      action: 'group.create',
      canvasId: 'c1',
      memberIds: [],
    });
    expect(result.success).toBe(false);
  });

  it('group.create accepts a valid payload with one member', () => {
    const result = ConductorActionRequestSchema.safeParse({
      action: 'group.create',
      canvasId: 'c1',
      memberIds: ['el-1'],
      title: 'My Group',
      bgColor: '#FF0000',
    });
    expect(result.success).toBe(true);
  });

  it('group.create accepts a payload without optional title/bgColor', () => {
    const result = ConductorActionRequestSchema.safeParse({
      action: 'group.create',
      canvasId: 'c1',
      memberIds: ['el-1', 'el-2'],
    });
    expect(result.success).toBe(true);
  });

  // ── group.ungroup ─────────────────────────────────────────────

  it('group.ungroup rejects an empty groupId', () => {
    const result = ConductorActionRequestSchema.safeParse({
      action: 'group.ungroup',
      canvasId: 'c1',
      groupId: '',
    });
    expect(result.success).toBe(false);
  });

  it('group.ungroup accepts a non-empty groupId', () => {
    const result = ConductorActionRequestSchema.safeParse({
      action: 'group.ungroup',
      canvasId: 'c1',
      groupId: 'group-1',
    });
    expect(result.success).toBe(true);
  });

  // ── group.add_members ─────────────────────────────────────────

  it('group.add_members rejects an empty memberIds array', () => {
    const result = ConductorActionRequestSchema.safeParse({
      action: 'group.add_members',
      canvasId: 'c1',
      groupId: 'group-1',
      memberIds: [],
    });
    expect(result.success).toBe(false);
  });

  it('group.add_members rejects an empty groupId', () => {
    const result = ConductorActionRequestSchema.safeParse({
      action: 'group.add_members',
      canvasId: 'c1',
      groupId: '',
      memberIds: ['el-1'],
    });
    expect(result.success).toBe(false);
  });

  it('group.add_members accepts a valid payload', () => {
    const result = ConductorActionRequestSchema.safeParse({
      action: 'group.add_members',
      canvasId: 'c1',
      groupId: 'group-1',
      memberIds: ['el-2', 'el-3'],
    });
    expect(result.success).toBe(true);
  });

  // ── group.remove_members ──────────────────────────────────────

  it('group.remove_members rejects an empty memberIds array', () => {
    const result = ConductorActionRequestSchema.safeParse({
      action: 'group.remove_members',
      canvasId: 'c1',
      groupId: 'group-1',
      memberIds: [],
    });
    expect(result.success).toBe(false);
  });

  it('group.remove_members accepts a valid payload', () => {
    const result = ConductorActionRequestSchema.safeParse({
      action: 'group.remove_members',
      canvasId: 'c1',
      groupId: 'group-1',
      memberIds: ['el-2'],
    });
    expect(result.success).toBe(true);
  });

  // ── unknown action ────────────────────────────────────────────

  it('rejects an unknown action discriminator', () => {
    const result = ConductorActionRequestSchema.safeParse({
      action: 'group.bogus',
      canvasId: 'c1',
      memberIds: ['el-1'],
    });
    expect(result.success).toBe(false);
  });
});

describe('ConductorActionRequestSchema — connector endpoints', () => {
  it('accepts bound and free endpoint references with connector style fields', () => {
    const result = ConductorActionRequestSchema.safeParse({
      action: 'connector.create',
      canvasId: 'c1',
      source: { kind: 'bound', nodeId: 'node-1', bindingPoint: { u: 0.25, v: 0.75 } },
      target: { kind: 'free', point: { x: 420, y: 180 } },
      routingMode: 'elbow',
      color: '#8b5cf6',
      endMarker: 'arrow',
    });
    expect(result.success).toBe(true);
  });

  it('keeps legacy anchored endpoints readable and rejects invalid binding ratios', () => {
    expect(ConductorActionRequestSchema.safeParse({
      action: 'connector.create',
      canvasId: 'c1',
      source: { nodeId: 'node-1', anchorId: 'bottom', edgePosition: 0.4 },
      target: { nodeId: 'node-2', anchorId: 'top' },
    }).success).toBe(true);
    expect(ConductorActionRequestSchema.safeParse({
      action: 'connector.create',
      canvasId: 'c1',
      source: { kind: 'bound', nodeId: 'node-1', bindingPoint: { u: 1.2, v: 0.5 } },
      target: { kind: 'free', point: { x: 10, y: 20 } },
    }).success).toBe(false);
  });
});

import type { CanvasElement, ElementMetadata } from '../conductor';

describe('ElementMetadata layout hints', () => {
  it('supports locked, priority, minSize, resizeMode fields', () => {
    const md: ElementMetadata = {
      label: 'TaskList',
      tags: [],
      createdBy: 'user',
      locked: false,
      priority: 'high',
      minSize: { w: 2, h: 1 },
      resizeMode: 'free',
    };
    expect(md.locked).toBe(false);
    expect(md.priority).toBe('high');
    expect(md.minSize).toEqual({ w: 2, h: 1 });
    expect(md.resizeMode).toBe('free');
  });

  it('defaults are undefined when not set (no DB migration)', () => {
    const md: ElementMetadata = {
      label: 'Note',
      tags: [],
      createdBy: 'user',
    };
    expect(md.locked).toBeUndefined();
    expect(md.priority).toBeUndefined();
    expect(md.minSize).toBeUndefined();
    expect(md.resizeMode).toBeUndefined();
  });
});
