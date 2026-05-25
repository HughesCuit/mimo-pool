import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { createMemoryStore } from '../src/store.ts';
import { proxyCompatibleRequest } from '../src/proxy.ts';

function upstream(handler) {
  const server = http.createServer(handler);
  return listen(server);
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', async () => {
      const address = server.address();
      if (isFetchBlockedPort(address.port)) {
        await new Promise((done) => server.close(done));
        resolve(listen(server));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => {
          server.close((error) => {
            if (error) throw error;
            done();
          });
          server.closeAllConnections();
        })
      });
    });
  });
}

function isFetchBlockedPort(port) {
  return port === 6000 || port === 6566 || port === 6697 || port === 10080 || (port >= 6665 && port <= 6669);
}

test('proxyCompatibleRequest falls back after exhausted key and marks it exhausted', async () => {
  const first = await upstream((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer exhausted-key');
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'quota exhausted' } }));
  });
  const second = await upstream((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer healthy-key');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });

  try {
    const store = createMemoryStore();
    await store.updateServiceGroup('CN', { openaiBaseUrl: `${first.url}/v1` });
    await store.updateServiceGroup('SGP', { openaiBaseUrl: `${second.url}/v1` });
    const [firstKey] = await store.importKeys('CN', ['exhausted-key']);
    await store.importKeys('SGP', ['healthy-key']);

    const result = await proxyCompatibleRequest(store, {
      protocol: 'openai',
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ model: 'mimo', messages: [] }))
    });

    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(result.body.toString()), { ok: true, path: '/v1/chat/completions' });
    const keys = await store.listKeys();
    assert.equal(keys.find((key) => key.id === firstKey.id).status, 'exhausted');
  } finally {
    await first.close();
    await second.close();
  }
});

test('proxyCompatibleRequest returns client errors without disabling key', async () => {
  const target = await upstream((req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'model not found' }));
  });

  try {
    const store = createMemoryStore();
    await store.updateServiceGroup('CN', { openaiBaseUrl: `${target.url}/v1` });
    const [key] = await store.importKeys('CN', ['active-key']);

    const result = await proxyCompatibleRequest(store, {
      protocol: 'openai',
      method: 'POST',
      path: '/v1/responses',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('{}')
    });

    assert.equal(result.status, 404);
    assert.equal((await store.getKey(key.id)).status, 'active');
  } finally {
    await target.close();
  }
});

test('app proxies OpenAI models endpoint through the key pool', async () => {
  const { createApp } = await import('../src/server.ts');
  let observedUrl = '';
  let observedMethod = '';
  let observedAuthorization = '';
  const target = await upstream((req, res) => {
    observedMethod = req.method;
    observedUrl = req.url;
    observedAuthorization = req.headers.authorization;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'mimo-chat', object: 'model' }] }));
  });

  try {
    const store = createMemoryStore();
    await store.updateServiceGroup('CN', { openaiBaseUrl: `${target.url}/v1` });
    await store.importKeys('CN', ['model-key']);
    const app = createApp({ store, adminToken: 'admin-secret', proxyTokens: ['proxy-secret'] });
    const server = await listen(app);
    try {
      const response = await fetch(`${server.url}/v1/models`, {
        headers: { authorization: 'Bearer proxy-secret' }
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(observedMethod, 'GET');
      assert.equal(observedUrl, '/v1/models');
      assert.equal(observedAuthorization, 'Bearer model-key');
      assert.deepEqual(body.data.map((model) => model.id), ['mimo-chat']);
    } finally {
      await server.close();
    }
  } finally {
    await target.close();
  }
});

