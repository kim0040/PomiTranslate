import { invoke } from '@tauri-apps/api/core';
import type { Locale } from './i18n/locale';

export type BackendResponse<T> = {
  v: number;
  id: string;
  type: 'response.ok' | 'response.error';
  payload?: T;
  error?: { code?: string; message?: string; messageKey?: string; details?: unknown };
};

export type Settings = {
  provider: string;
  model: string;
  base_url: string;
  wire_format: string;
  target_language: string;
  style_preset: string;
  style_prompt?: string;
  custom_system_prompt?: string;
  temperature?: number;
  batch_size?: number;
  request_timeout?: number;
  rpm_limit?: number;
  tpm_limit?: number;
  max_batch_retries?: number;
  resource_pack_enabled?: boolean;
  ui_language?: Locale;
  last_world_dir: string;
};

export type ScanResult = {
  status: string;
  candidateCount: number;
  providerRequests: number;
  fingerprint: string;
  scanPlanId: string;
  dryRun: boolean;
  writeBlockers?: string[];
  errors?: { scope?: string; message?: string }[];
  warnings?: BackendWarning[];
  requestEstimate?: number;
  candidates?: { id: string; source: string; kind?: string; kinds?: Record<string, number>; location?: string; locations?: unknown[]; occurrences?: number }[];
};

export type BackendWarning = { code: string; file?: string; count?: number; message?: string };

export type TranslationStats = { unique: number; translated: number; failed: number; kept_original: number; unchanged: number };

export type TranslationResult = {
  status: string;
  candidateCount: number;
  changedFileCount: number;
  providerRequests?: number;
  backupSetId?: string;
  errors?: { scope?: string; code?: string; message?: string }[];
  warnings?: BackendWarning[];
  translation?: Partial<TranslationStats>;
  translationFailures?: { source: string; reason: string }[];
  keptOriginalSamples?: string[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number; cost_reported?: boolean };
};

export type BackupSummary = {
  backupSetId: string;
  createdAt: string;
  fileCount: number;
  verified: boolean;
};

export type RecentWorld = {
  path: string;
  name: string;
  lastOpened: number;
  available: boolean;
};

export type WorldInspection = {
  validJavaWorld: boolean;
  kind: 'java_world' | 'server_root' | 'missing' | 'unknown';
  childWorlds?: string[];
  regionDirs?: string[];
  resourcePacks?: string[];
  dataVersions?: { world: string; dataVersion: number | null }[];
  writeBlockers: string[];
};

let serial = 0;

export async function callBackend<T>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
  serial += 1;
  const id = `ui-${Date.now()}-${serial}`;
  const response = await invoke<BackendResponse<T>>('sidecar_request', {
    request: { v: 1, id, type, payload }
  });
  if (response.id !== id) throw new Error('번역 코어가 요청과 다른 응답을 보냈습니다.');
  if (response.type === 'response.error') {
    throw new Error(response.error?.message || response.error?.code || '번역 코어 오류');
  }
  if (response.type !== 'response.ok' || !response.payload) {
    throw new Error('번역 코어 응답이 완전하지 않습니다.');
  }
  return response.payload;
}

export async function cancelBackend(): Promise<boolean> {
  return invoke<boolean>('cancel_active');
}

export async function credentialStored(provider: string): Promise<boolean> {
  return invoke<boolean>('credential_status', { provider });
}
