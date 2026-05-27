import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { maskApiKey, nowIso } from './routing.ts';
import type { AccountRecord, AccountSummary, AccountUsageRecord, ApiKeyRecord, BackupImportResult, BackupSnapshot, KeyStatus, ServiceGroup, Store } from './types.ts';

const defaultGroups = [
  {
    code: 'CN',
    name: '中国集群',
    sortOrder: 10,
    openaiBaseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
    anthropicBaseUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic'
  },
  {
    code: 'SGP',
    name: '新加坡集群',
    sortOrder: 20,
    openaiBaseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1',
    anthropicBaseUrl: 'https://token-plan-sgp.xiaomimimo.com/anthropic'
  },
  {
    code: 'AMS',
    name: '欧洲集群',
    sortOrder: 30,
    openaiBaseUrl: 'https://token-plan-ams.xiaomimimo.com/v1',
    anthropicBaseUrl: 'https://token-plan-ams.xiaomimimo.com/anthropic'
  }
] as const;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeKeyList(keys: string[]): string[] {
  return [...new Set(keys.map((key) => key.trim()).filter(Boolean))];
}

export class MemoryStore implements Store {
  private groups = new Map<string, ServiceGroup>();
  private keys = new Map<number, ApiKeyRecord>();
  private accounts = new Map<number, AccountRecord>();
  private usages = new Map<number, AccountUsageRecord>();
  private nextId = 1;
  private nextAccountId = 1;

  constructor() {
    const createdAt = nowIso();
    for (const group of defaultGroups) {
      this.groups.set(group.code, {
        ...group,
        enabled: true,
        createdAt,
        updatedAt: createdAt
      });
    }
  }

  async listServiceGroups(): Promise<ServiceGroup[]> {
    return [...this.groups.values()].sort((a, b) => a.sortOrder - b.sortOrder).map(clone);
  }

  async updateServiceGroup(code: string, patch: Partial<Pick<ServiceGroup, 'sortOrder' | 'enabled' | 'openaiBaseUrl' | 'anthropicBaseUrl'>>): Promise<ServiceGroup> {
    const group = this.requireGroup(code);
    const updated = { ...group, ...definedPatch(patch), updatedAt: nowIso() };
    this.groups.set(code, updated);
    return clone(updated);
  }

  async listKeys(): Promise<ApiKeyRecord[]> {
    return [...this.keys.values()].sort((a, b) => a.groupCode.localeCompare(b.groupCode) || a.sortOrder - b.sortOrder).map(clone);
  }

  async listActiveKeysForRouting() {
    const rows = [];
    for (const key of this.keys.values()) {
      const group = this.requireGroup(key.groupCode);
      rows.push({
        ...clone(key),
        groupName: group.name,
        groupSortOrder: group.sortOrder,
        groupEnabled: group.enabled,
        openaiBaseUrl: group.openaiBaseUrl,
        anthropicBaseUrl: group.anthropicBaseUrl
      });
    }
    return rows;
  }

  async getKey(id: number): Promise<ApiKeyRecord> {
    const key = this.keys.get(id);
    if (!key) throw new Error(`API key ${id} not found`);
    return clone(key);
  }

  async importKeys(groupCode: string, keys: string[]): Promise<ApiKeyRecord[]> {
    this.requireGroup(groupCode);
    const existing = [...this.keys.values()].filter((key) => key.groupCode === groupCode);
    let sortOrder = existing.reduce((max, key) => Math.max(max, key.sortOrder), 0);
    const existingValues = new Set(existing.map((key) => key.apiKey));
    const imported: ApiKeyRecord[] = [];
    for (const apiKey of normalizeKeyList(keys)) {
      if (existingValues.has(apiKey)) continue;
      sortOrder += 10;
      const createdAt = nowIso();
      const record: ApiKeyRecord = {
        id: this.nextId++,
        groupCode,
        accountId: null,
        apiKey,
        maskedKey: maskApiKey(apiKey),
        sortOrder,
        status: 'active',
        exhaustedReason: null,
        lastError: null,
        requestCount: 0,
        successCount: 0,
        failureCount: 0,
        createdAt,
        updatedAt: createdAt
      };
      this.keys.set(record.id, record);
      existingValues.add(apiKey);
      imported.push(clone(record));
    }
    return imported;
  }

