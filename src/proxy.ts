import { buildRoutePlan, classifyUpstreamFailure, resolveUpstreamUrl } from './routing.ts';
import { debugBody, debugLog, type DebugContext } from './debug.ts';
import type { Protocol, Store } from './types.ts';

export type ProxyRequest = {
  protocol: Protocol;
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  debug?: DebugContext;
};

export type ProxyResult = {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  target?: { groupCode: string; keyId: number; maskedKey: string };
};

export class NoAvailableKeysError extends Error {
  constructor() {
    super('No active upstream API keys are available');
  }
}

export async function proxyCompatibleRequest(store: Store, request: ProxyRequest): Promise<ProxyResult> {
  const plan = await buildRoutePlan(store, request.protocol);
  if (plan.length === 0) throw new NoAvailableKeysError();
  debugLog(request.debug, 'proxy.route_plan', { candidateCount: plan.length });

  let lastResult: ProxyResult | null = null;
  let lastError: Error | null = null;

  for (const target of plan) {
    const url = resolveUpstreamUrl(target.baseUrl, request.path, request.protocol);
    debugLog(request.debug, 'proxy.upstream_attempt', {
      url: safeUrl(url),
      target: compactTarget(target),
      ...debugBody('requestBody', request.body)
    });
    try {
      const response = await fetch(url, {
        method: request.method,
        headers: upstreamHeaders(request.protocol, request.headers, target.apiKey, request.body.length),
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : new Uint8Array(request.body),
        signal: AbortSignal.timeout(Number(process.env.UPSTREAM_TIMEOUT_MS ?? 120000))
      });
      const body = Buffer.from(await response.arrayBuffer());
      const headers = headersObject(response.headers);
      debugLog(request.debug, 'proxy.upstream_response', {
        status: response.status,
        ok: response.ok,
        target: compactTarget(target),
        ...debugBody('responseBody', body)
      });

      if (response.ok) {
        await store.recordKeySuccess(target.keyId);
        return { status: response.status, headers, body, target: compactTarget(target) };
      }

      const failure = classifyUpstreamFailure(response.status, body.toString('utf8'));
      if (failure === 'exhausted') {
        await store.markKeyExhausted(target.keyId, summarizeError(response.status, body));
        debugLog(request.debug, 'proxy.key_exhausted', { target: compactTarget(target), status: response.status });
        lastResult = { status: response.status, headers, body, target: compactTarget(target) };
        continue;
      }
      if (failure === 'retryable') {
        await store.recordKeyFailure(target.keyId, summarizeError(response.status, body));
        debugLog(request.debug, 'proxy.retryable_failure', { target: compactTarget(target), status: response.status });
        lastResult = { status: response.status, headers, body, target: compactTarget(target) };
        continue;
      }

      await store.recordKeyFailure(target.keyId, summarizeError(response.status, body));
      return { status: response.status, headers, body, target: compactTarget(target) };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      debugLog(request.debug, 'proxy.upstream_error', { target: compactTarget(target), error: lastError.message });
      await store.recordKeyFailure(target.keyId, lastError.message);
      continue;
    }
  }

  if (lastResult) return lastResult;
  throw lastError ?? new NoAvailableKeysError();
}

export async function directCompatibleRequest(store: Store, request: ProxyRequest & { keyId: number }): Promise<ProxyResult> {
  const key = await store.getKey(request.keyId);
  if (key.status !== 'active') {
    throw Object.assign(new Error('Selected API key is not active'), { statusCode: 400 });
  }
  const group = (await store.listServiceGroups()).find((item) => item.code === key.groupCode);
  if (!group || !group.enabled) {
    throw Object.assign(new Error('Selected API key service group is not enabled'), { statusCode: 400 });
  }
  const baseUrl = request.protocol === 'openai' ? group.openaiBaseUrl : group.anthropicBaseUrl;
  const url = resolveUpstreamUrl(baseUrl, request.path, request.protocol);
  debugLog(request.debug, 'proxy.direct_attempt', { url: safeUrl(url), target: { groupCode: key.groupCode, keyId: key.id, maskedKey: key.maskedKey } });
  const response = await fetch(url, {
    method: request.method,
    headers: upstreamHeaders(request.protocol, request.headers, key.apiKey, request.body.length),
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : new Uint8Array(request.body),
    signal: AbortSignal.timeout(Number(process.env.UPSTREAM_TIMEOUT_MS ?? 120000))
  });
  const body = Buffer.from(await response.arrayBuffer());
  const headers = headersObject(response.headers);
  debugLog(request.debug, 'proxy.direct_response', { status: response.status, ok: response.ok, target: { groupCode: key.groupCode, keyId: key.id, maskedKey: key.maskedKey }, ...debugBody('responseBody', body) });
  if (response.ok) {
    await store.recordKeySuccess(key.id);
  } else {
    await store.recordKeyFailure(key.id, summarizeError(response.status, body));
  }
  return {
    status: response.status,
    headers,
    body,
    target: { groupCode: key.groupCode, keyId: key.id, maskedKey: key.maskedKey }
  };
}

