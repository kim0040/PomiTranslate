import { BackendError, callBackend, type ModelInfo, type Settings } from '../api';
import { LocalizedError } from '../errors';
import { t } from '../i18n/index.svelte';
import type { AppState } from '../app.svelte';

type Listing = { models: ModelInfo[]; cached?: boolean; hiddenCount?: number };

/** The model list of the selected provider: fetched on demand, kept for five minutes per endpoint. */
export class ModelCatalog {
  models = $state<ModelInfo[]>([]);
  scope = $state('');
  cached = $state(false);
  /** Models the catalog layer marked as unsuitable for translating text (listed apart, hidden by default). */
  hidden = $state(0);
  /**
   * A model-list request is running. Separate from the app's `busy`, so it never blocks scan, review
   * or save: a slow provider can answer while those carry on.
   */
  loading = $state(false);
  private inFlight: { scope: string; promise: Promise<number> } | null = null;
  private catalogs = new Map<string, { models: ModelInfo[]; fetchedAt: number; cached: boolean; hidden: number }>();

  constructor(private readonly app: AppState) {}

  private scopeOf(selection: Settings): string {
    return JSON.stringify([selection.provider, selection.provider === 'custom' ? selection.base_url : '', selection.provider === 'custom' ? selection.wire_format : '']);
  }

  modelsFor(selection: Settings): ModelInfo[] {
    return this.scope === this.scopeOf(selection) ? this.models : [];
  }

  private remember(scope: string, listed: Listing, cached: boolean): number {
    const hidden = listed.hiddenCount ?? listed.models.filter((model) => model.suitable === false).length;
    this.models = listed.models;
    this.scope = scope;
    this.cached = cached;
    this.hidden = hidden;
    this.catalogs.set(scope, { models: listed.models, fetchedAt: Date.now(), cached, hidden });
    return listed.models.length;
  }

  /**
   * Read the provider's model list. A second request for the same provider joins the one in flight.
   */
  load(selection: Settings = this.app.settings, force = false): Promise<number> {
    const scope = this.scopeOf(selection);
    const cached = this.catalogs.get(scope);
    if (!force && cached && Date.now() - cached.fetchedAt < 5 * 60_000) {
      this.models = cached.models;
      this.scope = scope;
      this.cached = cached.cached;
      this.hidden = cached.hidden;
      return Promise.resolve(cached.models.length);
    }
    if (this.inFlight?.scope === scope) return this.inFlight.promise;
    const promise = (async () => {
      this.loading = true;
      try {
        const listed = await callBackend<Listing>('models.list', {
          provider: selection.provider,
          ...(selection.provider === 'custom' ? { baseUrl: selection.base_url } : {}),
          model: '',
          wireFormat: selection.wire_format,
          ...(selection.provider === 'openrouter' ? { publicCatalog: true } : {})
        });
        return this.remember(scope, listed, !!listed.cached);
      } finally {
        this.loading = false;
        this.inFlight = null;
      }
    })();
    this.inFlight = { scope, promise };
    return promise;
  }

  /** `check` for a form: the outcome as a value, with the provider's error code on failure. */
  async test(selection: Settings, draftApiKey = '', isCurrent: () => boolean = () => true): Promise<{ ok: true; count: number } | { ok: false; code: string }> {
    try {
      return { ok: true, count: await this.check(selection, draftApiKey, isCurrent) };
    } catch (cause) {
      return { ok: false, code: cause instanceof BackendError ? cause.code : '' };
    }
  }

  /**
   * Check the connection: list models with the typed key (sent once, never saved) or, without one,
   * the stored key. Always asks the provider and never falls back to a cached list, so a wrong key
   * cannot look like a working connection.
   */
  async check(selection: Settings, draftApiKey = '', isCurrent: () => boolean = () => true): Promise<number> {
    const scope = this.scopeOf(selection);
    if (this.loading) throw new LocalizedError(t('settings.model.wait'));
    this.loading = true;
    try {
      const draft = draftApiKey.trim();
      const listed = await callBackend<Listing>('models.list', {
        provider: selection.provider,
        ...(selection.provider === 'custom' ? { baseUrl: selection.base_url } : {}),
        model: '',
        wireFormat: selection.wire_format,
        connectionCheck: true,
        ...(draft ? { draftApiKey: draft } : {})
      });
      if (!isCurrent()) return 0;
      return this.remember(scope, listed, false);
    } finally {
      this.loading = false;
    }
  }
}