  async setKeyStatus(id: number, status: KeyStatus): Promise<ApiKeyRecord> {
    const key = await this.getKey(id);
    const updated = {
      ...key,
      status,
      exhaustedReason: status === 'exhausted' ? key.exhaustedReason : null,
      updatedAt: nowIso()
    };
    this.keys.set(id, updated);
    return clone(updated);
  }

  async markKeyExhausted(id: number, reason: string): Promise<ApiKeyRecord> {
    const key = await this.getKey(id);
    const updated = { ...key, status: 'exhausted' as const, exhaustedReason: reason, lastError: reason, failureCount: key.failureCount + 1, updatedAt: nowIso() };
    this.keys.set(id, updated);
    return clone(updated);
  }

  async recordKeySuccess(id: number): Promise<void> {
    const key = await this.getKey(id);
    this.keys.set(id, { ...key, requestCount: key.requestCount + 1, successCount: key.successCount + 1, updatedAt: nowIso() });
  }

  async recordKeyFailure(id: number, error: string): Promise<void> {
    const key = await this.getKey(id);
    this.keys.set(id, { ...key, requestCount: key.requestCount + 1, failureCount: key.failureCount + 1, lastError: error, updatedAt: nowIso() });
  }

  async resetKey(id: number): Promise<ApiKeyRecord> {
    const key = await this.getKey(id);
    const updated = { ...key, status: 'active' as const, exhaustedReason: null, lastError: null, updatedAt: nowIso() };
    this.keys.set(id, updated);
    return clone(updated);
  }

  async deleteKey(id: number): Promise<void> {
    this.keys.delete(id);
  }

  async listAccounts(): Promise<AccountSummary[]> {
    return [...this.accounts.values()]
      .sort((a, b) => (a.email ?? '').localeCompare(b.email ?? '') || a.id - b.id)
      .map((account) => this.accountSummary(account));
  }

  async getAccount(id: number): Promise<AccountRecord> {
    const account = this.accounts.get(id);
    if (!account) throw new Error(`Account ${id} not found`);
    return clone(account);
  }

  async createAccount(input: { email?: string | null; userId?: string | null }): Promise<AccountRecord> {
    const createdAt = nowIso();
    const account: AccountRecord = {
      id: this.nextAccountId++,
      email: nullableString(input.email),
      userId: nullableString(input.userId),
      cookieHeader: null,
      maskedCookie: null,
      loginStatus: 'none',
      lastError: null,
      createdAt,
      updatedAt: createdAt
    };
    this.accounts.set(account.id, account);
    return clone(account);
  }

  async updateAccount(id: number, input: { email?: string | null; userId?: string | null }): Promise<AccountRecord> {
    const account = await this.getAccount(id);
    const updated = { ...account, ...definedPatch({ email: nullableString(input.email), userId: nullableString(input.userId) }), updatedAt: nowIso() };
    this.accounts.set(id, updated);
    return clone(updated);
  }

  async deleteAccount(id: number): Promise<void> {
    await this.getAccount(id);
    this.accounts.delete(id);
    this.usages.delete(id);
    for (const key of this.keys.values()) {
      if (key.accountId === id) this.keys.set(key.id, { ...key, accountId: null, updatedAt: nowIso() });
    }
  }

  async setKeyAccount(keyId: number, accountId: number | null): Promise<ApiKeyRecord> {
    const key = await this.getKey(keyId);
    if (accountId !== null) await this.getAccount(accountId);
    const updated = { ...key, accountId, updatedAt: nowIso() };
    this.keys.set(keyId, updated);
    return clone(updated);
  }

  async saveAccountCookie(id: number, input: { cookieHeader: string; maskedCookie: string; userId?: string | null }): Promise<AccountRecord> {
    const account = await this.getAccount(id);
    const updated: AccountRecord = {
      ...account,
      userId: nullableString(input.userId) ?? account.userId,
      cookieHeader: input.cookieHeader,
      maskedCookie: input.maskedCookie,
      loginStatus: 'logged_in',
      lastError: null,
      updatedAt: nowIso()
    };
    this.accounts.set(id, updated);
    return clone(updated);
  }

  async clearAccountCookie(id: number): Promise<AccountRecord> {
    const account = await this.getAccount(id);
    const updated: AccountRecord = { ...account, cookieHeader: null, maskedCookie: null, loginStatus: 'none', lastError: null, updatedAt: nowIso() };
    this.accounts.set(id, updated);
    return clone(updated);
  }