test('app maps public OpenAI responses endpoint to chat completions upstream', async () => {
  const { createApp } = await import('../src/server.ts');
  let observedUrl = '';
  let observedPayload = null;
  const target = await upstream(async (req, res) => {
    observedUrl = req.url;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    observedPayload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-1',
      model: observedPayload.model,
      choices: [{ message: { role: 'assistant', content: 'hello from chat' } }]
    }));
  });

  try {
    const store = createMemoryStore();
    await store.updateServiceGroup('CN', { openaiBaseUrl: `${target.url}/v1` });
    await store.importKeys('CN', ['responses-key']);
    const app = createApp({ store, adminToken: 'admin-secret', proxyTokens: ['proxy-secret'] });
    const server = await listen(app);
    try {
      const response = await fetch(`${server.url}/v1/responses`, {
        method: 'POST',
        headers: { authorization: 'Bearer proxy-secret', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'mimo-v2.5-pro',
          input: 'hello'
        })
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(observedUrl, '/v1/chat/completions');
      assert.deepEqual(observedPayload.messages, [{ role: 'user', content: 'hello' }]);
      assert.equal(body.object, 'response');
      assert.equal(body.model, 'mimo-v2.5-pro');
      assert.equal(body.output_text, 'hello from chat');
    } finally {
      await server.close();
    }
  } finally {
    await target.close();
  }
});

test('app maps streamed chat completion SSE into responses SSE instead of parsing it as JSON', async () => {
  const { createApp } = await import('../src/server.ts');
  let observedPayload = null;
  const target = await upstream((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      observedPayload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.equal(observedPayload.stream, true);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end([
        'data:{"id":"chatcmpl-1","model":"mimo-v2.5-pro","choices":[{"finish_reason":"stop","index":0,"message":{"content":"你好","role":"assistant"}}]}',
        '',
        'data:[DONE]',
        ''
      ].join('\n'));
    });
  });

  try {
    const store = createMemoryStore();
    await store.updateServiceGroup('CN', { openaiBaseUrl: `${target.url}/v1` });
    await store.importKeys('CN', ['stream-key']);
    const app = createApp({ store, adminToken: 'admin-secret', proxyTokens: ['proxy-secret'] });
    const server = await listen(app);
    try {
      const response = await fetch(`${server.url}/v1/responses`, {
        method: 'POST',
        headers: { authorization: 'Bearer proxy-secret', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'mimo-v2.5-pro',
          input: 'hello',
          stream: true
        })
      });
      const text = await response.text();

      assert.equal(response.status, 200);
      assert.equal(observedPayload.stream, true);
      assert.match(response.headers.get('content-type'), /text\/event-stream/);
      assert.match(text, /event: response\.output_item\.added/);
      assert.match(text, /event: response\.content_part\.added/);
      assert.match(text, /event: response\.output_text\.delta/);
      assert.match(text, /response\.output_text\.delta/);
      assert.match(text, /"delta":"你好"/);
      assert.match(text, /event: response\.output_text\.done/);
      assert.match(text, /event: response\.content_part\.done/);
      assert.match(text, /event: response\.output_item\.done/);
      assert.match(text, /event: response\.completed/);
      assert.match(text, /data: \[DONE\]/);
    } finally {
      await server.close();
    }
  } finally {
    await target.close();
  }
});

test('app converts Mimo XML tool calls into Responses function_call stream items', async () => {
  const { createApp } = await import('../src/server.ts');
  const target = await upstream((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end([
        'data:{"id":"chatcmpl-tools","model":"mimo-v2.5-pro","choices":[{"finish_reason":"stop","index":0,"message":{"role":"assistant","content":"I will inspect it.<tool_call>\\n<function=exec>\\n<parameter=command>ls -la</parameter>\\n<parameter=workdir>/repo</parameter>\\n</function>\\n</tool_call>"}}]}',
        '',
        'data:[DONE]',
        ''
      ].join('\n'));
    });
  });

  try {
    const store = createMemoryStore();
    await store.updateServiceGroup('CN', { openaiBaseUrl: `${target.url}/v1` });
    await store.importKeys('CN', ['tool-key']);
    const app = createApp({ store, adminToken: 'admin-secret', proxyTokens: ['proxy-secret'] });
    const server = await listen(app);
    try {
      const response = await fetch(`${server.url}/v1/responses`, {
        method: 'POST',
        headers: { authorization: 'Bearer proxy-secret', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'mimo-v2.5-pro',
          input: 'check project',
          stream: true
        })
      });
      const text = await response.text();

      assert.equal(response.status, 200);
      assert.match(text, /event: response\.function_call_arguments\.delta/);
      assert.match(text, /event: response\.function_call_arguments\.done/);
      assert.match(text, /event: response\.output_item\.done/);
      assert.match(text, /"type":"function_call"/);
      assert.match(text, /"name":"exec"/);
      assert.match(text, /\\"command\\":\\"ls -la\\"/);
      assert.match(text, /\\"workdir\\":\\"\/repo\\"/);
      assert.doesNotMatch(text, /<tool_call>/);
    } finally {
      await server.close();
    }
  } finally {
    await target.close();
  }
});

