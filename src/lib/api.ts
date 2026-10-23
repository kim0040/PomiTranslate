import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export type CredentialMode = 'local' | 'session' | 'keychain';
export type CredentialStatus = { mode: CredentialMode; stored: boolean };
/** Why the credential store cannot be used right now. "Unavailable" is never the same as "empty". */
export type CredentialStoreError = 'VAULT_PERMISSIONS' | 'VAULT_SCHEMA' | 'VAULT_CORRUPT' | 'VAULT_IO' | 'VAULT_KEY_MISSING' | 'VAULT_LOCKED';
/** What the shell knows about the key store. `mode` is the configured one and survives an error. */
export type CredentialState = { mode?: CredentialMode; stored?: boolean; error?: CredentialStoreError };

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
  /** State of the write journal that belongs to this set; null for sets made before journals existed. */
  journalState?: string | null;
  /** True for sets made before journals existed: their integrity was never recorded. */
  legacy?: boolean;
};

/** How much disk the app's backups use. Optional: an older core does not send it. */
export type BackupUsage = {
  worldBytes: number;
  worldCount: number;
  appBytes: number;
  appBytesApproximate?: boolean;
  /** Sets that are the only way back for a translation that was never restored. */
  lastCopyIds?: string[];
};

export type BackupsListPayload = { backups: BackupSummary[]; usage?: BackupUsage };
export type BackupLocation = 'app' | 'world';

/** A review in progress: who is excluded and what was typed by hand. Kept per scan plan. */
export type ReviewDraft = {
  scanPlanId: string;
  exists: boolean;
  savedAt: number;
  excludedCandidateIds: string[];
  candidateOverrides: Record<string, string>;
};

/** Work a previous run left half done, found when the app starts. */
export type InterruptedJob = {
  jobId: string;
  kind: 'translate' | 'restore' | 'recovery';
  worldPath: string;
  worldName: string;
  createdAt: string;
  unitsTotal: number;
  unitsVerified: number;
  unitsUnknown: number;
  needsAttention: boolean;
  legacy: false;
  /** Where the job stopped. `partial` means some files were written and some failed. */
  state?: 'preparing' | 'prepared' | 'committing' | 'partial' | 'recovery_conflict' | 'recovering' | 'failed' | string;
  /** True while this job holds back new translations and restores of its world. */
  blocking?: boolean;
};

export type RecoveryConflict = { path: string; rootKind: 'world' | 'external_pack'; code: 'RECOVERY_CONFLICT' | 'MISSING' | 'UNREADABLE' | 'UNIT_INCONSISTENT' | string };
export type RecoveryResult = {
  jobId: string;
  mode: 'rollback' | 'keep';
  state: 'rolled_back' | 'kept' | 'recovery_conflict' | 'partial' | string;
  restoredFiles: number;
  keptFiles: number;
  conflicts: RecoveryConflict[];
  quarantineDir: string | null;
  /** Why a job ended up decided without the person's choice, when it did (e.g. an unpublished resume was undone). */
  settledBy?: 'unpublished_continuation' | string;
  /** Set with `recovery_conflict` when the quarantine step itself failed (DISK_FULL, RECOVERY_FAILED). */
  errorCode?: string;
};

export type CandidateLocation = {
  kind?: string;
  holder?: string;
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
  price: { input: number; output: number; perMillionInput: number; perMillionOutput: number } | null;
  cost: { low: number; high: number } | null;
};

export type BackendWarning = { code: string; file?: string; count?: number; message?: string; compression?: number[]; dropped_translations?: number };

