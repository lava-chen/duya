/**
 * groups store tests (Plan 478 P1.1) — main-process groups.toml CRUD.
 *
 * The toml path resolves through `resolveConfigRoot()` (compass), which
 * honors `DUYA_TEST=1` + `DUYA_TEST_NAMESPACE`; each test claims a unique
 * namespace so writes stay isolated from a real `~/.duya` tree.
 */

import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ConfigStore } from '../store';
import { _setConfigStoreForTest } from '../store-instance';
import { upsertConfigAgent } from '../agents';
import { createGroup, deleteGroup, getGroup, listGroups, updateGroup, GROUP_MAX_MEMBERS } from '../groups';

const NAMESPACE = `groups-test-${process.pid}`;

function duyaRoot(): string {
  return path.join(os.homedir(), '.duya', 'test-namespaces', NAMESPACE);
}

function groupsTomlPath(): string {
  return path.join(duyaRoot(), 'groups.toml');
}

process.env.DUYA_TEST = '1';
process.env.DUYA_TEST_NAMESPACE = NAMESPACE;

// Group member validation reads the live bot roster through the config
// store — back it with a temp store so tests never touch config.toml.
const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-groups-store-'));
const store = new ConfigStore({
  configPath: path.join(storeDir, 'config.toml'),
  secretsPath: path.join(storeDir, 'secrets.json'),
});
_setConfigStoreForTest(store);
upsertConfigAgent('ada', { name: 'Ada' });
upsertConfigAgent('bob', { name: 'Bob' });
upsertConfigAgent('carol', { name: 'Carol' });

afterAll(() => {
  _setConfigStoreForTest(undefined);
  fs.rmSync(storeDir, { recursive: true, force: true });
  try {
    fs.rmSync(duyaRoot(), { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

describe('groups CRUD', () => {
  it('createGroup writes groups.toml and listGroups resolves it', async () => {
    const created = await createGroup({ name: '产品讨论组', memberIds: ['ada', 'bob'] });
    expect(created.id).toMatch(/^group-[0-9a-f]{8}$/);
    expect(created.name).toBe('产品讨论组');
    expect(created.memberIds).toEqual(['ada', 'bob']);
    expect(created.maxRounds).toBe(3);
    expect(created.maxMemberTurns).toBe(10);

    const all = await listGroups();
    expect(all[created.id]?.name).toBe('产品讨论组');
    expect(fs.existsSync(groupsTomlPath())).toBe(true);
    const raw = fs.readFileSync(groupsTomlPath(), 'utf8');
    expect(raw).toContain(`[groups.${created.id}]`);
    expect(raw).toContain('"ada"');
  });

  it('getGroup returns a declared group and null for unknown ids', async () => {
    const created = await createGroup({ name: 'Ops', memberIds: ['carol'] });
    expect((await getGroup(created.id))?.name).toBe('Ops');
    expect(await getGroup('group-does-not-exist')).toBeNull();
  });

  it('createGroup rejects unknown members, duplicates, oversized rooms, and nested groups', async () => {
    await expect(createGroup({ name: 'X', memberIds: ['ghost'] })).rejects.toThrow(/Unknown group member/);
    await expect(createGroup({ name: 'X', memberIds: ['ada', 'ada'] })).rejects.toThrow(/Duplicate/);
    await expect(
      createGroup({ name: 'X', memberIds: ['ada', 'bob', 'carol', 'ghost', 'a1', 'a2', 'a3'] }),
    ).rejects.toThrow(/at most/);
    const created = await createGroup({ name: 'Outer', memberIds: ['ada', 'bob'] });
    await expect(createGroup({ name: 'Inner', memberIds: [created.id] })).rejects.toThrow(/not other groups/);
    expect(GROUP_MAX_MEMBERS).toBe(6);
  });

  it('createGroup rejects a blank name', async () => {
    await expect(createGroup({ name: '   ', memberIds: ['ada'] })).rejects.toThrow(/name is required/);
  });

  it('createGroup allows an empty room (members added later via settings)', async () => {
    const created = await createGroup({ name: 'Empty Room', memberIds: [] });
    expect(created.memberIds).toEqual([]);
    expect(created.description).toBe('');
  });

  it('persists and trims the description on create and update', async () => {
    const created = await createGroup({
      name: 'With Desc',
      memberIds: ['ada'],
      description: '  产品评审专用  ',
    });
    expect(created.description).toBe('产品评审专用');
    expect((await getGroup(created.id))?.description).toBe('产品评审专用');

    // Patch only the description: name/members stay untouched.
    const updated = await updateGroup(created.id, { description: '改版评审' });
    expect(updated.description).toBe('改版评审');
    expect(updated.name).toBe('With Desc');
    expect(updated.memberIds).toEqual(['ada']);
    const raw = fs.readFileSync(groupsTomlPath(), 'utf8');
    expect(raw).toContain('改版评审');
  });

  it('updateGroup patches only the supplied fields and revalidates members', async () => {
    const created = await createGroup({ name: 'Before', memberIds: ['ada'] });
    const updated = await updateGroup(created.id, { name: 'After', memberIds: ['ada', 'bob'], maxRounds: 5 });
    expect(updated.name).toBe('After');
    expect(updated.memberIds).toEqual(['ada', 'bob']);
    expect(updated.maxRounds).toBe(5);
    expect(updated.maxMemberTurns).toBe(10);
    await expect(updateGroup(created.id, { memberIds: ['ghost'] })).rejects.toThrow(/Unknown group member/);
    await expect(updateGroup('group-missing', { name: 'Nope' })).rejects.toThrow(/does not exist/);
  });

  it('deleteGroup removes the entry and is idempotent', async () => {
    const created = await createGroup({ name: 'Doomed', memberIds: ['ada', 'bob', 'carol'] });
    await deleteGroup(created.id);
    expect(await getGroup(created.id)).toBeNull();
    await expect(deleteGroup(created.id)).resolves.toBeUndefined();
  });
});
