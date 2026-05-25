import { proxyCompatibleRequest, type ProxyRequest, type ProxyResult } from './proxy.ts';
import { debugLog, type DebugContext } from './debug.ts';
import { applyModelAlias, restoreModelAlias } from './model-alias.ts';
import type { Store } from './types.ts';

type ResponsesRequest = {
  model?: string;
  input?: unknown;
  instructions?: string;
  stream?: boolean;
  temperature?: number;
  max_output_tokens?: number;
  previous_response_id?: string;
  parallel_tool_calls?: boolean;
  tool_choice?: unknown;
  tools?: unknown[];
  messages?: Array<{ role?: string; content?: unknown; tool_call_id?: string; tool_calls?: ChatToolCall[] }>;
};

type ChatToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

type ChatMessage = {
  role: string;
  content: string | null;
  tool_call_id?: string;
  tool_calls?: ChatToolCall[];
};

type ResponseHistory = {
  messages: ChatMessage[];
  expiresAt: number;
};

const responseHistories = new Map<string, ResponseHistory>();
const maxResponseHistories = 200;
const defaultResponseSessionTtlMs = 60 * 60 * 1000;

export async function proxyResponsesViaChatCompletions(store: Store, body: Buffer, headers: Record<string, string | string[] | undefined>, debug?: DebugContext): Promise<ProxyResult> {
  const request = parseResponsesRequest(body);
  const chatPayload = responsesToChatPayload(request);
  const aliased = applyModelAlias(Buffer.from(JSON.stringify(chatPayload)), debug);
  debugLog(debug, 'responses.compat_request', {
    chatMessageCount: chatPayload.messages.length,
    hasPreviousResponse: Boolean(request.previous_response_id),
    toolCount: request.tools?.length ?? 0
  });
  const result = await proxyCompatibleRequest(store, { ...responsesChatProxyRequestFromBody(aliased.body, headers), debug });

  if (result.status < 200 || result.status >= 300) return result;

  if (isEventStream(result)) {
    return {
      ...result,
      headers: { ...result.headers, 'content-type': 'text/event-stream; charset=utf-8' },
      body: Buffer.from(chatSseToResponsesSse(result.body, request.model ?? chatPayload.model))
    };
  }

  const chatBody = parseJson(result.body);
  const response = chatCompletionToResponse(chatBody, aliased.originalModel ?? request.model ?? chatPayload.model);
  rememberResponse(response.id, chatPayload.messages, response.output);
  debugLog(debug, 'responses.compat_response', {
    responseId: response.id,
    status: response.status,
    outputCount: response.output.length,
    outputTextBytes: Buffer.byteLength(response.output_text ?? '')
  });
  return {
    ...result,
    headers: { ...result.headers, 'content-type': 'application/json' },
    body: restoreModelAlias(Buffer.from(JSON.stringify(response)), aliased.originalModel, aliased.upstreamModel, debug)
  };
}

export function isStreamingResponsesRequest(body: Buffer): boolean {
  try {
    return parseResponsesRequest(body).stream === true;
  } catch {
    return false;
  }
}

export function responsesChatProxyRequest(body: Buffer, headers: Record<string, string | string[] | undefined>, debug?: DebugContext): ProxyRequest & { fallbackModel: string; chatMessages: ChatMessage[]; originalModel?: string; upstreamModel?: string } {
  const request = parseResponsesRequest(body);
  const chatPayload = responsesToChatPayload(request);
  const aliased = applyModelAlias(Buffer.from(JSON.stringify(chatPayload)), debug);
  debugLog(debug, 'responses.stream_compat_request', {
    chatMessageCount: chatPayload.messages.length,
    hasPreviousResponse: Boolean(request.previous_response_id),
    toolCount: request.tools?.length ?? 0
  });
  return {
    ...responsesChatProxyRequestFromBody(aliased.body, headers),
    fallbackModel: aliased.originalModel ?? request.model ?? chatPayload.model,
    chatMessages: chatPayload.messages,
    originalModel: aliased.originalModel,
    upstreamModel: aliased.upstreamModel,
    debug
  };
}

function responsesChatProxyRequestFromPayload(chatPayload: ReturnType<typeof responsesToChatPayload>, headers: Record<string, string | string[] | undefined>): ProxyRequest {
  return responsesChatProxyRequestFromBody(Buffer.from(JSON.stringify(chatPayload)), headers);
}

