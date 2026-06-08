/**
 * registry smoke test
 * Verifies extension routing and unsupported format handling.
 */

import { describe, it, expect } from 'vitest';
import { getParser, listSupportedExtensions, REGISTRY } from '../registry.js';

describe('ParserRegistry', () => {
  it('routes known extensions to parsers', () => {
    expect(getParser('.txt')).not.toBeNull();
    expect(getParser('.md')).not.toBeNull();
    expect(getParser('.docx')).not.toBeNull();
    expect(getParser('.pptx')).not.toBeNull();
    expect(getParser('.pdf')).not.toBeNull();
    expect(getParser('.png')).not.toBeNull();
    expect(getParser('.jpg')).not.toBeNull();
    expect(getParser('.jpeg')).not.toBeNull();
    expect(getParser('.gif')).not.toBeNull();
    expect(getParser('.webp')).not.toBeNull();
  });

  it('returns null for unsupported extensions', () => {
    expect(getParser('.zip')).toBeNull();
    expect(getParser('.exe')).toBeNull();
    expect(getParser('.doc')).toBeNull(); // .doc not migrated (Phase 7)
    expect(getParser('')).toBeNull();
  });

  it('lowercases extensions', () => {
    expect(getParser('.PDF')).not.toBeNull();
    expect(getParser('.TXT')).not.toBeNull();
  });

  it('lists all supported extensions', () => {
    const exts = listSupportedExtensions();
    expect(exts).toContain('.pdf');
    expect(exts).toContain('.docx');
    expect(exts).toContain('.txt');
    expect(exts.length).toBe(Object.keys(REGISTRY).length);
  });
});
