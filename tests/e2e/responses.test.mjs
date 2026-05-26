import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

const adminToken = 'e2e-admin-token';
const proxyToken = 'e2e-proxy-token';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(done))
      });
    });
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sse(res, chunks) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  });
  for (const chunk of chunks) {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  res.end('data: [DONE]\n\n');
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function createMockMimo() {
  const requests = [];
  const chatResponses = [];
  const server = http.createServer(async (req, res) => {
    const body = req.method === 'GET' || req.method === 'HEAD' ? {} : await readJsonBody(req);
    const auth = req.headers.authorization ?? '';
    requests.push({ path: req.url, method: req.method, auth, body });

    if (req.url === '/v1/models') {
      return json(res, 200, { object: 'list', data: [{ id: 'mimo-v2.5-pro', object: 'model' }] });
    }

    if (req.url !== '/v1/chat/completions') {
      return json(res, 404, { error: { message: 'unexpected mock path' } });
    }

    const next = chatResponses.shift();
    if (!next) return json(res, 500, { error: { message: 'mock response queue empty' } });
    if (next.status && next.status !== 200) return json(res, next.status, next.body ?? { error: { message: 'mock failure' } });
    if (body.stream) return sse(res, next.chunks);
    return json(res, 200, next.body);
  });
  return { server, requests, chatResponses };
}

async function findFreePort() {
  const probe = await listen(http.createServer((_req, res) => res.end('ok')));
  const port = new URL(probe.url).port;
  await probe.close();
  return Number(port);
}

async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + 10_000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`mimo-pool exited before health check passed with code ${child.exitCode}`);
    }
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError ?? new Error('health check timed out');
}

async function startMimoPool() {
  const temp = mkdtempSync(join(tmpdir(), 'mimo-pool-e2e-'));
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['dist/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DB_PATH: join(temp, 'mimo-pool.sqlite'),
      ADMIN_TOKEN: adminToken,
      PROXY_TOKENS: proxyToken,
      KEY_COOLDOWN_MS: '60000',
      UPSTREAM_TIMEOUT_MS: '5000',
      UPSTREAM_STREAM_IDLE_TIMEOUT_MS: '5000',
      RESPONSES_TOOL_NUDGE: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk.toString('utf8')));
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString('utf8')));
  await waitForHealth(baseUrl, child);
  return {
    baseUrl,
    stdout,
    stderr,
    async close() {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await Promise.race([
          once(child, 'exit'),
          new Promise((resolve) => setTimeout(resolve, 2000))
        ]);
      }
      rmSync(temp, { recursive: true, force: true });
    }
  };
}

async function adminFetch(baseUrl, path, init = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${adminToken}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers
    }
  });
}

async function configurePool(baseUrl, upstreamUrl) {
  const patch = { openaiBaseUrl: `${upstreamUrl}/v1` };
  await adminFetch(baseUrl, '/admin/api/groups/CN', { method: 'PATCH', body: JSON.stringify({ ...patch, sortOrder: 10, enabled: true }) });
  await adminFetch(baseUrl, '/admin/api/groups/SGP', { method: 'PATCH', body: JSON.stringify({ ...patch, sortOrder: 20, enabled: true }) });
  await adminFetch(baseUrl, '/admin/api/keys/import', {
    method: 'POST',
    body: JSON.stringify({ groupCode: 'CN', keys: ['e2e-cn-key'] })
  });
  await adminFetch(baseUrl, '/admin/api/keys/import', {
    method: 'POST',
    body: JSON.stringify({ groupCode: 'SGP', keys: ['e2e-sgp-key'] })
  });
}

function parseSse(text) {
  return text
    .split(/\n\n/)
    .map((event) => event.split(/\r?\n/).find((line) => line.startsWith('data:'))?.slice(5).trim())
    .filter((line) => line && line !== '[DONE]')
    .map((line) => JSON.parse(line));
}

async function proxyResponses(baseUrl, body) {
  return fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${proxyToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });
}

