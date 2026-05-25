import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { adminHtml } from './admin-ui.ts';
import { parseTokenList, requireToken } from './auth.ts';
import { listAdminModels, sendAdminChat, type ChatRequest } from './chat.ts';
import { readBody, readJson, sendError, sendJson, sendText } from './http.ts';
import { NoAvailableKeysError, prepareStreamingProxy, proxyCompatibleRequest } from './proxy.ts';
import { createResponsesSseTransformer, isStreamingResponsesRequest, proxyResponsesViaChatCompletions, responsesChatProxyRequest } from './responses-compat.ts';
import { createDebugContext, debugBody, debugLog } from './debug.ts';
import { addModelAliasesToList, applyModelAlias, restoreModelAlias } from './model-alias.ts';
import type { KeyStatus, Protocol, Store } from './types.ts';

export type ServerOptions = {
  store: Store;
  adminToken?: string;
  proxyTokens?: string[];
};

const openaiRoutes = new Set(['/v1/chat/completions', '/v1/completions', '/v1/responses', '/v1/models']);
const anthropicRoutes = new Set(['/v1/messages', '/anthropic/v1/messages']);

export function createApp(options: ServerOptions): http.Server {
  const adminToken = options.adminToken ?? process.env.ADMIN_TOKEN ?? 'change-me-admin';
  const proxyTokens = options.proxyTokens ?? parseTokenList(process.env.PROXY_TOKENS, 'change-me-proxy');

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') {
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/admin')) {
        return sendText(res, 200, adminHtml, 'text/html; charset=utf-8');
      }
      if (url.pathname.startsWith('/admin/api/')) {
        if (!requireToken(req, [adminToken])) return sendJson(res, 401, { error: { message: 'Unauthorized admin token' } });
        return handleAdmin(options.store, req, res, url);
      }

      const protocol = protocolForPath(url.pathname);
      if (protocol) {
        if (!requireToken(req, proxyTokens)) return sendJson(res, 401, { error: { message: 'Unauthorized proxy token' } });
        return handleProxy(options.store, protocol, req, res, url.pathname);
      }

      return sendJson(res, 404, { error: { message: 'Not found' } });
    } catch (error) {
      return sendError(res, error);
    }
  });
}