function responsesChatProxyRequestFromBody(body: Buffer, headers: Record<string, string | string[] | undefined>): ProxyRequest {
  return {
    protocol: 'openai',
    method: 'POST',
    path: '/v1/chat/completions',
    headers: { ...headers, 'content-type': 'application/json' },
    body
  };
}

function isEventStream(result: ProxyResult): boolean {
  const contentType = Object.entries(result.headers).find(([key]) => key.toLowerCase() === 'content-type')?.[1] ?? '';
  return contentType.includes('text/event-stream') || result.body.toString('utf8').trimStart().startsWith('data:');
}

function chatSseToResponsesSse(body: Buffer, fallbackModel: string): string {
  const transformer = createResponsesSseTransformer(fallbackModel);
  return transformer.transform(body) + transformer.flush();
}

export function createResponsesSseTransformer(fallbackModel: string, options: { requestMessages?: ChatMessage[]; debug?: DebugContext; modelOverride?: string } = {}) {
  const created = Math.floor(Date.now() / 1000);
  const itemId = `msg_${created}`;
  let responseId = `resp_${created}`;
  let model = fallbackModel;
  let sequence = 0;
  let outputIndex = 0;
  let buffer = '';
  let outputText = '';
  let rawText = '';
  let initialized = false;
  let textItemStarted = false;
  let completed = false;
  let failed = false;
  let finalFinishReason = '';
  let upstreamChunks = 0;
  let upstreamEvents = 0;
  let outputTextDeltas = 0;
  let outputTextBytes = 0;
  const nativeToolCalls = new Map<number, ChatToolCall>();
  const streamedToolCalls = new Map<number, { outputIndex: number; itemId: string; call: ChatToolCall; added: boolean }>();

  function ensureInitialized(): string {
    if (initialized) return '';
    initialized = true;
    return [
      sse({
        type: 'response.created',
        response: responseObject(responseId, created, 'in_progress', model, outputText, itemId)
      }),
      sse({
        type: 'response.in_progress',
        response: responseObject(responseId, created, 'in_progress', model, outputText, itemId)
      }),
    ].join('');
  }

  function ensureTextItem(): string {
    if (textItemStarted) return '';
    textItemStarted = true;
    return [
      sse({
        type: 'response.output_item.added',
        output_index: outputIndex,
        item: messageItem(itemId, 'in_progress', '')
      }),
      sse({
        type: 'response.content_part.added',
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] }
      })
    ].join('');
  }

  function complete(): string {
    if (completed || failed) return '';
    completed = true;
    const parsed = splitToolCalls(rawText || outputText);
    const toolCalls = [...Array.from(nativeToolCalls.values()).map(chatToolCallToParsed), ...parsed.toolCalls];
    outputText = parsed.text;
    let out = '';
    const outputItems = [];
    if (textItemStarted) {
      const message = messageItem(itemId, 'completed', outputText);
      outputItems.push(message);
      out += [
        sse({
          type: 'response.output_text.done',
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          text: outputText
        }),
        sse({
          type: 'response.content_part.done',
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          part: { type: 'output_text', text: outputText, annotations: [] }
        }),
        sse({
          type: 'response.output_item.done',
          output_index: outputIndex++,
          item: message
        })
      ].join('');
    }
    for (const call of toolCalls) {
      const existingStreamed = call.callId ? [...streamedToolCalls.values()].find((item) => item.call.id === call.callId) : undefined;
      const toolOutputIndex = existingStreamed?.outputIndex ?? outputIndex;
      const item = functionCallItem(existingStreamed?.itemId ?? `fc_${created}_${toolOutputIndex}`, call);
      outputItems.push(item);
      if (!existingStreamed?.added) {
        out += sse({
          type: 'response.output_item.added',
          output_index: toolOutputIndex,
          item: { ...item, status: 'in_progress', arguments: '' }
        });
        out += sse({
          type: 'response.function_call_arguments.delta',
          item_id: item.id,
          output_index: toolOutputIndex,
          delta: item.arguments
        });
      }
      out += sse({
        type: 'response.function_call_arguments.done',
        item_id: item.id,
        output_index: toolOutputIndex,
        arguments: item.arguments
      });
      out += sse({
        type: 'response.output_item.done',
        output_index: toolOutputIndex,
        item
      });
      outputIndex = Math.max(outputIndex, toolOutputIndex + 1);
    }
    if (options.requestMessages) {
      rememberResponse(responseId, options.requestMessages, outputItems);
    }
    const finalStatus = finalFinishReason === 'length' ? 'incomplete' : 'completed';
    const finalEvent = finalStatus === 'incomplete' ? 'response.incomplete' : 'response.completed';
    debugLog(options.debug, 'responses.stream_complete', {
      responseId,
      finalStatus,
      finalFinishReason,
      upstreamChunks,
      upstreamEvents,
      outputTextDeltas,
      outputTextBytes,
      toolCallCount: toolCalls.length
    });
    return [
      out,
      sse({
        type: finalEvent,
        response: responseObject(responseId, created, finalStatus, model, outputText, outputItems)
      }),
      'data: [DONE]\n\n'
    ].join('');
  }

  function fail(error: unknown): string {
    if (completed || failed) return '';
    failed = true;
    const message = error instanceof Error ? error.message : String(error);
    debugLog(options.debug, 'responses.stream_failed', {
      responseId,
      upstreamChunks,
      upstreamEvents,
      outputTextDeltas,
      outputTextBytes,
      error: message
    });
    return [
      ensureInitialized(),
      sse({
        type: 'error',
        code: 'stream_conversion_error',
        message: `Failed to convert upstream chat stream: ${message}`
      }),
      sse({
        type: 'response.failed',
        sequence_number: sequence++,
        response: failedResponseObject(responseId, created, model, `Failed to convert upstream chat stream: ${message}`)
      }),
      'data: [DONE]\n\n'
    ].join('');
  }

  function handlePayload(payload: string): string {
    if (!payload || payload === '[DONE]') {
      return payload === '[DONE]' ? ensureInitialized() + complete() : '';
    }
    const chunk = JSON.parse(payload) as {
      id?: string;
      model?: string;
      choices?: Array<{
        delta?: { content?: string; reasoning_content?: string; tool_calls?: Array<{ index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }> };
        message?: { content?: string | null; tool_calls?: ChatToolCall[] };
        finish_reason?: string;
      }>;
    };
    if (chunk.id) responseId = chunk.id.replace(/^chatcmpl-/, 'resp_');
    if (options.modelOverride) model = options.modelOverride;
    else if (chunk.model) model = chunk.model;
    let out = ensureInitialized();
    for (const choice of chunk.choices ?? []) {
      for (const callDelta of choice.delta?.tool_calls ?? []) {
        const index = callDelta.index ?? 0;
        const existing = nativeToolCalls.get(index) ?? {
          id: callDelta.id ?? `call_${created}_${index}`,
          type: 'function' as const,
          function: { name: '', arguments: '' }
        };
        nativeToolCalls.set(index, {
          id: callDelta.id ?? existing.id,
          type: 'function',
          function: {
            name: callDelta.function?.name ?? existing.function.name,
            arguments: existing.function.arguments + (callDelta.function?.arguments ?? '')
          }
        });
        out += emitToolCallDelta(index, callDelta);
        debugLog(options.debug, 'responses.stream_tool_delta', {
          responseId,
          toolIndex: index,
          toolCallId: nativeToolCalls.get(index)?.id,
          name: nativeToolCalls.get(index)?.function.name,
          argumentsBytes: Buffer.byteLength(nativeToolCalls.get(index)?.function.arguments ?? '')
        });
      }
      for (const call of choice.message?.tool_calls ?? []) {
        const index = nativeToolCalls.size;
        const normalized = normalizeChatToolCall(call, index, created);
        nativeToolCalls.set(index, normalized);
        out += emitWholeToolCall(index, normalized);
        debugLog(options.debug, 'responses.stream_tool_message', {
          responseId,
          toolCallId: call.id,
          name: call.function?.name,
          argumentsBytes: Buffer.byteLength(call.function?.arguments ?? '')
        });
      }
      const delta = choice.delta?.content ?? choice.message?.content ?? '';
      if (delta) {
        rawText += delta;
        if (!delta.includes('<tool_call>') && !rawText.includes('<tool_call>')) {
          outputText += delta;
          outputTextDeltas += 1;
          outputTextBytes += Buffer.byteLength(delta);
          out += ensureTextItem();
          out += sse({
            type: 'response.output_text.delta',
            sequence_number: sequence++,
            item_id: itemId,
            output_index: 0,
            content_index: 0,
            delta
          });
        }
      }
      if (choice.finish_reason) {
        finalFinishReason = choice.finish_reason;
        debugLog(options.debug, 'responses.stream_finish_reason', { responseId, finishReason: choice.finish_reason });
        out += complete();
      }
    }
    return out;
  }

  function emitToolCallDelta(index: number, callDelta: { id?: string; function?: { name?: string; arguments?: string } }): string {
    const call = nativeToolCalls.get(index);
    if (!call) return '';
    const state = ensureStreamedToolState(index, call, callDelta.function?.name);
    let out = '';
    if (!state.added) {
      state.added = true;
      out += sse({
        type: 'response.output_item.added',
        output_index: state.outputIndex,
        item: {
          id: state.itemId,
          type: 'function_call',
          status: 'in_progress',
          call_id: call.id,
          name: call.function.name,
          arguments: ''
        }
      });
    }
    const delta = callDelta.function?.arguments ?? '';
    if (delta) {
      out += sse({
        type: 'response.function_call_arguments.delta',
        item_id: state.itemId,
        output_index: state.outputIndex,
        delta
      });
    }
    return out;
  }

  function emitWholeToolCall(index: number, call: ChatToolCall): string {
    const state = ensureStreamedToolState(index, call, call.function.name);
    let out = '';
    if (!state.added) {
      state.added = true;
      out += sse({
        type: 'response.output_item.added',
        output_index: state.outputIndex,
        item: {
          id: state.itemId,
          type: 'function_call',
          status: 'in_progress',
          call_id: call.id,
          name: call.function.name,
          arguments: ''
        }
      });
    }
    if (call.function.arguments) {
      out += sse({
        type: 'response.function_call_arguments.delta',
        item_id: state.itemId,
        output_index: state.outputIndex,
        delta: call.function.arguments
      });
    }
    return out;
  }

  function ensureStreamedToolState(index: number, call: ChatToolCall, name?: string) {
    const existing = streamedToolCalls.get(index);
    if (existing) {
      if (name) existing.call.function.name = name;
      existing.call = call;
      return existing;
    }
    const state = {
      outputIndex: textItemStarted ? outputIndex++ : outputIndex,
      itemId: `fc_${created}_${index}`,
      call,
      added: false
    };
    if (!textItemStarted) outputIndex += 1;
    streamedToolCalls.set(index, state);
    return state;
  }

  return {
    transform(chunk: Buffer | Uint8Array): string {
      if (completed || failed) return '';
      upstreamChunks += 1;
      buffer += Buffer.from(chunk).toString('utf8');
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      let out = '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        upstreamEvents += 1;
        out += handlePayload(line.slice(5).trim());
      }
      return out;
    },
    flush(): string {
      if (failed) return '';
      let out = '';
      if (buffer.trim().startsWith('data:')) {
        out += handlePayload(buffer.trim().slice(5).trim());
      }
      out += ensureInitialized();
      out += complete();
      return out;
    },
    fail
  };
}

