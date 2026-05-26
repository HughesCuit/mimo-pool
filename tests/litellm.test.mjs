import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildLiteLLMConfig } from '../src/litellm-config.ts';
import { createMemoryStore } from '../src/store.ts';

test('buildLiteLLMConfig exports active keys in route order with fallbacks', async () => {
  const store = createMemoryStore();
  await store.updateServiceGroup('CN', { sortOrder: 20, openaiBaseUrl: 'https://cn.example/v1' });
  await store.updateServiceGroup('SGP', { sortOrder: 10, openaiBaseUrl: 'https://sgp.example/v1' });
  await store.updateServiceGroup('AMS', { enabled: false });
  await store.importKeys('CN', ['cn-key']);
  await store.importKeys('SGP', ['sgp-key']);
  await store.importKeys('AMS', ['ams-key']);

  const config = await buildLiteLLMConfig(store, {
    publicModels: ['gpt-5.4'],
    upstreamModel: 'mimo-v2.5-pro',
    masterKey: 'proxy-secret',
    requestTimeoutSeconds: 30
  });

  assert.match(config, /model_name: "gpt-5\.4"/);
  assert.equal([...config.matchAll(/model_name: "gpt-5\.4"/g)].length, 2);
  assert.doesNotMatch(config, /__mimo_/);
  assert.match(config, /fallbacks: \[\]/);
  assert.match(config, /api_base: "https:\/\/sgp\.example\/v1"[\s\S]*api_key: "sgp-key"[\s\S]*api_base: "https:\/\/cn\.example\/v1"[\s\S]*api_key: "cn-key"/);
  assert.doesNotMatch(config, /ams-key/);
  assert.match(config, /master_key: "proxy-secret"/);
  assert.match(config, /model: "openai\/mimo-v2\.5-pro"/);
});

test('buildLiteLLMConfig handles empty pools', async () => {
  const store = createMemoryStore();
  await store.updateServiceGroup('CN', { enabled: false });
  await store.updateServiceGroup('SGP', { enabled: false });
  await store.updateServiceGroup('AMS', { enabled: false });

  const config = await buildLiteLLMConfig(store, {
    publicModels: ['gpt-5.4'],
    masterKey: 'proxy-secret'
  });

  assert.match(config, /model_list:\n  \[\]/);
  assert.match(config, /fallbacks: \[\]/);
});
