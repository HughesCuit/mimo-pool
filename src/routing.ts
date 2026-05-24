import type { Protocol, RouteTarget, Store } from './types.ts';

export function nowIso(): string {
  return new Date().toISOString();
}

export function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 8) {
    return `${apiKey.slice(0, 3)}...${apiKey.slice(-4)}`;
  }
  return `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`;
}

export async function buildRoutePlan(store: Store, protocol: Protocol): Promise<RouteTarget[]> {
  const rows = await store.listActiveKeysForRouting();
  return rows
    .filter((row) => row.groupEnabled && row.status === 'active')
    .sort((a, b) => a.groupSortOrder - b.groupSortOrder || a.sortOrder - b.sortOrder || a.id - b.id)
    .map((row) => ({
      groupCode: row.groupCode,
      groupName: row.groupName,
      baseUrl: protocol === 'openai' ? row.openaiBaseUrl : row.anthropicBaseUrl,
      keyId: row.id,
      apiKey: row.apiKey,
      maskedKey: row.maskedKey
    }));
}

export type UpstreamFailure = 'exhausted' | 'retryable' | 'client';

export function classifyUpstreamFailure(status: number, bodyText: string): UpstreamFailure {
  const text = bodyText.toLowerCase();
  if (
    status === 429 ||
    text.includes('quota') ||
    text.includes('balance') ||
    text.includes('insufficient') ||
    text.includes('exhausted') ||
    text.includes('rate limit') ||
    text.includes('too many requests')
  ) {
    return 'exhausted';
  }
  if (status >= 500 || status === 408) {
    return 'retryable';
  }
  return 'client';
}

export function stripProtocolPrefix(protocol: Protocol, path: string): string {
  if (protocol === 'anthropic' && path.startsWith('/anthropic')) {
    return path.slice('/anthropic'.length) || '/';
  }
  return path;
}

export function resolveUpstreamUrl(baseUrl: string, path: string, protocol: Protocol): URL {
  const trimmedBase = baseUrl.replace(/\/+$/, '');
  const outgoingPath = stripProtocolPrefix(protocol, path);
  if (protocol === 'openai' && outgoingPath.startsWith('/v1/')) {
    return new URL(`${trimmedBase}${outgoingPath.slice(3)}`);
  }
  return new URL(`${trimmedBase}${outgoingPath.startsWith('/') ? outgoingPath : `/${outgoingPath}`}`);
}