/** Where a glossary lives: for every world, or for the world that is open. */
export type GlossaryScope = 'global' | 'world';
export type GlossaryMode = 'translate' | 'keep';
export type GlossaryEntry = {
  id: string;
  source: string;
  target: string;
  mode: GlossaryMode;
  caseSensitive: boolean;
  note: string;
};
export type GlossaryDocument = { scope: GlossaryScope; revision: number; updatedAt: string | null; entries: GlossaryEntry[] };
export type GlossarySkip = { row: number; reason: string; source: string };
export type GlossaryImportResult = GlossaryDocument & {
  added: number; updated: number; unchanged: number; removed: number; skipped: GlossarySkip[]; skippedCount: number;
};
export type GlossaryExportResult = { scope: GlossaryScope; format: 'csv' | 'tsv'; revision: number; count: number; text: string };
/** One sentence whose translation did not honour the glossary or left a format code behind. */
export type TranslationWarningSample = { code: string; entryId?: string; source: string; translated: string };

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

/** Why one sentence could not be translated; the raw provider text stays in the exported report only. */
export type FailureCode = 'timeout' | 'auth' | 'rate_limit' | 'quota' | 'bad_request' | 'unsupported_model' |
  'format_mismatch' | 'provider_unavailable' | 'cancelled' | 'other';

export type TranslationStats = { unique: number; translated: number; failed: number; kept_original: number; unchanged: number };

export type TranslationResult = {
  status: 'completed' | 'partial' | 'needs_retry' | 'failed' | 'cancelled' | 'locked' | 'invalidated' | 'unsupported' | string;
  candidateCount: number;
  changedFileCount: number;
  providerRequests?: number;
  backupSetId?: string;
  errors?: { scope?: string; code?: string; message?: string; file?: string }[];
  warnings?: BackendWarning[];
  translation?: Partial<TranslationStats>;
  translationFailures?: { source: string; reason: string; code?: FailureCode }[];
  translationFailureCodes?: Partial<Record<FailureCode, number>>;
  translationSamples?: { source: string; translated: string }[];
  keptOriginalSamples?: string[];
  /** Per-string quality warnings by code (glossary_mismatch, format_residue). Absent from an older core. */
  translationWarnings?: Record<string, number>;
  translationWarningSamples?: TranslationWarningSample[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number; cost_reported?: boolean; adapted_parameters?: string[] };
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
};

/** App state kept with the settings file (not in the web view's storage, which cleaners can clear). */
export type AppPrefs = {
  theme: 'system' | 'light' | 'dark';
  notice_accepted: boolean;
  tutorial_seen: boolean;
  update_auto_check: boolean;
  update_last_check: number;
  update_skipped_version: string;
  /** Absent from an older core: treated as on. */
  notify_on_finish?: boolean;
};

export type BootstrapPayload = {
  notices: Notices;
  settings: Settings & { app_prefs?: Partial<AppPrefs> };
  prefs?: AppPrefs;
  apiKeyStored: boolean;
  credentialMode?: CredentialMode;
  credentialState?: CredentialState;
  worlds: RecentWorld[];
  worldInspection: WorldInspection | null;
  backups: BackupSummary[];
  resume: ResumeStatus;
  /** Absent from an older core: treated as none. */
  interruptedJobs?: InterruptedJob[];
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
  pricing_prompt?: string;
  pricing_completion?: string;
  context_length?: number;
};

export type ProgressEvent = {
  event: string;
  phase?: 'collect' | 'translate' | 'write' | 'recovery';
  done?: number;
  /** A translated sentence, for the live sample list. */
  source?: string;
  translated?: string;
  samples?: { source: string; translated: string }[];
  failure?: string;
  /** Money spent so far; null means the provider reported none, which is not the same as 0. */
  cost?: number | null;
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
  /** Running count of quality warnings by code, on translation_progress. */
  warnings?: Record<string, number>;
  /** On checkpoint_glossary_changed: how many saved translations were dropped. */
  dropped_translations?: number;
};

export class BackendError extends Error {
  code: string;
  /** A second code that says why (for example the VAULT_* reason behind CREDENTIAL_UNAVAILABLE). */
  detail: string;
  /** "shell" for errors made by the desktop shell: their English text is never shown to people. */
  origin: 'shell' | 'core';
  constructor(message: string, code = '', detail = '', origin: 'shell' | 'core' = 'core') {
    super(message);
    this.name = 'BackendError';
    this.code = code;
    this.detail = detail;
    this.origin = origin;
  }
}

