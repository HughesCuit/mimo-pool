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
  exportBackup(): Promise<BackupSnapshot>;
  importBackup(snapshot: BackupSnapshot): Promise<BackupImportResult>;
  close?(): void;
};
