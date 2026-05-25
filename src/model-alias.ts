import { debugLog, type DebugContext } from './debug.ts';

export type ModelAlias = {
  from: string;
  to: string;
};

export type ModelAliasResult = {
  body: Buffer;
  originalModel?: string;
  upstreamModel?: string;
};

export function modelAliases(): ModelAlias[] {
  return parseAliases(process.env.MODEL_ALIASES ?? defaultModelAliases);
}

export function applyModelAlias(body: Buffer, debug?: DebugContext): ModelAliasResult {
  if (body.length === 0) return { body };
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
  } catch {
    return { body };
  }
  const model = typeof payload.model === 'string' ? payload.model : undefined;
  if (!model) return { body };
  const alias = resolveModelAlias(model);
  if (!alias || alias.to === model) return { body };
  payload.model = alias.to;
  debugLog(debug, 'model_alias.request', { originalModel: model, upstreamModel: alias.to });
  return {
    body: Buffer.from(JSON.stringify(payload)),
    originalModel: model,
    upstreamModel: alias.to
  };
}

export function restoreModelAlias(body: Buffer, originalModel?: string, upstreamModel?: string, debug?: DebugContext): Buffer {
  if (!originalModel || !upstreamModel || body.length === 0) return body;
  try {
    const payload = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
    restoreModelInValue(payload, originalModel, upstreamModel);
    debugLog(debug, 'model_alias.response', { originalModel, upstreamModel });
    return Buffer.from(JSON.stringify(payload));
  } catch {
    return body;
  }
}

export function addModelAliasesToList(body: Buffer): Buffer {
  const aliases = modelAliases();
  if (aliases.length === 0 || body.length === 0) return body;
  try {
    const payload = JSON.parse(body.toString('utf8')) as { data?: Array<Record<string, unknown>> };
    if (!Array.isArray(payload.data)) return body;
    const existing = new Set(payload.data.map((model) => model.id).filter((id): id is string => typeof id === 'string'));
    for (const alias of aliases.filter(isVisibleAlias)) {
      if (existing.has(alias.from)) continue;
      payload.data.push({ id: alias.from, object: 'model', owned_by: 'mimo-pool', alias_for: alias.to });
      existing.add(alias.from);
    }
    return Buffer.from(JSON.stringify(payload));
  } catch {
    return body;
  }
}

export function aliasModelIds(ids: string[]): string[] {
  const set = new Set(ids);
  for (const alias of modelAliases().filter(isVisibleAlias)) set.add(alias.from);
  return [...set];
}

function resolveModelAlias(model: string): ModelAlias | undefined {
  return modelAliases().find((alias) => aliasMatches(alias.from, model));
}

function parseAliases(value: string): ModelAlias[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [from, to] = entry.split(':').map((part) => part.trim());
      return from && to ? { from, to } : null;
    })
    .filter((entry): entry is ModelAlias => Boolean(entry));
}

const defaultModelAliases = [
  'gpt-*:mimo-v2.5-pro',
  'o*:mimo-v2.5-pro',
  'chatgpt-*:mimo-v2.5-pro'
].join(',');

function aliasMatches(pattern: string, model: string): boolean {
  if (pattern === model) return true;
  if (!pattern.includes('*')) return false;
  const escaped = pattern.split('*').map(escapeRegExp).join('.*');
  return new RegExp(`^${escaped}$`).test(model);
}

function isVisibleAlias(alias: ModelAlias): boolean {
  return !alias.from.includes('*');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function restoreModelInValue(value: unknown, originalModel: string, upstreamModel: string): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) restoreModelInValue(item, originalModel, upstreamModel);
    return;
  }
  const record = value as Record<string, unknown>;
  if (record.model === upstreamModel) record.model = originalModel;
  for (const item of Object.values(record)) restoreModelInValue(item, originalModel, upstreamModel);
}