type ParsedToolCall = {
  name: string;
  arguments: Record<string, string>;
  callId?: string;
  argumentsJson?: string;
};

function splitToolCalls(text: string): { text: string; toolCalls: ParsedToolCall[] } {
  const toolCalls: ParsedToolCall[] = [];
  const cleaned = text.replace(/<tool_call>([\s\S]*?)<\/tool_call>/g, (_match, inner: string) => {
    const parsed = parseToolCall(inner);
    if (parsed) toolCalls.push(parsed);
    return '';
  }).trim();
  return { text: cleaned, toolCalls };
}

function parseToolCall(inner: string): ParsedToolCall | null {
  const fnMatch = inner.match(/<function=([^>\s]+)>/);
  if (!fnMatch) return null;
  const args: Record<string, string> = {};
  for (const match of inner.matchAll(/<parameter=([^>\s]+)>([\s\S]*?)<\/parameter>/g)) {
    args[match[1]] = decodeEntities(match[2].trim());
  }
  return { name: fnMatch[1], arguments: args };
}

function functionCallItem(id: string, call: ParsedToolCall) {
  return {
    id,
    type: 'function_call',
    status: 'completed',
    call_id: call.callId ?? `call_${id}`,
    name: call.name,
    arguments: call.argumentsJson ?? JSON.stringify(call.arguments)
  };
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function legacyChatSseToResponsesSse(body: Buffer, fallbackModel: string): string {
  const lines = body.toString('utf8').split(/\r?\n/);
  const events: string[] = [];
  const created = Math.floor(Date.now() / 1000);
  let responseId = `resp_${created}`;
  let model = fallbackModel;
  let sequence = 0;

  events.push(sse({
    type: 'response.created',
    response: {
      id: responseId,
      object: 'response',
      created_at: created,
      status: 'in_progress',
      model
    }
  }));

  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    if (payload === '[DONE]') break;
    const chunk = JSON.parse(payload) as {
      id?: string;
      model?: string;
      choices?: Array<{ delta?: { content?: string; reasoning_content?: string }; message?: { content?: string }; finish_reason?: string }>;
    };
    if (chunk.id) responseId = chunk.id.replace(/^chatcmpl-/, 'resp_');
    if (chunk.model) model = chunk.model;
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta?.content ?? choice.message?.content ?? '';
      if (delta) {
        events.push(sse({
          type: 'response.output_text.delta',
          sequence_number: sequence++,
          item_id: `msg_${created}`,
          output_index: 0,
          content_index: 0,
          delta
        }));
      }
      if (choice.finish_reason) {
        events.push(sse({
          type: 'response.completed',
          response: {
            id: responseId,
            object: 'response',
            created_at: created,
            status: 'completed',
            model
          }
        }));
      }
    }
  }

  if (!events.some((event) => event.includes('"response.completed"'))) {
    events.push(sse({
      type: 'response.completed',
      response: {
        id: responseId,
        object: 'response',
        created_at: created,
        status: 'completed',
        model
      }
    }));
  }
  events.push('data: [DONE]\n\n');
  return events.join('');
}