test('responses adapter forwards tools and continues tool calls with function_call_output', async () => {
  const { createApp } = await import('../src/server.ts');
  const observedPayloads = [];
  const target = await upstream(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    observedPayloads.push(payload);

    res.writeHead(200, { 'content-type': 'application/json' });
    if (observedPayloads.length === 1) {
      res.end(JSON.stringify({
        id: 'chatcmpl-tool-native',
        model: payload.model,
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_native_1',
              type: 'function',
              function: { name: 'exec', arguments: '{"command":"ls -la"}' }
            }]
          },
          finish_reason: 'tool_calls'
        }]
      }));
      return;
    }

    res.end(JSON.stringify({
      id: 'chatcmpl-final',
      model: payload.model,
      choices: [{ message: { role: 'assistant', content: 'saw files' }, finish_reason: 'stop' }]
    }));
  });

  try {
    const store = createMemoryStore();
    await store.updateServiceGroup('CN', { openaiBaseUrl: `${target.url}/v1` });
    await store.importKeys('CN', ['responses-tool-key']);
    const app = createApp({ store, adminToken: 'admin-secret', proxyTokens: ['proxy-secret'] });
    const server = await listen(app);
    try {
      const first = await fetch(`${server.url}/v1/responses`, {
        method: 'POST',
        headers: { authorization: 'Bearer proxy-secret', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'mimo-v2.5-pro',
          input: 'check project',
          tools: [{
            type: 'function',
            name: 'exec',
            description: 'Run a command',
            parameters: {
              type: 'object',
              properties: { command: { type: 'string' } },
              required: ['command']
            }
          }]
        })
      });
      const firstBody = await first.json();
      const call = firstBody.output.find((item) => item.type === 'function_call');

      const second = await fetch(`${server.url}/v1/responses`, {
        method: 'POST',
        headers: { authorization: 'Bearer proxy-secret', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'mimo-v2.5-pro',
          previous_response_id: firstBody.id,
          input: [{
            type: 'function_call_output',
            call_id: call.call_id,
            output: 'package.json\nsrc'
          }],
          tools: [{
            type: 'function',
            name: 'exec',
            parameters: { type: 'object', properties: { command: { type: 'string' } } }
          }]
        })
      });
      const secondBody = await second.json();

      assert.equal(first.status, 200);
      assert.equal(call.name, 'exec');
      assert.equal(call.call_id, 'call_native_1');
      assert.deepEqual(observedPayloads[0].tools, [{
        type: 'function',
        function: {
          name: 'exec',
          description: 'Run a command',
          parameters: {
            type: 'object',
            properties: { command: { type: 'string' } },
            required: ['command']
          }
        }
      }]);
      assert.equal(second.status, 200);
      assert.deepEqual(observedPayloads[1].messages, [
        { role: 'user', content: 'check project' },
        { role: 'assistant', content: null, tool_calls: [{
          id: 'call_native_1',
          type: 'function',
          function: { name: 'exec', arguments: '{"command":"ls -la"}' }
        }] },
        { role: 'tool', tool_call_id: 'call_native_1', content: 'package.json\nsrc' }
      ]);
      assert.equal(secondBody.output_text, 'saw files');
    } finally {
      await server.close();
    }
  } finally {
    await target.close();
  }
});