async function handleAdmin(store: Store, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const path = url.pathname.slice('/admin/api'.length);

  if (req.method === 'GET' && path === '/groups') {
    return sendJson(res, 200, { groups: await store.listServiceGroups() });
  }
  const groupMatch = path.match(/^\/groups\/([A-Z]+)$/);
  if (req.method === 'PATCH' && groupMatch) {
    const body = await readJson<Record<string, unknown>>(req);
    return sendJson(res, 200, {
      group: await store.updateServiceGroup(groupMatch[1], {
        sortOrder: numberOrUndefined(body.sortOrder),
        enabled: booleanOrUndefined(body.enabled),
        openaiBaseUrl: stringOrUndefined(body.openaiBaseUrl),
        anthropicBaseUrl: stringOrUndefined(body.anthropicBaseUrl)
      })
    });
  }

  if (req.method === 'GET' && path === '/keys') {
    const keys = await store.listKeys();
    return sendJson(res, 200, { keys: keys.map(({ apiKey, ...safe }) => safe) });
  }
  if (req.method === 'GET' && path === '/export') {
    const snapshot = await store.exportBackup();
    const filename = `mimo-pool-backup-${new Date().toISOString().slice(0, 10)}.json`;
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`
    });
    res.end(JSON.stringify(snapshot, null, 2));
    return;
  }
  if (req.method === 'POST' && path === '/import') {
    const body = await readJson<Parameters<Store['importBackup']>[0]>(req);
    return sendJson(res, 200, { result: await store.importBackup(body) });
  }
  if (req.method === 'POST' && path === '/keys/import') {
    const body = await readJson<{ groupCode?: string; keys?: string[] | string }>(req);
    const keys = Array.isArray(body.keys) ? body.keys : String(body.keys ?? '').split(/\r?\n/);
    const imported = await store.importKeys(String(body.groupCode ?? ''), keys);
    return sendJson(res, 201, { imported: imported.map(({ apiKey, ...safe }) => safe) });
  }
  if (req.method === 'POST' && path === '/chat') {
    const body = await readJson<ChatRequest>(req);
    const result = await sendAdminChat(store, body);
    return sendJson(res, result.status, result);
  }
  if (req.method === 'GET' && path === '/models') {
    const result = await listAdminModels(store, {
      mode: url.searchParams.get('mode') === 'direct' ? 'direct' : 'proxy',
      apiType: url.searchParams.get('apiType') as ChatRequest['apiType'],
      keyId: url.searchParams.get('keyId') ? Number(url.searchParams.get('keyId')) : undefined
    });
    return sendJson(res, result.status, result);
  }
  const keyMatch = path.match(/^\/keys\/(\d+)$/);
  if (keyMatch && req.method === 'PATCH') {
    const body = await readJson<{ status?: KeyStatus }>(req);
    if (!['active', 'disabled', 'exhausted'].includes(String(body.status))) {
      return sendJson(res, 400, { error: { message: 'Invalid key status' } });
    }
    const key = await store.setKeyStatus(Number(keyMatch[1]), body.status as KeyStatus);
    const { apiKey, ...safe } = key;
    return sendJson(res, 200, { key: safe });
  }
  if (keyMatch && req.method === 'DELETE') {
    await store.deleteKey(Number(keyMatch[1]));
    res.writeHead(204);
    res.end();
    return;
  }
  const resetMatch = path.match(/^\/keys\/(\d+)\/reset$/);
  if (resetMatch && req.method === 'POST') {
    const key = await store.resetKey(Number(resetMatch[1]));
    const { apiKey, ...safe } = key;
    return sendJson(res, 200, { key: safe });
  }

  return sendJson(res, 404, { error: { message: 'Admin endpoint not found' } });
}

async function handleProxy(store: Store, protocol: Protocol, req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const body = req.method === 'GET' || req.method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
  const debug = createDebugContext(protocol, req.method ?? 'POST', path, body);
  debugLog(debug, 'proxy.request_start', { ...debugBody('requestBody', body) });
  if (protocol === 'openai' && path === '/v1/responses' && req.method === 'POST') {
    if (isStreamingResponsesRequest(body)) {
      return handleResponsesStreamingProxy(store, body, req, res, debug);
    }
    const result = await proxyResponsesViaChatCompletions(store, body, req.headers, debug);
    res.writeHead(result.status, responseHeaders(result.headers));
    res.end(result.body);
    debugLog(debug, 'proxy.request_end', { status: result.status, target: result.target, ...debugBody('responseBody', result.body) });
    return;
  }
  const wantsStream = bodyIncludesStreamTrue(body);
  const alias = protocol === 'openai' && req.method !== 'GET' && req.method !== 'HEAD'
    ? applyModelAlias(body, debug)
    : { body };
  const proxyRequest = {
    protocol,
    method: req.method ?? 'POST',
    path,
    headers: req.headers,
    body: alias.body,
    debug
  };

  try {
    if (wantsStream) {
      const upstream = await prepareStreamingProxy(store, proxyRequest);
      res.writeHead(upstream.status, responseHeaders(upstream.headers));
      if (!upstream.body) {
        res.end();
        return;
      }
      const reader = upstream.body.getReader();
      let chunks = 0;
      let bytes = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          chunks += 1;
          bytes += value.byteLength;
          res.write(Buffer.from(value));
        }
      }
      res.end();
      debugLog(debug, 'proxy.stream_request_end', { status: upstream.status, target: upstream.targetMeta, chunks, bytes });
      return;
    }

    const result = await proxyCompatibleRequest(store, proxyRequest);
    const responseBody = protocol === 'openai' && path === '/v1/models'
      ? addModelAliasesToList(result.body)
      : restoreModelAlias(result.body, alias.originalModel, alias.upstreamModel, debug);
    res.writeHead(result.status, responseHeaders(result.headers));
    res.end(responseBody);
    debugLog(debug, 'proxy.request_end', { status: result.status, target: result.target, ...debugBody('responseBody', responseBody) });
    return;
  } catch (error) {
    debugLog(debug, 'proxy.request_error', { error: error instanceof Error ? error.message : String(error) });
    if (error instanceof NoAvailableKeysError) {
      return sendJson(res, 503, { error: { message: error.message } });
    }
    throw error;
  }
}

async function handleResponsesStreamingProxy(store: Store, body: Buffer, req: IncomingMessage, res: ServerResponse, debug = createDebugContext('openai', req.method ?? 'POST', '/v1/responses', body)): Promise<void> {
  try {
    const proxyRequest = responsesChatProxyRequest(body, req.headers, debug);
    const upstream = await prepareStreamingProxy(store, proxyRequest);
    if (!upstream.ok) {
      res.writeHead(upstream.status, responseHeaders(upstream.headers));
      if (!upstream.body) {
        res.end();
        return;
      }
      const errorBody = Buffer.from(await upstream.arrayBuffer());
      res.end(errorBody);
      debugLog(debug, 'responses.stream_non_ok_end', { status: upstream.status, target: upstream.targetMeta, ...debugBody('responseBody', errorBody) });
      return;
    }
    res.writeHead(upstream.status, {
      ...responseHeaders(upstream.headers),
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    });
    if (!upstream.body) {
      res.end();
      return;
    }
    const transformer = createResponsesSseTransformer(proxyRequest.fallbackModel, {
      requestMessages: proxyRequest.chatMessages,
      debug,
      modelOverride: proxyRequest.originalModel
    });
    const reader = upstream.body.getReader();
    let downstreamChunks = 0;
    let downstreamBytes = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          const converted = transformer.transform(value);
          if (converted) {
            downstreamChunks += 1;
            downstreamBytes += Buffer.byteLength(converted);
            res.write(converted);
          }
        }
      }
      const tail = transformer.flush();
      if (tail) {
        downstreamChunks += 1;
        downstreamBytes += Buffer.byteLength(tail);
        res.write(tail);
      }
    } catch (error) {
      console.error('responses stream interrupted:', error);
      const failure = transformer.fail(error);
      if (failure) {
        downstreamChunks += 1;
        downstreamBytes += Buffer.byteLength(failure);
        res.write(failure);
      }
    }
    res.end();
    debugLog(debug, 'responses.stream_request_end', { status: upstream.status, target: upstream.targetMeta, downstreamChunks, downstreamBytes });
  } catch (error) {
    debugLog(debug, 'responses.stream_request_error', { error: error instanceof Error ? error.message : String(error) });
    if (error instanceof NoAvailableKeysError) {
      return sendJson(res, 503, { error: { message: error.message } });
    }
    if (res.headersSent) {
      console.error('responses stream failed after headers:', error);
      res.end();
      return;
    }
    throw error;
  }
}

function protocolForPath(path: string): Protocol | null {
  if (openaiRoutes.has(path)) return 'openai';
  if (anthropicRoutes.has(path)) return 'anthropic';
  return null;
}

function bodyIncludesStreamTrue(body: Buffer): boolean {
  if (body.length === 0) return false;
  try {
    const parsed = JSON.parse(body.toString('utf8')) as { stream?: unknown };
    return parsed.stream === true;
  } catch {
    return false;
  }
}

function responseHeaders(headers: Headers | Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  if (headers instanceof Headers) {
    for (const [key, value] of headers) result[key] = value;
  } else {
    Object.assign(result, headers);
  }
  delete result['content-encoding'];
  delete result['transfer-encoding'];
  delete result.connection;
  return result;
}

function numberOrUndefined(value: unknown): number | undefined {
  return value === undefined ? undefined : Number(value);
}

function booleanOrUndefined(value: unknown): boolean | undefined {
  return value === undefined ? undefined : Boolean(value);
}

function stringOrUndefined(value: unknown): string | undefined {
  return value === undefined ? undefined : String(value);
}