/**
 * Turn what a rejected shell command carries into a BackendError. The shell sends `{code, message,
 * detail?}`; only the code is trusted for behaviour. A plain string (an older shell, or a failure of
 * the bridge itself) becomes TRANSPORT.
 */
export function fromShellError(cause: unknown): BackendError {
  if (cause instanceof BackendError) return cause;
  if (cause && typeof cause === 'object' && typeof (cause as { code?: unknown }).code === 'string') {
    const { code, message, detail } = cause as { code: string; message?: unknown; detail?: unknown };
    return new BackendError(typeof message === 'string' ? message : code, code, typeof detail === 'string' ? detail : '', 'shell');
  }
  const text = cause instanceof Error ? cause.message : String(cause);
  // A bare code (the start-up deadlines of an older shell) still maps to itself.
  const bare = /^[A-Z][A-Z0-9_]{2,}$/.test(text) ? text : 'TRANSPORT';
  return new BackendError(text, bare, '', 'shell');
}

type BackendResponse<T> = {
  v: number;
  id: string;
  type: 'response.ok' | 'response.error';
  payload?: T;
  error?: { code?: string; message?: string; detail?: string; details?: unknown };
};

const SHELL_RESPONSE_CODES = ['CREDENTIAL_UNAVAILABLE', 'CREDENTIAL_SAVE_FAILED', 'CREDENTIAL_SAVE_UNCERTAIN', 'SETTINGS_RECONCILIATION_REQUIRED'];

let serial = 0;
// The Rust shell owns one sidecar process at a time. Keep short read requests (candidate paging,
// estimates, backup refreshes) in the same queue as long operations so a fast UI interaction
// cannot race the cleanup of the preceding sidecar process.
let backendQueue: Promise<void> = Promise.resolve();

/**
 * How long a read-only call may take before the page gives up on it. Long jobs (scan, translate,
 * restore, recovery) have no limit here: the shell and the job's own cancel own those. A call that
 * hits its limit rejects with DEADLINE and stops holding the queue, so one hung request (a model
 * list from a black-holed endpoint) cannot freeze paging, estimates and backups behind it.
 */
export const CALL_DEADLINES_MS: Record<string, number> = {
  'models.list': 60_000,
  'estimate.get': 30_000,
  'candidates.page': 30_000,
  'backups.list': 30_000,
  'worlds.discover': 30_000,
  'world.inspect': 30_000,
  'resume.status': 30_000,
  'review.draft.get': 20_000,
  'review.draft.set': 20_000,
  'review.draft.clear': 20_000,
  'glossary.get': 20_000,
  'glossary.set': 20_000,
  'glossary.import': 30_000,
  'glossary.export': 30_000
};

function withDeadline<T>(call: Promise<T>, limitMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new BackendError('The translation core did not answer in time.', 'DEADLINE', '', 'shell')), limitMs);
    call.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (cause) => { clearTimeout(timer); reject(cause); }
    );
  });
}

