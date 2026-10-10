import { open } from '@tauri-apps/plugin-dialog';
import { callBackend, type BackupSummary, type DiscoveredWorld, type RecentWorld, type ResumeStatus, type WorldInspection } from '../api';
import { t } from '../i18n/index.svelte';
import type { AppState } from '../app.svelte';
import { notifyAfterJob } from './notifications';

/** The open world, the worlds the app knows about, and the backups of the open world. */
export class WorldLibrary {
  worldDir = $state('');
  inspection = $state<WorldInspection | null>(null);
  recent = $state<RecentWorld[]>([]);
  discovered = $state<DiscoveredWorld[]>([]);
  discoveredLoaded = $state(false);
  backups = $state<BackupSummary[]>([]);

  constructor(private readonly app: AppState) {}

  /** Worlds the game launchers keep. Read-only and best effort: an empty list is not an error. */
  async loadDiscovered(force = false): Promise<void> {
    if (this.discoveredLoaded && !force) return;
    try {
      this.discovered = (await callBackend<{ worlds: DiscoveredWorld[] }>('worlds.discover')).worlds ?? [];
    } catch {
      this.discovered = [];
    } finally {
      this.discoveredLoaded = true;
    }
  }

  /** A folder dropped on the window opens like one chosen in the folder dialog. */
  async openDropped(path: string): Promise<void> {
    const app = this.app;
    if (!app.ready || app.startupFailed) return;
    if (app.isBusy) {
      app.notify(t('world.dropBusy'), 'info');
      return;
    }
    app.guards.leave(() => {
      app.page = 'workspace';
      void this.use(path);
    });
  }

  async choose(): Promise<void> {
    this.app.banner = null;
    try {
      const chosen = await open({ directory: true, multiple: false, title: t('world.open') });
      if (typeof chosen === 'string') await this.use(chosen);
    } catch (cause) {
      this.app.fail(cause);
    }
  }

  async use(path: string): Promise<void> {
    const app = this.app;
    if (app.isBusy) return;
    if (path !== this.worldDir && app.guards.waitForReviewDrafts(() => void this.use(path))) return;
    app.banner = null;
    try {
      const inspected = await callBackend<WorldInspection>('world.inspect', { worldDir: path });
      if (!inspected.validJavaWorld) {
        app.banner = { tone: 'error', message: t('world.invalid') };
        return;
      }
      const changed = path !== this.worldDir;
      this.worldDir = path;
      this.inspection = inspected;
      if (changed) {
        app.job.lastJob = null;
        app.job.lastScan = null;
        app.job.reset();
      }
      this.recent = (await callBackend<{ worlds: RecentWorld[] }>('worlds.remember', { worldDir: path })).worlds;
      await this.loadBackups();
      if (changed) app.job.applyResume(await callBackend<ResumeStatus>('resume.status', { worldDir: path }));
      app.step = 'world';
    } catch (cause) {
      app.fail(cause);
    }
  }

  async forget(path: string): Promise<void> {
    const app = this.app;
    if (this.worldDir === path && app.guards.waitForReviewDrafts(() => void this.forget(path))) return;
    try {
      this.recent = (await callBackend<{ worlds: RecentWorld[] }>('worlds.forget', { worldDir: path })).worlds;
      if (this.worldDir === path) {
        this.worldDir = '';
        this.inspection = null;
        this.backups = [];
        app.job.lastJob = null;
        app.job.lastScan = null;
        app.job.reset();
        app.step = 'world';
      }
    } catch (cause) {
      app.fail(cause);
    }
  }

  async loadBackups(): Promise<void> {
    if (!this.worldDir) {
      this.backups = [];
      return;
    }
    this.backups = (await callBackend<{ backups: BackupSummary[] }>('backups.list', { worldDir: this.worldDir })).backups;
  }

  async restore(backupSetId: string): Promise<boolean> {
    const app = this.app;
    if (!this.worldDir || app.isBusy) return false;
    const startedAt = Date.now();
    let notificationStatus = 'failed';
    app.busy = 'restore';
    app.banner = null;
    app.job.startClock();
    try {
      const restored = await callBackend<{ status: string; recoverySetId: string }>('restore.start', {
        worldDir: this.worldDir,
        backupSetId
      });
      if (restored.status !== 'restored' || !restored.recoverySetId) {
        throw new Error(t('backups.restoreUnconfirmed'));
      }
      notificationStatus = 'completed';
      app.job.reset();
      // Set after the reset: the scan and backup pages say why the reviewed scan is gone.
      app.job.lastRestoreId = restored.recoverySetId;
      app.step = 'scan';
      await this.loadBackups();
      app.notify(t('backups.restoreDone'), 'success', 9000);
      return true;
    } catch (cause) {
      app.fail(cause);
      return false;
    } finally {
      app.busy = '';
      notifyAfterJob(app, 'restore', startedAt, { status: notificationStatus });
      app.job.stopClock();
    }
  }
}
