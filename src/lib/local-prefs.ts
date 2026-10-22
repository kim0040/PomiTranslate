/**
 * Preferences this web view keeps itself. The core's preference file accepts only the keys it
 * knows, so a new switch lives here until the core learns it. Losing it (cleared web storage)
 * falls back to the default, which is the safe side for every switch below.
 */
const KEY = 'pomi.local-prefs.v1';

export type LocalPrefs = {
  /** Tell the person with a system notification when a job ends while the window is in the back. */
  notify_on_finish: boolean;
};

export const DEFAULT_LOCAL_PREFS: LocalPrefs = { notify_on_finish: true };

export function loadLocalPrefs(): LocalPrefs {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<LocalPrefs>;
    return { notify_on_finish: typeof parsed.notify_on_finish === 'boolean' ? parsed.notify_on_finish : DEFAULT_LOCAL_PREFS.notify_on_finish };
  } catch {
    return { ...DEFAULT_LOCAL_PREFS };
  }
}

export function saveLocalPrefs(prefs: LocalPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch { /* no storage: the switch lasts until the window closes */ }
}

// --- send-to-provider consent --------------------------------------------------------------
// The first run with a provider and model asks once before world text leaves the computer. The
// answer is kept per provider/model pair; changing either asks again.
const CONSENT_KEY = 'pomi.consent.v1';
const CONSENT_LIMIT = 50;

export function consentKey(provider: string, model: string): string {
  return `${provider}\u0000${model.trim()}`;
}

function readConsents(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(CONSENT_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function hasConsent(provider: string, model: string): boolean {
  return readConsents().includes(consentKey(provider, model));
}

export function rememberConsent(provider: string, model: string): void {
  try {
    const key = consentKey(provider, model);
    const next = [...readConsents().filter((item) => item !== key), key].slice(-CONSENT_LIMIT);
    localStorage.setItem(CONSENT_KEY, JSON.stringify(next));
  } catch { /* asked again next time */ }
}
