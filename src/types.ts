export type Protocol = 'openai' | 'anthropic';
export type KeyStatus = 'active' | 'disabled' | 'exhausted';

export type ServiceGroup = {
  code: string;
  name: string;
  sortOrder: number;
  enabled: boolean;
  openaiBaseUrl: string;
  anthropicBaseUrl: string;
  createdAt: string;
  updatedAt: string;
};

export type ApiKeyRecord = {
  id: number;
  groupCode: string;
  accountId: number | null;
  apiKey: string;
  maskedKey: string;
  sortOrder: number;
  status: KeyStatus;
  exhaustedReason: string | null;
  lastError: string | null;
  requestCount: number;
  successCount: number;
  failureCount: number;
  createdAt: string;
  updatedAt: string;
};

export type AccountRecord = {
  id: number;
  email: string | null;
  userId: string | null;
  cookieHeader: string | null;
  maskedCookie: string | null;
  loginStatus: 'none' | 'logged_in' | 'needs_login' | 'login_running' | 'login_failed';
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AccountUsageRecord = {
  accountId: number;
  monthUsage: unknown | null;
  usage: unknown | null;
  refreshedAt: string | null;
  lastError: string | null;
  updatedAt: string;
};

export type AccountSummary = Omit<AccountRecord, 'cookieHeader'> & {
  keyCount: number;
  usage: AccountUsageRecord | null;
};

export type RouteTarget = {
  groupCode: string;
  groupName: string;
  baseUrl: string;
  keyId: number;
  apiKey: string;
  maskedKey: string;
};

export type BackupSnapshot = {
  version: 1;
  exportedAt: string;
  serviceGroups: ServiceGroup[];
  accounts?: Array<Omit<AccountRecord, 'cookieHeader' | 'maskedCookie' | 'loginStatus' | 'lastError'> & { maskedCookie?: null }>;
  apiKeys: ApiKeyRecord[];
};

export type BackupImportResult = {
  groupsUpdated: number;
  keysCreated: number;
  keysUpdated: number;
};

export type Store = {
  listServiceGroups(): Promise<ServiceGroup[]>;
  updateServiceGroup(code: string, patch: Partial<Pick<ServiceGroup, 'sortOrder' | 'enabled' | 'openaiBaseUrl' | 'anthropicBaseUrl'>>): Promise<ServiceGroup>;
  listKeys(): Promise<ApiKeyRecord[]>;
  listActiveKeysForRouting(): Promise<Array<ApiKeyRecord & { groupName: string; groupSortOrder: number; groupEnabled: boolean; openaiBaseUrl: string; anthropicBaseUrl: string }>>;
  getKey(id: number): Promise<ApiKeyRecord>;
  importKeys(groupCode: string, keys: string[]): Promise<ApiKeyRecord[]>;
  setKeyStatus(id: number, status: KeyStatus): Promise<ApiKeyRecord>;
  markKeyExhausted(id: number, reason: string): Promise<ApiKeyRecord>;
  recordKeySuccess(id: number): Promise<void>;
  recordKeyFailure(id: number, error: string): Promise<void>;
  resetKey(id: number): Promise<ApiKeyRecord>;
  deleteKey(id: number): Promise<void>;
  listAccounts(): Promise<AccountSummary[]>;
  getAccount(id: number): Promise<AccountRecord>;
  createAccount(input: { email?: string | null; userId?: string | null }): Promise<AccountRecord>;
  updateAccount(id: number, input: { email?: string | null; userId?: string | null }): Promise<AccountRecord>;
  deleteAccount(id: number): Promise<void>;
  setKeyAccount(keyId: number, accountId: number | null): Promise<ApiKeyRecord>;
  saveAccountCookie(id: number, input: { cookieHeader: string; maskedCookie: string; userId?: string | null }): Promise<AccountRecord>;
  clearAccountCookie(id: number): Promise<AccountRecord>;
  setAccountLoginState(id: number, status: AccountRecord['loginStatus'], error?: string | null): Promise<AccountRecord>;
  saveAccountUsage(id: number, usage: { monthUsage: unknown; usage: unknown; refreshedAt: string; lastError?: string | null }): Promise<AccountUsageRecord>;
  setAccountUsageError(id: number, error: string): Promise<AccountUsageRecord>;
  exportBackup(): Promise<BackupSnapshot>;
  importBackup(snapshot: BackupSnapshot): Promise<BackupImportResult>;
  close?(): void;
};
