import { nowIso } from './routing.ts';
import type { AccountRecord, AccountSummary, Store } from './types.ts';

type LoginStatus = {
  accountId: number;
  state: 'idle' | 'running' | 'success' | 'failed';
  message: string;
  startedAt?: string;
  finishedAt?: string;
};

const loginJobs = new Map<number, LoginStatus>();

export function usageLoginUrl(): string {
  return process.env.USAGE_LOGIN_URL ?? 'https://platform.xiaomimimo.com/console/plan-manage';
}

export function usageApiUrl(): string {
  return process.env.USAGE_API_URL ?? 'https://platform.xiaomimimo.com/api/v1/tokenPlan/usage';
}

export function maskCookieHeader(cookieHeader: string): string {
  return cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const index = part.indexOf('=');
      if (index <= 0) return part.slice(0, 12);
      const name = part.slice(0, index);
      const value = part.slice(index + 1);
      if (value.length <= 8) return `${name}=***`;
      return `${name}=${value.slice(0, 4)}...${value.slice(-4)}`;
    })
    .join('; ');
}

export function userIdFromCookie(cookieHeader: string): string | null {
  const match = cookieHeader.match(/(?:^|;\s*)userId=([^;]+)/);
  return match ? decodeURIComponent(match[1].replace(/^"|"$/g, '')) : null;
}

export async function saveManualCookie(store: Store, accountId: number, cookieHeader: string): Promise<AccountRecord> {
  const normalized = normalizeCookieHeader(cookieHeader);
  if (!normalized) throw Object.assign(new Error('Cookie header is empty'), { statusCode: 400 });
  return store.saveAccountCookie(accountId, {
    cookieHeader: normalized,
    maskedCookie: maskCookieHeader(normalized),
    userId: userIdFromCookie(normalized)
  });
}

export async function refreshAccountUsage(store: Store, accountId: number, fetchImpl: typeof fetch = fetch) {
  const account = await store.getAccount(accountId);
  if (!account.cookieHeader) {
    const message = 'Account has no saved Mimo cookie';
    await store.setAccountUsageError(accountId, message);
    throw Object.assign(new Error(message), { statusCode: 400 });
  }
  try {
    const response = await fetchImpl(usageApiUrl(), {
      headers: {
        accept: 'application/json',
        cookie: account.cookieHeader,
        referer: usageLoginUrl()
      }
    });
    const text = await response.text();
    if (response.status === 401 || response.status === 403) {
      await store.setAccountLoginState(accountId, 'needs_login', `${response.status} ${text.slice(0, 200)}`);
    }
    if (!response.ok) {
      throw new Error(`${response.status} ${text.slice(0, 500)}`);
    }
    const parsed = JSON.parse(text) as { code?: unknown; message?: unknown; data?: { monthUsage?: unknown; usage?: unknown } };
    if (parsed.code !== 0 || !parsed.data) {
      throw new Error(`Usage API returned code=${String(parsed.code)} message=${String(parsed.message ?? '')}`);
    }
    await store.setAccountLoginState(accountId, 'logged_in', null);
    return store.saveAccountUsage(accountId, {
      monthUsage: parsed.data.monthUsage ?? null,
      usage: parsed.data.usage ?? null,
      refreshedAt: nowIso()
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await store.setAccountUsageError(accountId, message);
    throw error;
  }
}

export async function refreshAllAccountUsage(store: Store): Promise<{ refreshed: number; failed: number }> {
  const accounts = await store.listAccounts();
  let refreshed = 0;
  let failed = 0;
  for (const account of accounts) {
    if (!account.maskedCookie) continue;
    try {
      await refreshAccountUsage(store, account.id);
      refreshed += 1;
    } catch {
      failed += 1;
    }
  }
  return { refreshed, failed };
}

export function startUsageScheduler(store: Store): NodeJS.Timeout | null {
  const intervalMs = Number(process.env.USAGE_REFRESH_INTERVAL_MS ?? 3600000);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return null;
  const timer = setInterval(() => {
    void refreshAllAccountUsage(store).catch(() => undefined);
  }, intervalMs);
  timer.unref?.();
  return timer;
}

export async function startAccountLogin(store: Store, accountId: number): Promise<LoginStatus> {
  const existing = loginJobs.get(accountId);
  if (existing?.state === 'running') return existing;
  await store.setAccountLoginState(accountId, 'login_running', null);
  const status: LoginStatus = {
    accountId,
    state: 'running',
    message: 'Waiting for Mimo login',
    startedAt: nowIso()
  };
  loginJobs.set(accountId, status);
  void runLoginCapture(store, accountId).catch(() => undefined);
  return status;
}

export async function getAccountLoginStatus(store: Store, accountId: number): Promise<LoginStatus> {
  await store.getAccount(accountId);
  return loginJobs.get(accountId) ?? { accountId, state: 'idle', message: 'No login job is running' };
}

async function runLoginCapture(store: Store, accountId: number): Promise<void> {
  try {
    const cookieHeader = await captureCookieWithPlaywright();
    await store.saveAccountCookie(accountId, {
      cookieHeader,
      maskedCookie: maskCookieHeader(cookieHeader),
      userId: userIdFromCookie(cookieHeader)
    });
    loginJobs.set(accountId, {
      accountId,
      state: 'success',
      message: 'Cookie captured',
      finishedAt: nowIso()
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await store.setAccountLoginState(accountId, 'login_failed', message);
    loginJobs.set(accountId, {
      accountId,
      state: 'failed',
      message,
      finishedAt: nowIso()
    });
  }
}

async function captureCookieWithPlaywright(): Promise<string> {
  let playwright: typeof import('playwright');
  try {
    playwright = await import('playwright');
  } catch {
    throw new Error('Playwright is not installed. Run npm install and npm run install:browsers.');
  }
  const mode = process.env.USAGE_BROWSER_MODE ?? 'auto';
  const headlessCandidates = mode === 'headed' ? [false] : mode === 'headless' ? [true] : [false, true];
  let lastError: unknown;
  for (const headless of headlessCandidates) {
    try {
      const browser = await playwright.chromium.launch({ headless });
      try {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(usageLoginUrl(), { waitUntil: 'domcontentloaded' });
        const deadline = Date.now() + Number(process.env.USAGE_LOGIN_TIMEOUT_MS ?? 300000);
        while (Date.now() < deadline) {
          const cookies = await context.cookies('https://platform.xiaomimimo.com');
          const cookieHeader = cookiesToHeader(cookies);
          if (cookieHeader.includes('api-platform_serviceToken=') && cookieHeader.includes('userId=')) {
            return cookieHeader;
          }
          await page.waitForTimeout(1000);
        }
        throw new Error('Timed out waiting for Mimo login cookie');
      } finally {
        await browser.close();
      }
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function cookiesToHeader(cookies: Array<{ name: string; value: string }>): string {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

function normalizeCookieHeader(cookieHeader: string): string {
  return cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .join('; ');
}

export function publicAccounts(accounts: AccountSummary[]) {
  return accounts.map((account) => ({
    ...account,
    hasCookie: Boolean(account.maskedCookie)
  }));
}
