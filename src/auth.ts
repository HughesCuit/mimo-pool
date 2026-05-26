import type { IncomingMessage } from 'node:http';

export function getBearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const value = Array.isArray(header) ? header[0] : header;
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

export function getApiKeyToken(req: IncomingMessage): string | null {
  const header = req.headers['x-api-key'];
  if (!header) return null;
  return Array.isArray(header) ? header[0] : header;
}

export function requireToken(req: IncomingMessage, allowedTokens: string[]): boolean {
  const token = getBearerToken(req) ?? getApiKeyToken(req);
  return Boolean(token && allowedTokens.includes(token));
}

export function parseTokenList(value: string | undefined, fallback: string): string[] {
  return (value ?? fallback)
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);
}
