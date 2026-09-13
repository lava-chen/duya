import * as crypto from 'crypto';

/**
 * Migration 0013: Project avatar icon + color columns (Plan 525 follow-up).
 *
 * The create-project dialog lets users pick an icon glyph and an
 * accent color for a project. Both are free-form strings (icon name
 * from the renderer icon registry, color as a palette keyword) and
 * nullable — projects created programmatically keep NULL and render
 * with the default folder icon.
 */
const SQL = `
ALTER TABLE projects ADD COLUMN icon TEXT;
ALTER TABLE projects ADD COLUMN color TEXT;
`;

export const migration0013 = {
  version: 13,
  name: 'project_icon_color',
  sql: SQL,
  sha256: crypto.createHash('sha256').update(SQL).digest('hex'),
};
