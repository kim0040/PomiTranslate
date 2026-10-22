/**
 * Browser-side leftovers. The finish-notification switch used to live here; it is now an app
 * preference (`notify_on_finish`) kept by the core, so this file only reads the old value once.
 */
const LEGACY_KEY = 'pomi.local-prefs.v1';

/** The switch an earlier build kept in web storage, or null. Reading it removes it (a one-time migration). */
export function takeLegacyNotifyPref(): boolean | null {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (raw === null) return null;
    localStorage.removeItem(LEGACY_KEY);
    const parsed = JSON.parse(raw) as { notify_on_finish?: unknown };
    return typeof parsed.notify_on_finish === 'boolean' ? parsed.notify_on_finish : null;
  } catch {
    return null;
  }
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
