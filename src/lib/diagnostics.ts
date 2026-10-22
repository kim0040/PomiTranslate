/**
 * The text "Copy diagnostics" puts on the clipboard: what a support request needs, and nothing
 * the person typed or owns. No API key, no world name or path, no sentence of world text.
 */
export type DiagnosticsInput = {
  /** The shell's own snapshot (versions, platform, recent events, the core's last output). */
  shellText: string;
  appVersion: string;
  /** Short git revision of this build, when the build recorded one. */
  revision: string;
  uiLocale: string;
  browserLocale: string;
  platform: string;
  provider: string;
  model: string;
  lastError: { code: string; id: string; at: number } | null;
  logFolder: string;
};

export function formatDiagnostics(input: DiagnosticsInput): string {
  const last = input.lastError
    ? `${input.lastError.code || 'UNKNOWN'} (error id ${input.lastError.id}, ${new Date(input.lastError.at).toISOString()})`
    : 'none';
  return [
    'PomiTranslate diagnostics',
    `app version: ${input.appVersion || 'unknown'}`,
    `build revision: ${input.revision || 'not recorded'}`,
    `platform: ${input.platform || 'unknown'}`,
    `locale: ui=${input.uiLocale} browser=${input.browserLocale}`,
    `provider: ${input.provider || 'none'} model: ${input.model || 'none'}`,
    `last error: ${last}`,
    `log folder: ${input.logFolder || 'unknown'}`,
    '',
    input.shellText.trim()
  ].join('\n');
}

/** A short id to show beside an error, so a report and the log can be matched. */
export function newDiagnosticId(now: number = Date.now(), random: () => number = Math.random): string {
  const time = now.toString(36).slice(-4);
  const noise = Math.floor(random() * 36 ** 3).toString(36).padStart(3, '0');
  return `E${time}${noise}`.toUpperCase();
}

/**
 * Where the shell writes its log: `logs` under the app's local data folder. The shell reports the
 * roaming data folder, which on Windows is the sibling of the local one.
 */
export function expectedLogFolder(appDataFolder: string | null | undefined): string {
  if (!appDataFolder) return '';
  const local = appDataFolder.replace(/([\\/])AppData\1Roaming(?=[\\/]|$)/i, '$1AppData$1Local');
  const separator = local.includes('\\') ? '\\' : '/';
  return `${local.replace(/[\\/]+$/, '')}${separator}logs`;
}
