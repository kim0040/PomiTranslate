import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { filterPackages, parseThirdPartyLicenses } from '../../src/lib/licenses';

const file = readFileSync('public/licenses/THIRD_PARTY_LICENSES.txt', 'utf8');

describe('third-party license list', () => {
  const parsed = parseThirdPartyLicenses(file);

  it('keeps the introduction, including the required Minecraft notice, as an overview', () => {
    expect(parsed.overview).toContain('third-party software notices');
    expect(parsed.overview).toContain('NOT AN OFFICIAL MINECRAFT PRODUCT');
  });

  it('lists every package of every section with name, version and license', () => {
    const sections = new Set(parsed.packages.map((pkg) => pkg.section.replace(/ \(.*$/, '')));
    expect([...sections]).toEqual(['Desktop shell', 'Interface', 'Translation core', 'Bundled fonts']);
    const tauri = parsed.packages.find((pkg) => pkg.name === 'tauri');
    expect(tauri?.version).toMatch(/^\d/);
    expect(tauri?.license).not.toBe('');
    expect(tauri?.texts.length).toBeGreaterThan(0);
    // A package that ships on some targets only keeps that note out of its license.
    const only = parsed.packages.find((pkg) => pkg.note.startsWith('only on'));
    expect(only?.license).not.toContain('only on');
  });

  it('carries the bundled font with its full OFL text', () => {
    const font = parsed.packages.find((pkg) => pkg.name === 'Pretendard Variable');
    expect(font).toMatchObject({ version: '1.3.9', license: 'OFL-1.1', source: 'https://github.com/orioncactus/pretendard' });
    expect(font?.texts.join('\n')).toContain('SIL OPEN FONT LICENSE Version 1.1');
    expect(font?.texts.join('\n')).toContain('Kil Hyung-jin');
  });

  it('gives packages with several versions one entry each', () => {
    const names = parsed.packages.map((pkg) => `${pkg.name} ${pkg.version}`);
    expect(new Set(names).size).toBe(names.length);
  });

  it('filters by name, version and license, ignoring case', () => {
    expect(filterPackages(parsed.packages, '').length).toBe(parsed.packages.length);
    const hits = filterPackages(parsed.packages, 'PRETENDARD');
    expect(hits.map((pkg) => pkg.name)).toEqual(['Pretendard Variable']);
    expect(filterPackages(parsed.packages, 'ofl-1.1').length).toBe(1);
    expect(filterPackages(parsed.packages, 'no such package anywhere')).toEqual([]);
  });

  it('survives a file it does not understand', () => {
    expect(parseThirdPartyLicenses('')).toEqual({ overview: '', packages: [] });
    expect(parseThirdPartyLicenses('just some text').packages).toEqual([]);
  });
});
