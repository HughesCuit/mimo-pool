import assert from 'node:assert/strict';
import { test } from 'node:test';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMemoryStore, SqliteStore } from '../src/store.ts';

test('importKeys trims, deduplicates, and assigns stable order within group', async () => {
  const store = createMemoryStore();

  const imported = await store.importKeys('CN', [' key-a ', '', 'key-b', 'key-a']);

  assert.equal(imported.length, 2);
  assert.deepEqual(
    (await store.listKeys()).map((key) => ({
      key: key.apiKey,
      masked: key.maskedKey,
      order: key.sortOrder,
      status: key.status
    })),
    [
      { key: 'key-a', masked: 'key...ey-a', order: 10, status: 'active' },
      { key: 'key-b', masked: 'key...ey-b', order: 20, status: 'active' }
    ]
  );
});

test('resetKey makes an exhausted key active again', async () => {
  const store = createMemoryStore();
  const [key] = await store.importKeys('AMS', ['ams-key']);

  await store.markKeyExhausted(key.id, 'balance exhausted');
  await store.resetKey(key.id);

  assert.equal((await store.getKey(key.id)).status, 'active');
  assert.equal((await store.getKey(key.id)).exhaustedReason, null);
});

test('SqliteStore can enable and disable keys without treating status literals as columns', async () => {
  const dbPath = join(tmpdir(), `mimo-pool-${Date.now()}-${Math.random()}.sqlite`);
  const store = new SqliteStore(dbPath);
  try {
    const [key] = await store.importKeys('CN', ['sqlite-key']);
    await store.setKeyStatus(key.id, 'disabled');
    assert.equal((await store.getKey(key.id)).status, 'disabled');
    await store.setKeyStatus(key.id, 'active');
    assert.equal((await store.getKey(key.id)).status, 'active');
  } finally {
    store.close();
    for (const suffix of ['', '-shm', '-wal']) {
      try {
        unlinkSync(dbPath + suffix);
      } catch {
        // Ignore cleanup races on Windows.
      }
    }
  }
});

test('store backup export includes raw keys and import restores groups, keys, status, and stats', async () => {
  const source = createMemoryStore();
  await source.updateServiceGroup('SGP', {
    sortOrder: 5,
    enabled: false,
    openaiBaseUrl: 'https://example.test/openai',
    anthropicBaseUrl: 'https://example.test/anthropic'
  });
  const [key] = await source.importKeys('SGP', ['tp-secret-backup-key']);
  await source.recordKeySuccess(key.id);
  await source.markKeyExhausted(key.id, 'quota exhausted');

  const snapshot = await source.exportBackup();
  const target = createMemoryStore();
  const result = await target.importBackup(snapshot);
  await target.importBackup(snapshot);

  const restoredGroup = (await target.listServiceGroups()).find((group) => group.code === 'SGP');
  const restoredKeys = await target.listKeys();
  const restoredKey = restoredKeys.find((item) => item.apiKey === 'tp-secret-backup-key');

  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.apiKeys[0].apiKey, 'tp-secret-backup-key');
  assert.equal(result.groupsUpdated, 3);
  assert.equal(result.keysCreated, 1);
  assert.equal(result.keysUpdated, 0);
  assert.equal(restoredGroup.enabled, false);
  assert.equal(restoredGroup.sortOrder, 5);
  assert.equal(restoredGroup.openaiBaseUrl, 'https://example.test/openai');
  assert.equal(restoredKey.status, 'exhausted');
  assert.equal(restoredKey.exhaustedReason, 'quota exhausted');
  assert.equal(restoredKey.requestCount, 1);
  assert.equal(restoredKey.failureCount, 1);
  assert.equal(restoredKeys.filter((item) => item.apiKey === 'tp-secret-backup-key').length, 1);
});

test('admin API exports and imports backup snapshots', async () => {
  const { createApp } = await import('../src/server.ts');
  const source = createMemoryStore();
  await source.importKeys('CN', ['tp-admin-export-key']);
  const sourceApp = createApp({ store: source, adminToken: 'admin-secret', proxyTokens: ['proxy-secret'] });
  const target = createMemoryStore();
  const targetApp = createApp({ store: target, adminToken: 'admin-secret', proxyTokens: ['proxy-secret'] });

  const sourceServer = await new Promise((resolve) => sourceApp.listen(0, '127.0.0.1', () => {
    const address = sourceApp.address();
    resolve({ url: `http://127.0.0.1:${address.port}`, close: () => new Promise((done) => sourceApp.close(done)) });
  }));
  const targetServer = await new Promise((resolve) => targetApp.listen(0, '127.0.0.1', () => {
    const address = targetApp.address();
    resolve({ url: `http://127.0.0.1:${address.port}`, close: () => new Promise((done) => targetApp.close(done)) });
  }));

  try {
    const exported = await fetch(`${sourceServer.url}/admin/api/export`, {
      headers: { authorization: 'Bearer admin-secret' }
    });
    const snapshot = await exported.json();
    const imported = await fetch(`${targetServer.url}/admin/api/import`, {
      method: 'POST',
      headers: { authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify(snapshot)
    });
    const keys = await target.listKeys();

    assert.equal(exported.status, 200);
    assert.equal(exported.headers.get('content-disposition').includes('mimo-pool-backup'), true);
    assert.equal(snapshot.apiKeys[0].apiKey, 'tp-admin-export-key');
    assert.equal(imported.status, 200);
    assert.equal((await imported.json()).result.keysCreated, 1);
    assert.equal(keys[0].apiKey, 'tp-admin-export-key');
  } finally {
    await sourceServer.close();
    await targetServer.close();
  }
});