test('streaming responses adapter remembers tool calls for the next function output request', async () => {
  const { createApp } = await import('../src/server.ts');
  const observedPayloads = [];
  const target = await upstream(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    observedPayloads.push(payload);

    if (observedPayloads.length === 1) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end([
        'data:{"id":"chatcmpl-stream-tool","model":"mimo-v2.5-pro","choices":[{"finish_reason":"stop","index":0,"message":{"role":"assistant","content":"<tool_call>\\n<function=exec>\\n<parameter=command>pwd</parameter>\\n</function>\\n</tool_call>"}}]}',
        '',
        'data:[DONE]',
        ''
      ].join('\n'));
      return;
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-stream-final',
      model: payload.model,
      choices: [{ message: { role: 'assistant', content: 'done after pwd' }, finish_reason: 'stop' }]
    }));
  });

  try {
    const store = createMemoryStore();
    await store.updateServiceGroup('CN', { openaiBaseUrl: `${target.url}/v1` });
    await store.importKeys('CN', ['responses-stream-tool-key']);
    const app = createApp({ store, adminToken: 'admin-secret', proxyTokens: ['proxy-secret'] });
    const server = await listen(app);
    try {
      const first = await fetch(`${server.url}/v1/responses`, {
        method: 'POST',
        headers: { authorization: 'Bearer proxy-secret', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'mimo-v2.5-pro',
          input: 'where am I',
          stream: true,
          tools: [{ type: 'function', name: 'exec', parameters: { type: 'object' } }]
        })
      });
      const firstText = await first.text();
      const responseId = firstText.match(/"id":"(resp_stream-tool)"/)?.[1];
      const callId = firstText.match(/"call_id":"([^"]+)"/)?.[1];

      const second = await fetch(`${server.url}/v1/responses`, {
        method: 'POST',
        headers: { authorization: 'Bearer proxy-secret', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'mimo-v2.5-pro',
          previous_response_id: responseId,
          input: [{ type: 'function_call_output', call_id: callId, output: '/repo' }],
          tools: [{ type: 'function', name: 'exec', parameters: { type: 'object' } }]
        })
      });
      const secondBody = await second.json();

      assert.equal(first.status, 200);
      assert.ok(responseId);
      assert.ok(callId);
      assert.equal(second.status, 200);
      assert.deepEqual(observedPayloads[1].messages, [
        { role: 'user', content: 'where am I' },
        { role: 'assistant', content: null, tool_calls: [{
          id: callId,
          type: 'function',
          function: { name: 'exec', arguments: '{"command":"pwd"}' }
        }] },
        { role: 'tool', tool_call_id: callId, content: '/repo' }
      ]);
      assert.equal(secondBody.output_text, 'done after pwd');
    } finally {
      await server.close();
    }
  } finally {
    await target.close();
  }
});

test('streaming responses are not aborted by the non-stream upstream timeout', async () => {
  const { createApp } = await import('../src/server.ts');
  const previousTimeout = process.env.UPSTREAM_TIMEOUT_MS;
  process.env.UPSTREAM_TIMEOUT_MS = '20';
  const target = await upstream((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      setTimeout(() => {
        res.end([
          'data:{"id":"chatcmpl-slow","model":"mimo-v2.5-pro","choices":[{"finish_reason":"stop","index":0,"message":{"content":"slow hello","role":"assistant"}}]}',
          '',
          'data:[DONE]',
          ''
        ].join('\n'));
      }, 60);
    });
  });

  try {
    const store = createMemoryStore();
    await store.updateServiceGroup('CN', { openaiBaseUrl: `${target.url}/v1` });
    await store.importKeys('CN', ['slow-stream-key']);
    const app = createApp({ store, adminToken: 'admin-secret', proxyTokens: ['proxy-secret'] });
    const server = await listen(app);
    try {
      const response = await fetch(`${server.url}/v1/responses`, {
        method: 'POST',
        headers: { authorization: 'Bearer proxy-secret', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'mimo-v2.5-pro',
          input: 'slow',
          stream: true
        })
      });
      const text = await response.text();

      assert.equal(response.status, 200);
      assert.match(text, /slow hello/);
      assert.match(text, /event: response\.completed/);
    } finally {
      await server.close();
    }
  } finally {
    if (previousTimeout === undefined) {
      delete process.env.UPSTREAM_TIMEOUT_MS;
    } else {
      process.env.UPSTREAM_TIMEOUT_MS = previousTimeout;
    }
    await target.close();
  }
});

