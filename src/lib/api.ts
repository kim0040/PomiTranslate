import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export type CredentialMode = 'local' | 'session' | 'keychain';
export type CredentialStatus = { mode: CredentialMode; stored: boolean };

export type Provider = 'openai' | 'gemini' | 'anthropic' | 'openrouter' | 'comet' | 'custom';
export type Locale = 'ko' | 'en' | 'ja';

export type ScanFlag = 'translate_signs' | 'translate_books' | 'translate_custom_names' | 'translate_item_names' |
  'translate_lore' | 'translate_titles' | 'translate_filtered_titles' | 'translate_command_output' |
  'translate_text_displays' | 'skip_command_like_text';
export type ScanOptions = Record<ScanFlag, boolean> & {
  region_dirs: string[];
  skip_patterns: string[];
  component_translate_key_prefixes: string[];
};
export type ResourcePackOptions = { source_lang_files: string[]; target_lang_file: string; skip_if_target_exists: boolean };
export type GlossaryMode = 'translate' | 'keep';
export type GlossaryEntry = { source: string; target: string; mode: GlossaryMode; note: string; caseSensitive: boolean };
export type GlossaryScope = 'global' | 'world';
export type GlossaryPayload = { global: GlossaryEntry[]; world: GlossaryEntry[]; effective: GlossaryEntry[] };
export type CustomPrice = { input: number; output: number; updatedAt?: string };

export type Settings = {
  provider: Provider | string;
  model: string;
  base_url: string;
  wire_format: string;
  openrouter_reasoning?: string;
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
  max_file_write_retries?: number;
  continue_on_file_error?: boolean;
  /** Stop after translating so the result can be read and corrected before anything is written. */
  review_before_apply?: boolean;
  /** Spending cap in USD; 0 means no cap. */
  max_cost_usd?: number;
  glossary?: GlossaryEntry[];
  custom_prices?: Record<string, CustomPrice>;
  source_overrides?: Record<string, string>;
  concurrency?: number;
  resource_pack_enabled?: boolean;
  resource_pack_options?: ResourcePackOptions;
  external_resource_pack_paths?: string[];
  skip_target_language_text?: boolean;
  scan_options?: ScanOptions;
  ui_language?: Locale;
  last_world_dir: string;
};

export type Notices = { firstLaunch: string; about: string; backupWarning: string; apiWarning: string };

export type RecentWorld = { path: string; name: string; lastOpened: number; available: boolean };

