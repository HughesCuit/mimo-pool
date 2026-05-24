import type { IncomingMessage, ServerResponse } from 'node:http';

export async function readBody(req: IncomingMessage, limitBytes = Number(process.env.MAX_BODY_BYTES ?? 20 * 1024 * 1024)): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > limitBytes) {
      throw Object.assign(new Error('Request body too large'), { statusCode: 413 });
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export async function readJson<T = unknown>(req: IncomingMessage): Promise<T> {
  const body = await readBody(req);
  if (body.length === 0) return {} as T;
  return JSON.parse(body.toString('utf8')) as T;
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload, null, 2));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length
  });
  res.end(body);
}

export function sendText(res: ServerResponse, status: number, text: string, contentType = 'text/plain; charset=utf-8'): void {
  const body = Buffer.from(text);
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length
  });
  res.end(body);
}

export function sendError(res: ServerResponse, error: unknown): void {
  const status = typeof error === 'object' && error && 'statusCode' in error ? Number(error.statusCode) : 500;
  const message = error instanceof Error ? error.message : String(error);
  sendJson(res, status, { error: { message } });
}