export function callBackend<T>(type: string, payload: Record<string, unknown> = {}, options: { timeoutMs?: number } = {}): Promise<T> {
  const run = async (): Promise<T> => {
    serial += 1;
    const id = `ui-${Date.now()}-${serial}`;
    let response: BackendResponse<T>;
    try {
      response = await invoke<BackendResponse<T>>('sidecar_request', { request: { v: 1, id, type, payload } });
    } catch (cause) {
      // The shell rejects with a stable code. The queue prevents normal UI requests from reaching
      // its single-operation BUSY guard.
      throw fromShellError(cause);
    }
    if (response.id !== id) throw new BackendError('The translation core answered a different request.', 'TRANSPORT');
    if (response.type === 'response.error') {
      const code = response.error?.code || '';
      // These four are made by the shell itself, so their English text is never shown.
      const origin = SHELL_RESPONSE_CODES.includes(code) ? 'shell' : 'core';
      throw new BackendError(response.error?.message || code || 'Translation core error', code, response.error?.detail || '', origin);
    }
    if (response.type !== 'response.ok' || !response.payload) {
      throw new BackendError('The translation core response was incomplete.', 'TRANSPORT');
    }
    return response.payload;
  };

  const limit = options.timeoutMs ?? CALL_DEADLINES_MS[type] ?? 0;
  // The deadline starts when the call reaches the front of the queue, not when it was asked for.
  const result = backendQueue.then(() => (limit > 0 ? withDeadline(run(), limit) : run()));
  backendQueue = result.then(() => undefined, () => undefined);
  return result;
}

/** Call a shell command and surface a failure as a BackendError with its stable code. */
async function shell<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (cause) {
    throw fromShellError(cause);
  }
}

export async function cancelBackend(): Promise<boolean> {
  return shell<boolean>('cancel_active');
}

export async function credentialStatus(provider: string): Promise<CredentialState> {
  return shell<CredentialState>('credential_status', { provider });
}

export async function importCredential(provider: string, endpoint?: string): Promise<CredentialStatus> {
  return shell<CredentialStatus>('credential_import', { provider, endpoint: endpoint || null });
}

/** Set a damaged credential store aside and start an empty one. Keys saved in it are gone. */
export async function resetCredentialStorage(): Promise<void> {
  await shell<void>('credential_reset_storage');
}

/**
 * What the shell's half of the reset did. Every step runs even when an earlier one failed, so this
 * says exactly which ones worked. `keysDeleted` is also false when keys were not asked for.
 */
export type NativeResetOutcome = {
  keysDeleted: boolean;
  /** Some key stores were emptied and some could not be confirmed; a retry finishes the job. */
  keysPartiallyDeleted?: boolean;
  reportsCleared: boolean;
  /** Stable codes of what failed (KEYCHAIN_UNCONFIRMED, VAULT_IO, RESET_FAILED, ...). */
  errors: string[];
};

/** The shell's half of "reset the app": saved keys (when asked) and the run reports. */
export async function nativeReset(deleteKeys: boolean): Promise<NativeResetOutcome> {
  const outcome = await shell<Partial<NativeResetOutcome> | null | undefined>('native_reset', { deleteKeys });
  // Anything that is not clearly "true" counts as not done: an answer the page cannot read is not a success.
  return {
    keysDeleted: outcome?.keysDeleted === true,
    keysPartiallyDeleted: outcome?.keysPartiallyDeleted === true,
    reportsCleared: outcome?.reportsCleared === true,
    errors: Array.isArray(outcome?.errors) ? outcome.errors.filter((code): code is string => typeof code === 'string') : []
  };
}

/** Versions, platform, recent events and the core's last output, with secrets and paths removed. */
/**
 * Save the shell's diagnostics bundle as a text file through a native save dialog. Resolves true
 * when a file was written and false when the dialog was dismissed; rejects with EXPORT_FAILED.
 */
export async function diagnosticsExport(): Promise<boolean> {
  return shell<boolean>('diagnostics_export');
}

export async function diagnosticsSnapshot(): Promise<string> {
  return shell<string>('diagnostics_snapshot');
}

export async function operationActive(): Promise<boolean> {
  return shell<boolean>('operation_active');
}

type Unsubscribe = () => void;

/** Progress lines from a running scan or translation. */
export async function onProgress(handler: (event: ProgressEvent) => void): Promise<Unsubscribe> {
  return listen<{ payload?: ProgressEvent }>('pomi-progress', ({ payload }) => {
    if (payload?.payload) handler(payload.payload);
  });
}

export async function onZoomFailed(handler: () => void): Promise<Unsubscribe> {
  return listen('pomi-zoom-failed', () => handler());
}