/** A world found in a launcher's saves folder. `icon` is the world's own icon.png as a data URL. */
export type DiscoveredWorld = {
  path: string; folder: string; name: string; lastPlayed: number;
  dataVersion?: number | null; versionName?: string | null; icon?: string | null; source: string;
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

export type BackupSummary = {
  externalTargets?: string[];
  backupSetId: string;
  createdAt: string;
  fileCount: number;
  verified: boolean;
  kind?: 'translation' | 'recovery';
  sizeBytes?: number;
  inWorldFolder?: boolean;
};

export type CandidateLocation = {
  kind?: string;
  holder?: string;
  dimension?: string;
  pos?: [number, number, number] | null;
  detail?: string;
  chunk?: [number, number];
  file?: string;
};

export type Candidate = {
  id: string;
  source: string;
  kind: string;
  kinds?: Record<string, number>;
  occurrences: number;
  locations?: CandidateLocation[];
  location?: string;
};

export type CoverageItem = { id: string; scanned: boolean; present?: boolean; count?: number; scopeOption?: boolean };

export type Estimate = {
  candidateCount: number;
  requests: number;
  sourceChars: number;
  inputTokens: number;
  outputTokens: number;
  price: { input: number; output: number; perMillionInput: number; perMillionOutput: number; source?: 'catalog' | 'user' } | null;
  priceSource?: 'catalog' | 'user' | null;
  cost: { low: number; high: number } | null;
  /** True when the high end already includes an allowance for reasoning tokens. */
  reasoningIncluded?: boolean;
};

export type BackendWarning = { code: string; file?: string; count?: number; message?: string; compression?: number[] };

export type ScanResult = {
  status: string;
  candidateCount: number;
  occurrenceCount?: number;
  kinds?: Record<string, number>;
  providerRequests: number;
  fingerprint: string;
  scanPlanId: string;
  dryRun: boolean;
  writeBlockers?: string[];
  errors?: { scope?: string; message?: string }[];
  warnings?: BackendWarning[];
  requestEstimate?: number;
  estimate?: Estimate;
  coverage?: CoverageItem[];
  candidates?: Candidate[];
  lastScan?: LastScan | null;
};

export type CandidatePage = {
  candidates: Candidate[];
  offset: number;
  total: number;
  hasMore: boolean;
  kinds: Record<string, number>;
};

export type CandidateQuery = {
  scanPlanId: string;
  offset: number;
  limit: number;
  query?: string;
  kind?: string;
  state?: 'all' | 'included' | 'excluded' | 'manual';
  sort?: 'order' | 'source' | 'count' | 'kind';
  excludedCandidateIds?: string[];
  overrideCandidateIds?: string[];
};

export type TranslationStats = { unique: number; translated: number; failed: number; kept_original: number; unchanged: number };

export type FailureCode =
  | 'timeout' | 'auth' | 'rate_limit' | 'quota' | 'invalid_response' | 'content_filter' | 'network' | 'provider_error' | 'unknown';

export type TranslationFailure = { source: string; reason: FailureCode | string; detail?: string };

export type TranslationUsage = { prompt_tokens?: number; completion_tokens?: number; cost?: number; cost_reported?: boolean };

export type TranslationResult = {
  status: 'awaiting_review' | 'completed' | 'partial' | 'needs_retry' | 'failed' | 'cancelled' | 'budget_stopped' | 'locked' | 'invalidated' | 'unsupported' | string;
  candidateCount: number;
  changedFileCount: number;
  providerRequests?: number;
  glossaryMismatchCount?: number;
  glossaryMismatches?: { source: string; reason: 'glossary_mismatch' }[];
  priceSource?: 'catalog' | 'user' | null;
  backupSetId?: string;
  recoverySetId?: string;
  errors?: { scope?: string; code?: string; message?: string; file?: string }[];
  warnings?: BackendWarning[];
  translation?: Partial<TranslationStats>;
  translationFailures?: TranslationFailure[];
  translationSamples?: { source: string; translated: string }[];
  keptOriginalSamples?: string[];
  usage?: TranslationUsage;
};

export type TranslationState = 'all' | 'translated' | 'failed' | 'kept' | 'edited' | 'glossary_mismatch';

export type TranslationRow = {
  id: string;
  source: string;
  translated: string;
  status: Exclude<TranslationState, 'all'>;
  glossaryStale?: boolean;
  kind: string;
  occurrences: number;
  /** The unedited AI answer, empty when there is none. Used to revert an edit. */
  ai: string;
  reason?: FailureCode | string;
  detail?: string;
};

export type TranslationCounts = Record<TranslationState, number>;

export type TranslationPageMeta = {
  status: string;
  /** True once the job has been written to the world: only `translate.reapply` may write it again. */
  applied: boolean;
  backupSetId: string;
  failedCount: number;
  usage: TranslationUsage;
  retryEstimate: Estimate | null;
  glossaryActive?: boolean;
  glossaryStaleCount?: number;
  glossaryRefreshEstimate?: Estimate | null;
  glossaryRefreshed?: boolean;
};

export type TranslationPage = {
  rows: TranslationRow[];
  offset: number;
  total: number;
  hasMore: boolean;
  counts: TranslationCounts;
  meta: TranslationPageMeta;
};

export type ResumeStatus = {
  available: boolean;
  scanPlanId?: string;
  fingerprint?: string;
  candidateCount?: number;
  occurrenceCount?: number;
  kinds?: Record<string, number>;
  coverage?: CoverageItem[];
  candidates?: Candidate[];
  excludedCandidateIds?: string[];
  candidateOverrides?: Record<string, string>;
  savedAt?: number;
  status?: string;
  translatedCount?: number;
  reason?: string;
  backupSetId?: string;
  lastJob?: LastJob | null;
  lastScan?: LastScan | null;
};

export type LastScan = { at: number; candidateCount: number };

export type LastJob = {
  world: string;
  at: number;
  status: 'completed' | 'partial' | 'needs_retry' | 'failed' | 'cancelled' | string;
  translated: number;
  failed: number;
  changedFiles: number;
  candidateCount: number;
};

/** App state kept with the settings file (not in the web view's storage, which cleaners can clear). */
export type AppPrefs = {
  theme: 'system' | 'light' | 'dark';
  notice_accepted: boolean;
  tutorial_seen: boolean;
  /** The setup wizard was finished or put off, so it does not open again by itself. */
  setup_dismissed: boolean;
  update_auto_check: boolean;
  update_last_check: number;
  update_skipped_version: string;
  notify_on_finish: boolean;
};

export type BootstrapPayload = {
  notices: Notices;
  settings: Settings & { app_prefs?: Partial<AppPrefs> };
  prefs?: AppPrefs;
  apiKeyStored: boolean;
  credentialMode?: CredentialMode;
  worlds: RecentWorld[];
  worldInspection: WorldInspection | null;
  backups: BackupSummary[];
  resume: ResumeStatus;
  lastJob?: LastJob | null;
  lastScan?: LastScan | null;
};

export type ProviderUsage = {
  provider: 'openrouter'; checkedAt: string; usage: number;
  byokUsage: number | null; limit: number | null; limitRemaining: number | null;
};

export type ModelInfo = {
  supported_parameters?: string[];
  reasoning?: { mandatory?: boolean; default_enabled?: boolean; default_effort?: string; supported_efforts?: string[] | null };
  id: string;
  display_name?: string;
  pricing_prompt?: string | null;
  pricing_completion?: string | null;
  context_length?: number;
  /** False for models made for something other than translating text (image, audio, embeddings...). */
  suitable?: boolean;
};

export type ProgressEvent = {
  event: string;
  phase?: 'collect' | 'translate' | 'write';
  index?: number;
  total?: number;
  total_files?: number;
  completed?: number;
  failed?: number;
  batch?: number;
  batches?: number;
  requests?: number;
  requests_estimate?: number;
  attempt?: number;
  max_attempts?: number;
  code?: string;
  status?: string | number;
  message?: string;
  file?: string;
  candidate_text_count?: number;
  /** `translation_sample` events carry one source → translation pair. */
  source?: string;
  translated?: string;
};

export class BackendError extends Error {
  code: string;
  details?: unknown;
  constructor(message: string, code = '', details?: unknown) {
    super(message);
    this.name = 'BackendError';
    this.code = code;
    this.details = details;
  }
}

type BackendResponse<T> = {
  v: number;
  id: string;
  type: 'response.ok' | 'response.error';
  payload?: T;
  error?: { code?: string; message?: string; details?: unknown };
};

let serial = 0;
// The Rust shell owns one sidecar process at a time. Keep short read requests (candidate paging,
// estimates, backup refreshes) in the same queue as long operations so a fast UI interaction
// cannot race the cleanup of the preceding sidecar process.
let backendQueue: Promise<void> = Promise.resolve();

export function callBackend<T>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
  const run = async (): Promise<T> => {
    serial += 1;
    const id = `ui-${Date.now()}-${serial}`;
    let response: BackendResponse<T>;
    try {
      response = await invoke<BackendResponse<T>>('sidecar_request', { request: { v: 1, id, type, payload } });
    } catch (cause) {
      // Rust reports transport and shell failures as text. The queue prevents normal UI requests
      // from reaching its single-process BUSY guard.
      const text = cause instanceof Error ? cause.message : String(cause);
      const code = /^[A-Z][A-Z0-9_]+$/.test(text)
        ? text : /still running/i.test(text) ? 'BUSY' : 'TRANSPORT';
      throw new BackendError(text, code);
    }
    if (response.id !== id) throw new BackendError('The translation core answered a different request.', 'TRANSPORT');
    if (response.type === 'response.error') {
      throw new BackendError(response.error?.message || response.error?.code || 'Translation core error', response.error?.code || '', response.error?.details);
    }
    if (response.type !== 'response.ok' || !response.payload) {
      throw new BackendError('The translation core response was incomplete.', 'TRANSPORT');
    }
    return response.payload;
  };

  const result = backendQueue.then(run);
  backendQueue = result.then(() => undefined, () => undefined);
  return result;
}

