import { callBackend, type AppPrefs, type BootstrapPayload, type Settings } from '../api';
import { copySettings } from '../settings';
import { applyFontScale, normalizeFontScale, type FontScale } from '../font-scale';
import { t, setLocale, type Locale } from '../i18n/index.svelte';
import { detectLocale } from '../i18n/index.svelte';
import { takeLegacyNotifyPref } from '../local-prefs';
import { notificationsAvailable } from '../plugins';
import { RECOMMENDED_PROVIDER } from '../providers';
import { applyTheme, type ThemeChoice } from '../theme';
import type { AppState } from '../app.svelte';

export const NOTICE_KEY = 'pomi.notice.v1';
const DAY = 24 * 60 * 60;
const PREFS_RETRY_LIMIT = 5;

/** The language a person translating in this UI language most likely wants as the target. */
export const DEFAULT_TARGET: Record<Locale, string> = { ko: '한국어', en: 'English', ja: '日本語', zh: '简体中文' };

export const DEFAULT_PREFS: AppPrefs = {
  theme: 'system', notice_accepted: false, tutorial_seen: false, setup_dismissed: false,
  update_auto_check: true, update_last_check: 0, update_skipped_version: '', notify_on_finish: true, font_scale: 100
};

/** App state saved with the settings file, and the first-run guide (notice, wizard, tour) that reads it. */
export class Preferences {
  /** App state saved with the settings file; the web view's storage is only a fast copy. */
  prefs = $state<AppPrefs>({ ...DEFAULT_PREFS });
  theme = $state<ThemeChoice>('system');
  showNotice = $state(false);
  showTour = $state(false);
  /** The first-run setup wizard (also reached from Help). It carries the legal notice on its first step. */
  showWizard = $state(false);
  showLicenses = $state(false);
  /** The shell can show system notifications (plugin present). */
  notificationsSupported = $state(false);
  /** The person has not yet picked a display and target language in the first-run guide. */
  firstRun = $state(false);

