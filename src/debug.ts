import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Protocol } from './types.ts';

export type DebugContext = {
  requestId: string;
  startedAt: number;
  protocol: Protocol;
  method: string;
  path: string;
  bodyBytes: number;
  stream: boolean;
  model?: string;
  previousResponseId?: string;
  inputKind?: string;
  toolCount?: number;
};

let nextRequestId = 1;
let announcedLogFile = '';

export function debugEnabled(): boolean {
  return process.env.DEBUG_PROXY === '1' || process.env.DEBUG_PROXY === 'true';
}

export function debugBodyEnabled(): boolean {
  return process.env.DEBUG_PROXY_BODY === '1' || process.env.DEBUG_PROXY_BODY === 'true';
}

export function createDebugContext(protocol: Protocol, method: string, path: string, body: Buffer): DebugContext {
  const parsed = bodySummary(body);
  return {
    requestId: `${Date.now().toString(36)}-${nextRequestId++}`,
    startedAt: Date.now(),
    protocol,
    method,
    path,
    bodyBytes: body.length,
    stream: parsed.stream,
    model: parsed.model,
    previousResponseId: parsed.previousResponseId,
    inputKind: parsed.inputKind,
    toolCount: parsed.toolCount
  };
}

export function debugLog(context: DebugContext | undefined, event: string, details: Record<string, unknown> = {}): void {
  if (!context || !debugEnabled()) return;
  const payload = redact({
    ts: new Date().toISOString(),
    event,
    requestId: context.requestId,
    elapsedMs: Date.now() - context.startedAt,
    method: context.method,
    path: context.path,
    protocol: context.protocol,
    stream: context.stream,
    model: context.model,
    previousResponseId: context.previousResponseId,
    inputKind: context.inputKind,
    toolCount: context.toolCount,
    ...details
  });
  const line = `[mimo-pool:debug] ${JSON.stringify(payload)}`;
  const logFile = process.env.DEBUG_PROXY_LOG_FILE;
  if (logFile) {
    mkdirSync(dirname(logFile), { recursive: true });
    appendFileSync(logFile, `${line}\n`, 'utf8');
    if (announcedLogFile !== logFile) {
      announcedLogFile = logFile;
      console.error(`[mimo-pool:debug] writing debug logs to ${logFile}`);
    }
    return;
  }
  console.error(line);
}

export function debugBody(label: string, body: Buffer | string): Record<string, unknown> {
  const text = Buffer.isBuffer(body) ? body.toString('utf8') : body;
  const limit = Number(process.env.DEBUG_PROXY_BODY_LIMIT ?? 2000);
  return {
    [`${label}Bytes`]: Buffer.byteLength(text),
    ...(debugBodyEnabled() ? { [`${label}Preview`]: redactText(text).slice(0, limit) } : {})
  };
}

function bodySummary(body: Buffer): { stream: boolean; model?: string; previousResponseId?: string; inputKind?: string; toolCount?: number } {
  if (body.length === 0) return { stream: false };
  try {
    const parsed = JSON.parse(body.toString('utf8')) as {
      stream?: unknown;
      model?: unknown;
      previous_response_id?: unknown;
      input?: unknown;
      messages?: unknown;
      tools?: unknown[];
    };
    return {
      stream: parsed.stream === true,
      model: typeof parsed.model === 'string' ? parsed.model : undefined,
      previousResponseId: typeof parsed.previous_response_id === 'string' ? parsed.previous_response_id : undefined,
      inputKind: inputKind(parsed.input, parsed.messages),
      toolCount: Array.isArray(parsed.tools) ? parsed.tools.length : undefined
    };
  } catch {
    return { stream: false, inputKind: 'unparseable-json' };
  }
}

function inputKind(input: unknown, messages: unknown): string | undefined {
  if (typeof input === 'string') return 'string';
  if (Array.isArray(input)) {
    const types = input.map((item) => {
      if (typeof item === 'string') return 'string';
      if (item && typeof item === 'object' && 'type' in item) return String((item as { type?: unknown }).type);
      if (item && typeof item === 'object' && 'role' in item) return `role:${String((item as { role?: unknown }).role)}`;
      return typeof item;
    });
    return types.join(',');
  }
  if (Array.isArray(messages)) return `messages:${messages.length}`;
  return input === undefined ? undefined : typeof input;
}

function redact(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key.toLowerCase() === 'maskedkey') {
      output[key] = item;
    } else if (/api[-_]?key|authorization|token/i.test(key)) {
      output[key] = '[redacted]';
    } else {
      output[key] = redact(item);
    }
  }
  return output;
}

function redactText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/"api_key"\s*:\s*"[^"]+"/gi, '"api_key":"[redacted]"')
    .replace(/"apiKey"\s*:\s*"[^"]+"/g, '"apiKey":"[redacted]"')
    .replace(/tp-[A-Za-z0-9._-]{8,}/g, 'tp-[redacted]')
    .replace(/sk-[A-Za-z0-9._-]{8,}/g, 'sk-[redacted]');
}
