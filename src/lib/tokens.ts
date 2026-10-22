/**
 * Formatting tokens inside Minecraft text, matched the way mwt/tokens.py matches them, so the review
 * screen can warn about a manual translation the core would refuse to apply. Keep this in step with
 * that file: java.util.Formatter placeholders, {names} and section-sign codes.
 */
const FORMAT = /%(?:(?:(\d+)\$)|(<))?([-#+0,(]*)(\d+)?(?:\.(\d+))?([tT][A-Za-z]|[bBhHsScCdioxXeEfgGaA%n])/;
const OTHER = /\{[A-Za-z0-9_]+\}|§./;
const TOKEN = new RegExp(`${FORMAT.source}|(${OTHER.source})`, 'gu');
// Conversions that count as placeholders even glued to letters ("%sx" is "%s" + "x").
const ALWAYS_TOKEN = new Set('sdif%');

export type TokenCount = Map<string, { shown: string; count: number }>;

/** The tokens of a text, keyed by what they bind (not where they sit), with one example spelling each. */
export function tokenCounts(text: string): TokenCount {
  const found: TokenCount = new Map();
  const add = (key: string, shown: string) => {
    const entry = found.get(key);
    if (entry) entry.count += 1;
    else found.set(key, { shown, count: 1 });
  };
  for (const match of text.matchAll(TOKEN)) {
    const [whole, index, relative, flags, width, precision, conversion, other] = match;
    if (conversion) {
      const bare = !(index || relative || flags || width || precision);
      if (bare && !ALWAYS_TOKEN.has(conversion)) {
        const following = text.slice(match.index! + whole.length).match(/^[\p{L}\p{N}]/u);
        if (following) continue; // "15%off": a percentage in a sentence
      }
      const identity = index || (relative ? '<' : '');
      const key = ['fmt', identity, [...new Set(flags)].sort().join(''), width ?? '', precision ?? '', conversion].join('\u0000');
      add(key, whole);
    } else if (other) {
      add(`raw\u0000${other}`, other);
    }
  }
  return found;
}

/** A "§r" the model put after the last character changes nothing on screen; the core drops it too. */
function withoutTrailingReset(original: string, translated: string): string {
  let stripped = translated.trimEnd();
  const count = (text: string) => text.split('§r').length - 1;
  while (stripped.endsWith('§r') && count(stripped) > count(original)) stripped = stripped.slice(0, -2).trimEnd();
  return stripped || translated;
}

export type TokenReport = { ok: boolean; lost: string[]; added: string[] };

/** What a translation drops from, or invents beyond, the original's tokens. */
export function compareTokens(original: string, translated: string): TokenReport {
  const before = tokenCounts(original);
  const after = tokenCounts(withoutTrailingReset(original, translated));
  const lost: string[] = [];
  const added: string[] = [];
  for (const [key, entry] of before) {
    const missing = entry.count - (after.get(key)?.count ?? 0);
    for (let i = 0; i < missing; i++) lost.push(entry.shown);
  }
  for (const [key, entry] of after) {
    const extra = entry.count - (before.get(key)?.count ?? 0);
    for (let i = 0; i < extra; i++) added.push(entry.shown);
  }
  return { ok: !lost.length && !added.length, lost, added };
}

export function tokensPreserved(original: string, translated: string): boolean {
  return compareTokens(original, translated).ok;
}