  async setAccountLoginState(id: number, status: AccountRecord['loginStatus'], error: string | null = null): Promise<AccountRecord> {
    const account = await this.getAccount(id);
    const updated: AccountRecord = { ...account, loginStatus: status, lastError: error, updatedAt: nowIso() };
    this.accounts.set(id, updated);
    return clone(updated);
  }

  async saveAccountUsage(id: number, usage: { monthUsage: unknown; usage: unknown; refreshedAt: string; lastError?: string | null }): Promise<AccountUsageRecord> {
    await this.getAccount(id);
    const record: AccountUsageRecord = {
      accountId: id,
      monthUsage: usage.monthUsage,
      usage: usage.usage,
      refreshedAt: usage.refreshedAt,
      lastError: usage.lastError ?? null,
      updatedAt: nowIso()
    };
    this.usages.set(id, clone(record));
    return clone(record);
  }

  async setAccountUsageError(id: number, error: string): Promise<AccountUsageRecord> {
    await this.getAccount(id);
    const previous = this.usages.get(id);
    const record: AccountUsageRecord = {
      accountId: id,
      monthUsage: previous?.monthUsage ?? null,
      usage: previous?.usage ?? null,
      refreshedAt: previous?.refreshedAt ?? null,
      lastError: error,
      updatedAt: nowIso()
    };
    this.usages.set(id, clone(record));
    return clone(record);
  }

  async exportBackup(): Promise<BackupSnapshot> {
    return {
      version: 1,
      exportedAt: nowIso(),
      serviceGroups: await this.listServiceGroups(),
      apiKeys: await this.listKeys(),
      accounts: [...this.accounts.values()].map(({ cookieHeader, maskedCookie, loginStatus, lastError, ...account }) => ({ ...clone(account), maskedCookie: null }))
    };
  }

  async importBackup(snapshot: BackupSnapshot): Promise<BackupImportResult> {
    validateBackup(snapshot);
    let groupsUpdated = 0;
    let keysCreated = 0;
    let keysUpdated = 0;

    for (const group of snapshot.serviceGroups) {
      const existing = this.groups.get(group.code);
      const updated: ServiceGroup = {
        ...group,
        createdAt: existing?.createdAt ?? group.createdAt ?? nowIso(),
        updatedAt: nowIso()
      };
      this.groups.set(group.code, clone(updated));
      groupsUpdated += 1;
    }

    for (const account of snapshot.accounts ?? []) {
      const id = Number(account.id);
      const createdAt = account.createdAt || nowIso();
      this.accounts.set(id, {
        id,
        email: nullableString(account.email),
        userId: nullableString(account.userId),
        cookieHeader: null,
        maskedCookie: null,
        loginStatus: 'none',
        lastError: null,
        createdAt,
        updatedAt: nowIso()
      });
      this.nextAccountId = Math.max(this.nextAccountId, id + 1);
    }

    for (const key of snapshot.apiKeys) {
      const existing = [...this.keys.values()].find((item) => item.apiKey === key.apiKey);
      const updated: ApiKeyRecord = {
        ...key,
        id: existing?.id ?? this.nextId++,
        accountId: key.accountId ?? null,
        maskedKey: maskApiKey(key.apiKey),
        createdAt: existing?.createdAt ?? key.createdAt ?? nowIso(),
        updatedAt: nowIso()
      };
      this.requireGroup(updated.groupCode);
      this.keys.set(updated.id, clone(updated));
      if (existing) keysUpdated += 1;
      else keysCreated += 1;
    }

    return { groupsUpdated, keysCreated, keysUpdated };
  }

  private accountSummary(account: AccountRecord): AccountSummary {
    const { cookieHeader, ...safe } = account;
    return {
      ...clone(safe),
      keyCount: [...this.keys.values()].filter((key) => key.accountId === account.id).length,
      usage: clone(this.usages.get(account.id) ?? null)
    };
  }

  private requireGroup(code: string): ServiceGroup {
    const group = this.groups.get(code);
    if (!group) throw new Error(`Service group ${code} not found`);
    return group;
  }
}

export function createMemoryStore(): Store {
  return new MemoryStore();
}

