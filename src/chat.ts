import { directCompatibleRequest, proxyCompatibleRequest } from './proxy.ts';
import type { Protocol, Store } from './types.ts';

export type ChatApiType = 'openai-chat' | 'openai-responses' | 'anthropic-messages';
export type ChatMode = 'proxy' | 'direct';
export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type ChatRequest = {
  mode?: ChatMode;
  apiType?: ChatApiType;
  protocol?: Protocol;
  keyId?: number;
  model?: string;
  messages?: ChatMessage[];
};

export async function sendAdminChat(store: Store, request: ChatRequest) {
  const apiType = normalizeApiType(request);
  const protocol = protocolForApiType(apiType);
  const path = pathForApiType(apiType);
  const payload = payloadForApiType(apiType, request.model, request.messages ?? []);
  const proxyRequest = {
    protocol,
    method: 'POST',
    path,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify(payload))
  };

  const result = request.mode === 'direct'
    ? await directCompatibleRequest(store, { ...proxyRequest, keyId: requireKeyId(request.keyId) })
    : await proxyCompatibleRequest(store, proxyRequest);
  const json = parseJsonBody(result.body);
  return {
    mode: request.mode === 'direct' ? 'direct' : 'proxy',
    apiType,
    protocol,
    status: result.status,
    reply: extractReply(apiType, json),
    raw: json,
    target: result.target
  };
}

export async function listAdminModels(store: Store, request: Pick<ChatRequest, 'mode' | 'apiType' | 'keyId'>) {
  const apiType = normalizeApiType(request);
  const protocol = protocolForApiType(apiType);
  if (protocol === 'anthropic') {
    return {
      mode: request.mode === 'direct' ? 'direct' : 'proxy',
      apiType,
      protocol,
      status: 200,
      models: [],
      raw: { message: 'Anthropic-compatible APIs usually do not expose a models endpoint.' },
      target: undefined
    };
  }
  const proxyRequest = {
    protocol,
    method: 'GET',
    path: '/v1/models',
    headers: {},
    body: Buffer.alloc(0)
  };
  const result = request.mode === 'direct'
    ? await directCompatibleRequest(store, { ...proxyRequest, keyId: requireKeyId(request.keyId) })
    : await proxyCompatibleRequest(store, proxyRequest);
  const raw = parseJsonBody(result.body);
  return {
    mode: request.mode === 'direct' ? 'direct' : 'proxy',
    apiType,
    protocol,
    status: result.status,
    models: extractModelIds(raw),
    raw,
    target: result.target
  };
}

function normalizeApiType(request: ChatRequest): ChatApiType {
  if (request.apiType) return request.apiType;
  if (request.protocol === 'anthropic') return 'anthropic-messages';
  return 'openai-chat';
}

function protocolForApiType(apiType: ChatApiType): Protocol {
  return apiType === 'anthropic-messages' ? 'anthropic' : 'openai';
}

function pathForApiType(apiType: ChatApiType): string {
  if (apiType === 'openai-responses') return '/v1/chat/completions';
  if (apiType === 'anthropic-messages') return '/v1/messages';
  return '/v1/chat/completions';
}

function payloadForApiType(apiType: ChatApiType, model = 'mimo', messages: ChatMessage[]) {
  if (apiType === 'openai-responses') {
    return { model, messages };
  }
  if (apiType === 'anthropic-messages') {
    const system = messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n');
    return {
      model,
      max_tokens: 1024,
      ...(system ? { system } : {}),
      messages: messages
        .filter((message) => message.role !== 'system')
        .map((message) => ({ role: message.role, content: message.content }))
    };
  }
  return { model, messages };
}

function parseJsonBody(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return { text: body.toString('utf8') };
  }
}

function extractReply(apiType: ChatApiType, value: unknown): string {
  const data = value as Record<string, unknown>;
  if (apiType === 'openai-chat') {
    const choices = data.choices as Array<{ message?: { content?: string } }> | undefined;
    return choices?.[0]?.message?.content ?? '';
  }
  if (apiType === 'openai-responses') {
    if (typeof data.output_text === 'string') return data.output_text;
    const output = data.output as Array<{ content?: Array<{ text?: string }> }> | undefined;
    const outputText = output?.flatMap((item) => item.content ?? []).map((item) => item.text ?? '').join('\n').trim();
    if (outputText) return outputText;
    const choices = data.choices as Array<{ message?: { content?: string } }> | undefined;
    return choices?.[0]?.message?.content ?? '';
  }
  const content = data.content as Array<{ text?: string }> | undefined;
  return content?.map((item) => item.text ?? '').join('\n').trim() ?? '';
}

function extractModelIds(value: unknown): string[] {
  const data = value as { data?: Array<{ id?: unknown }>; models?: Array<unknown> };
  if (Array.isArray(data.data)) {
    return data.data.map((model) => model.id).filter((id): id is string => typeof id === 'string');
  }
  if (Array.isArray(data.models)) {
    return data.models.filter((id): id is string => typeof id === 'string');
  }
  return [];
}

function requireKeyId(keyId: number | undefined): number {
  if (!keyId) {
    throw Object.assign(new Error('Direct chat mode requires keyId'), { statusCode: 400 });
  }
  return keyId;
}
