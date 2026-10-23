import { checkForUpdate, installUpdate, onUpdateProgress, type UpdateInfo } from '../native';
import { t } from '../i18n/index.svelte';
import type { AppState } from '../app.svelte';
import type { UpdateState } from './types';

/** Release-feed checks and the download-and-install flow. */
export class Updater {
  update = $state<UpdateInfo | null>(null);
  state = $state<UpdateState>('idle');
  error = $state('');
  progress = $state<{ downloaded: number; total: number | null } | null>(null);

  constructor(private readonly app: AppState) {}

  /** Check the release feed. A manual check reports every outcome; an automatic one stays quiet. */
  async check(manual = true): Promise<void> {
    if (this.state === 'checking' || this.state === 'installing') return;
    this.state = 'checking';
    this.error = '';
    try {
      const info = await checkForUpdate();
      this.update = info;
      this.state = 'idle';
      void this.app.setPrefs({ update_last_check: Math.floor(Date.now() / 1000) });
      if (!manual && info.status === 'available' && info.version !== this.app.prefs.update_skipped_version) {
        this.app.notify(t('update.availableToast', { version: info.version ?? '' }), 'info', 9000);
      }
    } catch (cause) {
      this.state = manual ? 'error' : 'idle';
      this.error = cause instanceof Error ? cause.message : String(cause);
    }
  }

  get available(): boolean {
    return this.update?.status === 'available' && this.update.version !== this.app.prefs.update_skipped_version;
  }

  async install(): Promise<void> {
    if (this.app.isBusy || this.state === 'installing') return;
    this.state = 'installing';
    this.error = '';
    this.progress = { downloaded: 0, total: null };
    let stop: (() => void) | null = null;
    try {
      stop = await onUpdateProgress((downloaded, total) => { this.progress = { downloaded, total }; }).catch(() => null);
      await installUpdate();
    } catch (cause) {
      this.state = 'error';
      this.error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      stop?.();
    }
  }

  skip(): void {
    if (this.update?.version) void this.app.setPrefs({ update_skipped_version: this.update.version });
  }
}