export class SqliteStore implements Store {
  private db: DatabaseSync;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  async listServiceGroups(): Promise<ServiceGroup[]> {
    return this.db.prepare('SELECT code, name, sort_order AS sortOrder, enabled, openai_base_url AS openaiBaseUrl, anthropic_base_url AS anthropicBaseUrl, created_at AS createdAt, updated_at AS updatedAt FROM service_groups ORDER BY sort_order ASC').all().map(rowToGroup);
  }

  async updateServiceGroup(code: string, patch: Partial<Pick<ServiceGroup, 'sortOrder' | 'enabled' | 'openaiBaseUrl' | 'anthropicBaseUrl'>>): Promise<ServiceGroup> {
    const current = await this.requireGroup(code);
    const updated = { ...current, ...definedPatch(patch), updatedAt: nowIso() };
    this.db.prepare('UPDATE service_groups SET sort_order = ?, enabled = ?, openai_base_url = ?, anthropic_base_url = ?, updated_at = ? WHERE code = ?')
      .run(updated.sortOrder, updated.enabled ? 1 : 0, updated.openaiBaseUrl, updated.anthropicBaseUrl, updated.updatedAt, code);
    return updated;
  }

  async listKeys(): Promise<ApiKeyRecord[]> {
    return this.db.prepare('SELECT id, group_code AS groupCode, account_id AS accountId, api_key AS apiKey, masked_key AS maskedKey, sort_order AS sortOrder, status, exhausted_reason AS exhaustedReason, last_error AS lastError, request_count AS requestCount, success_count AS successCount, failure_count AS failureCount, created_at AS createdAt, updated_at AS updatedAt FROM api_keys ORDER BY group_code ASC, sort_order ASC').all().map(rowToKey);
  }

  async listActiveKeysForRouting() {
    return this.db.prepare(`
      SELECT k.id, k.group_code AS groupCode, k.account_id AS accountId, k.api_key AS apiKey, k.masked_key AS maskedKey, k.sort_order AS sortOrder, k.status,
             k.exhausted_reason AS exhaustedReason, k.last_error AS lastError, k.request_count AS requestCount,
             k.success_count AS successCount, k.failure_count AS failureCount, k.created_at AS createdAt, k.updated_at AS updatedAt,
             g.name AS groupName, g.sort_order AS groupSortOrder, g.enabled AS groupEnabled,
             g.openai_base_url AS openaiBaseUrl, g.anthropic_base_url AS anthropicBaseUrl
        FROM api_keys k
        JOIN service_groups g ON g.code = k.group_code
       WHERE k.status = 'active' AND g.enabled = 1
       ORDER BY g.sort_order ASC, k.sort_order ASC, k.id ASC
    `).all().map((row) => ({ ...rowToKey(row), groupName: String(row.groupName), groupSortOrder: Number(row.groupSortOrder), groupEnabled: Boolean(row.groupEnabled), openaiBaseUrl: String(row.openaiBaseUrl), anthropicBaseUrl: String(row.anthropicBaseUrl) }));
  }

  async getKey(id: number): Promise<ApiKeyRecord> {
    const row = this.db.prepare('SELECT id, group_code AS groupCode, account_id AS accountId, api_key AS apiKey, masked_key AS maskedKey, sort_order AS sortOrder, status, exhausted_reason AS exhaustedReason, last_error AS lastError, request_count AS requestCount, success_count AS successCount, failure_count AS failureCount, created_at AS createdAt, updated_at AS updatedAt FROM api_keys WHERE id = ?').get(id);
    if (!row) throw new Error(`API key ${id} not found`);
    return rowToKey(row);
  }

  async importKeys(groupCode: string, keys: string[]): Promise<ApiKeyRecord[]> {
    await this.requireGroup(groupCode);
    const current = this.db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS maxOrder FROM api_keys WHERE group_code = ?').get(groupCode) as { maxOrder: number };
    const existingRows = this.db.prepare('SELECT api_key AS apiKey FROM api_keys WHERE group_code = ?').all(groupCode) as Array<{ apiKey: string }>;
    const existing = new Set(existingRows.map((row) => row.apiKey));
    let sortOrder = Number(current.maxOrder);
    const imported: ApiKeyRecord[] = [];
    const insert = this.db.prepare('INSERT INTO api_keys (group_code, account_id, api_key, masked_key, sort_order, status, created_at, updated_at) VALUES (?, NULL, ?, ?, ?, ?, ?, ?)');
    for (const apiKey of normalizeKeyList(keys)) {
      if (existing.has(apiKey)) continue;
      sortOrder += 10;
      const createdAt = nowIso();
      const result = insert.run(groupCode, apiKey, maskApiKey(apiKey), sortOrder, 'active', createdAt, createdAt);
      imported.push(await this.getKey(Number(result.lastInsertRowid)));
      existing.add(apiKey);
    }
    return imported;
  }

