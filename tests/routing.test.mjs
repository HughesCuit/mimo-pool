import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMemoryStore } from '../src/store.ts';
import { buildRoutePlan, classifyUpstreamFailure, clearAllCooldownsForTests, maskApiKey, setKeyCooldown } from '../src/routing.ts';

test('buildRoutePlan orders active keys by service group order then key order', async () => {
  const store = createMemoryStore();
  await store.importKeys('SGP', ['sgp-first', 'sgp-second']);
  await store.importKeys('CN', ['cn-first']);
  await store.updateServiceGroup('CN', { sortOrder: 20 });
  await store.updateServiceGroup('SGP', { sortOrder: 10 });

  const plan = await buildRoutePlan(store, 'openai');

  assert.deepEqual(
    plan.map((target) => [target.groupCode, target.apiKey]),
    [
      ['SGP', 'sgp-first'],
      ['SGP', 'sgp-second'],
      ['CN', 'cn-first']
    ]
  );
});

test('buildRoutePlan skips disabled, exhausted, and inactive service groups', async () => {
  const store = createMemoryStore();
  const [cn] = await store.importKeys('CN', ['cn-first']);
  await store.importKeys('SGP', ['sgp-first']);
  await store.markKeyExhausted(cn.id, 'quota exhausted');
  await store.updateServiceGroup('SGP', { enabled: false });

  const plan = await buildRoutePlan(store, 'anthropic');

  assert.deepEqual(plan, []);
});

test('buildRoutePlan skips keys in temporary cooldown', async () => {
  clearAllCooldownsForTests();
  const store = createMemoryStore();
  const [cooling] = await store.importKeys('CN', ['cooling-key']);
  await store.importKeys('CN', ['ready-key']);
  setKeyCooldown(cooling.id);

  const plan = await buildRoutePlan(store, 'openai');

  assert.deepEqual(plan.map((target) => target.apiKey), ['ready-key']);
  clearAllCooldownsForTests();
});

test('classifyUpstreamFailure conservatively identifies exhausted keys', () => {
  assert.equal(classifyUpstreamFailure(429, '{"error":{"message":"rate limit exceeded"}}'), 'cooldown');
  assert.equal(classifyUpstreamFailure(400, '{"error":"insufficient balance"}'), 'exhausted');
  assert.equal(classifyUpstreamFailure(500, 'upstream unavailable'), 'retryable');
  assert.equal(classifyUpstreamFailure(404, 'model not found'), 'client');
});

test('maskApiKey keeps only short prefix and suffix', () => {
  assert.equal(maskApiKey('sk-1234567890abcdef'), 'sk-1...cdef');
});
