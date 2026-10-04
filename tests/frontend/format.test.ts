import { describe, expect, it } from 'vitest';

import {
  baseName,
  describeDetail,
  describeLocation,
  teleportCommand,
  formatBytes,
  formatCompact,
  formatDate,
  formatDuration,
  formatNumber,
  formatRequestEstimate,
  formatRequestRange,
  formatUsd,
  middleEllipsis
} from '../../src/lib/format';

describe('format helpers', () => {
  it('shows glossary-aware request ranges in each locale and keeps exact request counts compact', () => {
    const range = { requests: 1, requestRange: { low: 1, high: 3 } };
    expect(formatRequestEstimate(range, 'ko')).toBe('요청 1–3회');
    expect(formatRequestEstimate(range, 'en')).toBe('1–3 requests');
    expect(formatRequestEstimate(range, 'ja')).toBe('リクエスト1～3回');
    expect(formatRequestRange(range, 'ko')).toBe('요청 1–3회');
    expect(formatRequestEstimate({ requests: 2, requestRange: { low: 2, high: 2 } }, 'en')).toBe('2');
    expect(formatRequestRange({ requestRange: { low: 2, high: 2 } }, 'en')).toBe('');
  });

  it('formats counts and compact values in each supported locale', () => {
    expect(formatNumber(1234567, 'en')).toBe('1,234,567');
    expect(formatNumber(1234567, 'ko')).toBe('1,234,567');
    expect(formatNumber(1234567, 'ja')).toBe('1,234,567');
    expect(formatCompact(1250, 'en')).toBe('1.3K');
    expect(formatCompact(1250, 'ko')).toBe('1.3천');
    expect(formatCompact(1250, 'ja')).toBe('1250');
  });

  it('formats bytes at boundaries and handles invalid values safely', () => {
    expect(formatBytes(-1, 'en')).toBe('0 B');
    expect(formatBytes(Number.NaN, 'en')).toBe('0 B');
    expect(formatBytes(0, 'en')).toBe('0 B');
    expect(formatBytes(1024, 'en')).toBe('1 KB');
    expect(formatBytes(1536, 'en')).toBe('1.5 KB');
    expect(formatBytes(1024 ** 2, 'en')).toBe('1 MB');
    expect(formatBytes(1024 ** 3 * 1.25, 'en')).toBe('1.3 GB');
  });

  it('keeps small USD amounts visible and uses currency formatting', () => {
    expect(formatUsd(0, 'en')).toBe('$0.00');
    expect(formatUsd(1.25, 'en')).toBe('$1.25');
    expect(formatUsd(0.01234, 'en')).toBe('$0.012');
    expect(formatUsd(-0.0001, 'en')).toBe('-$0.0001');
    expect(formatUsd(1.25, 'ko')).toContain('US$');
    // Estimates and caps under a cent never collapse to "$0.00".
    expect(formatUsd(0.00004, 'en')).toBe('$0.00004');
    expect(formatUsd(0.00018, 'en')).toBe('$0.00018');
    expect(formatUsd(0.005, 'en')).toBe('$0.005');
    expect(formatUsd(0.00004, 'ko')).toBe('US$0.00004');
  });

  it('formats duration with the correct unit and clamps negative input', () => {
    expect(formatDuration(-1, 'en')).toBe('0s');
    expect(formatDuration(59.4, 'en')).toBe('59s');
    expect(formatDuration(60, 'en')).toBe('1m 0s');
    expect(formatDuration(3599, 'en')).toBe('59m 59s');
    expect(formatDuration(3600, 'en')).toBe('1h 0m');
    expect(formatDate('not-a-date', 'en')).toBe('');
    expect(formatDate('2026-01-02T03:04:05Z', 'en')).toContain('2026');
  });

  it('formats dates, paths, locations, and detail labels', () => {
    expect(formatDuration(61, 'ko')).toBe('1분 1초');
    expect(formatNumber(2, 'ja')).toBe('2');
    expect(formatUsd(0.01, 'ja')).toContain('$');
    expect(formatNumber(1, 'en')).toBe('1');
    expect(baseName('/tmp/world/')).toBe('world');
    expect(baseName('C:\\Users\\player\\world')).toBe('world');
    expect(middleEllipsis('short/path')).toBe('short/path');
    const longPath = '/Users/player/Documents/Minecraft/worlds/this-is-a-very-long-world-folder-name';
    const shortened = middleEllipsis(longPath, 32);
    expect(shortened).toHaveLength(32);
    expect(shortened).toContain('…');
    expect(shortened.startsWith('/Users')).toBe(true);
    expect(shortened.endsWith('name')).toBe(true);
    expect(describeLocation({ holder: 'minecraft:oak_sign', pos: [1, 64, 20] }, 'en', 'sign')).toBe('Overworld · Sign · x 1 · y 64 · z 20');
    expect(describeLocation({ holder: 'minecraft:chest' }, 'en')).toBe('Overworld · chest');
    expect(describeLocation({ chunk: [3, -2] }, 'en')).toBe('Overworld · Chunk (3, -2)');
    expect(describeLocation({ dimension: 'custom:sky', kind: 'entity_name', pos: [8, 70, 11] }, 'en')).toBe('custom:sky · Entity Name · x 8 · y 70 · z 11');
    expect(teleportCommand({ dimension: 'minecraft:the_nether', pos: [1, 64, 20] })).toBe('/execute in minecraft:the_nether run tp @s 1 64 20');
    expect(describeDetail('front:2', 'en')).toBe('Front, line 2');
    expect(describeDetail('page:3', 'en')).toBe('Page 3');
    expect(describeDetail('unmapped:value', 'en')).toBe('unmapped:value');
    expect(describeDetail(undefined, 'en')).toBe('');
  });
});