test('e2e dist server handles Responses streaming, tools, and fallback', async (t) => {
  const mock = createMockMimo();
  const upstream = await listen(mock.server);
  const app = await startMimoPool();
  try {
    await configurePool(app.baseUrl, upstream.url);

    mock.chatResponses.push(
      { status: 503, body: { error: { message: 'temporary upstream overload' } } },
      {
        chunks: [
          {
            id: 'chatcmpl-e2e-1',
            model: 'mimo-v2.5-pro',
            choices: [{ delta: { content: 'hello' } }]
          },
          {
            id: 'chatcmpl-e2e-1',
            model: 'mimo-v2.5-pro',
            choices: [{ finish_reason: 'stop' }]
          }
        ]
      }
    );

    const first = await proxyResponses(app.baseUrl, {
      model: 'mimo-v2.5-pro',
      stream: true,
      input: 'hello'
    });
    assert.equal(first.status, 200);
    const firstEvents = parseSse(await first.text());
    assert.equal(firstEvents.at(-1).type, 'response.completed');
    assert.equal(firstEvents.at(-1).response.output_text, 'hello');
    assert.equal(firstEvents.at(-1).response.model, 'mimo-v2.5-pro');
    assert.equal(mock.requests[0].auth, 'Bearer e2e-cn-key');
    assert.equal(mock.requests[1].auth, 'Bearer e2e-sgp-key');
    assert.equal(mock.requests[1].body.model, 'mimo-v2.5-pro');

    mock.chatResponses.push({
      chunks: [
        {
          id: 'chatcmpl-e2e-2',
          model: 'mimo-v2.5-pro',
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call_e2e',
                type: 'function',
                function: { name: 'exec', arguments: '{"command":"pwd"}' }
              }]
            }
          }]
        },
        {
          id: 'chatcmpl-e2e-2',
          model: 'mimo-v2.5-pro',
          choices: [{ finish_reason: 'tool_calls' }]
        }
      ]
    });

    const toolCall = await proxyResponses(app.baseUrl, {
      model: 'mimo-v2.5-pro',
      stream: true,
      input: 'check project',
      tools: [{
        type: 'function',
        name: 'exec',
        description: 'run shell command',
        parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }
      }]
    });
    assert.equal(toolCall.status, 200);
    const toolEvents = parseSse(await toolCall.text());
    const completed = toolEvents.find((event) => event.type === 'response.completed');
    const callItem = completed.response.output.find((item) => item.type === 'function_call');
    assert.equal(callItem.name, 'exec');
    assert.equal(callItem.call_id, 'call_e2e');
    assert.equal(callItem.arguments, '{"command":"pwd"}');

    mock.chatResponses.push({
      chunks: [
        {
          id: 'chatcmpl-e2e-3',
          model: 'mimo-v2.5-pro',
          choices: [{ delta: { content: 'done' } }]
        },
        {
          id: 'chatcmpl-e2e-3',
          model: 'mimo-v2.5-pro',
          choices: [{ finish_reason: 'stop' }]
        }
      ]
    });

    const continued = await proxyResponses(app.baseUrl, {
      model: 'mimo-v2.5-pro',
      stream: true,
      previous_response_id: completed.response.id,
      input: [{ type: 'function_call_output', call_id: 'call_e2e', output: 'C:/Users/richa/Documents/mimo-pool' }]
    });
    assert.equal(continued.status, 200);
    const continuedEvents = parseSse(await continued.text());
    assert.equal(continuedEvents.at(-1).response.output_text, 'done');
    const continuedBody = mock.requests.at(-1).body;
    assert.equal(continuedBody.messages.at(-1).role, 'tool');
    assert.equal(continuedBody.messages.at(-1).tool_call_id, 'call_e2e');
  } catch (error) {
    t.diagnostic(`mimo-pool stdout:\n${app.stdout.join('')}`);
    t.diagnostic(`mimo-pool stderr:\n${app.stderr.join('')}`);
    throw error;
  } finally {
    await app.close();
    await upstream.close();
  }
});