test('streaming responses pass upstream non-ok errors through without fake completion', async () => {
  const { createApp } = await import('../src/server.ts');
  const target = await upstream((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'bad request from upstream' } }));
    });
  });

  try {
    const store = createMemoryStore();
    await store.updateServiceGroup('CN', { openaiBaseUrl: `${target.url}/v1` });
    await store.importKeys('CN', ['stream-error-key']);
    const app = createApp({ store, adminToken: 'admin-secret', proxyTokens: ['proxy-secret'] });
    const server = await listen(app);
    try {
      const response = await fetch(`${server.url}/v1/responses`, {
        method: 'POST',
        headers: { authorization: 'Bearer proxy-secret', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'mimo-v2.5-pro', input: 'bad', stream: true })
      });
      const text = await response.text();

      assert.equal(response.status, 400);
      assert.match(response.headers.get('content-type'), /application\/json/);
      assert.match(text, /bad request from upstream/);
      assert.doesNotMatch(text, /response\.completed/);
    } finally {
      await server.close();
    }
  } finally {
    await target.close();
  }
});

test('streaming responses emit visible failure events when upstream SSE is malformed', async () => {
  const { createApp } = await import('../src/server.ts');
  const target = await upstream((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data:{"id":"chatcmpl-bad","choices":[bad json]}\n\n');
    });
  });

  try {
    const store = createMemoryStore();
    await store.updateServiceGroup('CN', { openaiBaseUrl: `${target.url}/v1` });
    await store.importKeys('CN', ['bad-sse-key']);
    const app = createApp({ store, adminToken: 'admin-secret', proxyTokens: ['proxy-secret'] });
    const server = await listen(app);
    try {
      const response = await fetch(`${server.url}/v1/responses`, {
        method: 'POST',
        headers: { authorization: 'Bearer proxy-secret', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'mimo-v2.5-pro', input: 'bad sse', stream: true })
      });
      const text = await response.text();

      assert.equal(response.status, 200);
      assert.match(text, /event: error/);
      assert.match(text, /event: response\.failed/);
      assert.match(text, /Failed to convert upstream chat stream/);
      assert.doesNotMatch(text, /event: response\.completed/);
    } finally {
      await server.close();
    }
  } finally {
    await target.close();
  }
});

test('streaming responses map chat length finish_reason to response.incomplete', async () => {
  const { createApp } = await import('../src/server.ts');
  const target = await upstream((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end([
        'data:{"id":"chatcmpl-length","model":"mimo-v2.5-pro","choices":[{"finish_reason":"length","index":0,"message":{"content":"partial","role":"assistant"}}]}',
        '',
        'data:[DONE]',
        ''
      ].join('\n'));
    });
  });

  try {
    const store = createMemoryStore();
    await store.updateServiceGroup('CN', { openaiBaseUrl: `${target.url}/v1` });
    await store.importKeys('CN', ['length-key']);
    const app = createApp({ store, adminToken: 'admin-secret', proxyTokens: ['proxy-secret'] });
    const server = await listen(app);
    try {
      const response = await fetch(`${server.url}/v1/responses`, {
        method: 'POST',
        headers: { authorization: 'Bearer proxy-secret', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'mimo-v2.5-pro', input: 'long', stream: true })
      });
      const text = await response.text();

      assert.equal(response.status, 200);
      assert.match(text, /event: response\.incomplete/);
      assert.match(text, /"status":"incomplete"/);
      assert.match(text, /"reason":"max_output_tokens"/);
      assert.doesNotMatch(text, /event: response\.completed/);
    } finally {
      await server.close();
    }
  } finally {
    await target.close();
  }
});