  async setKeyStatus(id: number, status: KeyStatus): Promise<ApiKeyRecord> {
    this.db.prepare("UPDATE api_keys SET status = ?, exhausted_reason = CASE WHEN ? = 'exhausted' THEN exhausted_reason ELSE NULL END, updated_at = ? WHERE id = ?")
      .run(status, status, nowIso(), id);
    return this.getKey(id);
  }

  async markKeyExhausted(id: number, reason: string): Promise<ApiKeyRecord> {
    this.db.prepare("UPDATE api_keys SET status = 'exhausted', exhausted_reason = ?, last_error = ?, failure_count = failure_count + 1, updated_at = ? WHERE id = ?")
      .run(reason, reason, nowIso(), id);
    return this.getKey(id);
  }

  async recordKeySuccess(id: number): Promise<void> {
    this.db.prepare('UPDATE api_keys SET request_count = request_count + 1, success_count = success_count + 1, updated_at = ? WHERE id = ?').run(nowIso(), id);
  }

  async recordKeyFailure(id: number, error: string): Promise<void> {
    this.db.prepare('UPDATE api_keys SET request_count = request_count + 1, failure_count = failure_count + 1, last_error = ?, updated_at = ? WHERE id = ?').run(error, nowIso(), id);
  }

  async resetKey(id: number): Promise<ApiKeyRecord> {
    this.db.prepare("UPDATE api_keys SET status = 'active', exhausted_reason = NULL, last_error = NULL, updated_at = ? WHERE id = ?").run(nowIso(), id);
    return this.getKey(id);
  }

  async deleteKey(id: number): Promise<void> {
    this.db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
  }

  async listAccounts(): Promise<AccountSummary[]> {
    const accounts = this.db.prepare(`
      SELECT a.id, a.email, a.user_id AS userId, a.cookie_header AS cookieHeader, a.masked_cookie AS maskedCookie,
             a.login_status AS loginStatus, a.last_error AS lastError, a.created_at AS createdAt, a.updated_at AS updatedAt,
             COUNT(k.id) AS keyCount,
             u.month_usage AS monthUsageJson, u.usage AS usageJson, u.refreshed_at AS refreshedAt,
             u.last_error AS usageLastError, u.updated_at AS usageUpdatedAt
        FROM accounts a
        LEFT JOIN api_keys k ON k.account_id = a.id
        LEFT JOIN account_usage u ON u.account_id = a.id
       GROUP BY a.id
       ORDER BY COALESCE(a.email, ''), a.id
    `).all();
    return accounts.map(rowToAccountSummary);
  }

  async getAccount(id: number): Promise<AccountRecord> {
    const row = this.db.prepare('SELECT id, email, user_id AS userId, cookie_header AS cookieHeader, masked_cookie AS maskedCookie, login_status AS loginStatus, last_error AS lastError, created_at AS createdAt, updated_at AS updatedAt FROM accounts WHERE id = ?').get(id);
    if (!row) throw new Error(`Account ${id} not found`);
    return rowToAccount(row);
  }

