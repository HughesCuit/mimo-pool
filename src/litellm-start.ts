import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildLiteLLMConfig } from './litellm-config.ts';
import { createSqliteStore } from './store.ts';

async function main(): Promise<void> {
  const configPath = process.env.LITELLM_CONFIG_PATH ?? 'data/litellm-config.yaml';
  const port = process.env.LITELLM_PORT ?? '4000';
  const store = createSqliteStore();
  try {
    const config = await buildLiteLLMConfig(store);
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, config, 'utf8');
    console.log(`LiteLLM config written to ${configPath}`);
  } finally {
    store.close?.();
  }

  const child = spawn('litellm', ['--config', configPath, '--port', port, ...process.argv.slice(2)], {
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
  child.on('error', (error) => {
    console.error(`Failed to start LiteLLM. Install it first: uv tool install 'litellm[proxy]'`);
    console.error(error);
    process.exit(1);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
