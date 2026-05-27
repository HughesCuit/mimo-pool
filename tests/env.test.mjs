import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { ensureRuntimeConfig } from '../src/env.ts';

test('ensureRuntimeConfig auto-generates missing required tokens in non-interactive mode', async () => {
  const previousAdmin = process.env.ADMIN_TOKEN;
  const previousProxy = process.env.PROXY_TOKENS;
  const tempDir = mkdtempSync(join(tmpdir(), 'mimo-pool-env-'));
  const envPath = join(tempDir, '.env');
  delete process.env.ADMIN_TOKEN;
  delete process.env.PROXY_TOKENS;

  try {
    await ensureRuntimeConfig(envPath);
    const text = readFileSync(envPath, 'utf8');

    assert.match(process.env.ADMIN_TOKEN, /^ap-/);
    assert.match(process.env.PROXY_TOKENS, /^pt-/);
    assert.match(text, /^ADMIN_TOKEN=ap-/m);
    assert.match(text, /^PROXY_TOKENS=pt-/m);
  } finally {
    if (previousAdmin === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = previousAdmin;
    if (previousProxy === undefined) delete process.env.PROXY_TOKENS;
    else process.env.PROXY_TOKENS = previousProxy;
    rmSync(tempDir, { recursive: true, force: true });
  }
});