  async createAccount(input: { email?: string | null; userId?: string | null }): Promise<AccountRecord> {
    const createdAt = nowIso();
    const result = this.db.prepare('INSERT INTO accounts (email, user_id, login_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(nullableString(input.email), nullableString(input.userId), 'none', createdAt, createdAt);
    return this.getAccount(Number(result.lastInsertRowid));
  }

  async updateAccount(id: number, input: { email?: string | null; userId?: string | null }): Promise<AccountRecord> {
    await this.getAccount(id);
    this.db.prepare('UPDATE accounts SET email = ?, user_id = ?, updated_at = ? WHERE id = ?')
      .run(nullableString(input.email), nullableString(input.userId), nowIso(), id);
    return this.getAccount(id);
  }

  async deleteAccount(id: number): Promise<void> {
    await this.getAccount(id);
    this.db.prepare('UPDATE api_keys SET account_id = NULL, updated_at = ? WHERE account_id = ?').run(nowIso(), id);
    this.db.prepare('DELETE FROM account_usage WHERE account_id = ?').run(id);
    this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
  }

  async setKeyAccount(keyId: number, accountId: number | null): Promise<ApiKeyRecord> {
    await this.getKey(keyId);
    if (accountId !== null) await this.getAccount(accountId);
    this.db.prepare('UPDATE api_keys SET account_id = ?, updated_at = ? WHERE id = ?').run(accountId, nowIso(), keyId);
    return this.getKey(keyId);
  }

  async saveAccountCookie(id: number, input: { cookieHeader: string; maskedCookie: string; userId?: string | null }): Promise<AccountRecord> {
    const current = await this.getAccount(id);
    this.db.prepare('UPDATE accounts SET cookie_header = ?, masked_cookie = ?, user_id = ?, login_status = ?, last_error = NULL, updated_at = ? WHERE id = ?')
      .run(input.cookieHeader, input.maskedCookie, nullableString(input.userId) ?? current.userId, 'logged_in', nowIso(), id);
    return this.getAccount(id);
  }

  async clearAccountCookie(id: number): Promise<AccountRecord> {
    await this.getAccount(id);
    this.db.prepare('UPDATE accounts SET cookie_header = NULL, masked_cookie = NULL, login_status = ?, last_error = NULL, updated_at = ? WHERE id = ?')
      .run('none', nowIso(), id);
    return this.getAccount(id);
  }

  async setAccountLoginState(id: number, status: AccountRecord['loginStatus'], error: string | null = null): Promise<AccountRecord> {
    await this.getAccount(id);
    this.db.prepare('UPDATE accounts SET login_status = ?, last_error = ?, updated_at = ? WHERE id = ?').run(status, error, nowIso(), id);
    return this.getAccount(id);
  }

  async saveAccountUsage(id: number, usage: { monthUsage: unknown; usage: unknown; refreshedAt: string; lastError?: string | null }): Promise<AccountUsageRecord> {
    await this.getAccount(id);
    const updatedAt = nowIso();
    this.db.prepare(`
      INSERT INTO account_usage (account_id, month_usage, usage, refreshed_at, last_error, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET
        month_usage = excluded.month_usage,
        usage = excluded.usage,
        refreshed_at = excluded.refreshed_at,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `).run(id, JSON.stringify(usage.monthUsage), JSON.stringify(usage.usage), usage.refreshedAt, usage.lastError ?? null, updatedAt);
    return this.requireAccountUsage(id);
  }

  async setAccountUsageError(id: number, error: string): Promise<AccountUsageRecord> {
    await this.getAccount(id);
    const existing = this.db.prepare('SELECT month_usage AS monthUsageJson, usage AS usageJson, refreshed_at AS refreshedAt FROM account_usage WHERE account_id = ?').get(id) as Record<string, unknown> | undefined;
    const updatedAt = nowIso();
    this.db.prepare(`
      INSERT INTO account_usage (account_id, month_usage, usage, refreshed_at, last_error, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `).run(id, textOrNull(existing?.monthUsageJson), textOrNull(existing?.usageJson), textOrNull(existing?.refreshedAt), error, updatedAt);
    return this.requireAccountUsage(id);
  }

  async exportBackup(): Promise<BackupSnapshot> {
    return {
      version: 1,
      exportedAt: nowIso(),
      serviceGroups: await this.listServiceGroups(),
      accounts: (await this.listAccounts()).map(({ keyCount, usage, loginStatus, lastError, maskedCookie, ...account }) => ({ ...account, maskedCookie: null })),
      apiKeys: await this.listKeys()
    };
  }

  async importBackup(snapshot: BackupSnapshot): Promise<BackupImportResult> {
    validateBackup(snapshot);
    let groupsUpdated = 0;
    let keysCreated = 0;
    let keysUpdated = 0;
    const upsertGroup = this.db.prepare(`
      INSERT INTO service_groups (code, name, sort_order, enabled, openai_base_url, anthropic_base_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(code) DO UPDATE SET
        name = excluded.name,
        sort_order = excluded.sort_order,
        enabled = excluded.enabled,
        openai_base_url = excluded.openai_base_url,
        anthropic_base_url = excluded.anthropic_base_url,
        updated_at = excluded.updated_at
    `);
    const upsertAccount = this.db.prepare(`
      INSERT INTO accounts (id, email, user_id, cookie_header, masked_cookie, login_status, last_error, created_at, updated_at)
      VALUES (?, ?, ?, NULL, NULL, 'none', NULL, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        email = excluded.email,
        user_id = excluded.user_id,
        updated_at = excluded.updated_at
    `);
    const findKey = this.db.prepare('SELECT id FROM api_keys WHERE api_key = ? ORDER BY id ASC LIMIT 1');
    const insertKey = this.db.prepare(`
      INSERT INTO api_keys (group_code, account_id, api_key, masked_key, sort_order, status, exhausted_reason, last_error, request_count, success_count, failure_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const updateKey = this.db.prepare(`
      UPDATE api_keys
         SET group_code = ?, account_id = ?, masked_key = ?, sort_order = ?, status = ?, exhausted_reason = ?, last_error = ?,
             request_count = ?, success_count = ?, failure_count = ?, updated_at = ?
       WHERE id = ?
    `);

    this.db.exec('BEGIN');
    try {
      for (const group of snapshot.serviceGroups) {
        upsertGroup.run(
          group.code,
          group.name,
          group.sortOrder,
          group.enabled ? 1 : 0,
          group.openaiBaseUrl,
          group.anthropicBaseUrl,
          group.createdAt || nowIso(),
          nowIso()
        );
        groupsUpdated += 1;
      }

      for (const account of snapshot.accounts ?? []) {
        upsertAccount.run(account.id, nullableString(account.email), nullableString(account.userId), account.createdAt || nowIso(), nowIso());
      }

      for (const key of snapshot.apiKeys) {
        const existing = findKey.get(key.apiKey) as { id: number } | undefined;
        if (existing) {
          updateKey.run(
            key.groupCode,
            key.accountId ?? null,
            maskApiKey(key.apiKey),
            key.sortOrder,
            key.status,
            key.exhaustedReason,
            key.lastError,
            key.requestCount,
            key.successCount,
            key.failureCount,
            nowIso(),
            existing.id
          );
          keysUpdated += 1;
        } else {
          insertKey.run(
            key.groupCode,
            key.accountId ?? null,
            key.apiKey,
            maskApiKey(key.apiKey),
            key.sortOrder,
            key.status,
            key.exhaustedReason,
            key.lastError,
            key.requestCount,
            key.successCount,
            key.failureCount,
            key.createdAt || nowIso(),
            nowIso()
          );
          keysCreated += 1;
        }
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    return { groupsUpdated, keysCreated, keysUpdated };
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS service_groups (
        code TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        openai_base_url TEXT NOT NULL,
        anthropic_base_url TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS api_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_code TEXT NOT NULL REFERENCES service_groups(code) ON DELETE CASCADE,
        account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
        api_key TEXT NOT NULL,
        masked_key TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'disabled', 'exhausted')),
        exhausted_reason TEXT,
        last_error TEXT,
        request_count INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(group_code, api_key)
      );

      CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT,
        user_id TEXT,
        cookie_header TEXT,
        masked_cookie TEXT,
        login_status TEXT NOT NULL DEFAULT 'none' CHECK(login_status IN ('none', 'logged_in', 'needs_login', 'login_running', 'login_failed')),
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS account_usage (
        account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
        month_usage TEXT,
        usage TEXT,
        refreshed_at TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );
    `);
    this.addColumnIfMissing('api_keys', 'account_id', 'INTEGER REFERENCES accounts(id) ON DELETE SET NULL');
    const insert = this.db.prepare('INSERT OR IGNORE INTO service_groups (code, name, sort_order, enabled, openai_base_url, anthropic_base_url, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?)');
    for (const group of defaultGroups) {
      const createdAt = nowIso();
      insert.run(group.code, group.name, group.sortOrder, group.openaiBaseUrl, group.anthropicBaseUrl, createdAt, createdAt);
    }
  }

  private async requireGroup(code: string): Promise<ServiceGroup> {
    const row = this.db.prepare('SELECT code, name, sort_order AS sortOrder, enabled, openai_base_url AS openaiBaseUrl, anthropic_base_url AS anthropicBaseUrl, created_at AS createdAt, updated_at AS updatedAt FROM service_groups WHERE code = ?').get(code);
    if (!row) throw new Error(`Service group ${code} not found`);
    return rowToGroup(row);
  }

  private requireAccountUsage(accountId: number): AccountUsageRecord {
    const row = this.db.prepare('SELECT account_id AS accountId, month_usage AS monthUsageJson, usage AS usageJson, refreshed_at AS refreshedAt, last_error AS lastError, updated_at AS updatedAt FROM account_usage WHERE account_id = ?').get(accountId);
    if (!row) throw new Error(`Usage for account ${accountId} not found`);
    return rowToUsage(row);
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
}

function rowToGroup(row: Record<string, unknown>): ServiceGroup {
  return {
    code: String(row.code),
    name: String(row.name),
    sortOrder: Number(row.sortOrder),
    enabled: Boolean(row.enabled),
    openaiBaseUrl: String(row.openaiBaseUrl),
    anthropicBaseUrl: String(row.anthropicBaseUrl),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt)
  };
}

function rowToKey(row: Record<string, unknown>): ApiKeyRecord {
  return {
    id: Number(row.id),
    groupCode: String(row.groupCode),
    accountId: row.accountId === null || row.accountId === undefined ? null : Number(row.accountId),
    apiKey: String(row.apiKey),
    maskedKey: String(row.maskedKey),
    sortOrder: Number(row.sortOrder),
    status: row.status as KeyStatus,
    exhaustedReason: row.exhaustedReason === null ? null : String(row.exhaustedReason),
    lastError: row.lastError === null ? null : String(row.lastError),
    requestCount: Number(row.requestCount),
    successCount: Number(row.successCount),
    failureCount: Number(row.failureCount),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt)
  };
}