void legacyChatSseToResponsesSse;

function sse(payload: unknown): string {
  const type = typeof payload === 'object' && payload && 'type' in payload ? String((payload as { type: unknown }).type) : 'message';
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function responseObject(id: string, createdAt: number, status: 'in_progress' | 'completed' | 'incomplete', model: string, outputText: string, output: unknown[] | string) {
  return {
    id,
    object: 'response',
    created_at: createdAt,
    status,
    model,
    output: status === 'completed' || status === 'incomplete' ? output : [],
    output_text: status === 'completed' || status === 'incomplete' ? outputText : undefined,
    incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
    error: null,
    usage: null
  };
}

function failedResponseObject(id: string, createdAt: number, model: string, message: string) {
  return {
    id,
    object: 'response',
    created_at: createdAt,
    status: 'failed',
    error: {
      code: 'stream_conversion_error',
      message
    },
    incomplete_details: null,
    model,
    output: [],
    usage: null
  };
}

function messageItem(id: string, status: 'in_progress' | 'completed', text: string) {
  return {
    id,
    type: 'message',
    status,
    role: 'assistant',
    content: [
      {
        type: 'output_text',
        text,
        annotations: []
      }
    ]
  };
}

function responseOutputItems(messageId: string, outputText: string, toolCalls: ParsedToolCall[], includeText: boolean) {
  const output = [];
  if (includeText) {
    output.push(messageItem(messageId, 'completed', outputText));
  }
  for (const [index, call] of toolCalls.entries()) {
    output.push(functionCallItem(`fc_${messageId}_${index}`, call));
  }
  return output;
}

function rememberResponse(responseId: string, requestMessages: ChatMessage[], output: unknown[]): void {
  const assistant = assistantMessageFromOutput(output);
  if (!assistant) return;
  pruneResponseHistories();
  responseHistories.set(responseId, { messages: [...requestMessages, assistant], expiresAt: Date.now() + responseSessionTtlMs() });
  while (responseHistories.size > maxResponseHistories) {
    const oldest = responseHistories.keys().next().value;
    if (!oldest) break;
    responseHistories.delete(oldest);
  }
}

function responseSessionTtlMs(): number {
  const ttl = Number(process.env.RESPONSES_SESSION_TTL_MS ?? defaultResponseSessionTtlMs);
  return Number.isFinite(ttl) && ttl > 0 ? ttl : defaultResponseSessionTtlMs;
}

function historyMessages(responseId: string): ChatMessage[] {
  pruneResponseHistories();
  const history = responseHistories.get(responseId);
  if (!history) return [];
  if (history.expiresAt <= Date.now()) {
    responseHistories.delete(responseId);
    return [];
  }
  return history.messages;
}

function pruneResponseHistories(): void {
  const now = Date.now();
  for (const [id, history] of responseHistories) {
    if (history.expiresAt <= now) responseHistories.delete(id);
  }
}

function assistantMessageFromOutput(output: unknown[]): ChatMessage | null {
  const message = output.find((item) => {
    const record = item as { type?: unknown };
    return record?.type === 'message';
  }) as { content?: Array<{ type?: string; text?: string }> } | undefined;
  const text = message?.content?.find((part) => part.type === 'output_text')?.text ?? '';
  const calls = output.filter((item) => (item as { type?: unknown })?.type === 'function_call') as Array<{
    call_id?: string;
    name?: string;
    arguments?: string;
  }>;
  if (!message && calls.length === 0) return null;
  return {
    role: 'assistant',
    content: text || (calls.length > 0 ? null : ''),
    ...(calls.length > 0 ? {
      tool_calls: calls.map((call, index) => ({
        id: call.call_id ?? `call_${index}`,
        type: 'function' as const,
        function: {
          name: call.name ?? '',
          arguments: call.arguments ?? '{}'
        }
      }))
    } : {})
  };
}

function normalizeChatToolCall(call: ChatToolCall, index: number, created: number): ChatToolCall {
  return {
    id: call.id ?? `call_${created}_${index}`,
    type: 'function',
    function: {
      name: call.function?.name ?? '',
      arguments: call.function?.arguments ?? '{}'
    }
  };
}

function chatToolCallToParsed(call: ChatToolCall): ParsedToolCall {
  return {
    name: call.function.name,
    arguments: {},
    callId: call.id,
    argumentsJson: call.function.arguments || '{}'
  };
}

function toolChoiceForChat(toolChoice: unknown): Record<string, unknown> {
  if (toolChoice === undefined) return {};
  if (typeof toolChoice === 'string') return { tool_choice: toolChoice };
  if (!toolChoice || typeof toolChoice !== 'object') return {};
  const record = toolChoice as { type?: unknown; name?: unknown; function?: { name?: unknown } };
  if (record.function && typeof record.function.name === 'string') {
    return { tool_choice: { type: 'function', function: { name: record.function.name } } };
  }
  if (record.type === 'function' && typeof record.name === 'string') {
    return { tool_choice: { type: 'function', function: { name: record.name } } };
  }
  if (record.type === 'auto' || record.type === 'none') {
    return { tool_choice: record.type };
  }
  if (record.type === 'required' || record.type === 'tool' || record.type === 'any' || record.type === 'function') {
    return { tool_choice: 'required' };
  }
  return { tool_choice: toolChoice };
}

function toolsForChat(tools: unknown[] | undefined): Record<string, unknown> {
  if (!tools?.length) return {};
  const converted = tools.map(toolForChat).filter(Boolean);
  return converted.length > 0 ? { tools: converted } : {};
}

function toolForChat(tool: unknown): unknown | null {
  if (!tool || typeof tool !== 'object') return null;
  const record = tool as {
    type?: unknown;
    name?: unknown;
    description?: unknown;
    parameters?: unknown;
    function?: unknown;
  };
  if (record.type !== 'function') return null;
  if (record.function && typeof record.function === 'object') {
    return { type: 'function', function: record.function };
  }
  if (typeof record.name !== 'string') return null;
  return {
    type: 'function',
    function: {
      name: record.name,
      ...(typeof record.description === 'string' ? { description: record.description } : {}),
      ...(record.parameters ? { parameters: record.parameters } : {})
    }
  };
}

function parseResponsesRequest(body: Buffer): ResponsesRequest {
  if (body.length === 0) return {};
  return JSON.parse(body.toString('utf8')) as ResponsesRequest;
}

function responsesToChatPayload(request: ResponsesRequest) {
  const messages: ChatMessage[] = [];
  if (request.instructions) {
    messages.push({ role: 'system', content: request.instructions });
  }
  if (request.previous_response_id) {
    messages.push(...historyMessages(request.previous_response_id));
  }
  messages.push(...mergeConsecutiveAssistantToolCalls(inputToMessages(request.input)));
  if (request.messages?.length) {
    messages.push(...request.messages.map((message) => ({
      role: normalizeRole(message.role),
      content: contentToText(message.content),
      ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
      ...(message.tool_calls ? { tool_calls: message.tool_calls } : {})
    })));
  }
  if (messages.length === 0) {
    messages.push({ role: 'user', content: '' });
  }
  return {
    model: request.model ?? 'mimo',
    messages,
    ...(request.stream === undefined ? {} : { stream: request.stream }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.max_output_tokens === undefined ? {} : { max_tokens: request.max_output_tokens }),
    ...(request.parallel_tool_calls === undefined ? {} : { parallel_tool_calls: request.parallel_tool_calls }),
    ...toolChoiceForChat(request.tool_choice),
    ...toolsForChat(request.tools)
  };
}

function mergeConsecutiveAssistantToolCalls(messages: ChatMessage[]): ChatMessage[] {
  const merged: ChatMessage[] = [];
  for (const message of messages) {
    const previous = merged.at(-1);
    if (
      previous?.role === 'assistant' &&
      previous.content === null &&
      Array.isArray(previous.tool_calls) &&
      message.role === 'assistant' &&
      message.content === null &&
      Array.isArray(message.tool_calls)
    ) {
      previous.tool_calls.push(...message.tool_calls);
      continue;
    }
    merged.push(message);
  }
  return merged;
}

function inputToMessages(input: unknown): ChatMessage[] {
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  if (!Array.isArray(input)) return [];
  return input.map((item) => {
    if (typeof item === 'string') return { role: 'user', content: item };
    const record = item as { role?: string; content?: unknown; type?: string; call_id?: unknown; output?: unknown; name?: unknown; arguments?: unknown };
    if (record.type === 'function_call') {
      const callId = String(record.call_id ?? `call_${Date.now()}`);
      return {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: callId,
          type: 'function',
          function: {
            name: String(record.name ?? ''),
            arguments: typeof record.arguments === 'string' ? record.arguments : JSON.stringify(record.arguments ?? {})
          }
        }]
      };
    }
    if (record.type === 'function_call_output') {
      return {
        role: 'tool',
        tool_call_id: String(record.call_id ?? ''),
        content: contentToText(record.output)
      };
    }
    return {
      role: normalizeRole(record.role),
      content: contentToText(record.content)
    };
  });
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      const record = part as { text?: unknown; type?: string };
      return typeof record.text === 'string' ? record.text : '';
    }).filter(Boolean).join('\n');
  }
  if (content && typeof content === 'object' && 'text' in content) {
    const text = (content as { text?: unknown }).text;
    return typeof text === 'string' ? text : '';
  }
  if (content === null || content === undefined) return '';
  if (typeof content === 'number' || typeof content === 'boolean') return String(content);
  if (typeof content === 'object') return JSON.stringify(content);
  return '';
}

