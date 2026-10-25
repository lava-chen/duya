/**
 * The `/init` writer — the file the command actually produces.
 *
 * These are real files in a real temporary directory: the write is atomic
 * (temp + rename), the decision is idempotent, and the interesting cases are
 * the ones where an existing file must NOT be touched.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  INIT_AGENTS_MD_MARKER_PREFIX,
  readInitAgentsMdVersion,
} from '../src/agents-md/init-template.js';
import { writeInitAgentsMd } from '../src/agents-md/write-agents-md.js';

let root: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'duya-init-md-')));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function target(): string {
  return path.join(root, 'AGENTS.md');
}

describe('writeInitAgentsMd', () => {
  it('creates the file and records the template version', async () => {
    const result = await writeInitAgentsMd(root);

    expect(result.ok).toBe(true);
    expect(result.created).toBe(true);
    expect(result.upgraded).toBe(false);
    expect(result.unchanged).toBe(false);
    expect(result.replacedUnmarked).toBeUndefined();
    expect(result.version).toBe(1);

    const body = fs.readFileSync(target(), 'utf-8');
    expect(body.startsWith(`${INIT_AGENTS_MD_MARKER_PREFIX}1 -->`)).toBe(true);
    expect(readInitAgentsMdVersion(body)).toBe(1);
  });

  it('leaves a current file exactly as it is', async () => {
    await writeInitAgentsMd(root);
    const before = fs.readFileSync(target(), 'utf-8');
    // The user edits the file.
    fs.writeFileSync(target(), `${before}\nHand-written addition.\n`, 'utf-8');
    const edited = fs.readFileSync(target(), 'utf-8');

    const result = await writeInitAgentsMd(root);

    expect(result.unchanged).toBe(true);
    expect(result.upgraded).toBe(false);
    expect(fs.readFileSync(target(), 'utf-8')).toBe(edited);
  });

  it('upgrades a file recorded below the current version', async () => {
    fs.writeFileSync(
      target(),
      `${INIT_AGENTS_MD_MARKER_PREFIX}0 -->\nold body\n`,
      'utf-8',
    );

    const result = await writeInitAgentsMd(root);

    expect(result.upgraded).toBe(true);
    expect(result.created).toBe(false);
    expect(result.unchanged).toBe(false);
    // A file that DOES carry a marker was written by duya, so overwriting it
    // is an upgrade and not the destruction of the user's own file.
    expect(result.replacedUnmarked).toBeUndefined();
    expect(readInitAgentsMdVersion(fs.readFileSync(target(), 'utf-8'))).toBe(1);
  });

  it('reports a marker-less file as replaced, because it was the user\'s own', async () => {
    fs.writeFileSync(target(), '# My own AGENTS.md\n', 'utf-8');

    const result = await writeInitAgentsMd(root);

    expect(result.replacedUnmarked).toBe(true);
    expect(result.upgraded).toBe(true);
    expect(readInitAgentsMdVersion(fs.readFileSync(target(), 'utf-8'))).toBe(1);
  });

  it('leaves no temporary file behind', async () => {
    await writeInitAgentsMd(root);
    expect(fs.readdirSync(root)).toEqual(['AGENTS.md']);
  });
});
