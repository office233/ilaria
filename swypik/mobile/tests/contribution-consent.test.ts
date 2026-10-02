import assert from 'node:assert/strict';
import test from 'node:test';
import { initialConsent, changeConsent, revokeConsent } from '../src/features/contribution/consent.ts';
import { contributionAvailability, requireContributionExecutor } from '../src/features/contribution/client.ts';

test('data/compute are off by default and independent', () => {
  const initial = initialConsent('fixture-user');
  assert.equal(initial.data, false); assert.equal(initial.compute, false);
  const data = changeConsent(initial, 'data', true);
  assert.equal(data.compute, false); assert.equal(data.data, true);
  const compute = changeConsent(initial, 'compute', true);
  assert.equal(compute.data, false); assert.equal(compute.compute, true);
  const revoked = revokeConsent({ ...data, compute: true });
  assert.equal(revoked.data, false); assert.equal(revoked.compute, false);
  assert.ok(revoked.epoch > data.epoch);
});
test('anonymous preferences cannot authorize anything', () => {
  assert.throws(() => changeConsent(initialConsent(), 'compute', true));
});
test('consent cannot fake-enable missing training or phone executor', () => {
  const consent = changeConsent(changeConsent(initialConsent('fixture-user'), 'data', true), 'compute', true);
  assert.throws(() => requireContributionExecutor(consent), /unavailable/);
  assert.equal(contributionAvailability.phoneExecutor, 'unavailable');
  assert.equal(contributionAvailability.compute, 'awaiting-release');
});
