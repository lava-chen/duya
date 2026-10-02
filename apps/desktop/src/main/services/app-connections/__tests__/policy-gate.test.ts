import { describe, it, expect } from 'vitest';
import {
  isProviderEnabled,
  type AppPolicy,
} from '../policy-gate';

describe('app-connection policy gate (Plan 450 Phase C)', () => {
 it('fails open to enabled when the per-provider entry is missing', () => {
  const policy: AppPolicy = { perProvider: {} };
  expect(isProviderEnabled(policy, 'notion')).toBe(true);
 });

 it('fails open to enabled when an entry exists but lacks `enabled`', () => {
  const policy: AppPolicy = {
   perProvider: { notion: { enabled: true } },
  };
  expect(isProviderEnabled(policy, 'notion')).toBe(true);
 });

 it('honors an explicit `enabled: false`', () => {
  const policy: AppPolicy = {
   perProvider: { notion: { enabled: false } },
  };
  expect(isProviderEnabled(policy, 'notion')).toBe(false);
 });

 it('isolates decisions per provider', () => {
  const policy: AppPolicy = {
   perProvider: {
    notion: { enabled: false },
    github: { enabled: true },
   },
  };
  expect(isProviderEnabled(policy, 'notion')).toBe(false);
  expect(isProviderEnabled(policy, 'github')).toBe(true);
  expect(isProviderEnabled(policy, 'unknown')).toBe(true);
 });
});