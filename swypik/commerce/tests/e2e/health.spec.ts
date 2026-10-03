import { test, expect } from '@playwright/test';

test('/api/health reports healthy with all subsystems ok', async ({ request }) => {
  const res = await request.get('/api/health');
  expect(res.status()).toBe(200);
  const json = await res.json();
  expect(json.status).toBe('healthy');
  // Tolerate either "database" or "db" key naming
  const services = json.services ?? {};
  const db = services.database ?? services.db;
  expect(db, 'db status').toBe('ok');
  expect(services.redis, 'redis status').toBe('ok');

  // Storage can be a string ("ok") or an object { status, ok, latency_ms, bucket_configured }
  const storage = services.storage;
  const storageStatus = typeof storage === 'string' ? storage : storage?.status;
  expect(storageStatus, 'storage status').toBe('ok');
});

test('/api/health exposes release metadata for deploy auditability', async ({ request }) => {
  const res = await request.get('/api/health');
  expect(res.status()).toBe(200);
  const json = await res.json();
  expect(json.release, 'release block present').toBeTruthy();
  expect(typeof json.release.commit, 'release.commit is string').toBe('string');
  expect(json.release.commit.length).toBeGreaterThan(0);
});

test('/api/health storage reports bucket_configured', async ({ request }) => {
  const res = await request.get('/api/health');
  const json = await res.json();
  const storage = json.services?.storage;
  if (typeof storage === 'object' && storage !== null) {
    expect(storage.bucket_configured, 'bucket_configured').toBe(true);
  }
});