export async function getGlossary(world?: string): Promise<GlossaryPayload> {
  return callBackend<GlossaryPayload>('glossary.get', world ? { world } : {});
}

export async function setGlossary(scope: GlossaryScope, entries: GlossaryEntry[], world?: string): Promise<{ scope: GlossaryScope; entries: GlossaryEntry[]; count: number }> {
  return callBackend<{ scope: GlossaryScope; entries: GlossaryEntry[]; count: number }>('glossary.set', { scope, entries, ...(world ? { world } : {}) });
}

export async function cancelBackend(): Promise<boolean> {
  return invoke<boolean>('cancel_active');
}

export async function credentialStatus(provider: string): Promise<CredentialStatus> {
  return invoke<CredentialStatus>('credential_status', { provider });
}

export async function importCredential(provider: string): Promise<CredentialStatus> {
  return invoke<CredentialStatus>('credential_import', { provider });
}

export async function operationActive(): Promise<boolean> {
  return invoke<boolean>('operation_active');
}

type Unsubscribe = () => void;

/** Progress lines from a running scan or translation. */
export async function onProgress(handler: (event: ProgressEvent) => void): Promise<Unsubscribe> {
  return listen<{ payload?: ProgressEvent }>('pomi-progress', ({ payload }) => {
    if (payload?.payload) handler(payload.payload);
  });
}

/** Sent by the shell when the window's close button is pressed during an operation. */
export async function onCloseBlocked(handler: () => void): Promise<Unsubscribe> {
  return listen('pomi-close-blocked', () => handler());
}

export async function onZoomFailed(handler: () => void): Promise<Unsubscribe> {
  return listen('pomi-zoom-failed', () => handler());
}