test('non-streaming responses map chat length finish_reason to incomplete response', async () => {
  const { createApp } = await import('../src/server.ts');
  const target = await upstream(async (req, res) => {
    for await (const _chunk of req) {
      // drain request
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-length-json',
      model: 'mimo-v2.5-pro',
      choices: [{ message: { role: 'assistant', content: 'partial json' }, finish_reason: 'length' }]
    }));
  });

  try {
    const store = createMemoryStore();
    await store.updateServiceGroup('CN', { openaiBaseUrl: `${target.url}/v1` });
    await store.importKeys('CN', ['length-json-key']);
    const app = createApp({ store, adminToken: 'admin-secret', proxyTokens: ['proxy-secret'] });
    const server = await listen(app);
    try {
      const response = await fetch(`${server.url}/v1/responses`, {
        method: 'POST',
        headers: { authorization: 'Bearer proxy-secret', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'mimo-v2.5-pro', input: 'long' })
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.status, 'incomplete');
      assert.deepEqual(body.incomplete_details, { reason: 'max_output_tokens' });
      assert.equal(body.output_text, 'partial json');
    } finally {
      await server.close();
    }
  } finally {
    await target.close();
  }
});

test('debug mode logs proxy request flow without leaking raw API keys', async () => {
  const { createApp } = await import('../src/server.ts');
  const previousDebug = process.env.DEBUG_PROXY;
  const previousBody = process.env.DEBUG_PROXY_BODY;
  process.env.DEBUG_PROXY = '1';
  process.env.DEBUG_PROXY_BODY = '1';
  const logs = [];
  const originalError = console.error;
  console.error = (...args) => {
    logs.push(args.join(' '));
  };
  const target = await upstream(async (req, res) => {
    for await (const _chunk of req) {
      // drain request
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-debug',
      model: 'mimo-v2.5-pro',
      choices: [{ message: { role: 'assistant', content: 'debug ok' }, finish_reason: 'stop' }]
    }));
  });

  try {
    const store = createMemoryStore();
    await store.updateServiceGroup('CN', { openaiBaseUrl: `${target.url}/v1` });
    await store.importKeys('CN', ['tp-debug-secret-key-123456']);
    const app = createApp({ store, adminToken: 'admin-secret', proxyTokens: ['proxy-secret'] });
    const server = await listen(app);
    try {
      const response = await fetch(`${server.url}/v1/responses`, {
        method: 'POST',
        headers: { authorization: 'Bearer proxy-secret', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'mimo-v2.5-pro', input: 'hello', stream: false })
      });
      await response.text();
      const text = logs.join('\n');

      assert.equal(response.status, 200);
      assert.match(text, /\[mimo-pool:debug\]/);
      assert.match(text, /proxy\.request_start/);
      assert.match(text, /proxy\.upstream_attempt/);
      assert.match(text, /responses\.compat_response/);
      assert.match(text, /tp-d\.\.\.3456/);
      assert.doesNotMatch(text, /tp-debug-secret-key-123456/);
      assert.doesNotMatch(text, /Bearer proxy-secret/);
    } finally {
      await server.close();
    }
  } finally {
    console.error = originalError;
    if (previousDebug === undefined) delete process.env.DEBUG_PROXY;
    else process.env.DEBUG_PROXY = previousDebug;
    if (previousBody === undefined) delete process.env.DEBUG_PROXY_BODY;
    else process.env.DEBUG_PROXY_BODY = previousBody;
    await target.close();
  }
});
