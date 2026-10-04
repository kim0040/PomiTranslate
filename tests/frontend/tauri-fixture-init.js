(() => {
  // Documentation previews use the same UI with an explicit, validated locale.
  const requestedLocale = new URLSearchParams(location.search).get('locale');
  const previewLocale = ['ko', 'en', 'ja'].includes(requestedLocale) ? requestedLocale : 'ko';
  const previewLanguages = { ko: '한국어', en: 'English', ja: '日本語' };
  const previewTranslations = { ko: '잃어버린 열쇠 상점', en: 'The Lost Key Shop', ja: '失われた鍵の店' };
  window.__pomiRequests = [];
  window.__pomiSettingsSaves = [];
  window.__pomiNativeCalls = [];
  window.__pomiNotifications = [];
  window.__pomiNotificationPermissionRequests = 0;
  window.__pomiClipboard = [];
  try {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (value) => { window.__pomiClipboard.push(String(value)); } }
    });
  } catch { /* Clipboard may be supplied by the browser. */ }
  class FixtureNotification {
    static permission = 'default';
    static async requestPermission() {
      window.__pomiNotificationPermissionRequests++;
      FixtureNotification.permission = 'granted';
      return 'granted';
    }
    constructor(title, options = {}) {
      window.__pomiNotifications.push({ title, body: options.body || '' });
    }
  }
  window.Notification = FixtureNotification;
  const callbacks = new Map();
  const listeners = new Map();
  let callbackId = 0;
  let eventId = 0;
  let bootstrapAttempts = 0;

  const candidates = [
    { id: 'welcome', source: 'Welcome to Roguefire', kind: 'sign', kinds: { sign: 3 }, occurrences: 3, locations: [{ holder: 'minecraft:oak_sign', kind: 'sign', dimension: 'minecraft:overworld', pos: [12, 64, -8], chunk: [0, -1], detail: 'front:1' }] },
    { id: 'shop', source: 'The Lost Key Shop', kind: 'text_display', kinds: { text_display: 1 }, occurrences: 1, locations: [{ holder: 'minecraft:text_display', kind: 'text_display', dimension: 'minecraft:overworld', pos: [24, 70, 11], chunk: [1, 0], detail: 'base' }] },
    { id: 'book', source: 'Find the keeper beyond the old bridge.', kind: 'book_page', kinds: { book_page: 2 }, occurrences: 2, locations: [{ holder: 'minecraft:written_book', kind: 'book_page', dimension: 'minecraft:the_nether', pos: [30, 65, 9], chunk: [1, 0], detail: 'page:3' }] },
    { id: 'lore', source: 'A blade that remembers every battle', kind: 'item_lore', kinds: { item_lore: 8 }, occurrences: 8, locations: [{ holder: 'minecraft:diamond_sword', kind: 'item_lore', dimension: 'custom:sky', file: 'dimensions/custom/sky/region/r.0.0.mca', pos: [8, 63, 20], chunk: [0, 1], detail: 'line:1' }] },
    { id: 'tellraw', source: 'You are not ready yet.', kind: 'command', kinds: { command: 1 }, occurrences: 1, locations: [{ holder: 'minecraft:command_block', pos: [-4, 58, 42], chunk: [-1, 2], detail: 'base' }] },
    { id: 'merchant', source: 'Merchant of the Northern Gate', kind: 'entity_name', kinds: { entity_name: 2 }, occurrences: 2, locations: [{ holder: 'minecraft:villager', pos: [101, 67, -33], chunk: [6, -3], detail: 'custom' }] }
  ];
  // Generated data remains in the test backend; only requested pages reach the UI.
  const requestedCount = Number(new URLSearchParams(location.search).get('count') || 0);
  if (requestedCount > 0) {
    const template = [...candidates];
    candidates.length = 0;
    for (let i = 0; i < Math.min(requestedCount, 100000); i++) {
      const base = template[i % template.length];
      candidates.push({ ...base, id: `candidate-${i}`, source: `${base.source} ${i}` });
    }
  }
  // `tokens=1` puts § formatting codes into one sentence, to test that a broken code is refused.
  if (new URLSearchParams(location.search).get('tokens') === '1') candidates[3].source = '§6A blade that remembers every battle§r';
  const worldDir = '/private/tmp/pomi-eval/Roguefire — a deliberately long translated world folder name';
  const inspection = {
    validJavaWorld: true,
    kind: 'java_world',
    childWorlds: [],
    regionDirs: ['region', 'entities', 'DIM-1/region', 'DIM1/region', 'dimensions/roguefire/sky/region'],
    resourcePacks: [`${worldDir}/resources.zip`],
    dataVersions: [{ world: 'Roguefire', dataVersion: 4189 }],
    writeBlockers: []
  };
  const backups = [
    { backupSetId: '2026-09-29T16-24-18Z-translation', createdAt: '2026-09-29T16:24:18+09:00', fileCount: 69, verified: true, kind: 'translation', sizeBytes: 1843200, inWorldFolder: false },
    { backupSetId: 'legacy-2026-09-28T12-10-00', createdAt: '2026-09-28T12:10:00+09:00', fileCount: 12, verified: false, kind: 'recovery', sizeBytes: 512000, inWorldFolder: true }
  ];
  const credentialModes = new Map();
  const requestedCredentialMode = new URLSearchParams(location.search).get('credentialMode');
  const initialCredentialMode = ['local', 'session', 'keychain'].includes(requestedCredentialMode) ? requestedCredentialMode : 'local';
  const connectionAttempts = new Map();
  const settings = {
    provider: 'openrouter', model: new URLSearchParams(location.search).get('model') || 'xiaomi/mimo-v2.6-flash', base_url: '', wire_format: 'openai',
    target_language: new URLSearchParams(location.search).get('targetLanguage') || previewLanguages[previewLocale], style_preset: 'neutral', style_prompt: '', custom_system_prompt: '',
    temperature: 0.3, batch_size: 40, request_timeout: 120, rpm_limit: 0, tpm_limit: 0,
    max_batch_retries: 3, concurrency: 4, resource_pack_enabled: false,
    skip_target_language_text: true, ui_language: previewLocale, last_world_dir: worldDir,
    // `review=0` keeps the old single-pass behaviour for the specs written before review-before-apply.
    review_before_apply: new URLSearchParams(location.search).get('review') !== '0', max_cost_usd: 0
  };
  // Saved manual translations from an earlier session, in the settings object format.
  if (new URLSearchParams(location.search).get('sourceOverrides') === '1') settings.source_overrides = { 'Welcome to Roguefire': '환영합니다', 'You are not ready yet.': '아직 준비가 안 됐군.' };
  // A fresh install: no model chosen and no key saved yet.
  const fresh = new URLSearchParams(location.search).get('fresh') === '1';
  if (fresh) Object.assign(settings, { provider: 'openai', model: '' });
  let freshKeySaved = false;
  const estimate = {
    candidateCount: candidates.length, requests: 1, sourceChars: 180, inputTokens: 720,
    outputTokens: 240, price: { input: 0.00000015, output: 0.0000006, perMillionInput: 0.15, perMillionOutput: 0.6 },
    cost: { low: 0.000252, high: 0.000504 },
    // `reasoning=1` reports the reasoning allowance as included in the estimate.
    ...(new URLSearchParams(location.search).get('reasoning') === '1' ? { reasoningIncluded: true } : {})
  };
  const scan = {
    status: 'completed', candidateCount: candidates.length, occurrenceCount: candidates.reduce((sum, item) => sum + item.occurrences, 0),
    kinds: candidates.reduce((counts, item) => { counts[item.kind] = (counts[item.kind] || 0) + 1; return counts; }, {}),
    providerRequests: 0, fingerprint: 'fixture-world-fingerprint', scanPlanId: 'fixture-scan-plan', dryRun: true,
    lastScan: { at: 1790585600, candidateCount: candidates.length },
    writeBlockers: [], errors: [], warnings: [], requestEstimate: 1, estimate, candidates: candidates.slice(0, 200),
    coverage: [
      { id: 'regions', scanned: true, present: true, count: 6 },
      { id: 'entities', scanned: true, present: true, count: 2 },
      { id: 'resource_pack', scanned: false, present: true, count: 1 },
      { id: 'datapacks', scanned: false, present: true, count: 4 },
      { id: 'command_storage', scanned: false, present: true, count: 31 },
      { id: 'playerdata', scanned: false, present: true, count: 4 }
    ]
  };

  function scenario() {
    return new URLSearchParams(location.search).get('scenario') || 'selected';
  }
  function emit(name, message) {
    for (const listener of listeners.values()) {
      if (listener.event === name) callbacks.get(listener.handler)?.({ event: name, id: listener.id, payload: message });
    }
  }
  function ok(request, payload) {
    return { v: 1, id: request.id, type: 'response.ok', payload };
  }
  function resumePayload(status = 'needs_retry') {
    return {
      available: true, scanPlanId: scan.scanPlanId, fingerprint: scan.fingerprint,
      candidateCount: candidates.length, occurrenceCount: scan.occurrenceCount, kinds: scan.kinds, coverage: scan.coverage, candidates: candidates.slice(0, 200), excludedCandidateIds: ['tellraw'],
      candidateOverrides: { shop: previewTranslations[previewLocale] }, savedAt: 1790672400,
      lastScan: new URLSearchParams(location.search).get('scenario') === 'unscanned' ? null : { at: 1790585600, candidateCount: candidates.length },
      status, translatedCount: job ? job.rows.filter((row) => row.status !== 'failed').length : 2, failedCount: job ? job.rows.filter((row) => row.status === 'failed').length : 0, backupSetId: '',
      lastJob: { world: 'Roguefire', at: 1790672300, status: 'partial', translated: 4, failed: 2, changedFiles: 4, candidateCount: 6 }
    };
  }
  function filteredPage(body) {
    let rows = [...candidates];
    const query = String(body.query || '').trim().toLocaleLowerCase();
    if (query) rows = rows.filter((item) => item.source.toLocaleLowerCase().includes(query));
    if (body.kind) rows = rows.filter((item) => item.kind === body.kind);
    const excluded = new Set(body.excludedCandidateIds || []);
    const manual = new Set(body.overrideCandidateIds || []);
    for (const row of rows) if (settings.source_overrides?.[row.source]) manual.add(row.id);
    if (body.state === 'included') rows = rows.filter((item) => !excluded.has(item.id));
    if (body.state === 'excluded') rows = rows.filter((item) => excluded.has(item.id));
    if (body.state === 'manual') rows = rows.filter((item) => manual.has(item.id));
    if (body.sort === 'source') rows.sort((a, b) => a.source.localeCompare(b.source));
    if (body.sort === 'count') rows.sort((a, b) => b.occurrences - a.occurrences);
    if (body.sort === 'kind') rows.sort((a, b) => a.kind.localeCompare(b.kind));
    const offset = Number(body.offset || 0);
    const limit = Number(body.limit || 200);
    return { candidates: rows.slice(offset, offset + limit), offset, total: rows.length, hasMore: offset + limit < rows.length, kinds: scan.kinds };
  }
  // --- the saved translation job (what the sidecar keeps in its checkpoint) -------------------
  const query = new URLSearchParams(location.search);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const failCodes = ['timeout', 'rate_limit', 'invalid_response', 'network', 'quota', 'content_filter', 'auth', 'provider_error', 'unknown'];
  const failDetails = {
    timeout: 'ReadTimeout: read timed out (120s) while waiting for the provider', rate_limit: 'HTTP 429 Too Many Requests: rate limit reached for requests',
    invalid_response: 'Expected 6 items but the model returned 5', network: 'ConnectError: [Errno 8] nodename nor servname provided, or not known',
    quota: 'HTTP 402 Payment Required: insufficient credits', content_filter: 'The response was blocked by the safety system',
    auth: 'HTTP 401 Unauthorized: invalid api key', provider_error: 'HTTP 503 Service Unavailable: upstream connect error', unknown: 'Not translated yet.', budget_unsent: '', unsent: ''
  };
  // Rows no request has answered: not failures of the AI; a retry sends them.
  const UNSENT = ['budget_unsent', 'unsent'];
  const isUnsent = (row) => row.status === 'failed' && UNSENT.includes(row.reason);
  const koText = {
    'Welcome to Roguefire': '로그파이어에 오신 것을 환영합니다', 'The Lost Key Shop': '잃어버린 열쇠 상점',
    'Find the keeper beyond the old bridge.': '낡은 다리 너머의 수호자를 찾아라.', 'A blade that remembers every battle': '모든 전투를 기억하는 검',
    'You are not ready yet.': '아직 준비가 되지 않았습니다.', 'Merchant of the Northern Gate': '북문의 상인'
  };
  function aiFor(source) {
    const lead = (source.match(/^(§.)+/) || [''])[0];
    const tail = /§r$/.test(source) ? '§r' : '';
    const suffix = (source.match(/ \d+$/) || [''])[0];
    const core = source.slice(lead.length, source.length - tail.length - suffix.length);
    return `${lead}${koText[core] || `번역: ${core}`}${tail}${suffix}`;
  }
  let job = null;
  function failRow(row, code) { Object.assign(row, { status: 'failed', reason: code, detail: failDetails[code] || '' }); }
  function makeJob(kind, excluded) {
    const skip = new Set(excluded || []);
    const rows = candidates.filter((item) => !skip.has(item.id)).map((item) => ({
      id: item.id, source: item.source, kind: item.kind, occurrences: item.occurrences, ai: aiFor(item.source), status: 'translated', reason: '', detail: '', edit: undefined
    }));
    const pending = (row) => failRow(row, kind === 'budget_stopped' ? 'budget_unsent' : 'unsent');
    const spread = (row, index) => failRow(row, failCodes[index % 6]);
    if (kind === 'partial') rows.slice(0, 2).forEach((row) => failRow(row, 'provider_error'));
    else if (kind === 'failed' || kind === 'needs_retry') rows.forEach(spread);
    else if (kind === 'cancelled') rows.slice(2).forEach(pending);
    else if (kind === 'budget_stopped') rows.slice(3).forEach(pending);
    else if (kind === 'review') {
      const count = Number(query.get('fail') || 0);
      rows.slice(0, count).forEach((row, index) => failRow(row, query.get('failCode') || failCodes[index % failCodes.length]));
    }
    job = {
      kind, rows, status: kind === 'review' ? 'awaiting_review' : kind === 'success' ? 'completed' : kind, excluded: [...skip],
      applied: kind === 'success' || kind === 'partial', backupSetId: kind === 'success' || kind === 'partial' ? backups[0].backupSetId : '',
      requests: 0, usage: { prompt_tokens: 712, completion_tokens: 231, cost: 0.00025, cost_reported: true }
    };
    return job;
  }
  function ensureJob(excluded) {
    if (job) return job;
    const current = scenario();
    const kind = current.startsWith('result-') ? current.slice(7) : 'review';
    // The result scenarios describe a job over all six sentences; the others leave the command text out.
    return makeJob(kind, current.startsWith('result-') ? [] : excluded ?? (['scanned', 'review', 'run', 'run-progress', 'dark-review'].includes(current) ? ['tellraw'] : []));
  }
  const viewRow = (row, drafts = new Set()) => {
    const edited = row.edit !== undefined || drafts.has(row.id);
    return {
      id: row.id, source: row.source, kind: row.kind, occurrences: row.occurrences, ai: row.status === 'failed' ? '' : row.ai,
      translated: row.edit !== undefined ? row.edit : row.status === 'failed' ? '' : row.ai,
      status: edited ? 'edited' : row.status === 'translated' && row.ai === row.source ? 'kept' : row.status,
      ...(row.status === 'failed' && row.edit === undefined ? { reason: row.reason, detail: row.detail } : {})
    };
  };
  function jobCounts(drafts) {
    const counts = { all: 0, translated: 0, failed: 0, kept: 0, edited: 0, unsent: 0, errored: 0 };
    for (const row of job.rows) {
      counts.all++;
      const view = viewRow(row, drafts);
      counts[view.status]++;
      if (view.status === 'failed') counts[isUnsent(row) ? 'unsent' : 'errored']++;
    }
    return counts;
  }
  function retryEstimate() {
    const failed = job.rows.filter((row) => row.status === 'failed' && row.edit === undefined).length;
    if (!failed) return null;
    return { ...estimate, candidateCount: failed, requests: Math.ceil(failed / 40), cost: { low: 0.000042 * failed, high: 0.000084 * failed } };
  }
  function pagePayload(body) {
    const drafts = new Set(body.draftIds || []);
    let rows = job.rows.map((row) => viewRow(row, drafts));
    const text = String(body.query || '').trim().toLocaleLowerCase();
    if (text) rows = rows.filter((row) => row.source.toLocaleLowerCase().includes(text) || row.translated.toLocaleLowerCase().includes(text));
    const unsentIds = new Set(job.rows.filter(isUnsent).map((row) => row.id));
    if (body.state === 'unsent') rows = rows.filter((row) => row.status === 'failed' && unsentIds.has(row.id));
    else if (body.state === 'errored') rows = rows.filter((row) => row.status === 'failed' && !unsentIds.has(row.id));
    else if (body.state && body.state !== 'all') rows = rows.filter((row) => row.status === body.state);
    const offset = Number(body.offset || 0);
    const limit = Math.max(1, Math.min(500, Number(body.limit || 100)));
    return {
      rows: rows.slice(offset, offset + limit), offset, total: rows.length, hasMore: offset + limit < rows.length, counts: jobCounts(drafts),
      meta: { status: job.status, applied: job.applied, backupSetId: job.backupSetId, failedCount: job.rows.filter((row) => row.status === 'failed').length, unsentCount: job.rows.filter(isUnsent).length, usage: { ...job.usage, requests: job.requests },  retryEstimate: retryEstimate() }
    };
  }
  function jobResult(status, extra = {}) {
    const unsent = job.rows.filter(isUnsent);
    const failed = job.rows.filter((row) => row.status === 'failed' && !isUnsent(row));
    const unchanged = job.rows.filter((row) => row.status === 'translated' && row.ai === row.source && row.edit === undefined).length;
    return {
      status, candidateCount: candidates.length, changedFileCount: job.applied ? 8 : 0, providerRequests: 0, backupSetId: job.applied ? job.backupSetId : '', preTranslate: '', localhostServer: false,
      errors: [], warnings: [],
      translation: { unique: job.rows.length, translated: job.rows.length - failed.length - unsent.length - unchanged, failed: failed.length, kept_original: 0, unchanged, pending: unsent.length },
      translationFailures: failed.slice(0, 20).map((row) => ({ source: row.source, reason: row.reason, detail: row.detail })),
      translationSamples: job.rows.filter((row) => row.status !== 'failed').slice(0, 12).map((row) => ({ source: row.source, translated: row.edit ?? row.ai })), keptOriginalSamples: [],
      // The job's own totals, like the usage: this call's providerRequests is in `extra`.
      jobProviderRequests: job.requests, usage: { ...job.usage, requests: job.requests }, ...extra
    };
  }
  function progressEvents(request, type, names) {
    names.forEach(([delay, payload]) => setTimeout(() => emit('pomi-progress', { v: 1, id: request.id, type, payload }), delay));
  }
  const editReason = (row, text) => {
    const clean = String(text).trim();
    if (!clean) return 'empty';
    if (clean.length > 32000) return 'too_long';
    if (clean.includes('\u0000')) return 'invalid';
    const tokens = (value) => (value.match(/§.|%(?:\d+\$)?[sdif]|\{[A-Za-z0-9_]+\}/g) || []).sort().join('|');
    return tokens(row.source) === tokens(clean) ? '' : 'tokens';
  };
  /** Validate edits as the sidecar does; returns an EDITS_INVALID error response or applies them. */
  function applyEdits(request, edits) {
    const refused = [];
    for (const [id, text] of Object.entries(edits || {})) {
      const row = job.rows.find((item) => item.id === id);
      if (!row) return { v: 1, id: request.id, type: 'response.error', error: { code: 'INVALID_REQUEST', message: 'Unknown candidate', recoverable: true } };
      if (text === null) continue;
      const reason = editReason(row, text);
      if (reason) refused.push({ id, reason });
    }
    if (refused.length) return { v: 1, id: request.id, type: 'response.error', error: { code: 'EDITS_INVALID', message: 'Some edited translations cannot be written.', recoverable: true, details: { rows: refused } } };
    for (const [id, text] of Object.entries(edits || {})) {
      const row = job.rows.find((item) => item.id === id);
      if (text === null || String(text).trim() === row.ai) delete row.edit; else row.edit = String(text).trim();
      if (row.edit !== undefined) { row.status = 'translated'; row.reason = ''; row.detail = ''; }
    }
    return null;
  }

  function resultPayload(status) {
    if (status === 'partial') return {
      status, candidateCount: candidates.length, changedFileCount: 4, providerRequests: 2, jobProviderRequests: 2,
      backupSetId: backups[0].backupSetId,
      translation: { unique: 6, translated: 4, failed: 2, kept_original: 0, unchanged: 0 },
      translationSamples: [
        { source: 'The Lost Key Shop', translated: '잃어버린 열쇠 상점' }, { source: 'Find the keeper beyond the old bridge.', translated: '낡은 다리 너머의 수호자를 찾아라.' },
        { source: 'A blade that remembers every battle', translated: '모든 전투를 기억하는 검' }, { source: 'You are not ready yet.', translated: '아직 준비가 되지 않았습니다.' }
      ],
      translationFailures: [{ source: 'Welcome to Roguefire', reason: 'provider_error', detail: 'HTTP 503 Service Unavailable: upstream connect error' }],
      usage: { prompt_tokens: 540, completion_tokens: 180, cost: 0.00018, cost_reported: true }
    };
    if (status === 'failed' || status === 'needs_retry') return {
      status, candidateCount: candidates.length, changedFileCount: 0, providerRequests: 3, jobProviderRequests: 3,
      errors: [{ code: 'PROVIDER_ERROR', message: 'Provider requests failed repeatedly.' }],
      translation: { unique: 6, translated: 0, failed: 6, kept_original: 0, unchanged: 0 },
      translationFailures: [{ source: 'Welcome to Roguefire', reason: 'provider_error', detail: 'HTTP 503 Service Unavailable: upstream connect error' }],
      usage: { prompt_tokens: 680, completion_tokens: 0, cost: 0.0002, cost_reported: true }
    };
    if (status === 'budget_stopped') return {
      status, candidateCount: candidates.length, changedFileCount: 0, providerRequests: 1, jobProviderRequests: 1, backupSetId: '',
      translation: { unique: 6, translated: 3, failed: 0, kept_original: 0, unchanged: 0, pending: 3 },
      usage: { prompt_tokens: 380, completion_tokens: 120, cost: 0.0001, cost_reported: true }
    };
    if (status === 'cancelled') return {
      status, candidateCount: candidates.length, changedFileCount: 2, providerRequests: 1, jobProviderRequests: 1,
      backupSetId: backups[0].backupSetId,
      translation: { unique: 6, translated: 2, failed: 0, kept_original: 0, unchanged: 0, pending: 4 },
      usage: { prompt_tokens: 280, completion_tokens: 80, cost: 0.00008, cost_reported: true }
    };
    if (status === 'invalidated') return {
      status, candidateCount: candidates.length, changedFileCount: 0, providerRequests: 0,
      translation: { unique: 6, translated: 0, failed: 0, kept_original: 0, unchanged: 0 }
    };
    if (status === 'unsupported') return {
      status, candidateCount: candidates.length, changedFileCount: 0, providerRequests: 0,
      translation: { unique: 0, translated: 0, failed: 0, kept_original: 0, unchanged: 0 }
    };
    return {
      status: 'completed', candidateCount: candidates.length, changedFileCount: 8, providerRequests: 1, jobProviderRequests: 1,
      backupSetId: backups[0].backupSetId,
      translation: { unique: 6, translated: 5, failed: 0, kept_original: 0, unchanged: 1 },
      translationSamples: [
        { source: 'Welcome to Roguefire', translated: '로그파이어에 오신 것을 환영합니다' },
        { source: 'The Lost Key Shop', translated: '잃어버린 열쇠 상점' }
      ],
      usage: { prompt_tokens: 712, completion_tokens: 231, cost: 0.00025, cost_reported: true }
    };
  }

  async function sidecar(request) {
    const type = request.type;
    const body = request.payload || {};
    // A key (draft or stored) is recorded only as a flag and its length, never as text.
    const { apiKey: _hidden, draftApiKey: _draft, ...loggable } = body;
    window.__pomiRequests.push({
      type, provider: body.provider, publicCatalog: body.publicCatalog, connectionCheck: body.connectionCheck,
      baseUrl: body.baseUrl, wireFormat: body.wireFormat,
      hasDraftKey: typeof body.draftApiKey === 'string' && body.draftApiKey.length > 0,
      draftKeyLength: typeof body.draftApiKey === 'string' ? body.draftApiKey.length : undefined,
      hasApiKey: typeof body.apiKey === 'string' && body.apiKey.length > 0, apiKeyLength: typeof body.apiKey === 'string' ? body.apiKey.length : undefined,
      payload: JSON.parse(JSON.stringify(loggable))
    });
    const current = scenario();
    if (type === 'app.bootstrap') {
      bootstrapAttempts++;
      if (bootstrapAttempts === 1 && ['startup-handshake', 'startup-bootstrap', 'startup-stopped'].includes(current)) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        throw current === 'startup-handshake' ? 'CORE_HANDSHAKE_TIMEOUT'
          : current === 'startup-bootstrap' ? 'BOOTSTRAP_TIMEOUT'
          : 'CORE_STOPPED';
      }
      if (current === 'startup-delay') await new Promise((resolve) => setTimeout(resolve, 500));
      const empty = current === 'empty';
      const resumed = ['scanned', 'review', 'run', 'run-progress', 'result-success', 'result-failed', 'dark-review', 'home-resume', 'awaiting-review'].includes(current);
      const resultScenarios = ['result-partial', 'result-failed', 'result-needs_retry', 'result-cancelled', 'result-invalidated', 'result-unsupported'];
      return ok(request, {
        notices: { firstLaunch: '', about: '', backupWarning: '', apiWarning: '' },
        settings: { ...settings, last_world_dir: empty ? '' : worldDir, ...(current === 'first-run' ? { app_prefs: {} } : {}) },
        ...(current === 'first-run' ? { prefs: { theme: 'system', notice_accepted: false, tutorial_seen: false, setup_dismissed: false, update_auto_check: true, update_last_check: 0, update_skipped_version: '' } } : {}),
        ...(new URLSearchParams(location.search).get('notify') === 'off' ? { prefs: { theme: 'system', notice_accepted: true, tutorial_seen: true, setup_dismissed: true, update_auto_check: false, update_last_check: 0, update_skipped_version: '', notify_on_finish: false } } : {}),
        apiKeyStored: !fresh || freshKeySaved, credentialMode: credentialModes.get(settings.provider) || initialCredentialMode, worlds: empty ? [] : [{ path: worldDir, name: 'Roguefire', lastOpened: 1790672400, available: true }],
        worldInspection: empty ? null : inspection, backups: empty ? [] : backups,
        resume: current === 'awaiting-review' ? resumePayload('awaiting_review') : resumed || resultScenarios.includes(current) ? resumePayload() : { available: false },
        lastJob: empty || current === 'unscanned' ? null : { world: 'Roguefire', at: 1790672300, status: 'partial', translated: 4, failed: 2, changedFiles: 4, candidateCount: 6 },
        lastScan: empty || current === 'unscanned' ? null : { at: 1790585600, candidateCount: candidates.length }
      });
    }
    // This fixture tests draft wiring only; the real AST parser has Python regressions.
    if (type === 'settings.import_legacy') {
      if (body.source === 'invalid Python import') return { v: 1, id: request.id, type: 'response.error', error: { code: 'INVALID_REQUEST', message: 'Invalid public legacy settings' } };
      return ok(request, { config: { api: { provider: 'custom', base_url: 'https://legacy.example/v1', wire_format: 'openai', model: 'literal-model' }, prompt: { custom_system_prompt: 'Preserve formatting' } } });
    }
    if (type === 'settings.set') {
      if (new URLSearchParams(location.search).get('slowSettings') === '1') await new Promise((resolve) => setTimeout(resolve, 1500));
      if (body.maxCostUsd !== undefined && !(Number.isFinite(Number(body.maxCostUsd)) && Number(body.maxCostUsd) >= 0 && Number(body.maxCostUsd) <= 1000)) {
        return { v: 1, id: request.id, type: 'response.error', error: { code: 'INVALID_REQUEST', message: 'max_cost_usd must be between 0 and 1000' } };
      }
      if (new URLSearchParams(location.search).get('saveFails') === '1') return { v: 1, id: request.id, type: 'response.error', error: { code: 'SETTINGS_FAILED', message: 'Synthetic save failure' } };
      // What a save carried, without the key, so a test can check the exact payload.
      window.__pomiSettingsSaves.push(Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'apiKey')));
      const aliases = { reviewBeforeApply: 'review_before_apply', maxCostUsd: 'max_cost_usd', openrouterReasoning: 'openrouter_reasoning', externalResourcePackPaths: 'external_resource_pack_paths', resourcePackOptions: 'resource_pack_options', sourceOverrides: 'source_overrides', continueOnFileError: 'continue_on_file_error', maxFileWriteRetries: 'max_file_write_retries', targetLanguage: 'target_language', uiLanguage: 'ui_language', baseUrl: 'base_url', wireFormat: 'wire_format', resourcePackEnabled: 'resource_pack_enabled', skipTargetLanguageText: 'skip_target_language_text', scanOptions: 'scan_options' };
      for (const [key, value] of Object.entries(body)) {
        if (key !== 'apiKey' && key !== 'credentialMode') settings[aliases[key] || key] = value;
      }
      credentialModes.set(body.provider, body.credentialMode || 'local');
      if (body.apiKey) freshKeySaved = true;
      return ok(request, { settings: { ...settings }, apiKeyStored: !fresh || freshKeySaved, credentialMode: body.credentialMode || 'local' });
    }
    if (type === 'prefs.set') {
      window.__pomiPrefs = { ...(window.__pomiPrefs || {}), ...(body.prefs || {}) };
      return ok(request, { prefs: { ...({ theme: 'system', notice_accepted: false, tutorial_seen: false, setup_dismissed: false, update_auto_check: true, update_last_check: 0, update_skipped_version: '' }), ...window.__pomiPrefs } });
    }
    if (type === 'app.reset') {
      if (body.confirm !== 'reset') return { v: 1, id: request.id, type: 'response.error', error: { code: 'INVALID_REQUEST', message: 'Reset needs an explicit confirmation' } };
      sessionStorage.setItem('pomi.fixture.reset', 'true');
      return ok(request, { removed: ['settings.json', 'scans', 'jobs', 'models'], kept: ['backups'] });
    }
    if (type === 'world.inspect') return ok(request, inspection);
    if (type === 'worlds.discover') {
      if (current === 'empty') return ok(request, { worlds: [], savesDirs: [], total: 0 });
      // A generated 16x16 PNG keeps the tile realistic without shipping a binary fixture.
      const icon = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAACo0lEQVR4nBXR6XLadgAEcL0V0l+LDnQ8BEISEjrQGScTu/ksIQMCzCUQgS9JxjmnndZJ2yTNTHrYePxYJU+wv92lrCOid3DvETwgvkbyAj99h30L62ecfUd0i+Ar0vewHmD8C+8FqEfXMI/QPuHJSzy9QXCPx19w9g3eHfrvcPEZ+isYf6P7G559w5MHUOef4P+Dp18Q/4noCP8I6w88eonzGyQfcPY7nv2HizvEb3D2C9I7UPZH6Nc/PMFruNfw36P9Ef5fOH8L7R7JK3hHOLe4uEH46w8IlXXIJqJHvrCx2Z0mTl32ylNWHtmE/DzlJj6/6omZL2Yem6fiwm1RG1vNYrput8pUmcTi0MXU5Sce2bfZSchtbW5qyludbByxtpSDyVDTtFn1+bFOr7riIUbpMIekVRnyJOQXrjzx5dxnR211E8pri37eF6i1ww1iobDoPGzOYzoLyDAUxm05T8jU4NcBPbOaRUSGFn8wGstUonKbKxM5D8R9m94bdKExS41ZherUFAeutPWEmd2c+uQyauw8pjJpataXtpqcu+rekXe+klnNtc0cfG5uNE5lij55Hkq1LlYROcSNpcFRe49edUjtIXNIpqu7nnDo0PuYOzHWmliZzNjkFolUutIskgceR81NeRerl6l0aZJloFQmW3bZKhTHkVD7/KjXKANpZLbGjro35F3QpBanoI500JSxxYxsbmSzw4QuTfq05qBDBraQu0rlNDJHnHvqoKtSV4ZY2Eztk0XIF2GrdpVJyhcOqYNW3sM2ZYeuUujsNJXXPSwCgTp9UZjSTOdLj77U1JXN7cLW1FPWndZSZ8uY1DoZduXaY6uEveqCqsxm6QpZX75yhG0g1EFj020UljoMlVG3mYdKEQu1wS46dOZyq476PxC9O4m8/TG/AAAAAElFTkSuQmCC';
      return ok(request, { total: 2, savesDirs: ['/Users/fixture/Library/Application Support/minecraft/saves'], worlds: [
        { path: worldDir, folder: 'Roguefire', name: 'Roguefire', lastPlayed: 1790672400, dataVersion: 4189, versionName: '1.21.4', icon, source: 'saves' },
        { path: '/Users/fixture/Library/Application Support/minecraft/saves/Skyblock', folder: 'Skyblock', name: 'Skyblock Classic', lastPlayed: 1790500000, dataVersion: 4556, versionName: '1.21.11', icon: null, source: 'saves' }
      ] });
    }
    if (type === 'worlds.remember') return ok(request, { worlds: [{ path: worldDir, name: 'Roguefire', lastOpened: 1790672400, available: true }] });
    if (type === 'worlds.forget') return ok(request, { worlds: [] });
    if (type === 'resume.status') {
      if (job && !job.applied && ['awaiting_review', 'budget_stopped', 'cancelled', 'needs_retry', 'failed'].includes(job.status)) return ok(request, resumePayload(job.status));
      return ok(request, ['result-cancelled', 'result-needs_retry'].includes(current) ? { ...resumePayload(), status: current.slice(7) } : { available: false });
    }
    if (type === 'backups.list') return ok(request, { backups });
    if (type === 'estimate.get') {
      if (new URLSearchParams(location.search).get('slowEstimate') === '1') await new Promise((resolve) => setTimeout(resolve, 600));
      const excluded = new Set([...(body.excludedCandidateIds || []), ...(body.overrideCandidateIds || [])]);
      const count = candidates.filter((row) => !excluded.has(row.id) && !settings.source_overrides?.[row.source]).length;
      return ok(request, { ...estimate, candidateCount: count, requests: Math.ceil(count / 40) });
    }
    if (type === 'candidates.page') return ok(request, filteredPage(body));
    if (type === 'provider.usage') return ok(request, { provider: 'openrouter', checkedAt: '2026-10-01T00:00:00Z', usage: 0.123456, byokUsage: 0, limit: null, limitRemaining: null });
    if (type === 'models.list') {
      if (new URLSearchParams(location.search).get('slowModels') === '1') await new Promise((resolve) => setTimeout(resolve, 700));
      if (new URLSearchParams(location.search).get('modelError') === '1') return { v: 1, id: request.id, type: 'response.error', error: { code: 'MODELS_FAILED', message: 'Synthetic metadata lookup failure' } };
      const fail = (code, message) => ({ v: 1, id: request.id, type: 'response.error', error: { code, message } });
      if (body.connectionCheck) {
        // The key text decides the outcome, so a test can reach every failure the real core reports.
        const draft = typeof body.draftApiKey === 'string' ? body.draftApiKey : '';
        const identity = JSON.stringify([body.provider, body.baseUrl || '', body.wireFormat || '', draft]);
        const attempts = connectionAttempts.get(identity) || 0;
        connectionAttempts.set(identity, attempts + 1);
        const storedKey = (!fresh || freshKeySaved) && new URLSearchParams(location.search).get('missingKey') !== '1';
        if (!draft && !storedKey) return fail('KEY_MISSING', 'API key is missing');
        if (draft.startsWith('offline-') && attempts === 0) return fail('NETWORK_ERROR', 'request failed');
        const failures = { 'bad-': ['AUTH_FAILED', 'HTTP 401'], 'nocredit-': ['NO_CREDIT', 'HTTP 402'], 'rate-': ['RATE_LIMITED', 'HTTP 429'], 'down-': ['PROVIDER_ERROR', 'HTTP 503'], 'timeout-': ['TIMEOUT', 'timed out'] };
        for (const [prefix, [code, message]] of Object.entries(failures)) if (draft.startsWith(prefix)) return fail(code, message);
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      const catalog = [
        { id: 'xiaomi/mimo-v2.6-flash', display_name: 'MiMo V2.6 Flash' },
        { id: 'deepseek/deepseek-v4.1-flash', supported_parameters: ['reasoning'], reasoning: { mandatory: false, default_enabled: true, default_effort: 'high', supported_efforts: ['max', 'high', 'low'] } },
        { id: 'mandatory-fixture', reasoning: { mandatory: true, supported_efforts: ['high'] } },
        { id: 'google/gemini-2.5-flash-lite', display_name: 'Gemini 2.5 Flash Lite', pricing_prompt: '0.0000001', pricing_completion: '0.0000004', context_length: 1048576 },
        { id: 'openai/gpt-5-mini', display_name: 'GPT-5 Mini', pricing_prompt: '0.00000025', pricing_completion: '0.000002', context_length: 400000, supported_parameters: ['reasoning'], reasoning: { mandatory: false, default_enabled: true, default_effort: 'medium', supported_efforts: ['high', 'medium', 'low'] } },
        { id: 'anthropic/claude-haiku-4.5', display_name: 'Claude Haiku 4.5', pricing_prompt: '0.000001', pricing_completion: '0.000005', context_length: 200000 },
        { id: 'openai/gpt-5.1', display_name: 'GPT-5.1', pricing_prompt: '0.00000125', pricing_completion: '0.00001', context_length: 400000 },
        { id: 'openai/gpt-image-1', display_name: 'GPT Image 1', suitable: false },
        { id: 'openai/whisper-1', display_name: 'Whisper', suitable: false },
        { id: 'openai/text-embedding-3-large', display_name: 'Text Embedding 3 Large', suitable: false }
      ].map((model) => ({ suitable: true, ...model }));
      return ok(request, { cached: new URLSearchParams(location.search).get('cachedModels') === '1', hiddenCount: catalog.filter((model) => !model.suitable).length, models: catalog });
    }
    if (type === 'prompt.enhance') return ok(request, { enhancedPrompt: '중세 판타지 분위기에 맞추어 짧고 자연스럽게 번역하세요.' });
    if (type === 'scan.start') {
      if (current === 'scan-running') {
        setTimeout(() => emit('pomi-progress', { v: 1, id: request.id, type: 'scan.progress', payload: { event: 'scan_start', total_files: 96 } }), 50);
        setTimeout(() => emit('pomi-progress', { v: 1, id: request.id, type: 'scan.progress', payload: { event: 'file_start', phase: 'collect', index: 37, total: 96 } }), 120);
        return new Promise((resolve) => setTimeout(() => resolve(ok(request, scan)), 60000));
      }
      return ok(request, scan);
    }
    if (type === 'translate.start' || type === 'translate.resume') {
      if (current === 'run-progress') {
        // Two batches finish a second apart, so the remaining-time estimate appears after the second one.
        progressEvents(request, 'translate.progress', [
          [50, { event: 'phase_start', phase: 'translate', total: 6, requests_estimate: 3 }],
          [400, { event: 'translation_progress', completed: 2, total: 6, failed: 0, batch: 1, batches: 3, requests: 1 }],
          [450, { event: 'translation_sample', source: 'Welcome to Roguefire', translated: '로그파이어에 오신 것을 환영합니다' }],
          [500, { event: 'translation_sample', source: 'The Lost Key Shop', translated: '잃어버린 열쇠 상점' }],
          [1500, { event: 'translation_progress', completed: 4, total: 6, failed: 0, batch: 2, batches: 3, requests: 2 }],
          [1550, { event: 'translation_sample', source: 'Merchant of the Northern Gate', translated: '북문의 상인' }]
        ]);
        return new Promise((resolve) => setTimeout(() => resolve(ok(request, resultPayload('completed'))), 60000));
      }
      if (current.startsWith('result-')) {
        ensureJob(body.excludedCandidateIds);
        const staged = resultPayload(current.slice('result-'.length));
        job.requests = staged.jobProviderRequests ?? 0;
        return ok(request, staged);
      }
      const resuming = type === 'translate.resume';
      const budgetStop = query.get('budget') === '1' && !body.budgetOverride && !job;
      if (!resuming || !job) makeJob('review', body.excludedCandidateIds);
      if (budgetStop) {
        makeJob('budget_stopped', body.excludedCandidateIds).requests = 1;
        return ok(request, jobResult('budget_stopped', { providerRequests: 1 }));
      }
      if (job.status === 'budget_stopped') job.rows.forEach((row) => { row.status = 'translated'; row.reason = ''; row.detail = ''; });
      job.requests += 1;
      progressEvents(request, 'translate.progress', [
        [10, { event: 'phase_start', phase: 'translate', total: job.rows.length, requests_estimate: 1 }],
        [30, { event: 'translation_progress', completed: job.rows.length, total: job.rows.length, failed: 0, batch: 1, batches: 1, requests: 1 }]
      ]);
      await sleep(80);
      if (settings.review_before_apply) {
        job.status = 'awaiting_review';
        return ok(request, jobResult('awaiting_review', { providerRequests: 1 }));
      }
      // Single pass: written straight away, failed rows stay original.
      job.applied = true;
      job.backupSetId = backups[0].backupSetId;
      job.status = job.rows.some((row) => row.status === 'failed') ? 'partial' : 'completed';
      return ok(request, jobResult(job.status, { providerRequests: 1 }));
    }
    if (type === 'translations.page') {
      if (query.get('nocp') === '1') return { v: 1, id: request.id, type: 'response.error', error: { code: 'RESUME_NOT_AVAILABLE', message: 'No saved translations', recoverable: true } };
      ensureJob(['tellraw']);
      return ok(request, pagePayload(body));
    }
    if (type === 'translate.retry_failed') {
      ensureJob(['tellraw']);
      progressEvents(request, 'translate.progress', [
        [10, { event: 'phase_start', phase: 'translate', total: job.rows.filter((row) => row.status === 'failed').length, requests_estimate: 1 }]
      ]);
      await sleep(80);
      job.requests += 1;
      if (query.get('retryFail') !== '1') job.rows.forEach((row) => { if (row.status === 'failed' && row.edit === undefined) { row.status = 'translated'; row.reason = ''; row.detail = ''; } });
      job.status = 'awaiting_review';
      job.usage = { ...job.usage, prompt_tokens: job.usage.prompt_tokens + 120, completion_tokens: job.usage.completion_tokens + 40, cost: job.usage.cost + 0.00006 };
      return ok(request, jobResult('awaiting_review', { providerRequests: 1, backupSetId: job.applied ? job.backupSetId : '', changedFileCount: 0 }));
    }
    if (type === 'translate.apply' || type === 'translate.reapply') {
      ensureJob(['tellraw']);
      const reapply = type === 'translate.reapply';
      if (!reapply && job.applied) return { v: 1, id: request.id, type: 'response.error', error: { code: 'ALREADY_APPLIED', message: 'Use reapply', recoverable: true } };
      if (reapply && !job.applied) return { v: 1, id: request.id, type: 'response.error', error: { code: 'NOTHING_TO_REAPPLY', message: 'Nothing to reapply', recoverable: true } };
      if (query.get('worldChanged') === '1' && reapply) return { v: 1, id: request.id, type: 'response.error', error: { code: 'WORLD_CHANGED_SINCE_APPLY', message: 'World changed', recoverable: true } };
      const refusal = applyEdits(request, body.edits);
      if (refusal) return refusal;
      progressEvents(request, 'translate.progress', [
        [10, { event: 'phase_start', phase: 'write', total: 8 }],
        [40, { event: 'file_start', phase: 'write', index: 3, total: 8 }]
      ]);
      await sleep(120);
      job.applied = true;
      job.backupSetId = backups[0].backupSetId;
      job.status = job.rows.some((row) => row.status === 'failed') ? 'partial' : 'completed';
      return ok(request, jobResult(job.status, reapply ? { recoverySetId: 'recovery-before-reapply' } : {}));
    }
    if (type === 'restore.start') return ok(request, { status: 'restored', recoverySetId: 'recovery-before-restore' });
    if (type === 'credentials.delete') {
      const cleared = JSON.parse(sessionStorage.getItem('pomi.fixture.cleared') || '[]');
      sessionStorage.setItem('pomi.fixture.cleared', JSON.stringify([...cleared, body.provider]));
      return ok(request, { deleted: true });
    }
    return ok(request, {});
  }

  window.__pomiEmit = (name, payload) => {
    for (const listener of listeners.values()) if (listener.event === name) callbacks.get(listener.handler)?.({ event: name, id: listener.id, payload });
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener(event, id) { listeners.delete(id); } };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    plugins: { path: { sep: '/', delimiter: ':' } },
    transformCallback(callback) { const id = ++callbackId; callbacks.set(id, callback); return id; },
    unregisterCallback(id) { callbacks.delete(id); },
    runCallback(id, data) { callbacks.get(id)?.(data); },
    convertFileSrc(path) { return path; },
    async invoke(command, args = {}) {
      if (command === 'export_document') {
        const filename = args.kind === 'settings' ? 'pomi-settings.json' : args.kind === 'scan_report' ? 'scan-report.json' : 'translate-report.json';
        const url = URL.createObjectURL(new Blob([JSON.stringify(args.document, null, 2)], { type: 'application/json' }));
        const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return true;
      }
      if (command === 'plugin:event|listen') {
        if (scenario() === 'startup-listeners') return new Promise(() => {});
        const id = ++eventId; listeners.set(id, { id, event: args.event, handler: args.handler }); return id;
      }
      if (command === 'plugin:event|unlisten') { listeners.delete(args.eventId); return null; }
      if (command === 'plugin:dialog|open') return window.__pomiDialogFiles ?? null;
      if (command === 'set_unsaved_settings') { window.__pomiNativeCalls.push({ command, args }); window.__pomiUnsavedSettings = args.unsaved; return null; }
      if (command === 'close_guard_ack' || command === 'finish_close') { window.__pomiNativeCalls.push({ command, args }); return null; }
      if (command === 'plugin:notification|is_permission_granted') return false;
      if (command === 'credential_status') return { stored: new URLSearchParams(location.search).get('missingKey') !== '1' && (!fresh || freshKeySaved), mode: credentialModes.get(args.provider) || 'local' };
      if (command === 'credential_import') return { stored: true, mode: 'local' };
      if (command === 'operation_active') return false;
      if (command === 'open_external') { (window.__pomiOpened ||= []).push(args.url); return null; }
      if (command === 'data_locations') return { data: '/Users/fixture/Library/Application Support/PomiTranslate', app: '/Users/fixture/Library/Application Support/app.pomitranslate.desktop' };
      if (command === 'reveal_world_folder') { window.__pomiWorldRevealed = args.worldDir; return null; }
      if (command === 'reveal_data_folder') { window.__pomiRevealed = (window.__pomiRevealed || 0) + 1; return null; }
      if (command === 'plugin:app|version') return '0.1.0';
      if (command === 'update_check') {
        window.__pomiUpdateChecks = (window.__pomiUpdateChecks || 0) + 1;
        const mode = new URLSearchParams(location.search).get('update') || 'current';
        if (mode === 'offline') throw 'UPDATE_UNREACHABLE';
        const releaseUrl = 'https://github.com/kim0040/PomiTranslate/releases/latest';
        if (mode === 'current') return { status: 'current', currentVersion: '0.1.0', canInstall: true, releaseUrl };
        return { status: 'available', currentVersion: '0.1.0', version: '0.2.0', notes: 'Faster scans.\nFixes.', date: '2026-10-20', canInstall: mode !== 'unsigned', releaseUrl };
      }
      if (command === 'update_install') {
        window.__pomiInstalled = true;
        emit('pomi-update-progress', { downloaded: 512, total: 1024 });
        return new Promise(() => {}); // the real app restarts here
      }
      if (command === 'cancel_active') return true;
      if (command === 'sidecar_request') return sidecar(args.request);
      // Window chrome calls are decoration in the preview: accept and record them.
      if (command.startsWith('plugin:window|') || command === 'set_menu_labels' || command === 'set_menu_theme') { (window.__pomiChrome ||= []).push({ command, args }); return null; }
      throw new Error(`Unsupported fixture command: ${command}`);
    }
  };
  if (scenario() !== 'first-run') localStorage.setItem('pomi.notice.v1', 'accepted');
  else localStorage.removeItem('pomi.notice.v1');
  localStorage.setItem('pomi.theme.v1', new URLSearchParams(location.search).get('theme') || (scenario() === 'dark-review' ? 'dark' : 'light'));
})();
