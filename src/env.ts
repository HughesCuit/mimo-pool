import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

type EnvFile = {
  path: string;
  values: Map<string, string>;
  lines: string[];
};

const requiredTokens = [
  { name: 'ADMIN_TOKEN', prefix: 'ap' },
  { name: 'PROXY_TOKENS', prefix: 'pt' }
] as const;

export async function ensureRuntimeConfig(envPath = '.env'): Promise<void> {
  const envFile = loadEnvFile(envPath);
  applyEnvFile(envFile);
  const interactive = Boolean(input.isTTY && output.isTTY);
  const prompts = interactive ? createInterface({ input, output }) : null;
  try {
    for (const token of requiredTokens) {
      await ensureToken(envFile, token.name, token.prefix, prompts);
    }
  } finally {
    prompts?.close();
  }
}

async function ensureToken(envFile: EnvFile, name: string, prefix: string, prompts: ReturnType<typeof createInterface> | null): Promise<void> {
  const current = process.env[name] ?? '';
  const fromFile = envFile.values.get(name);
  if (!isPlaceholder(current)) {
    if (prompts && fromFile !== undefined) {
      const action = await prompts.question(`${name} is configured in .env as ${maskSecret(current)}. Press Enter to keep it, type "g" to generate a new one, or type a new value: `);
      if (!action.trim()) return;
      const next = action.trim().toLowerCase() === 'g' ? generatedToken(prefix) : action.trim();
      setToken(envFile, name, next);
      return;
    }
    return;
  }

  const generated = generatedToken(prefix);
  if (!prompts) {
    setToken(envFile, name, generated);
    return;
  }
  const answer = await prompts.question(`${name} is not configured. Press Enter to generate ${maskSecret(generated)}, or type your own value: `);
  setToken(envFile, name, answer.trim() || generated);
}

function loadEnvFile(path: string): EnvFile {
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/) : [];
  const values = new Map<string, string>();
  for (const line of lines) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (!match) continue;
    values.set(match[1], unquoteEnv(match[2].trim()));
  }
  return { path, values, lines };
}

function applyEnvFile(envFile: EnvFile): void {
  for (const [key, value] of envFile.values) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function setToken(envFile: EnvFile, name: string, value: string): void {
  process.env[name] = value;
  envFile.values.set(name, value);
  upsertEnvLine(envFile, name, value);
  writeFileSync(envFile.path, envFile.lines.join('\n').replace(/\n*$/, '\n'));
  console.log(`${name} saved to ${envFile.path} as ${maskSecret(value)}`);
}

function upsertEnvLine(envFile: EnvFile, name: string, value: string): void {
  const line = `${name}=${quoteEnv(value)}`;
  const index = envFile.lines.findIndex((item) => item.match(new RegExp(`^\\s*${name}=`)));
  if (index >= 0) envFile.lines[index] = line;
  else envFile.lines.push(line);
}

function isPlaceholder(value: string): boolean {
  const trimmed = value.trim();
  return !trimmed || trimmed.startsWith('replace-with-') || trimmed.startsWith('change-me-');
}

function generatedToken(prefix: string): string {
  return `${prefix}-${randomBytes(24).toString('base64url')}`;
}

function maskSecret(value: string): string {
  if (value.length <= 10) return `${value.slice(0, 3)}...`;
  return `${value.slice(0, 5)}...${value.slice(-4)}`;
}

function unquoteEnv(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function quoteEnv(value: string): string {
  return /^[A-Za-z0-9._~:/,+-]+$/.test(value) ? value : JSON.stringify(value);
}
