import { open } from '@tauri-apps/plugin-dialog';
import {
  BackendError, callBackend,
  type BackupLocation, type BackupSummary, type BackupUsage, type BackupsListPayload, type DiscoveredWorld,
  type RecentWorld, type ResumeStatus, type WorldInspection
} from '../api';
import { LocalizedError } from '../errors';
import { t } from '../i18n/index.svelte';
import { revealQuarantineFolder, revealWorldFolder } from '../native';
import type { AppState } from '../app.svelte';
import { announce } from './notifications';
import { UNKNOWN_COMMAND_CODES } from './types';

/** The open world, the worlds the app knows about, and the backups of the open world. */
export class WorldLibrary {
  worldDir = $state('');
  inspection = $state<WorldInspection | null>(null);
  recent = $state<RecentWorld[]>([]);
  discovered = $state<DiscoveredWorld[]>([]);
  discoveredLoaded = $state(false);
  backups = $state<BackupSummary[]>([]);
  /** False once the core said it has no backups.delete/prune (an older core): the controls are hidden. */
  backupAdminSupported = $state(true);
  /** Disk used by backups; absent when the core is too old to report it. */
  backupUsage = $state<BackupUsage | null>(null);

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
    if (path !== this.worldDir && !(await app.job.draft.mayDiscard('world'))) return;
    if (app.isBusy) return;
    if (path !== this.worldDir && app.guards.waitForReviewDrafts(() => void this.use(path))) return;
    // A valid new world resets the job (and with it any pending recovery lookup); an invalid folder changes nothing.
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
    if (this.worldDir === path && !(await app.job.draft.mayDiscard('forget'))) return;
    if (this.worldDir === path && app.guards.waitForReviewDrafts(() => void this.forget(path))) return;
    try {
      this.recent = (await callBackend<{ worlds: RecentWorld[] }>('worlds.forget', { worldDir: path })).worlds;
      if (this.worldDir === path) {
        this.worldDir = '';
        this.inspection = null;
        this.backups = [];
        this.backupUsage = null;
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
      this.backupUsage = null;
      return;
    }
    const listed = await callBackend<BackupsListPayload>('backups.list', { worldDir: this.worldDir });
    this.backups = listed.backups;
    this.backupUsage = listed.usage ?? null;
  }

  async restore(backupSetId: string): Promise<boolean> {
    const app = this.app;
    if (!this.worldDir || app.isBusy) return false;
    if (app.recovery.interruptedHere.length) {
      app.notify(t('recovery.blocksRestore'), 'error');
      return false;
    }
    if (app.job.scan && !(await app.job.draft.mayDiscard('restore'))) return false;
    if (app.isBusy) return false;
    if (app.guards.waitForReviewDrafts(() => void this.restore(backupSetId))) return false;
    app.busy = 'restore';
    app.banner = null;
    app.job.startClock();
    let ok = false;
    try {
      const restored = await callBackend<{ status: string; recoverySetId: string }>('restore.start', {
        worldDir: this.worldDir,
        backupSetId
      });
      if (restored.status !== 'restored' || !restored.recoverySetId) {
        throw new LocalizedError(t('backups.restoreUnconfirmed'));
      }
      app.job.reset();
      // Set after the reset: the scan and backup pages say why the reviewed scan is gone.
      app.job.lastRestoreId = restored.recoverySetId;
      app.step = 'scan';
      await this.loadBackups();
      app.notify(t('backups.restoreDone'), 'success', 9000);
      ok = true;
      return true;
    } catch (cause) {
      app.fail(cause);
      if (cause instanceof BackendError && cause.code === 'RECOVERY_REQUIRED') await app.recovery.openInterrupted();
      return false;
    } finally {
      app.busy = '';
      app.job.stopClock();
      announce(app, 'restore', ok, false);
    }
  }

  // --- backup administration ---------------------------------------------------------------

  /** Delete one backup set. The core refuses while a job holds the world and for sets recovery needs. */
  async deleteBackup(backupSetId: string, location: BackupLocation = 'app', acknowledgeLastCopy = false): Promise<boolean> {
    const app = this.app;
    if (!this.worldDir || app.isBusy) return false;
    try {
      await callBackend('backups.delete', { worldDir: this.worldDir, backupSetId, location, acknowledgeLastCopy });
      await this.loadBackups();
      app.notify(t('backups.deleted'), 'success');
      return true;
    } catch (cause) {
      if (cause instanceof BackendError && UNKNOWN_COMMAND_CODES.includes(cause.code)) this.backupAdminSupported = false;
      app.fail(cause);
      await this.loadBackups().catch(() => {});
      return false;
    }
  }

  /** Keep the newest `keepLatest` sets and delete the rest (never the only recovery copy). */
  async pruneBackups(keepLatest: number, location: BackupLocation = 'app'): Promise<boolean> {
    const app = this.app;
    if (!this.worldDir || app.isBusy) return false;
    try {
      const outcome = await callBackend<{ deleted: string[]; skipped?: unknown[]; failed?: unknown[] }>('backups.prune', {
        worldDir: this.worldDir, keepLatest, location, acknowledgeLastCopy: false
      });
      await this.loadBackups();
      const count = outcome.deleted?.length ?? 0;
      app.notify(t(count ? 'backups.pruned' : 'backups.prunedNone', { count }), count ? 'success' : 'info');
      if (outcome.failed?.length) app.notify(t('backups.pruneSomeFailed', { count: outcome.failed.length }), 'error');
      return true;
    } catch (cause) {
      if (cause instanceof BackendError && UNKNOWN_COMMAND_CODES.includes(cause.code)) this.backupAdminSupported = false;
      app.fail(cause);
      await this.loadBackups().catch(() => {});
      return false;
    }
  }

  /** Show a folder in Finder or Explorer; without a shell the path is copied, and failing that shown. */
  async openFolder(path: string, kind: 'world' | 'other' = 'other'): Promise<void> {
    if (kind === 'world' ? await revealWorldFolder(path) : await revealQuarantineFolder(path)) return;
    try {
      await navigator.clipboard.writeText(path);
      this.app.notify(t('folder.copied', { path }), 'info', 9000);
    } catch {
      this.app.notify(t('folder.show', { path }), 'info', 12000);
    }
  }
}
