import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { createApp } from '../src/server.ts';
import { createMemoryStore } from '../src/store.ts';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(done))
      });
    });
  });
}

function upstream(handler) {
  return listen(http.createServer(handler));
}

test('admin home renders login screen before the management app', async () => {
  const store = createMemoryStore();
  const app = createApp({ store, adminToken: 'admin-secret', proxyTokens: ['proxy-secret'] });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.url}/admin`);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /id="loginView"/);
    assert.match(html, /Admin token/);
    assert.match(html, /id="appShell"/);
    assert.match(html, /function loadStoredSessions/);
    assert.match(html, /webauthnInterceptor/);
  } finally {
    await server.close();
  }
});

test('admin chat endpoint can send through the configured proxy pool', async () => {
  const target = await upstream((req, res) => {
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, 'Bearer pool-key');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'proxy hello' } }] }));
  });
  const store = createMemoryStore();
  await store.updateServiceGroup('CN', { openaiBaseUrl: `${target.url}/v1` });
  await store.importKeys('CN', ['pool-key']);
  const app = createApp({ store, adminToken: 'admin-secret', proxyTokens: ['proxy-secret'] });
  const server = await listen(app);

  try {
    const response = await fetch(`${server.url}/admin/api/chat`, {
      method: 'POST',
      headers: { authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'proxy',
        protocol: 'openai',
        model: 'mimo',
        messages: [{ role: 'user', content: 'hi' }]
      })
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.reply, 'proxy hello');
    assert.equal(body.mode, 'proxy');
  } finally {
    await server.close();
    await target.close();
  }
});

test('admin chat endpoint maps OpenAI Responses chat to chat completions upstream for Mimo compatibility', async () => {
  let observedUrl = '';
  const target = await upstream((req, res) => {
    observedUrl = req.url;
    assert.equal(req.headers.authorization, 'Bearer pool-key');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'responses via chat' } }] }));
  });
  const store = createMemoryStore();
  await store.updateServiceGroup('CN', { openaiBaseUrl: `${target.url}/v1` });
  await store.importKeys('CN', ['pool-key']);
  const app = createApp({ store, adminToken: 'admin-secret', proxyTokens: ['proxy-secret'] });
  const server = await listen(app);

  try {
    const response = await fetch(`${server.url}/admin/api/chat`, {
      method: 'POST',
      headers: { authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'proxy',
        apiType: 'openai-responses',
        model: 'mimo',
        messages: [{ role: 'user', content: 'hi' }]
      })
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(observedUrl, '/v1/chat/completions');
    assert.equal(body.reply, 'responses via chat');
    assert.equal(body.apiType, 'openai-responses');
  } finally {
    await server.close();
    await target.close();
  }
});

test('admin chat endpoint can send directly with a selected configured API key', async () => {
  const target = await upstream((req, res) => {
    assert.equal(req.url, '/v1/messages');
    assert.equal(req.headers['x-api-key'], 'direct-key');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ content: [{ type: 'text', text: 'direct hello' }] }));
  });
  const store = createMemoryStore();
  await store.updateServiceGroup('SGP', { anthropicBaseUrl: target.url });
  const [key] = await store.importKeys('SGP', ['direct-key']);
  const app = createApp({ store, adminToken: 'admin-secret', proxyTokens: ['proxy-secret'] });
  const server = await listen(app);

  try {
    const response = await fetch(`${server.url}/admin/api/chat`, {
      method: 'POST',
      headers: { authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'direct',
        protocol: 'anthropic',
        keyId: key.id,
        model: 'claude',
        messages: [{ role: 'user', content: 'hi' }]
      })
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.reply, 'direct hello');
    assert.equal(body.mode, 'direct');
  } finally {
    await server.close();
    await target.close();
  }
});

test('admin models endpoint lists model ids for the selected proxy-compatible route', async () => {
  let observedUrl = '';
  const target = await upstream((req, res) => {
    observedUrl = req.url;
    assert.equal(req.headers.authorization, 'Bearer pool-key');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'mimo-chat' }, { id: 'mimo-reasoner' }] }));
  });
  const store = createMemoryStore();
  await store.updateServiceGroup('CN', { openaiBaseUrl: `${target.url}/v1` });
  await store.importKeys('CN', ['pool-key']);
  const app = createApp({ store, adminToken: 'admin-secret', proxyTokens: ['proxy-secret'] });
  const server = await listen(app);

  try {
    const response = await fetch(`${server.url}/admin/api/models?mode=proxy&apiType=openai-chat`, {
      headers: { authorization: 'Bearer admin-secret' }
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(observedUrl, '/v1/models');
    assert.deepEqual(body.models, ['mimo-chat', 'mimo-reasoner']);
  } finally {
    await server.close();
    await target.close();
  }
});
