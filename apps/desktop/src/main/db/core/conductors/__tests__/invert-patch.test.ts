import { describe, expect, it } from 'vitest';
import { invertPatch } from '../invert-patch';

describe('invertPatch', () => {
  describe('canvas.rename', () => {
    it('restores prevName when present', () => {
      const out = invertPatch({ name: 'New', prevName: 'Old' }, 'canvas.rename');
      expect(out).toEqual({ name: 'Old' });
    });

    it('falls back to "Untitled" when prevName missing', () => {
      const out = invertPatch({ name: 'New' }, 'canvas.rename');
      expect(out).toEqual({ name: 'Untitled' });
    });
  });

  describe('widget.* (legacy dual-write path)', () => {
    it('widget.create returns empty (inverse = delete, branch handles row removal)', () => {
      expect(invertPatch({ widget: { id: 'w1' } }, 'widget.create')).toEqual({});
    });

    it('widget.move returns prevPosition', () => {
      const out = invertPatch({ position: { x: 10, y: 20 }, prevPosition: { x: 0, y: 0 } }, 'widget.move');
      expect(out).toEqual({ position: { x: 0, y: 0 } });
    });

    it('widget.resize returns prevPosition (same shape as move)', () => {
      const out = invertPatch({ position: { x: 100, y: 100, w: 8, h: 4 }, prevPosition: { x: 0, y: 0, w: 4, h: 3 } }, 'widget.resize');
      expect(out).toEqual({ position: { x: 0, y: 0, w: 4, h: 3 } });
    });

    it('widget.update_config returns prevConfig', () => {
      const out = invertPatch({ config: { theme: 'dark' }, prevConfig: { theme: 'light' } }, 'widget.update_config');
      expect(out).toEqual({ config: { theme: 'light' } });
    });

    it('widget.update_data returns prevData', () => {
      const out = invertPatch({ data: { items: [1, 2] }, prevData: { items: [] } }, 'widget.update_data');
      expect(out).toEqual({ data: { items: [] } });
    });

    it('widget.delete returns empty (redo branch reads deletedWidget from patch)', () => {
      expect(invertPatch({ deletedWidget: { id: 'w1' } }, 'widget.delete')).toEqual({});
    });

    it('widget.restore returns empty (inverse = delete)', () => {
      expect(invertPatch({ restoredWidget: { id: 'w1' } }, 'widget.restore')).toEqual({});
    });
  });

  describe('element.* (current primary protocol)', () => {
    it('element.create returns empty (inverse = delete by elementId)', () => {
      expect(invertPatch({ element: { id: 'e1' } }, 'element.create')).toEqual({});
    });

    it('element.move returns prevPosition', () => {
      const out = invertPatch({ position: { x: 5, y: 5 }, prevPosition: { x: 1, y: 1 } }, 'element.move');
      expect(out).toEqual({ position: { x: 1, y: 1 } });
    });

    it('element.update returns all three prev fields when present', () => {
      const out = invertPatch(
        {
          config: { k: 'new' },
          prevConfig: { k: 'old' },
          vizSpec: { type: 'new' },
          prevVizSpec: { type: 'old' },
          position: { x: 9 },
          prevPosition: { x: 0 },
        },
        'element.update',
      );
      expect(out).toEqual({
        config: { k: 'old' },
        vizSpec: { type: 'old' },
        position: { x: 0 },
      });
    });

    it('element.update tolerates missing prev fields (identity fallback)', () => {
      const out = invertPatch({ config: { k: 'k' } }, 'element.update');
      expect(out).toEqual({ config: { k: 'k' }, vizSpec: undefined, position: undefined });
    });

    it('element.update preserves vizSpec when prevVizSpec is null but vizSpec is set', () => {
      const out = invertPatch({ config: {}, vizSpec: { a: 1 }, prevVizSpec: null }, 'element.update');
      // null ?? { a: 1 } = { a: 1 }, so vizSpec in result is the current value
      expect(out).toMatchObject({ config: {}, vizSpec: { a: 1 } });
    });

    it('element.delete returns empty (redo branch reads deletedElement from patch)', () => {
      expect(invertPatch({ deletedElement: { id: 'e1' } }, 'element.delete')).toEqual({});
    });

    it('element.arrange returns empty (no-op undo; arrange is not reversible)', () => {
      expect(invertPatch({ layout: [] }, 'element.arrange')).toEqual({});
    });
  });

  describe('native and connector actions (Phase 3.7 additions)', () => {
    // Patch shape must match what conductor:action writes in db-handlers.ts.
    // For native/connector create the row is stored under patch.element.
    // For update_content, prevConfig is the full previous config JSON.
    // For reparent, prevMetadata.parentId is the previous parentId.
    it('element.create_native returns elementId for the undo branch', () => {
      const out = invertPatch({ element: { id: 'n1', elementKind: 'native/document' } }, 'element.create_native');
      expect(out).toEqual({ elementId: 'n1' });
    });

    it('element.create_native handles missing element gracefully', () => {
      const out = invertPatch({}, 'element.create_native');
      expect(out).toEqual({ elementId: undefined });
    });

    it('connector.create returns elementId (rows live in conductor_elements)', () => {
      const out = invertPatch({ element: { id: 'c1', elementKind: 'native/connector' } }, 'connector.create');
      expect(out).toEqual({ elementId: 'c1' });
    });

    it('connector.create handles missing element gracefully', () => {
      const out = invertPatch({}, 'connector.create');
      expect(out).toEqual({ elementId: undefined });
    });

    it('element.update_content returns prevConfig as content for undo UPDATE', () => {
      const prevConfig = { title: 'Old Title' };
      const nextConfig = { title: 'New Title' };
      const out = invertPatch({ config: nextConfig, prevConfig }, 'element.update_content');
      expect(out).toEqual({ content: prevConfig });
    });

    it('element.update_content falls back to current config when prevConfig missing', () => {
      const cfg = { title: 'Same' };
      const out = invertPatch({ config: cfg }, 'element.update_content');
      expect(out).toEqual({ content: cfg });
    });

    it('element.reparent returns prevMetadata.parentId', () => {
      const out = invertPatch(
        { metadata: { parentId: 'p2' }, prevMetadata: { parentId: 'p1' } },
        'element.reparent',
      );
      expect(out).toEqual({ parentId: 'p1' });
    });

    it('element.reparent falls back to current metadata.parentId when prevMetadata missing', () => {
      const out = invertPatch({ metadata: { parentId: 'p1' } }, 'element.reparent');
      expect(out).toEqual({ parentId: 'p1' });
    });

    it('element.reparent tolerates metadata.parentId missing (returns undefined)', () => {
      const out = invertPatch({ metadata: {}, prevMetadata: {} }, 'element.reparent');
      expect(out).toEqual({ parentId: undefined });
    });
  });

  describe('unknown action_type', () => {
    it('returns empty (defensive default)', () => {
      expect(invertPatch({ foo: 'bar' }, 'unknown.action')).toEqual({});
    });

    it('returns empty for empty patch on unknown action', () => {
      expect(invertPatch({}, '')).toEqual({});
    });
  });
});