function rowToAccount(row: Record<string, unknown>): AccountRecord {
  return {
    id: Number(row.id),
    email: row.email === null ? null : String(row.email),
    userId: row.userId === null ? null : String(row.userId),
    cookieHeader: row.cookieHeader === null ? null : String(row.cookieHeader),
    maskedCookie: row.maskedCookie === null ? null : String(row.maskedCookie),
    loginStatus: row.loginStatus as AccountRecord['loginStatus'],
    lastError: row.lastError === null ? null : String(row.lastError),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt)
  };
}

function rowToUsage(row: Record<string, unknown>): AccountUsageRecord {
  return {
    accountId: Number(row.accountId),
    monthUsage: parseJsonColumn(row.monthUsageJson),
    usage: parseJsonColumn(row.usageJson),
    refreshedAt: row.refreshedAt === null ? null : String(row.refreshedAt),
    lastError: row.lastError === null ? null : String(row.lastError),
    updatedAt: String(row.updatedAt)
  };
}

function rowToAccountSummary(row: Record<string, unknown>): AccountSummary {
  const account = rowToAccount(row);
  const { cookieHeader, ...safe } = account;
  const hasUsage = row.monthUsageJson !== null || row.usageJson !== null || row.refreshedAt !== null || row.usageLastError !== null;
  return {
    ...safe,
    keyCount: Number(row.keyCount),
    usage: hasUsage ? {
      accountId: account.id,
      monthUsage: parseJsonColumn(row.monthUsageJson),
      usage: parseJsonColumn(row.usageJson),
      refreshedAt: row.refreshedAt === null ? null : String(row.refreshedAt),
      lastError: row.usageLastError === null ? null : String(row.usageLastError),
      updatedAt: row.usageUpdatedAt === null ? nowIso() : String(row.usageUpdatedAt)
    } : null
  };
}

function parseJsonColumn(value: unknown): unknown | null {
  if (value === null || value === undefined) return null;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

function validateBackup(snapshot: BackupSnapshot): void {
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.serviceGroups) || !Array.isArray(snapshot.apiKeys)) {
    throw new Error('Invalid backup snapshot');
  }
  for (const group of snapshot.serviceGroups) {
    if (!group.code || !group.name || !group.openaiBaseUrl || !group.anthropicBaseUrl) {
      throw new Error('Invalid backup service group');
    }
  }
  for (const key of snapshot.apiKeys) {
    if (!key.groupCode || !key.apiKey || !['active', 'disabled', 'exhausted'].includes(key.status)) {
      throw new Error('Invalid backup API key');
    }
  }
}

export function createSqliteStore(filePath = process.env.DB_PATH ?? 'data/mimo-pool.sqlite'): Store {
  return new SqliteStore(filePath);
}

function definedPatch<T extends Record<string, unknown>>(patch: T): Partial<T> {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<T>;
}

function nullableString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function textOrNull(value: unknown): string | null {
  return value === undefined || value === null ? null : String(value);
}
