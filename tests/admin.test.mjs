import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMemoryStore, SqliteStore } from '../src/store.ts';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ url: `http://127.0.0.1:${address.port}`, close: () => new Promise((done) => server.close(done)) });
    });
  });
}

function upstream(handler) {
  return listen(http.createServer(handler));
}

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

test('SqliteStore service group partial updates keep omitted URLs unchanged', async () => {
  const dbPath = join(tmpdir(), `mimo-pool-${Date.now()}-${Math.random()}.sqlite`);
  const store = new SqliteStore(dbPath);
  try {
    const before = (await store.listServiceGroups()).find((group) => group.code === 'CN');

    const updated = await store.updateServiceGroup('CN', { openaiBaseUrl: 'http://127.0.0.1:9999/v1' });

    assert.equal(updated.openaiBaseUrl, 'http://127.0.0.1:9999/v1');
    assert.equal(updated.anthropicBaseUrl, before.anthropicBaseUrl);
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

test('store manages accounts, key bindings, cookie metadata, and usage without leaking cookies in backups', async () => {
  const store = createMemoryStore();
  const account = await store.createAccount({ email: 'user@example.com', userId: '6870851481' });
  const [key] = await store.importKeys('CN', ['tp-account-key']);

  await store.setKeyAccount(key.id, account.id);
  await store.saveAccountCookie(account.id, {
    cookieHeader: 'api-platform_serviceToken="secret-token"; userId=6870851481',
    maskedCookie: 'api-platform_serviceToken="sec...ken"; userId=687...1481',
    userId: '6870851481'
  });
  await store.saveAccountUsage(account.id, {
    monthUsage: { items: [{ name: 'month_total_token', used: 1, limit: 10, percent: 10 }] },
    usage: { items: [{ name: 'plan_total_token', used: 1, limit: 10, percent: 10 }] },
    refreshedAt: '2026-05-27T00:00:00.000Z'
  });

  const accounts = await store.listAccounts();
  const snapshot = await store.exportBackup();

  assert.equal((await store.getKey(key.id)).accountId, account.id);
  assert.equal(accounts[0].keyCount, 1);
  assert.equal(accounts[0].hasOwnProperty('cookieHeader'), false);
  assert.equal(accounts[0].usage.usage.items[0].name, 'plan_total_token');
  assert.equal(JSON.stringify(snapshot).includes('secret-token'), false);
  assert.equal(snapshot.accounts[0].email, 'user@example.com');
  assert.equal(snapshot.apiKeys[0].accountId, account.id);
});

test('admin API manages account cookies, key binding, and usage refresh', async () => {
  const { createApp } = await import('../src/server.ts');
  const previousUsageUrl = process.env.USAGE_API_URL;
  const usageServer = await upstream((req, res) => {
    assert.equal(req.headers.cookie, 'api-platform_serviceToken="secret-token"; userId=6870851481');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      code: 0,
      message: '',
      data: {
        monthUsage: { percent: 1, items: [{ name: 'month_total_token', used: 10, limit: 100, percent: 10 }] },
        usage: { percent: 1, items: [{ name: 'plan_total_token', used: 10, limit: 100, percent: 10 }] }
      }
    }));
  });
  process.env.USAGE_API_URL = `${usageServer.url}/usage`;
  process.env.USAGE_REFRESH_INTERVAL_MS = '0';
  const store = createMemoryStore();
  const [key] = await store.importKeys('CN', ['tp-admin-account-key']);
  const app = createApp({ store, adminToken: 'admin-secret', proxyTokens: ['proxy-secret'] });
  const server = await listen(app);

  try {
    const created = await fetch(`${server.url}/admin/api/accounts`, {
      method: 'POST',
      headers: { authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.com' })
    });
    const account = (await created.json()).account;
    const cookie = await fetch(`${server.url}/admin/api/accounts/${account.id}/cookie`, {
      method: 'POST',
      headers: { authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ cookieHeader: 'api-platform_serviceToken="secret-token"; userId=6870851481' })
    });
    const bind = await fetch(`${server.url}/admin/api/keys/${key.id}/account`, {
      method: 'POST',
      headers: { authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: account.id })
    });
    const refresh = await fetch(`${server.url}/admin/api/accounts/${account.id}/refresh`, {
      method: 'POST',
      headers: { authorization: 'Bearer admin-secret' }
    });
    const listed = await fetch(`${server.url}/admin/api/accounts`, {
      headers: { authorization: 'Bearer admin-secret' }
    });
    const accounts = (await listed.json()).accounts;

    assert.equal(created.status, 201);
    assert.equal(cookie.status, 200);
    assert.equal(bind.status, 200);
    assert.equal(refresh.status, 200);
    assert.equal(accounts[0].userId, '6870851481');
    assert.equal(accounts[0].hasCookie, true);
    assert.equal(JSON.stringify(accounts).includes('secret-token'), false);
    assert.equal(accounts[0].usage.usage.items[0].name, 'plan_total_token');
  } finally {
    if (previousUsageUrl === undefined) delete process.env.USAGE_API_URL;
    else process.env.USAGE_API_URL = previousUsageUrl;
    delete process.env.USAGE_REFRESH_INTERVAL_MS;
    await server.close();
    await usageServer.close();
  }
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
