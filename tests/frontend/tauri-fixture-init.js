(() => {
  // Documentation previews use the same UI with an explicit, validated locale.
  const requestedLocale = new URLSearchParams(location.search).get('locale');
  const previewLocale = ['ko', 'en', 'ja', 'zh'].includes(requestedLocale) ? requestedLocale : 'ko';
  const previewLanguages = { ko: '한국어', en: 'English', ja: '日本語', zh: '简体中文' };
  const previewTranslations = { ko: '잃어버린 열쇠 상점', en: 'The Lost Key Shop', ja: '失われた鍵の店', zh: '失落的钥匙商店' };
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
  // System notifications go through the shell's notification plugin (see `plugin:notification|*` below):
  // __pomiNotifications records what was shown and __pomiNotificationPermissionRequests each permission question.
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
  if (new URLSearchParams(location.search).get('sourceLang') === 'ja') candidates[0].source = 'ようこそ、ローグファイアへ';
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
    { backupSetId: '2026-09-29T16-24-18Z-translation', createdAt: '2026-09-29T16:24:18+09:00', fileCount: 69, verified: true, kind: 'translation', sizeBytes: 1843200, inWorldFolder: false, journalState: 'committed', legacy: false },
    { backupSetId: 'legacy-2026-09-28T12-10-00', createdAt: '2026-09-28T12:10:00+09:00', fileCount: 12, verified: false, kind: 'recovery', sizeBytes: 512000, inWorldFolder: true, journalState: null, legacy: true }
  ];
  // ?scenario=backups-many: enough app-managed sets to exercise "keep latest N".
  if (new URLSearchParams(location.search).get('scenario') === 'backups-many') {
    for (let i = 0; i < 5; i++) {
      backups.push({ backupSetId: `2026-09-2${i}T10-00-00Z-translation`, createdAt: `2026-09-2${i}T10:00:00+09:00`, fileCount: 40 + i, verified: true, kind: 'translation', sizeBytes: 900000 + i * 1000, inWorldFolder: false, journalState: 'committed', legacy: false });
    }
  }
  // ?scenario=backups-last-copy: a single app set that cannot be replaced.
  if (new URLSearchParams(location.search).get('scenario') === 'backups-last-copy') backups.splice(1, 1);
  // ?backups=none: a world that was never translated.
  if (new URLSearchParams(location.search).get('backups') === 'none') backups.length = 0;
  const lastCopyIds = () => (backups.filter((item) => !item.inWorldFolder).length === 1 ? [backups.find((item) => !item.inWorldFolder).backupSetId] : []);
  const backupUsage = () => ({
    worldBytes: backups.reduce((sum, item) => sum + (item.sizeBytes || 0), 0), worldCount: backups.length,
    appBytes: 123456789, appBytesApproximate: new URLSearchParams(location.search).get('scenario') === 'backups-many', lastCopyIds: lastCopyIds()
  });
  // Interrupted jobs the core lists on bootstrap (?scenario=interrupted).
  const recoveryMode = () => new URLSearchParams(location.search).get('recovery');
  const undoneResume = () => sessionStorage.getItem('pomi.fixture.undone') === 'true';
  const interruptedJobs = () => (undoneResume() ? [
    { jobId: 'job-earlier', kind: 'translate', worldPath: worldDir, worldName: 'Roguefire', createdAt: '2026-09-29T09:12:00+09:00', unitsTotal: 69, unitsVerified: 30, unitsUnknown: 0, needsAttention: true, legacy: false, state: 'partial', blocking: true }
  ] : ((['interrupted', 'interrupted-partial'].includes(scenario()) || (scenario() === 'recovery-required' && sessionStorage.getItem('pomi.fixture.rr') === 'true')) && sessionStorage.getItem('pomi.fixture.recovered') !== 'true' ? [
    { jobId: 'job-interrupted-1', kind: 'translate', worldPath: worldDir, worldName: 'Roguefire', createdAt: '2026-09-30T09:12:00+09:00', unitsTotal: 69, unitsVerified: 41, unitsUnknown: 3, needsAttention: true, legacy: false, state: scenario() === 'interrupted-partial' ? 'partial' : 'committing', blocking: true }
  ] : []));
  const drafts = JSON.parse(sessionStorage.getItem('pomi.fixture.drafts') || '{}');
  const saveDrafts = () => sessionStorage.setItem('pomi.fixture.drafts', JSON.stringify(drafts));
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
    review_before_apply: new URLSearchParams(location.search).get('review') !== '0', max_cost_usd: Number(new URLSearchParams(location.search).get('cap') || 0),
    custom_prices: {}
  };
  // ?provider=custom: a Custom endpoint. ?key=unbound: its saved key predates address binding, so the
  // shell refuses it (CREDENTIAL_ENDPOINT_UNBOUND) until a key is typed again.
  if (new URLSearchParams(location.search).get('provider') === 'custom') Object.assign(settings, { provider: 'custom', base_url: 'https://llm.example/v1', model: 'custom-model' });
  // ?provider=gemini&price=table: a Gemini model priced from the dated list-price table; price=unknown has no price at all.
  if (new URLSearchParams(location.search).get('provider') === 'gemini') Object.assign(settings, { provider: 'gemini', model: new URLSearchParams(location.search).get('model') || 'gemini-2.5-flash' });
  const keyUnbound = () => new URLSearchParams(location.search).get('key') === 'unbound' && sessionStorage.getItem('pomi.fixture.bound') !== 'true';
  // Saved manual translations from an earlier session, in the settings object format.
  if (new URLSearchParams(location.search).get('sourceOverrides') === '1') settings.source_overrides = { 'Welcome to Roguefire': '환영합니다', 'You are not ready yet.': '아직 준비가 안 됐군.' };
  // A fresh install: no model chosen and no key saved yet.
  const fresh = new URLSearchParams(location.search).get('fresh') === '1';
  if (fresh) Object.assign(settings, { provider: 'openai', model: '' });
  let freshKeySaved = false;
  // `unpriced=1`: the model has no price, so a spending limit cannot be enforced (the core answers `COST_CAP_UNPRICED`).
  const unpriced = new URLSearchParams(location.search).get('unpriced') === '1';
  const capUnenforceable = (body) => unpriced && settings.max_cost_usd > 0 && !body.unpricedCapAck && !settings.custom_prices?.[`${settings.provider}/${settings.model}`];
  const capRefusal = (request) => ({ v: 1, id: request.id, type: 'response.error', error: { code: 'COST_CAP_UNPRICED', message: 'A spending limit needs a known price.', recoverable: true } });
  const estimate = {
    candidateCount: candidates.length, requests: 1, sourceChars: 180, inputTokens: 720,
    outputTokens: 240, requestRange: { low: 1, high: 1 }, glossaryRetryRequests: 0, glossaryPromptChars: 0,
    inputTokensHigh: 720, outputTokensHigh: 240,
    price: { input: 0.00000015, output: 0.0000006, perMillionInput: 0.15, perMillionOutput: 0.6, source: 'catalog' },
    cost: { low: 0.000252, high: 0.000504 },
    // `reasoning=1` reports the reasoning allowance as included in the estimate.
    ...(new URLSearchParams(location.search).get('reasoning') === '1' ? { reasoningIncluded: true } : {})
  };
  // ?price=table|unknown fixes the price (and the cost) the estimate reports; the per-row cost model below leaves it alone.
  const priceMode = new URLSearchParams(location.search).get('price');
  if (priceMode === 'table') Object.assign(estimate, { price: { input: 3e-7, output: 2.5e-6, perMillionInput: 0.3, perMillionOutput: 2.5, source: 'table', checkedOn: '2026-10-23', sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing' }, cost: { low: 0.000816, high: 0.001632 } });
  if (priceMode === 'unknown') Object.assign(estimate, { price: null, cost: null });
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
  // ?chunks=clean|mixed|newer|skipped|empty|overflow|resumed-empty: what the scan saw chunk by chunk. Without it the core predates the field.
  // With ?scenario=interrupted-partial&chunks=newer, reloading the page is an app restart: the interrupted job (and its
  // newer coverage) persist, translate.resume refuses until acceptNewerVersion is true, and only then settles the job.
  const chunkMode = new URLSearchParams(location.search).get('chunks');
  const chunkEntry = (state, dataVersion, compression, status, count) => ({ state, dataVersion, compression, status, count });
  const chunkCounts = (processed, skipped = 0, unreadable = 0, notInspected = 0) => ({ processed, skipped_unsupported: skipped, unreadable, not_inspected: notInspected });
  function chunkCoverageFor(mode) {
    const base = { version: 1, levelDataVersion: 4189, levelDataVersions: [{ world: 'Roguefire', dataVersion: 4189 }], newestCovered: 4556 };
    const group = (dimension, kind, entries) => {
      const counts = chunkCounts(0);
      for (const entry of entries) counts[entry.status] += entry.count;
      const known = entries.filter((entry) => entry.state === 'known').map((entry) => entry.dataVersion);
      return { dimension, kind, counts, min: known.length ? Math.min(...known) : null, max: known.length ? Math.max(...known) : null, entries };
    };
    const finish = (groups, files, flags, distribution, extra = {}) => {
      const counts = chunkCounts(0);
      for (const item of groups) for (const key of Object.keys(counts)) counts[key] += item.counts[key];
      const known = distribution.filter((item) => item.state === 'known').map((item) => item.dataVersion);
      return {
        ...base, groups, flags, counts: { ...counts, total: Object.values(counts).reduce((sum, value) => sum + value, 0) },
        chunkVersions: { min: known.length ? Math.min(...known) : null, max: known.length ? Math.max(...known) : null, distribution, ...(extra.versions || {}) },
        files: { scanned: 8, unreadable: 0, notInspected: 0, detectedUnsupported: {}, ...files },
        ...(extra.top || {})
      };
    };
    if (mode === 'clean') {
      return finish([group('overworld', 'region', [chunkEntry('known', 4189, 2, 'processed', 120)])], {}, { mixed: false, newer: false, missing: false },
        [{ dataVersion: 4189, state: 'known', count: 120 }]);
    }
    if (mode === 'mixed') {
      return finish([
        group('overworld', 'region', [chunkEntry('known', 4189, 2, 'processed', 60), chunkEntry('known', 4556, 4, 'processed', 30), chunkEntry('missing', null, 2, 'processed', 10)]),
        group('the_nether', 'region', [chunkEntry('known', 4189, 2, 'processed', 20)])
      ], {}, { mixed: true, newer: false, missing: true }, [
        { dataVersion: null, state: 'missing', count: 10 }, { dataVersion: 4189, state: 'known', count: 80 }, { dataVersion: 4556, state: 'known', count: 30 }
      ]);
    }
    if (mode === 'newer') {
      return finish([
        group('overworld', 'region', [chunkEntry('known', 4189, 2, 'processed', 90), chunkEntry('known', 4800, 4, 'processed', 30)])
      ], {}, { mixed: true, newer: true, missing: false }, [{ dataVersion: 4189, state: 'known', count: 90 }, { dataVersion: 4800, state: 'known', count: 30 }]);
    }
    if (mode === 'overflow') {
      // One file met more version/compression combinations than the report itemises: the surplus is overflow, the range stays exact.
      const overflowGroup = group('overworld', 'region', [chunkEntry('known', 4000, 2, 'processed', 1), chunkEntry('overflow', null, null, 'processed', 12), chunkEntry('unobserved', null, 127, 'skipped_unsupported', 63)]);
      overflowGroup.min = 4000; overflowGroup.max = 5000; overflowGroup.overflow = 12; overflowGroup.writeBlockedFiles = 1;
      return finish([overflowGroup], {}, { mixed: true, newer: true, missing: false }, [{ dataVersion: 4000, state: 'known', count: 1 }],
        { versions: { min: 4000, max: 5000, truncated: true, overflow: 12 } });
    }
    if (mode === 'resumed-empty') {
      // A scan continued from a checkpoint made before chunk coverage existed: finished files were not searched again.
      return finish([group('overworld', 'region', [chunkEntry('known', 4189, 2, 'processed', 40)])], {}, { mixed: false, newer: false, missing: false },
        [{ dataVersion: 4189, state: 'known', count: 40 }], { top: { partial: true } });
    }
    // skipped / empty: part of the world was not searched.
    const searched = mode === 'empty' ? 0 : 100;
    return finish([
      group('overworld', 'region', [
        ...(searched ? [chunkEntry('known', 4189, 2, 'processed', searched)] : []),
        chunkEntry('known', 4189, 2, 'skipped_unsupported', 12), chunkEntry('unobserved', null, 127, 'skipped_unsupported', 3), chunkEntry('unobserved', null, 2, 'unreadable', 4)
      ]),
      group('overworld', 'entities', [chunkEntry('unobserved', null, null, 'not_inspected', 6)])
    ], { notInspected: 1 }, { mixed: false, newer: false, missing: false },
    [{ dataVersion: 4189, state: 'known', count: searched + 12 }]);
  }
  if (chunkMode) {
    scan.chunkCoverage = chunkCoverageFor(chunkMode);
    if (chunkMode === 'empty' || chunkMode === 'resumed-empty') Object.assign(scan, { candidateCount: 0, occurrenceCount: 0, kinds: {}, candidates: [], requestEstimate: 0 });
  }

  // ?vault=corrupt: the credential store cannot be opened until "reset credential storage" runs.
  function vaultBroken() {
    return new URLSearchParams(location.search).get('vault') === 'corrupt' && sessionStorage.getItem('pomi.fixture.vaultReset') !== 'true';
  }

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
  // The counts come from the job this page runs, or (fromJob false, and before any run) the saved checkpoint's two translations.
  function resumePayload(status = 'needs_retry', fromJob = true) {
    const live = fromJob ? job : null;
    return {
      available: true, scanPlanId: scan.scanPlanId, fingerprint: scan.fingerprint,
      candidateCount: candidates.length, occurrenceCount: scan.occurrenceCount, kinds: scan.kinds, coverage: scan.coverage, ...(scan.chunkCoverage ? { chunkCoverage: scan.chunkCoverage } : {}), candidates: candidates.slice(0, 200), excludedCandidateIds: ['tellraw'],
      candidateOverrides: { shop: previewTranslations[previewLocale] }, savedAt: 1790672400,
      lastScan: new URLSearchParams(location.search).get('scenario') === 'unscanned' ? null : { at: 1790585600, candidateCount: candidates.length },
      status, translatedCount: live ? live.rows.filter((row) => row.status !== 'failed').length : 2, failedCount: live ? live.rows.filter((row) => row.status === 'failed').length : 0,
      backupSetId: live?.backupSetId || '', recoverySetId: live?.recoverySetId,
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
  // result-<status>[-resume|-bare]: -resume keeps a checkpoint after the run, the others leave none (see resume.status).
  function resultStatus(current) {
    return current.startsWith('result-') ? current.slice('result-'.length).split('-')[0] : 'completed';
  }
  // The glossary, kept in memory for the page and in sessionStorage across reloads.
  // ?glossary=seeded|conflict-once|invalid|busy-once|write-failed|unsupported
  // ?glossaryHold=save|import: that request waits until the test calls window.__pomiRelease().
  // ?glossaryExport=save|cancel|fail: the app (not a browser) saves the export through the shell's save dialog,
  // which writes the file, is dismissed, or cannot write it. Without the parameter the export is a download.
  if (new URLSearchParams(location.search).has('glossaryExport')) window.isTauri = true;
  const glossaryMode = () => new URLSearchParams(location.search).get('glossary') || '';
  const glossaryStore = () => JSON.parse(sessionStorage.getItem('pomi.fixture.glossary') || '{}');
  const glossaryPut = (store) => sessionStorage.setItem('pomi.fixture.glossary', JSON.stringify(store));
  const glossaryKey = (body) => (body.scope === 'world' ? `world:${body.worldDir}` : 'global');
  // ?editedMismatch=1 / ?estimateRange=1 start with one global entry that matches the first sentence.
  const glossarySeed = () => (glossaryMode() === 'seeded' ? [
    { id: '1'.repeat(20), source: 'Elder Mira', target: '', mode: 'keep', caseSensitive: false, note: 'village elder' },
    { id: '2'.repeat(20), source: 'Lost Key', target: '잃어버린 열쇠', mode: 'translate', caseSensitive: true, note: '' }
  ] : new URLSearchParams(location.search).get('editedMismatch') === '1'
    ? [{ id: '3'.repeat(20), source: 'Welcome to Roguefire', target: 'ログファイア', mode: 'translate', caseSensitive: false, note: '' }]
    : new URLSearchParams(location.search).get('estimateRange') === '1'
      ? [{ id: '4'.repeat(20), source: 'Welcome to Roguefire', target: '로그파이어', mode: 'translate', caseSensitive: false, note: '' }]
      : []);
  const glossaryDoc = (body) => {
    const store = glossaryStore();
    const found = store[glossaryKey(body)];
    return { scope: body.scope, revision: found ? found.revision : 0, updatedAt: found ? '2026-10-20T00:00:00+00:00' : null, entries: found ? found.entries : (body.scope === 'global' ? glossarySeed() : []) };
  };
  const glossaryError = (request, code, message) => ({ v: 1, id: request.id, type: 'response.error', error: { code, message, recoverable: true } });
  const glossaryNewId = () => Array.from({ length: 20 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
  // RFC 4180 cells: quotes may hold separators, doubled quotes and line breaks.
  function glossaryRows(text, sep) {
    const rows = []; let row = []; let cell = ''; let quoted = false; let wasQuoted = false;
    const push = () => { row.push(wasQuoted ? cell : cell.trim()); cell = ''; wasQuoted = false; };
    const finish = () => { push(); if (row.some((c) => c !== '')) rows.push(row); row = []; };
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += c;
      } else if (c === '"' && cell.trim() === '') { quoted = true; wasQuoted = true; cell = ''; }
      else if (c === sep) push();
      else if (c === '\n') finish();
      else if (c === '\r') { if (text[i + 1] === '\n') i++; finish(); }
      else cell += c;
    }
    if (cell !== '' || row.length) finish();
    return rows;
  }
  function glossaryParse(text, format) {
    const sep = format === 'tsv' ? '\t' : ',';
    const lines = glossaryRows(text.replace(/^﻿/, ''), sep);
    const out = []; const skipped = [];
    lines.forEach((cells, index) => {
      if (index === 0 && ['source', 'original'].includes((cells[0] || '').toLowerCase())) return;
      const [source = '', target = '', mode = '', note = '', flag = ''] = cells;
      const row = index + 1;
      if (!source) { skipped.push({ row, reason: 'empty_source', source }); return; }
      const kind = mode.toLowerCase() === 'keep' ? 'keep' : 'translate';
      if (mode && !['keep', 'translate'].includes(mode.toLowerCase())) { skipped.push({ row, reason: 'invalid_mode', source }); return; }
      if (kind === 'translate' && !target) { skipped.push({ row, reason: 'missing_target', source }); return; }
      if (out.some((item) => item.source.toLowerCase() === source.toLowerCase())) { skipped.push({ row, reason: 'duplicate_in_file', source }); return; }
      out.push({ source, target: kind === 'keep' ? '' : target, mode: kind, note, caseSensitive: flag.toLowerCase() === 'true' });
    });
    return { rows: out, skipped };
  }
  const glossaryCell = (value) => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  const glossaryHold = (what) => (new URLSearchParams(location.search).get('glossaryHold') === what
    ? new Promise((resolve) => { window.__pomiRelease = resolve; }) : null);

  // --- the saved translation job (what the sidecar keeps in its checkpoint) -------------------
  const query = new URLSearchParams(location.search);
  const firstLaunch = scenario() === 'first-run';
  const fixturePrefs = firstLaunch ? {} : {
    theme: query.get('theme') || (scenario() === 'dark-review' ? 'dark' : 'light'),
    notice_accepted: true,
    tutorial_seen: true,
    setup_dismissed: true,
    update_auto_check: true,
    update_last_check: 0,
    update_skipped_version: '',
    notify_on_finish: query.get('notify') !== 'off'
  };
  if (query.has('theme')) fixturePrefs.theme = query.get('theme');
  if (query.get('notify') === 'off') fixturePrefs.notify_on_finish = false;
  window.__pomiPrefs = fixturePrefs;
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
  // Result scenarios whose run wrote to the world (the others wrote nothing).
  const APPLIED_KINDS = ['success', 'completed', 'partial', 'quality', 'codes'];
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
      if ((scenario() === 'glossary-mismatch' || query.get('glossaryMismatch') === '1') && rows[0]) rows[0].status = 'glossary_mismatch';
      if (query.get('stale') === '1' && rows[1]) rows[1].glossaryFixtureStale = true;
      if (query.get('editedMismatch') === '1' && rows[0]) {
        rows[0].status = 'glossary_mismatch';
        rows[0].edit = '별칭';
      }
    }
    job = {
      kind, rows, status: kind === 'review' ? 'awaiting_review' : kind === 'success' ? 'completed' : kind, excluded: [...skip],
      applied: APPLIED_KINDS.includes(kind), backupSetId: APPLIED_KINDS.includes(kind) ? backups[0].backupSetId : '',
      requests: 0, usage: { prompt_tokens: 712, completion_tokens: 231, cost: 0.00025, cost_reported: true },
      glossaryHashes: Object.fromEntries(rows.map((row) => [row.source, glossaryHash(row.source)]))
    };
    return job;
  }
  function ensureJob(excluded) {
    if (job) return job;
    const current = scenario();
    const kind = current.startsWith('result-') ? resultStatus(current) : 'review';
    // The result scenarios describe a job over all six sentences; the others leave the command text out.
    return makeJob(kind, current.startsWith('result-') ? [] : excluded ?? (['scanned', 'review', 'run', 'run-progress', 'dark-review'].includes(current) ? ['tellraw'] : []));
  }
  /** The glossary the job translates with: the saved global list, with this world's entries winning. */
  function effectiveGlossary() {
    const worldEntries = glossaryDoc({ scope: 'world', worldDir }).entries;
    return [...glossaryDoc({ scope: 'global' }).entries.filter((entry) => !worldEntries.some((other) =>
      entry.source === other.source || ((!entry.caseSensitive || !other.caseSensitive) && entry.source.toLowerCase() === other.source.toLowerCase())
    )), ...worldEntries];
  }
  function termMatches(text, entry) {
    const source = entry.source;
    if (!source) return false;
    if (/[\u3040-\u30ff\u3400-\u9fff]/.test(source)) return (entry.caseSensitive ? text : text.toLowerCase()).includes(entry.caseSensitive ? source : source.toLowerCase());
    const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<!\\w)${escaped}(?!\\w)`, entry.caseSensitive ? '' : 'i').test(text);
  }
  function glossaryHash(source) { return JSON.stringify(effectiveGlossary().filter((entry) => termMatches(source, entry))); }
  function fixtureGlossaryBlock(entries, reminder = false) {
    const translating = entries.filter((entry) => (entry.mode || 'translate') === 'translate').map((entry) => ({ source: entry.source, target: entry.target }));
    const keeping = entries.filter((entry) => entry.mode === 'keep').map((entry) => entry.source);
    if (!translating.length && !keeping.length) return '';
    const lines = ['', '[FIXED GLOSSARY — BEGIN]'];
    if (reminder) lines.push('Reminder: follow every glossary rule below exactly; these rules are mandatory.');
    if (translating.length) {
      lines.push('Use these fixed translations exactly (do not vary their spelling):');
      lines.push(JSON.stringify(translating));
    }
    if (keeping.length) {
      lines.push('Keep these terms untranslated exactly as written:');
      lines.push(JSON.stringify(keeping));
    }
    lines.push('[FIXED GLOSSARY — END]');
    return lines.join('\n');
  }
  function estimateForRows(rows) {
    const count = rows.length;
    const requests = Math.ceil(count / settings.batch_size);
    const entriesFor = (batch) => effectiveGlossary().filter((entry) => batch.some((row) => termMatches(row.source, entry)));
    let glossaryPromptChars = 0;
    for (let index = 0; index < count; index += settings.batch_size) {
      glossaryPromptChars += fixtureGlossaryBlock(entriesFor(rows.slice(index, index + settings.batch_size))).length;
    }
    const matchedRows = rows.map((row) => entriesFor([row])).filter((entries) => entries.length);
    const glossaryRetryRequests = matchedRows.length;
    const reminderPromptChars = matchedRows.reduce((total, entries) => total + fixtureGlossaryBlock(entries, true).length, 0);
    const scale = count / Math.max(1, candidates.length);
    const inputTokens = Math.ceil(estimate.inputTokens * scale) + Math.ceil(glossaryPromptChars / 4);
    const outputTokens = Math.ceil(estimate.outputTokens * scale);
    const inputTokensHigh = inputTokens + Math.ceil(reminderPromptChars / 4);
    const outputTokensHigh = outputTokens + glossaryRetryRequests * 40;
    return {
      ...estimate,
      candidateCount: count,
      requests,
      requestRange: { low: requests, high: requests + glossaryRetryRequests },
      glossaryRetryRequests,
      glossaryPromptChars,
      sourceChars: Math.ceil(estimate.sourceChars * scale),
      inputTokens,
      outputTokens,
      inputTokensHigh,
      outputTokensHigh,
      cost: priceMode ? estimate.cost : {
        low: 0.000042 * count + glossaryPromptChars / 4 * estimate.price.input,
        high: 0.000084 * (count + glossaryRetryRequests) + (glossaryPromptChars + reminderPromptChars) / 4 * estimate.price.input
      }
    };
  }
  function glossaryStale(row) { return row.status !== 'failed' && (row.glossaryFixtureStale || job.glossaryHashes?.[row.source] !== glossaryHash(row.source)); }
  const viewRow = (row, drafts = new Set()) => {
    const edited = row.edit !== undefined;
    const glossaryMismatch = row.status === 'glossary_mismatch';
    return {
      id: row.id, source: row.source, kind: row.kind, occurrences: row.occurrences, ai: row.status === 'failed' ? '' : row.ai,
      translated: row.edit !== undefined ? row.edit : row.status === 'failed' ? '' : row.ai,
      glossaryStale: glossaryStale(row),
      edited, glossaryMismatch,
      status: glossaryMismatch ? row.status : edited || drafts.has(row.id) ? 'edited' : row.status === 'translated' && row.ai === row.source ? 'kept' : row.status,
      ...(row.status === 'failed' && row.edit === undefined ? { reason: row.reason, detail: row.detail } : {})
    };
  };
  function jobCounts(drafts) {
    const counts = { all: 0, translated: 0, failed: 0, kept: 0, edited: 0, unsent: 0, errored: 0, glossary_mismatch: 0 };
    for (const row of job.rows) {
      counts.all++;
      const view = viewRow(row, drafts);
      counts[view.status]++;
      if (view.status === 'failed') counts[isUnsent(row) ? 'unsent' : 'errored']++;
    }
    return counts;
  }
  function estimateRows(rows) { return rows.length ? estimateForRows(rows) : null; }
  Object.assign(estimate, estimateForRows(candidates));
  function retryRows() {
    return job.rows.filter((row) => (row.status === 'failed' && row.edit === undefined) || glossaryStale(row));
  }
  function retryEstimate() {
    return estimateRows(retryRows());
  }
  function glossaryRefreshRows() {
    return job.rows.filter(glossaryStale);
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
      meta: { status: job.status, applied: job.applied, backupSetId: job.backupSetId, recoverySetId: job.recoverySetId,
        failedCount: job.rows.filter((row) => row.status === 'failed').length, retryCount: retryRows().length,
        unsentCount: job.rows.filter(isUnsent).length, usage: { ...job.usage, requests: job.requests }, retryEstimate: retryEstimate(),
        glossaryActive: effectiveGlossary().length > 0, glossaryStaleCount: glossaryRefreshRows().length, glossaryRefreshCount: glossaryRefreshRows().length,
        glossaryRefreshEstimate: estimateRows(glossaryRefreshRows()), glossaryRefreshed: !!job.glossaryRefreshed }
    };
  }
  function jobResult(status, extra = {}) {
    const unsent = job.rows.filter(isUnsent);
    const failed = job.rows.filter((row) => row.status === 'failed' && !isUnsent(row));
    const mismatchRows = job.rows.filter((row) => row.status === 'glossary_mismatch').map((row) => ({ source: row.source, reason: 'glossary_mismatch' }));
    const unchanged = job.rows.filter((row) => row.status === 'translated' && row.ai === row.source && row.edit === undefined).length;
    return {
      status, candidateCount: candidates.length, changedFileCount: job.applied ? 8 : 0, providerRequests: 0, backupSetId: job.applied ? job.backupSetId : '', preTranslate: '', localhostServer: false,
      errors: [], warnings: mismatchRows.length ? [{ code: 'GLOSSARY_MISMATCH', count: mismatchRows.length }] : [],
      glossaryMismatchCount: mismatchRows.length, glossaryMismatches: mismatchRows,
      priceSource: settings.custom_prices?.[`${settings.provider}/${settings.model}`] ? 'user' : null,
      translation: { unique: job.rows.length, translated: job.rows.length - failed.length - unsent.length - unchanged, failed: failed.length, kept_original: 0, unchanged, pending: unsent.length },
      translationFailures: failed.slice(0, 20).map((row) => ({ source: row.source, reason: row.reason, detail: row.detail })),
      translationSamples: job.rows.filter((row) => row.status !== 'failed').slice(0, 12).map((row) => ({ source: row.source, translated: row.edit ?? row.ai })), keptOriginalSamples: [],
      // The job's own totals, like the usage: this call's providerRequests is in `extra`.
      jobProviderRequests: job.requests, usage: { ...job.usage, requests: job.requests },
      ...(job.costCapUnenforced ? { costCapEnforced: false } : {}), ...extra
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
    if (status === 'quality') return {
      status: 'completed', candidateCount: candidates.length, changedFileCount: 8, providerRequests: 2,
      backupSetId: backups[0].backupSetId,
      translation: { unique: 6, translated: 6, failed: 0, kept_original: 0, unchanged: 0 },
      translationWarnings: { glossary_mismatch: 7, format_residue: 1, glossary_truncated: 1 },
      translationWarningSamples: [
        { code: 'glossary_mismatch', entryId: 'global:' + '1'.repeat(20), source: 'Elder Mira greets you', translated: '장로 미라가 인사합니다' },
        { code: 'glossary_mismatch', entryId: 'global:' + '2'.repeat(20), source: 'The Lost Key Shop', translated: '분실 열쇠 상점' },
        { code: 'glossary_mismatch', entryId: 'world:' + '9'.repeat(20), source: 'Gate of Dawn', translated: '새벽의 문' },
        { code: 'format_residue', source: '§lcrypt', translated: '§lc지하실' },
        { code: 'glossary_mismatch', entryId: 'global:' + '1'.repeat(20), source: 'Elder Mira again', translated: '장로 미라 다시' },
        { code: 'glossary_mismatch', entryId: 'global:' + '1'.repeat(20), source: 'a sixth sample that must not be shown', translated: 'x' }
      ],
      warnings: [{ code: 'glossary_changed', dropped_translations: 4 }],
      usage: { prompt_tokens: 712, completion_tokens: 231, cost: 0.00025, cost_reported: true }
    };
    if (status === 'codes') return {
      status: 'partial', candidateCount: candidates.length, changedFileCount: 3, providerRequests: 4,
      backupSetId: backups[0].backupSetId,
      translation: { unique: 6, translated: 3, failed: 3, kept_original: 0, unchanged: 0 },
      translationFailures: [
        { source: 'Welcome to Roguefire', reason: 'RAW PROVIDER TEXT must never be shown', code: 'rate_limit' },
        { source: 'You are not ready yet.', reason: 'RAW PROVIDER TEXT must never be shown', code: 'format_mismatch' },
        { source: 'Merchant of the Northern Gate', reason: 'RAW PROVIDER TEXT must never be shown', code: 'brand_new_code' }
      ],
      translationFailureCodes: { rate_limit: 1, format_mismatch: 1, other: 1 },
      warnings: [{ code: 'chunk_too_large', file: 'region/r.0.0.mca', count: 2 }, { code: 'something_new', file: 'x' }],
      usage: { prompt_tokens: 540, completion_tokens: 180, cost: 0.00018, cost_reported: true, adapted_parameters: ['temperature'] }
    };
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
    const loggedPayload = type.startsWith('glossary.')
      ? { scope: body.scope, hasWorld: typeof body.worldDir === 'string' && !!body.worldDir, count: Array.isArray(body.entries) ? body.entries.length : undefined, baseRevision: body.baseRevision, mode: body.mode, format: body.format }
      : type === 'settings.set'
        ? { ...Object.fromEntries(Object.entries(loggable).filter(([key]) => !['glossary', 'customPrices'].includes(key))), glossaryCount: Array.isArray(body.glossary) ? body.glossary.length : undefined, customPriceCount: Object.keys(body.customPrices || {}).length }
        : JSON.parse(JSON.stringify(loggable));
    window.__pomiRequests.push({
      type, provider: body.provider, publicCatalog: body.publicCatalog, acceptNewerVersion: body.acceptNewerVersion, connectionCheck: body.connectionCheck,
      baseUrl: body.baseUrl, wireFormat: body.wireFormat,
      hasDraftKey: typeof body.draftApiKey === 'string' && body.draftApiKey.length > 0,
      draftKeyLength: typeof body.draftApiKey === 'string' ? body.draftApiKey.length : undefined,
      hasApiKey: typeof body.apiKey === 'string' && body.apiKey.length > 0, apiKeyLength: typeof body.apiKey === 'string' ? body.apiKey.length : undefined,
      payload: loggedPayload
    });
    const current = scenario();
    if (type === 'app.bootstrap') {
      bootstrapAttempts++;
      if (bootstrapAttempts === 1 && ['startup-handshake', 'startup-bootstrap', 'startup-stopped'].includes(current)) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        throw current === 'startup-handshake' ? 'CORE_HANDSHAKE_TIMEOUT'
          : current === 'startup-bootstrap' ? 'BOOTSTRAP_TIMEOUT'
          : { code: 'CORE_STOPPED', message: 'Translation core stopped before it returned a result' };
      }
      if (current === 'startup-delay') await new Promise((resolve) => setTimeout(resolve, 500));
      const empty = current === 'empty';
      const resumed = ['scanned', 'review', 'run', 'run-progress', 'recovery-required', 'translate-fails', 'result-success', 'result-failed', 'dark-review', 'home-resume', 'awaiting-review'].includes(current);
      const resultScenarios = ['result-quality', 'result-codes', 'result-partial', 'result-failed', 'result-failed-resume', 'result-needs_retry', 'result-needs_retry-bare', 'result-cancelled', 'result-invalidated', 'result-unsupported'];
      return ok(request, {
        notices: { firstLaunch: '', about: '', backupWarning: '', apiWarning: '' },
        // The app state is saved with the settings (empty on a first run, so the guide starts).
        settings: { ...settings, last_world_dir: empty ? '' : worldDir, app_prefs: { ...fixturePrefs } },
        prefs: { ...fixturePrefs },
        apiKeyStored: vaultBroken() ? false : !fresh || freshKeySaved, credentialMode: credentialModes.get(settings.provider) || initialCredentialMode,
        ...(vaultBroken() ? { credentialState: { mode: 'local', error: 'VAULT_CORRUPT' } } : {}),
        worlds: empty ? [] : [{ path: worldDir, name: 'Roguefire', lastOpened: 1790672400, available: true }],
        worldInspection: empty ? null : inspection, backups: empty ? [] : backups, interruptedJobs: interruptedJobs(),
        resume: current === 'awaiting-review' ? resumePayload('awaiting_review') : resumed || resultScenarios.includes(current) ? resumePayload() : { available: false },
        // ?history=none: the core has no record of an earlier scan or job (the summary falls back to the backups).
        lastJob: empty || current === 'unscanned' || query.get('history') === 'none' ? null : { world: 'Roguefire', at: 1790672300, status: 'partial', translated: 4, failed: 2, changedFiles: 4, candidateCount: 6 },
        lastScan: empty || current === 'unscanned' || query.get('history') === 'none' ? null : { at: 1790585600, candidateCount: candidates.length }
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
      window.__pomiSettingsSaves.push({ ...Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'apiKey' && !['glossary', 'customPrices'].includes(key))), glossaryCount: Array.isArray(body.glossary) ? body.glossary.length : undefined, customPriceCount: Object.keys(body.customPrices || {}).length });
      const aliases = { reviewBeforeApply: 'review_before_apply', maxCostUsd: 'max_cost_usd', customPrices: 'custom_prices', openrouterReasoning: 'openrouter_reasoning', externalResourcePackPaths: 'external_resource_pack_paths', resourcePackOptions: 'resource_pack_options', sourceOverrides: 'source_overrides', continueOnFileError: 'continue_on_file_error', maxFileWriteRetries: 'max_file_write_retries', targetLanguage: 'target_language', uiLanguage: 'ui_language', baseUrl: 'base_url', wireFormat: 'wire_format', resourcePackEnabled: 'resource_pack_enabled', skipTargetLanguageText: 'skip_target_language_text', scanOptions: 'scan_options' };
      for (const [key, value] of Object.entries(body)) {
        if (key !== 'apiKey' && key !== 'credentialMode') settings[aliases[key] || key] = value;
      }
      credentialModes.set(body.provider, body.credentialMode || 'local');
      if (body.apiKey) { freshKeySaved = true; sessionStorage.setItem('pomi.fixture.bound', 'true'); (window.__pomiKeySaves ||= []).push(body.provider); }
      return ok(request, { settings: { ...settings }, apiKeyStored: !fresh || freshKeySaved, credentialMode: body.credentialMode || 'local' });
    }
    if (type === 'prefs.set') {
      Object.assign(fixturePrefs, body.prefs || {});
      return ok(request, { prefs: { ...fixturePrefs } });
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
      // ?nocp=1: the core kept no checkpoint at all.
      if (query.get('nocp') === '1') return ok(request, { available: false });
      // A job this page started and has not finished (awaiting review, stopped at the limit, a reapply that stopped).
      if (job && (!job.applied || job.status === 'reapply_interrupted') && ['awaiting_review', 'budget_stopped', 'reapply_interrupted'].includes(job.status)) return ok(request, resumePayload(job.status));
      if (current === 'interrupted-partial') return ok(request, { ...resumePayload(), status: 'partial' });
      // result-<status>[-resume|-bare]: a cancelled or stopped run, or one named -resume, keeps a checkpoint; the others none.
      if (current.startsWith('result-')) return ok(request, ['result-cancelled', 'result-needs_retry', 'result-failed-resume'].includes(current) ? resumePayload(resultStatus(current), false) : { available: false });
      if (job && !job.applied && ['cancelled', 'needs_retry', 'failed'].includes(job.status)) return ok(request, resumePayload(job.status));
      return ok(request, { available: false });
    }
    if (type === 'backups.list') return ok(request, { backups: [...backups], usage: backupUsage() });
    if (type === 'backups.delete') {
      const index = backups.findIndex((item) => item.backupSetId === body.backupSetId);
      const fail = (code) => ({ v: 1, id: request.id, type: 'response.error', error: { code, message: 'raw core message' } });
      if (index < 0) return fail('BACKUP_NOT_FOUND');
      if (backups[index].journalState === 'unfinished') return fail('BACKUP_IN_USE_BY_RECOVERY');
      if (lastCopyIds().includes(body.backupSetId) && !body.acknowledgeLastCopy) return fail('BACKUP_LAST_COPY');
      const [gone] = backups.splice(index, 1);
      (window.__pomiDeleted ||= []).push(gone.backupSetId);
      return ok(request, { deleted: true, backupSetId: gone.backupSetId, location: body.location || 'app', freedBytes: gone.sizeBytes });
    }
    if (type === 'backups.prune') {
      const mine = backups.filter((item) => !item.inWorldFolder).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      const doomed = mine.slice(Math.max(1, Number(body.keepLatest || 1)));
      for (const item of doomed) backups.splice(backups.indexOf(item), 1);
      (window.__pomiPruned ||= []).push(doomed.map((item) => item.backupSetId));
      return ok(request, { deleted: doomed.map((item) => item.backupSetId), kept: mine.length - doomed.length, skipped: [], freedBytes: doomed.reduce((sum, item) => sum + item.sizeBytes, 0), failed: [] });
    }
    if (type === 'review.draft.get') {
      if (current === 'no-draft-support') return { v: 1, id: request.id, type: 'response.error', error: { code: 'UNSUPPORTED_REQUEST', message: 'unknown' } };
      const draft = drafts[body.scanPlanId];
      return ok(request, draft ? { scanPlanId: body.scanPlanId, exists: true, ...draft } : { scanPlanId: body.scanPlanId, exists: false, savedAt: null, excludedCandidateIds: [], candidateOverrides: {} });
    }
    if (type === 'review.draft.set') {
      if (current === 'no-draft-support') return { v: 1, id: request.id, type: 'response.error', error: { code: 'UNSUPPORTED_REQUEST', message: 'unknown' } };
      drafts[body.scanPlanId] = { savedAt: Date.now() / 1000, excludedCandidateIds: body.excludedCandidateIds || [], candidateOverrides: body.candidateOverrides || {} };
      saveDrafts();
      (window.__pomiDraftSaves ||= []).push({ ...drafts[body.scanPlanId] });
      return ok(request, { saved: true, savedAt: drafts[body.scanPlanId].savedAt, excludedCount: (body.excludedCandidateIds || []).length, overrideCount: Object.keys(body.candidateOverrides || {}).length });
    }
    if (type === 'review.draft.clear') {
      const existed = !!drafts[body.scanPlanId];
      delete drafts[body.scanPlanId];
      saveDrafts();
      return ok(request, { cleared: existed });
    }
    if (type === 'resume.discard') { (window.__pomiDiscards ||= []).push(body); return ok(request, { discarded: 2 }); }
    if (type === 'recovery.start') {
      (window.__pomiRecoveries ||= []).push({ jobId: body.jobId, mode: body.mode, ...(body.acceptConflicts ? { acceptConflicts: true } : {}) });
      setTimeout(() => emit('pomi-progress', { v: 1, id: request.id, type: 'recovery.progress', payload: { event: 'recovery_progress', phase: 'recovery', done: 20, total: 69 } }), 40);
      await new Promise((resolve) => setTimeout(resolve, 250));
      // ?recovery=undone-resume: the named job was an unpublished resume, so undoing it lists the earlier job again.
      if (recoveryMode() === 'undone-resume') {
        sessionStorage.setItem('pomi.fixture.undone', 'true');
        return ok(request, { jobId: body.jobId, mode: body.mode, state: 'rolled_back', settledBy: 'unpublished_continuation', restoredFiles: 0, keptFiles: 0, conflicts: [], quarantineDir: null });
      }
      // ?recovery=quarantine-failed: moving the conflicts aside failed (full disk), so the job stays open.
      if (recoveryMode() === 'quarantine-failed') {
        return ok(request, {
          jobId: body.jobId, mode: body.mode, state: 'recovery_conflict', errorCode: 'DISK_FULL', restoredFiles: 0, keptFiles: 0,
          conflicts: [{ path: 'region/r.0.0.mca', rootKind: 'world', code: 'UNIT_INCONSISTENT' }], quarantineDir: '/Users/fixture/quarantine/job-interrupted-1'
        });
      }
      sessionStorage.setItem('pomi.fixture.recovered', 'true');
      const conflicts = new URLSearchParams(location.search).get('conflict') === '1' && !body.acceptConflicts
        ? [{ path: 'region/r.0.0.mca', rootKind: 'world', code: 'RECOVERY_CONFLICT' }, { path: 'resources.zip', rootKind: 'external_pack', code: 'UNIT_INCONSISTENT' }] : [];
      if (conflicts.length) sessionStorage.removeItem('pomi.fixture.recovered');
      return ok(request, {
        jobId: body.jobId, mode: body.mode, state: conflicts.length ? 'recovery_conflict' : (body.mode === 'keep' ? 'kept' : 'rolled_back'),
        restoredFiles: body.mode === 'keep' ? 0 : 41, keptFiles: body.mode === 'keep' ? 41 : 0, conflicts,
        quarantineDir: conflicts.length ? '/Users/fixture/quarantine/job-interrupted-1' : null
      });
    }
    if (type === 'estimate.get') {
      if (new URLSearchParams(location.search).get('slowEstimate') === '1') await new Promise((resolve) => setTimeout(resolve, 600));
      const excluded = new Set([...(body.excludedCandidateIds || []), ...(body.overrideCandidateIds || [])]);
      const estimateRows = candidates.filter((row) => !excluded.has(row.id) && !settings.source_overrides?.[row.source]);
      const count = estimateRows.length;
      const userPrice = settings.custom_prices?.[`${settings.provider}/${settings.model}`];
      const calculated = estimateForRows(estimateRows);
      const inputRate = userPrice?.input / 1_000_000;
      const outputRate = userPrice?.output / 1_000_000;
      const cost = userPrice ? {
        low: calculated.inputTokens * inputRate + calculated.outputTokens * outputRate,
        high: (calculated.inputTokensHigh * inputRate + calculated.outputTokensHigh * outputRate) * 2
      } : unpriced ? null : calculated.cost;
      return ok(request, { ...calculated, ...(unpriced && !userPrice ? { price: null } : {}), priceSource: userPrice ? 'user' : calculated.priceSource, candidateCount: count, cost });
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
        { id: 'xiaomi/mimo-v2.6-flash', display_name: 'MiMo V2.6 Flash', pricing_prompt: null, pricing_completion: null },
        { id: 'deepseek/deepseek-v4.1-flash', supported_parameters: ['reasoning'], reasoning: { mandatory: false, default_enabled: true, default_effort: 'high', supported_efforts: ['max', 'high', 'low'] } },
        { id: 'mandatory-fixture', reasoning: { mandatory: true, supported_efforts: ['high'] } },
        { id: 'google/gemini-2.5-flash-lite', display_name: 'Gemini 2.5 Flash Lite', pricing_prompt: '0.0000001', pricing_completion: '0.0000004', context_length: 1048576 },
        { id: 'openai/gpt-5-mini', display_name: 'GPT-5 Mini', pricing_prompt: '0.00000025', pricing_completion: '0.000002', context_length: 400000, supported_parameters: ['reasoning'], reasoning: { mandatory: false, default_enabled: true, default_effort: 'medium', supported_efforts: ['high', 'medium', 'low'] } },
        { id: 'anthropic/claude-haiku-4.5', display_name: 'Claude Haiku 4.5', pricing_prompt: '0.000001', pricing_completion: '0.000005', context_length: 200000 },
        { id: 'openai/gpt-5.1', display_name: 'GPT-5.1', pricing_prompt: '0.00000125', pricing_completion: '0.00001', context_length: 400000 },
        { id: 'openai/gpt-image-1', display_name: 'GPT Image 1', suitable: false },
        { id: 'openai/whisper-1', display_name: 'Whisper', suitable: false },
        { id: 'openai/text-embedding-3-large', display_name: 'Text Embedding 3 Large', suitable: false },
        // ?unsuitableModel=1: the saved model is one that does not write text; the core keeps it, marked.
        ...(new URLSearchParams(location.search).get('unsuitableModel') === '1' ? [{ id: 'saved-tts-fixture', unsuitable_reason: 'id:tts', suitable: false }] : [])
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
      // The core refuses a scan with newer chunks until the person confirmed once.
      if (chunkMode === 'newer' && body.acceptNewerVersion !== true) return { v: 1, id: request.id, type: 'response.error', error: { code: 'NEWER_VERSION_UNCONFIRMED', recoverable: true, message: 'raw core text' } };
      if (keyUnbound()) throw { code: 'CREDENTIAL_ENDPOINT_UNBOUND', message: 'raw shell text that must not be shown' };
      if (current === 'run-progress') {
        // ?progress=nocost: the provider reports no cost (null). ?progress=many: more samples than the list keeps.
        // ?progress=eta-retry adds a rate-limit retry notice after the last event. ?progress=eta / eta-wobble: 100 sentences with an event every few seconds (run under page.clock) for the remaining-time estimate.
        // ?progress=quality adds glossary warnings and a dropped-checkpoint notice. Without it: two batches a second apart,
        // so the remaining-time estimate appears after the second one, each with its newest translations.
        const progressMode = new URLSearchParams(location.search).get('progress');
        const eta = String(progressMode).startsWith('eta');
        setTimeout(() => emit('pomi-progress', { v: 1, id: request.id, type: 'translate.progress', payload: { event: 'phase_start', phase: 'translate', total: eta ? 100 : 6, requests_estimate: eta ? 1 : 3 } }), 50);
        if (eta) {
          // [seconds after the start, sentences done]: a steady pace, or one that jumps about.
          const points = progressMode !== 'eta-wobble' ? [[5, 6], [10, 12], [15, 18], [20, 24], [25, 30], [30, 36]] : [[5, 1], [10, 2], [15, 3], [20, 4], [25, 5], [28, 60], [30, 90]];
          for (const [seconds, completed] of points) {
            setTimeout(() => emit('pomi-progress', { v: 1, id: request.id, type: 'translate.progress', payload: { event: 'translation_progress', completed, total: 100, failed: 0, batch: 1, batches: 10, requests: 1, cost: 0.0001 } }), seconds * 1000 + 100);
          }
          if (progressMode === 'eta-retry') setTimeout(() => emit('pomi-progress', { v: 1, id: request.id, type: 'translate.progress', payload: { event: 'translation_batch_error', attempt: 1, max_attempts: 3, failure: 'rate_limit' } }), 33000);
          return new Promise((resolve) => setTimeout(() => resolve(ok(request, resultPayload('completed'))), 600000));
        }
        const sentence = (n) => ({ source: `Sentence ${n} ${'x'.repeat(200)}`, translated: `문장 ${n}` });
        if (progressMode === 'many') {
          for (let round = 0; round < 3; round++) {
            setTimeout(() => emit('pomi-progress', { v: 1, id: request.id, type: 'translate.progress', payload: { event: 'translation_progress', completed: 2 + round, total: 6, failed: 0, batch: round + 1, batches: 3, requests: round + 1, cost: null, samples: [1, 2, 3].map((n) => sentence(round * 3 + n)) } }), 120 + round * 30);
          }
        } else {
          if (progressMode === 'quality') {
            setTimeout(() => emit('pomi-progress', { v: 1, id: request.id, type: 'translate.progress', payload: { event: 'checkpoint_glossary_changed', dropped_translations: 9 } }), 80);
          }
          const cost = (value) => (progressMode === 'nocost' ? null : value);
          progressEvents(request, 'translate.progress', [
            [400, { event: 'translation_progress', completed: 2, total: 6, failed: 0, batch: 1, batches: 3, requests: 1, cost: cost(0.000062), ...(progressMode === 'quality' ? { warnings: { glossary_mismatch: 2, format_residue: 1 } } : {}),
              samples: [{ source: 'Welcome to Roguefire', translated: '로그파이어에 오신 것을 환영합니다' }, { source: 'The Lost Key Shop', translated: '잃어버린 열쇠 상점' }] }],
            [1500, { event: 'translation_progress', completed: 4, total: 6, failed: 0, batch: 2, batches: 3, requests: 2, cost: cost(0.000123),
              samples: [{ source: 'Merchant of the Northern Gate', translated: '북문의 상인' }] }]
          ]);
        }
        return new Promise((resolve) => setTimeout(() => resolve(ok(request, resultPayload('completed'))), 60000));
      }
      if (current === 'recovery-required') {
        sessionStorage.setItem('pomi.fixture.rr', 'true');
        return { v: 1, id: request.id, type: 'response.error', error: { code: 'RECOVERY_REQUIRED', recoverable: true, message: 'raw core text' } };
      }
      if (current === 'translate-fails') return { v: 1, id: request.id, type: 'response.error', error: { code: 'AUTH_FAILED', message: 'RAW provider text 401' } };
      // Continuing an interrupted job finishes it as the run it was (it predates the review step).
      if (current === 'interrupted-partial') {
        sessionStorage.setItem('pomi.fixture.recovered', 'true');
        (window.__pomiResumes ||= []).push(type);
        return ok(request, resultPayload('completed'));
      }
      // result-<status>[-resume|-bare]: the run ends as that status (the job behind it serves the review and retries).
      if (current.startsWith('result-')) {
        ensureJob(body.excludedCandidateIds);
        const staged = resultPayload(resultStatus(current));
        job.requests = staged.jobProviderRequests ?? staged.providerRequests ?? 0;
        return ok(request, staged);
      }
      const resuming = type === 'translate.resume';
      if (capUnenforceable(body)) return capRefusal(request);
      const budgetStop = (query.get('budget') === '1' || query.get('overCap') === '1') && !body.budgetDisabled;
      if (!resuming || !job) makeJob('review', body.excludedCandidateIds);
      if (unpriced && settings.max_cost_usd > 0 && body.unpricedCapAck) job.costCapUnenforced = true;
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
      // ?nocp=1, or a result scenario that kept no checkpoint and wrote nothing: there is no saved table.
      const noTable = current.startsWith('result-') && !['result-cancelled', 'result-needs_retry', 'result-failed-resume'].includes(current) && !(job ? job.applied : APPLIED_KINDS.includes(resultStatus(current)));
      // ?notable=1: the saved job can be resumed, but its translation table cannot be read.
      if (query.get('nocp') === '1' || query.get('notable') === '1' || (noTable && !(job && job.status === 'awaiting_review'))) return { v: 1, id: request.id, type: 'response.error', error: { code: 'RESUME_NOT_AVAILABLE', message: 'No saved translations', recoverable: true } };
      ensureJob(['tellraw']);
      return ok(request, pagePayload(body));
    }
    if (type === 'translate.retry_failed') {
      if (capUnenforceable(body)) return capRefusal(request);
      ensureJob(['tellraw']);
      if (unpriced && settings.max_cost_usd > 0 && body.unpricedCapAck) job.costCapUnenforced = true;
      const stale = glossaryRefreshRows();
      const sendRows = body.refreshGlossary ? stale : retryRows();
      window.__pomiRetrySent = sendRows.map((row) => row.id);
      progressEvents(request, 'translate.progress', [
        [10, { event: 'phase_start', phase: 'translate', total: sendRows.length, requests_estimate: 1 }]
      ]);
      await sleep(80);
      job.requests += 1;
      for (const row of sendRows.filter(glossaryStale)) {
        row.ai = effectiveGlossary().filter((entry) => termMatches(row.source, entry)).reduce((answer, entry) =>
          entry.mode === 'keep' ? answer : answer.replaceAll(entry.source, entry.target), row.source);
        row.status = 'translated';
        row.glossaryFixtureStale = false;
      }
      if (stale.length && job.applied) job.glossaryRefreshed = true;
      if (!body.refreshGlossary && query.get('retryFail') !== '1') sendRows.forEach((row) => { if (row.status === 'failed' && row.edit === undefined) { row.status = 'translated'; row.reason = ''; row.detail = ''; } });
      job.glossaryHashes = Object.fromEntries(job.rows.map((row) => [row.source, glossaryHash(row.source)]));
      job.status = 'awaiting_review';
      job.usage = { ...job.usage, prompt_tokens: job.usage.prompt_tokens + 120, completion_tokens: job.usage.completion_tokens + 40, cost: job.usage.cost + 0.00006 };
      return ok(request, jobResult('awaiting_review', { providerRequests: 1, backupSetId: job.applied ? job.backupSetId : '', changedFileCount: 0 }));
    }
    if (type === 'translate.apply' || type === 'translate.reapply') {
      ensureJob(['tellraw']);
      const reapply = type === 'translate.reapply';
      if (job.rows.some(glossaryStale)) return { v: 1, id: request.id, type: 'response.error', error: { code: 'GLOSSARY_CHANGED', message: 'Re-check glossary', recoverable: true } };
      if (job.rows.some((row) => row.status === 'glossary_mismatch') && !body.acknowledgeGlossaryMismatch) return { v: 1, id: request.id, type: 'response.error', error: { code: 'GLOSSARY_MISMATCH_UNCONFIRMED', message: 'Review mismatches', recoverable: true } };
      if (!reapply && job.applied) return { v: 1, id: request.id, type: 'response.error', error: { code: 'ALREADY_APPLIED', message: 'Use reapply', recoverable: true } };
      if (reapply && !job.applied) return { v: 1, id: request.id, type: 'response.error', error: { code: 'NOTHING_TO_REAPPLY', message: 'Nothing to reapply', recoverable: true } };
      if (query.get('worldChanged') === '1' && reapply) return { v: 1, id: request.id, type: 'response.error', error: { code: 'WORLD_CHANGED_SINCE_APPLY', message: 'World changed', recoverable: true } };
      if (query.get('reapplyInterrupted') === '1' && reapply && !job.reapplyInterruptedOnce) {
        job.reapplyInterruptedOnce = true;
        job.status = 'reapply_interrupted';
        job.recoverySetId = 'recovery-before-reapply';
        return { v: 1, id: request.id, type: 'response.error', error: { code: 'REAPPLY_INTERRUPTED', message: 'Reapply stopped after restore', recoverable: true, details: { recoverySetId: job.recoverySetId } } };
      }
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
    if (type.startsWith('glossary.')) {
      (window.__pomiGlossary ||= []).push({ type, payload: body });
      if (glossaryMode() === 'unsupported') return glossaryError(request, 'UNSUPPORTED_REQUEST', 'unknown');
      const store = glossaryStore();
      const key = glossaryKey(body);
      const doc = glossaryDoc(body);
      if (type === 'glossary.get') return ok(request, doc);
      if (type === 'glossary.export') {
        const header = 'source,target,mode,note,caseSensitive';
        const lines = doc.entries.map((item) => [item.source, item.target, item.mode, item.note, String(item.caseSensitive)].map(glossaryCell).join(','));
        return ok(request, { scope: body.scope, format: body.format, revision: doc.revision, count: doc.entries.length, text: `﻿${[header, ...lines].join('\r\n')}\r\n` });
      }
      // set and import change the list: a stale revision, a refusal or a busy file are scripted per scenario.
      const mode = glossaryMode();
      if (mode === 'conflict-once' && sessionStorage.getItem('pomi.fixture.glossaryConflict') !== 'true') {
        sessionStorage.setItem('pomi.fixture.glossaryConflict', 'true');
        store[key] = { revision: doc.revision + 1, entries: [...doc.entries, { id: glossaryNewId(), source: 'Added Elsewhere', target: '', mode: 'keep', caseSensitive: false, note: '' }] };
        glossaryPut(store);
        return glossaryError(request, 'GLOSSARY_CONFLICT', 'The glossary was changed by another save');
      }
      if (mode === 'busy-once' && sessionStorage.getItem('pomi.fixture.glossaryBusy') !== 'true') {
        sessionStorage.setItem('pomi.fixture.glossaryBusy', 'true');
        return glossaryError(request, 'GLOSSARY_BUSY', 'busy');
      }
      if (mode === 'write-failed') return glossaryError(request, 'GLOSSARY_WRITE_FAILED', 'The glossary could not be saved: disk full');
      if (body.baseRevision !== doc.revision) return glossaryError(request, 'GLOSSARY_CONFLICT', 'stale');
      if (type === 'glossary.set') {
        const entries = body.entries || [];
        if (mode === 'invalid' && entries.length > 1) return glossaryError(request, 'GLOSSARY_INVALID', 'entries[1].target: is longer than 200 characters');
        const saved = entries.map((item) => ({ id: item.id || glossaryNewId(), source: item.source, target: item.target || '', mode: item.mode, caseSensitive: !!item.caseSensitive, note: item.note || '' }));
        await glossaryHold('save');
        store[key] = { revision: doc.revision + 1, entries: saved };
        glossaryPut(store);
        return ok(request, glossaryDoc(body));
      }
      if (type === 'glossary.import') {
        const parsed = glossaryParse(body.text || '', body.format);
        await glossaryHold('import');
        if (!parsed.rows.length && body.mode === 'replace') return glossaryError(request, 'GLOSSARY_INVALID', 'text: has no usable rows');
        let added = 0; let updated = 0; let unchanged = 0; let removed = 0;
        const next = body.mode === 'replace' ? [] : [...doc.entries];
        for (const row of parsed.rows) {
          const at = next.findIndex((item) => item.source.toLowerCase() === row.source.toLowerCase());
          if (at < 0) { next.push({ id: glossaryNewId(), ...row }); added++; continue; }
          const same = next[at].target === row.target && next[at].mode === row.mode && next[at].note === row.note;
          if (same) unchanged++; else { next[at] = { ...next[at], ...row }; updated++; }
        }
        if (body.mode === 'replace') removed = doc.entries.filter((item) => !next.some((row) => row.source.toLowerCase() === item.source.toLowerCase())).length;
        store[key] = { revision: doc.revision + 1, entries: next };
        glossaryPut(store);
        return ok(request, { ...glossaryDoc(body), added, updated, unchanged, removed, skipped: parsed.skipped, skippedCount: parsed.skipped.length });
      }
    }
    if (type === 'credentials.delete') {
      // ?delete=unconfirmed: the system keychain entry could not be deleted.
      if (new URLSearchParams(location.search).get('delete') === 'unconfirmed') {
        return { v: 1, id: request.id, type: 'response.error', error: { code: 'KEYCHAIN_UNCONFIRMED', message: 'raw core text', recoverable: true } };
      }
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
      if (command === 'export_document' && String(args.kind).startsWith('glossary_')) {
        // The shell writes the exact text itself; nothing is downloaded. A dismissed dialog answers false.
        (window.__pomiExports ||= []).push({ kind: args.kind, fileName: args.fileName ?? null, document: args.document });
        const exportMode = new URLSearchParams(location.search).get('glossaryExport');
        if (exportMode === 'fail') throw { code: 'EXPORT_FAILED', message: 'raw' };
        return exportMode !== 'cancel';
      }
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
      if (command === 'credential_status' && vaultBroken()) return { mode: 'local', error: 'VAULT_CORRUPT' };
      if (command === 'credential_reset_storage') { sessionStorage.setItem('pomi.fixture.vaultReset', 'true'); (window.__pomiShell ||= []).push('credential_reset_storage'); return null; }
      if (command === 'native_reset') {
        (window.__pomiShell ||= []).push(`native_reset:${args.deleteKeys}`);
        // ?reset=busy|state-unknown: the shell refuses. ?reset=unconfirmed-once: the keychain could not be
        // confirmed the first time (some stores are already empty); a retry finishes the job.
        const resetMode = new URLSearchParams(location.search).get('reset');
        if (resetMode === 'busy') throw { code: 'BUSY', message: 'raw' };
        if (resetMode === 'state-unknown') throw { code: 'CORE_STATE_UNKNOWN', message: 'raw' };
        if (resetMode === 'unconfirmed-once' && sessionStorage.getItem('pomi.fixture.resetTried') !== 'true') {
          sessionStorage.setItem('pomi.fixture.resetTried', 'true');
          return { keysDeleted: false, keysPartiallyDeleted: true, reportsCleared: true, errors: ['KEYCHAIN_UNCONFIRMED'] };
        }
        if (args.deleteKeys) sessionStorage.setItem('pomi.fixture.cleared', JSON.stringify(['openai', 'gemini', 'anthropic', 'openrouter', 'comet', 'custom']));
        return { keysDeleted: !!args.deleteKeys, keysPartiallyDeleted: false, reportsCleared: true, errors: [] };
      }
      if (command === 'diagnostics_snapshot') return 'PomiTranslate diagnostics\nversion 0.1.0\nevents: none';
      if (command === 'diagnostics_export') {
        (window.__pomiShell ||= []).push('diagnostics_export');
        return new URLSearchParams(location.search).get('diagnostics') !== 'cancel';
      }
      if (command === 'exit_set_settings_dirty') { window.__pomiDirty = args.dirty; return null; }
      // The shell requires the intent id of the question on every answer, and refuses one that is gone.
      // ?exit=gone answers UPDATE_CANCELLED, ?exit=gone-quit answers INVALID_REQUEST.
      if (command === 'exit_confirm' || command === 'exit_cancel') {
        (window.__pomiCalls ||= []).push({ command, args });
        if (typeof args.intent !== 'number') throw { code: 'INVALID_REQUEST', message: 'missing intent' };
        const exitMode = new URLSearchParams(location.search).get('exit');
        if (exitMode === 'gone') throw { code: 'UPDATE_CANCELLED', message: 'raw' };
        if (exitMode === 'gone-quit') throw { code: 'INVALID_REQUEST', message: 'raw' };
        if (window.__pomiInstallWait && args.intent === window.__pomiInstallWait.intent) {
          const wait = window.__pomiInstallWait;
          window.__pomiInstallWait = null;
          (window.__pomiShell ||= []).push(command);
          if (command === 'exit_cancel') wait.reject({ code: 'UPDATE_CANCELLED', message: 'raw' });
          else window.__pomiInstalled = true; // the real app restarts here
          return null;
        }
      }
      if (command === 'exit_cancel') { (window.__pomiShell ||= []).push('exit_cancel'); return null; }
      if (command === 'exit_keep_waiting') {
        (window.__pomiShell ||= []).push('exit_keep_waiting');
        setTimeout(() => emit('pomi-exit-waiting', null), 20);
        if (new URLSearchParams(location.search).get('exit') === 'stuck-again') setTimeout(() => emit('pomi-exit-stuck', null), 150);
        return null;
      }
      if (command === 'exit_confirm') {
        (window.__pomiShell ||= []).push('exit_confirm');
        // ?exit=stuck: the job ignores the cancel; the test reports the end of the wait itself (pomi-exit-stuck),
        // so the waiting state lasts as long as it needs. ?exit=stuck-again: the shell reports it after 150 ms.
        const exitMode = new URLSearchParams(location.search).get('exit');
        if (['stuck', 'stuck-again'].includes(exitMode)) setTimeout(() => emit('pomi-exit-waiting', null), 20);
        if (exitMode === 'stuck-again') setTimeout(() => emit('pomi-exit-stuck', null), 150);
        return null;
      }
      if (command === 'exit_force') { (window.__pomiShell ||= []).push('exit_force'); return null; }
      if (command === 'update_cancel') { (window.__pomiShell ||= []).push('update_cancel'); return null; }
      if (command === 'credential_status') return { stored: new URLSearchParams(location.search).get('missingKey') !== '1' && (!fresh || freshKeySaved), mode: credentialModes.get(args.provider) || 'local' };
      if (command === 'credential_import') return { stored: true, mode: 'local' };
      if (command === 'operation_active') return false;
      if (command === 'open_external') { (window.__pomiOpened ||= []).push(args.url); return null; }
      if (command === 'data_locations') return { data: '/Users/fixture/Library/Application Support/PomiTranslate', app: '/Users/fixture/Library/Application Support/app.pomitranslate.desktop' };
      if (command === 'reveal_world_folder') { window.__pomiWorldRevealed = args.worldDir; (window.__pomiRevealedPaths ||= []).push(args.worldDir); return null; }
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
        // ?install=busy|cancelled|state-unknown: the shell refuses. ?install=ask: unsaved settings make it ask first
        // (reason "update", intent 7) and the install waits for the answer.
        const installMode = new URLSearchParams(location.search).get('install');
        if (installMode === 'busy') throw { code: 'UPDATE_BUSY', message: 'raw' };
        if (installMode === 'cancelled') throw { code: 'UPDATE_CANCELLED', message: 'raw' };
        if (installMode === 'state-unknown') throw { code: 'CORE_STATE_UNKNOWN', message: 'raw' };
        if (installMode === 'ask') {
          return new Promise((resolve, reject) => {
            window.__pomiInstallWait = { intent: 7, resolve, reject };
            emit('pomi-exit-confirm', { job: false, dirty: true, reason: 'update', intent: 7 });
          });
        }
        window.__pomiInstalled = true;
        emit('pomi-update-progress', { downloaded: 512, total: 1024 });
        return new Promise(() => {}); // the real app restarts here
      }
      if (command === 'plugin:notification|is_permission_granted') {
        const mode = new URLSearchParams(location.search).get('notify') || 'granted';
        if (mode === 'missing') throw new Error('plugin not registered');
        return mode === 'granted';
      }
      if (command === 'plugin:notification|request_permission') {
        (window.__pomiShell ||= []).push('notification_permission');
        window.__pomiNotificationPermissionRequests++;
        return new URLSearchParams(location.search).get('notify') === 'denied' ? 'denied' : 'granted';
      }
      if (command === 'plugin:notification|notify') { window.__pomiNotifications.push({ title: args.options?.title ?? '', body: args.options?.body ?? '', ...args.options }); return null; }
      if (command === 'reveal_quarantine_folder') {
        if (new URLSearchParams(location.search).get('reveal') === 'missing') throw new Error('unknown command');
        (window.__pomiRevealedPaths ||= []).push(args.path); return null;
      }
      if (command === 'cancel_active') return true;
      if (command === 'sidecar_request') return sidecar(args.request);
      // Window chrome calls are decoration in the preview: accept and record them.
      if (command.startsWith('plugin:window|') || command === 'set_menu_labels' || command === 'set_menu_theme') { (window.__pomiChrome ||= []).push({ command, args }); return null; }
      throw new Error(`Unsupported fixture command: ${command}`);
    }
  };
  // The one-time "text is sent to the provider" question is answered ahead of time, so flows that
  // start a translation reach the run; ?consent=ask leaves it to be asked.
  if (new URLSearchParams(location.search).get('consent') !== 'ask') {
    localStorage.setItem('pomi.consent.v1', JSON.stringify([`${settings.provider}\u0000${settings.model.trim()}`]));
  }
  if (scenario() !== 'first-run') localStorage.setItem('pomi.notice.v1', 'accepted');
  else localStorage.removeItem('pomi.notice.v1');
  localStorage.setItem('pomi.theme.v1', new URLSearchParams(location.search).get('theme') || (scenario() === 'dark-review' ? 'dark' : 'light'));
})();