export async function prepareStreamingProxy(store: Store, request: ProxyRequest): Promise<Response & { targetMeta?: { groupCode: string; keyId: number; maskedKey: string } }> {
  const plan = await buildRoutePlan(store, request.protocol);
  if (plan.length === 0) throw new NoAvailableKeysError();
  debugLog(request.debug, 'proxy.stream_route_plan', { candidateCount: plan.length });

  let lastResponse: Response | null = null;
  let lastError: Error | null = null;

  for (const target of plan) {
    const url = resolveUpstreamUrl(target.baseUrl, request.path, request.protocol);
    debugLog(request.debug, 'proxy.stream_upstream_attempt', {
      url: safeUrl(url),
      target: compactTarget(target),
      ...debugBody('requestBody', request.body)
    });
    try {
      const response = await fetch(url, {
        method: request.method,
        headers: upstreamHeaders(request.protocol, request.headers, target.apiKey, request.body.length),
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : new Uint8Array(request.body),
        signal: streamAbortSignal()
      }) as Response & { targetMeta?: { groupCode: string; keyId: number; maskedKey: string } };

      if (response.ok) {
        await store.recordKeySuccess(target.keyId);
        response.targetMeta = compactTarget(target);
        debugLog(request.debug, 'proxy.stream_upstream_open', { status: response.status, target: compactTarget(target) });
        return response;
      }

      const preview = Buffer.from(await response.clone().arrayBuffer());
      debugLog(request.debug, 'proxy.stream_upstream_response', {
        status: response.status,
        ok: false,
        target: compactTarget(target),
        ...debugBody('responseBody', preview)
      });
      const failure = classifyUpstreamFailure(response.status, preview.toString('utf8'));
      if (failure === 'exhausted') {
        await store.markKeyExhausted(target.keyId, summarizeError(response.status, preview));
        debugLog(request.debug, 'proxy.stream_key_exhausted', { target: compactTarget(target), status: response.status });
        lastResponse = response;
        continue;
      }
      if (failure === 'retryable') {
        await store.recordKeyFailure(target.keyId, summarizeError(response.status, preview));
        debugLog(request.debug, 'proxy.stream_retryable_failure', { target: compactTarget(target), status: response.status });
        lastResponse = response;
        continue;
      }

      await store.recordKeyFailure(target.keyId, summarizeError(response.status, preview));
      response.targetMeta = compactTarget(target);
      return response;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      debugLog(request.debug, 'proxy.stream_upstream_error', { target: compactTarget(target), error: lastError.message });
      await store.recordKeyFailure(target.keyId, lastError.message);
      continue;
    }
  }

  if (lastResponse) return lastResponse;
  throw lastError ?? new NoAvailableKeysError();
}

function streamAbortSignal(): AbortSignal | undefined {
  const timeout = Number(process.env.UPSTREAM_STREAM_TIMEOUT_MS ?? 0);
  return timeout > 0 ? AbortSignal.timeout(timeout) : undefined;
}

function upstreamHeaders(protocol: Protocol, incoming: ProxyRequest['headers'], apiKey: string, bodyLength: number): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (['host', 'connection', 'content-length', 'authorization', 'x-api-key'].includes(lower)) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  if (bodyLength > 0 && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  if (protocol === 'anthropic') {
    headers.set('x-api-key', apiKey);
    if (!headers.has('anthropic-version')) {
      headers.set('anthropic-version', process.env.ANTHROPIC_VERSION ?? '2023-06-01');
    }
  } else {
    headers.set('authorization', `Bearer ${apiKey}`);
  }
  return headers;
}

function headersObject(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of headers) {
    if (!['content-encoding', 'transfer-encoding', 'connection'].includes(key.toLowerCase())) {
      result[key] = value;
    }
  }
  return result;
}

function summarizeError(status: number, body: Buffer): string {
  const text = body.toString('utf8').replace(/\s+/g, ' ').trim();
  return `${status} ${text.slice(0, 300)}`;
}

function compactTarget(target: { groupCode: string; keyId: number; maskedKey: string }) {
  return { groupCode: target.groupCode, keyId: target.keyId, maskedKey: target.maskedKey };
}

function safeUrl(url: URL): string {
  return `${url.origin}${url.pathname}`;
}