  private targetTouched = false;
  private prefsAttempts = 0;
  private prefsGaveUp = false;
  private unsavedPrefs: Partial<AppPrefs> = {};
  private prefsRetry: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly app: AppState) {}

  dispose(): void {
    if (this.prefsRetry) clearTimeout(this.prefsRetry);
  }

  /**
   * Read the saved app state. A build before this one kept the theme and the notice answer only in
   * the web view's storage; when the settings file has none yet, that answer is carried over once.
   */
  apply(boot: BootstrapPayload): void {
    const saved = { ...DEFAULT_PREFS, ...(boot.prefs ?? {}) };
    if (!boot.settings.app_prefs) {
      let acceptedBefore = false;
      try { acceptedBefore = localStorage.getItem(NOTICE_KEY) === 'accepted'; } catch { /* no storage */ }
      const carried: Partial<AppPrefs> = {};
      // Someone who used the app before the wizard existed is not shown a first-run guide.
      if (acceptedBefore) Object.assign(carried, { notice_accepted: true, tutorial_seen: true, setup_dismissed: true });
      if (this.theme !== 'system') carried.theme = this.theme;
      Object.assign(saved, carried);
      if (Object.keys(carried).length) void this.setPrefs(carried);
    }
    // The finish-notification switch used to live in web storage: carry an earlier choice over once.
    const legacyNotify = takeLegacyNotifyPref();
    if (legacyNotify !== null && legacyNotify !== (saved.notify_on_finish ?? true)) {
      saved.notify_on_finish = legacyNotify;
      void this.setPrefs({ notify_on_finish: legacyNotify });
    }
    this.prefs = saved;
    void notificationsAvailable().then((ok) => { this.notificationsSupported = ok; });
    // A fresh install: the saved provider is only the core's built-in default, which is not the one
    // the wizard recommends. Show the recommendation (nothing is saved until the wizard or Settings
    // saves). A provider anyone chose, or that has a model or a key, is never touched.
    const settings = this.app.settings;
    if (!saved.notice_accepted && !settings.model && !this.app.apiKeyStored && settings.provider === 'openai') {
      this.app.settings = { ...settings, provider: RECOMMENDED_PROVIDER };
    }
    if (saved.theme !== this.theme) this.setThemeOnly(saved.theme);
    applyFontScale(normalizeFontScale(saved.font_scale));
    this.showNotice = !saved.notice_accepted;
    // Nothing is saved until the guide is finished, so closing the app during it leaves the install as it was.
    this.firstRun = this.showNotice;
    if (this.firstRun && !boot.settings.app_prefs) this.chooseFirstRunLanguage(detectLocale());
    // First run, or still no usable provider and the guide was never put off or finished.
    this.showWizard = !saved.notice_accepted || (this.app.setupNeeds.length > 0 && !saved.setup_dismissed);
    // The tour is optional: it is offered when the wizard finishes and from Help, never started by itself.
    this.showTour = false;
    if (saved.update_auto_check && Date.now() / 1000 - saved.update_last_check > DAY) {
      setTimeout(() => void this.app.updater.check(false), 4000);
    }
  }

  /**
   * Save app state. The change applies at once. While a scan, translation or restore holds the core
   * the save cannot run, so it is kept and retried until it lands; otherwise the next launch would
   * read the older value from the settings file.
   */
  async setPrefs(changes: Partial<AppPrefs>): Promise<void> {
    this.prefs = { ...this.prefs, ...changes };
    const pending = { ...this.unsavedPrefs, ...changes };
    this.unsavedPrefs = {};
    try {
      const saved = await callBackend<{ prefs: AppPrefs }>('prefs.set', { prefs: pending });
      this.prefs = { ...this.prefs, ...saved.prefs, ...this.unsavedPrefs };
      this.prefsAttempts = 0;
      this.prefsGaveUp = false;
    } catch {
      this.unsavedPrefs = { ...pending, ...this.unsavedPrefs };
      this.prefsAttempts += 1;
      if (this.prefsAttempts >= PREFS_RETRY_LIMIT) {
        // The change applies for this session; stop retrying and say so once.
        if (!this.prefsGaveUp) {
          this.prefsGaveUp = true;
          this.app.notify(t('prefs.notSaved'), 'error');
        }
        return;
      }
      if (!this.prefsRetry && !this.app.destroyed) {
        this.prefsRetry = setTimeout(() => {
          this.prefsRetry = null;
          if (Object.keys(this.unsavedPrefs).length) void this.setPrefs({});
        }, 3000);
      }
    }
  }

  /** The language switcher of the first-run guide: applies at once, saved when the guide is accepted. */
  chooseFirstRunLanguage(locale: Locale): void {
    this.app.settings = { ...this.app.settings, ui_language: locale };
    if (!this.targetTouched) this.app.settings.target_language = DEFAULT_TARGET[locale];
    setLocale(locale);
  }

  setFirstRunTarget(value: string): void {
    this.targetTouched = true;
    this.app.settings = { ...this.app.settings, target_language: value };
  }

  acceptNotice(): void {
    try { localStorage.setItem(NOTICE_KEY, 'accepted'); } catch { /* the settings file is the record */ }
    this.showNotice = false;
    void this.setPrefs({ notice_accepted: true });
    if (this.firstRun) {
      this.firstRun = false;
      // The language and target picked in the guide become the saved settings.
      void this.app.persistSettings().catch((cause) => this.app.fail(cause));
    }
  }

  /** Open the setup wizard again (Help, the tour, or a missing-setup notice). */
  openWizard(): void {
    if (!this.app.ready || this.app.startupFailed || this.showNotice) return;
    this.showWizard = true;
  }

  /**
   * Close the wizard without finishing ("later"). It stays closed on later launches, and the plain
   * setup notices on the scan and run steps still say what is missing. The tour is not started: it
   * stays one click away in Help.
   */
  dismissWizard(): void {
    this.showWizard = false;
    this.app.guards.wizardDirty = false;
    if (!this.prefs.setup_dismissed) void this.setPrefs({ setup_dismissed: true });
  }

  /** The wizard finished and saved: the guide counts as seen, and the next stop is the world step. */
  finishSetup(openTour = false): void {
    this.showWizard = false;
    this.app.guards.wizardDirty = false;
    const seen: Partial<AppPrefs> = {};
    if (!this.prefs.setup_dismissed) seen.setup_dismissed = true;
    if (!this.prefs.tutorial_seen) seen.tutorial_seen = true;
    if (Object.keys(seen).length) void this.setPrefs(seen);
    this.app.page = 'workspace';
    this.app.step = 'world';
    this.showTour = openTour;
  }

  /** Save what the wizard collected in one `settings.set`, key included. Returns false on failure. */
  async saveSetup(changes: Partial<Settings>, apiKey: string): Promise<boolean> {
    const previous = copySettings(this.app.settings);
    this.app.settings = copySettings({ ...this.app.settings, ...changes });
    const saved = await this.app.saveSettings(previous, apiKey, this.app.credentialMode);
    if (!saved) this.app.settings = previous;
    return saved;
  }

  finishTour(): void {
    this.showTour = false;
    if (!this.prefs.tutorial_seen) void this.setPrefs({ tutorial_seen: true });
  }

  setThemeOnly(choice: ThemeChoice): void {
    this.theme = choice;
    applyTheme(choice);
  }

  setTheme(choice: ThemeChoice): void {
    this.setThemeOnly(choice);
    void this.setPrefs({ theme: choice });
  }

  get fontScale(): FontScale {
    return normalizeFontScale(this.prefs.font_scale);
  }

  /** The text size applies at once, like the appearance, and is saved with the other app state. */
  setFontScale(scale: FontScale): void {
    applyFontScale(scale);
    void this.setPrefs({ font_scale: scale });
  }
}
