import type { Locale, MessageKey } from './i18n/index.svelte';
import { translate } from './i18n/index.svelte';
import type { CandidateLocation } from './api';

const BCP47: Record<Locale, string> = { ko: 'ko-KR', en: 'en-US', ja: 'ja-JP', zh: 'zh-CN' };

export function formatNumber(value: number, locale: Locale): string {
  return new Intl.NumberFormat(BCP47[locale]).format(value);
}

export function formatCompact(value: number, locale: Locale): string {
  return new Intl.NumberFormat(BCP47[locale], { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

export function formatBytes(bytes: number, locale: Locale): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exponent;
  const digits = exponent === 0 || value >= 100 ? 0 : 1;
  return `${new Intl.NumberFormat(BCP47[locale], { maximumFractionDigits: digits }).format(value)} ${units[exponent]}`;
}

/** Dollars, with as many decimals as it takes to show the first significant digits of a tiny amount. */
export function formatUsd(amount: number, locale: Locale): string {
  const abs = Math.abs(amount);
  const options: Intl.NumberFormatOptions = { style: 'currency', currency: 'USD' };
  // Under a cent, fixed decimals would round a real amount to "$0.00": keep two significant digits instead.
  if (abs > 0 && abs < 0.01) options.maximumSignificantDigits = 2;
  else { options.minimumFractionDigits = 2; options.maximumFractionDigits = abs >= 1 ? 2 : 3; }
  return new Intl.NumberFormat(BCP47[locale], options).format(amount);
}

export function formatDuration(seconds: number, locale: Locale): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return translate(locale, 'time.seconds', { n: total });
  if (total < 3600) return translate(locale, 'time.minutes', { m: Math.floor(total / 60), s: total % 60 });
  return translate(locale, 'time.hours', { h: Math.floor(total / 3600), m: Math.floor((total % 3600) / 60) });
}

export function formatDate(value: string | number, locale: Locale): string {
  const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(BCP47[locale], { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

/** The last folder of a path, for a world name. Works with both separators. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Shorten the middle of a long path and keep both ends, which are what people recognise. */
export function middleEllipsis(path: string, max = 56): string {
  if (path.length <= max) return path;
  const keep = max - 1;
  const head = Math.ceil(keep * 0.4);
  return `${path.slice(0, head)}…${path.slice(path.length - (keep - head))}`;
}

const HOLDER_PREFIX = /^minecraft:/;

/** Dimension name, localized text kind and block coordinates; unknown holder IDs remain in a tooltip. */
export function describeLocation(location: CandidateLocation, locale: Locale, fallbackKind?: string): string {
  const dimension = dimensionId(location);
  const dimensionLabel = dimension === 'minecraft:overworld' ? translate(locale, 'review.dimension.overworld')
    : dimension === 'minecraft:the_nether' ? translate(locale, 'review.dimension.nether')
    : dimension === 'minecraft:the_end' ? translate(locale, 'review.dimension.end') : dimension;
  const kindId = location.kind || fallbackKind;
  const kind = kindId ? translate(locale, `kind.${kindId}` as MessageKey)
    : (location.holder ?? '').replace(HOLDER_PREFIX, '').replaceAll('_', ' ');
  if (location.pos) {
    const [x, y, z] = location.pos;
    return `${dimensionLabel} · ${kind} · ${translate(locale, 'review.location.coordinates', { x, y, z })}`;
  }
  if (kind) return `${dimensionLabel} · ${kind}`;
  const [cx, cz] = location.chunk ?? [];
  return cx === undefined || cz === undefined ? dimensionLabel : `${dimensionLabel} · ${translate(locale, 'detail.chunk', { x: cx, z: cz })}`;
}

/** Infer vanilla or custom dimension IDs from the scan-relative file path. */
export function dimensionId(location: CandidateLocation): string {
  if (location.dimension) return location.dimension;
  const file = (location.file ?? '').replace(/\\/g, '/');
  if (/(?:^|\/)DIM-1(?:\/|$)/.test(file)) return 'minecraft:the_nether';
  if (/(?:^|\/)DIM1(?:\/|$)/.test(file)) return 'minecraft:the_end';
  const custom = file.match(/(?:^|\/)dimensions\/([^/]+)\/([^/]+)(?:\/|$)/);
  if (custom) return `${custom[1]}:${custom[2]}`;
  return 'minecraft:overworld';
}

export function rawLocation(location: CandidateLocation): string {
  const parts = [location.holder, location.pos ? `(${location.pos.join(', ')})` : '', location.file ?? ''].filter(Boolean);
  return parts.join(' · ');
}

export function teleportCommand(location: CandidateLocation): string {
  const pos = location.pos;
  if (!pos || pos.length !== 3 || !pos.every(Number.isFinite)) return '';
  return `/execute in ${dimensionId(location)} run tp @s ${pos.join(' ')}`;
}

/** "front:2" → "Front, line 2". Unknown details are shown as they came. */
export function describeDetail(detail: string | undefined, locale: Locale): string {
  if (!detail) return '';
  const [name, value] = detail.split(':');
  const table: Record<string, () => string> = {
    front: () => translate(locale, 'detail.front', { line: value }),
    back: () => translate(locale, 'detail.back', { line: value }),
    line: () => translate(locale, 'detail.line', { line: value }),
    page: () => translate(locale, 'detail.page', { page: value }),
    custom: () => translate(locale, 'detail.custom'),
    base: () => translate(locale, 'detail.base')
  };
  return table[name]?.() ?? detail;
}