function normalizeRole(role: string | undefined): string {
  if (role === 'assistant' || role === 'system' || role === 'tool') return role;
  return 'user';
}

function parseJson(body: Buffer): Record<string, unknown> {
  return JSON.parse(body.toString('utf8')) as Record<string, unknown>;
}

function chatCompletionToResponse(chatBody: Record<string, unknown>, fallbackModel: string) {
  const choices = chatBody.choices as Array<{ message?: { content?: string | null; tool_calls?: ChatToolCall[] }; finish_reason?: string }> | undefined;
  const choice = choices?.[0];
  const message = choice?.message;
  const parsed = splitToolCalls(message?.content ?? '');
  const toolCalls = [
    ...(message?.tool_calls ?? []).map((call, index) => chatToolCallToParsed(normalizeChatToolCall(call, index, Math.floor(Date.now() / 1000)))),
    ...parsed.toolCalls
  ];
  const outputText = parsed.text;
  const created = Math.floor(Date.now() / 1000);
  const output = responseOutputItems(`msg_${created}`, outputText, toolCalls, outputText.length > 0 || toolCalls.length === 0);
  return {
    id: typeof chatBody.id === 'string' ? chatBody.id.replace(/^chatcmpl-/, 'resp_') : `resp_${created}`,
    object: 'response',
    created_at: created,
    status: choice?.finish_reason === 'length' ? 'incomplete' : 'completed',
    model: typeof chatBody.model === 'string' ? chatBody.model : fallbackModel,
    output,
    output_text: outputText,
    incomplete_details: choice?.finish_reason === 'length' ? { reason: 'max_output_tokens' } : null,
    error: null,
    usage: chatBody.usage ?? null
  };
}
