// Run after the current UI has been captured in every supported UI language.
import { createHash } from 'node:crypto';
import { copyFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const filesUnder = (path) => readdirSync(resolve(root, path), { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? filesUnder(`${path}/${entry.name}`) : [`${path}/${entry.name}`]);
const sources = [...filesUnder('src'), 'tests/frontend/preview.html', 'tests/frontend/tauri-fixture-init.js', 'package.json', 'pnpm-lock.yaml', 'scripts/capture-docs.playwright.js'].sort();
const sourceHash = sha(sources.map((path) => `${path}\0${sha(readFileSync(resolve(root, path)))}\n`).join(''));
const images = [];
for (const locale of ['ko', 'en', 'ja', 'zh']) {
  for (const screen of ['review', 'settings', 'run']) {
    const path = `locales/${locale}/${screen}.png`;
    const bytes = readFileSync(resolve(root, 'docs/images', path));
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if (width !== 1440 || height !== 980) throw new Error(`Unexpected screenshot size: ${path}`);
    images.push({ path, locale, screen, width, height, bytes: bytes.length, sha256: sha(bytes) });
  }
}
// Preserve existing Korean image URLs using this capture, not old screenshots.
for (const screen of ['review', 'settings', 'run']) copyFileSync(resolve(root, `docs/images/locales/ko/${screen}.png`), resolve(root, `docs/images/${screen}.png`));
const manifest = { schema: 1, capturedOn: new Date().toISOString().slice(0, 10), environment: 'macOS / Playwright Chromium', theme: 'light', synthetic: true, externalRequests: 0, paidRequests: 0, sourceHash, sourceFiles: sources, images, aliases: { 'review.png': 'locales/ko/review.png', 'settings.png': 'locales/ko/settings.png', 'run.png': 'locales/ko/run.png' } };
writeFileSync(resolve(root, 'docs/images/manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
const assetImages = [];
const assetAliases = {};
for (const locale of ['ko', 'en', 'ja', 'zh']) {
  const paths = [`assets/brand/social/og_default_${locale}_v1`, ...['scan_first', 'backup_first', 'api_notice', 'unsupported'].map((card) => `assets/illustrations/docs/doc_${card}_${locale}_v1`)];
  for (const path of paths) {
    for (const extension of ['svg', 'png']) {
      const file = `${path}.${extension}`;
      const bytes = readFileSync(resolve(root, file));
      assetImages.push({ path: file.replace('assets/', ''), locale, bytes: bytes.length, sha256: sha(bytes) });
    }
  }
}
for (const card of ['scan_first', 'backup_first', 'api_notice', 'unsupported']) {
  const alias = `illustrations/docs/doc_${card}_v1.png`;
  const localized = `illustrations/docs/doc_${card}_ko_v1.png`;
  copyFileSync(resolve(root, 'assets', localized), resolve(root, 'assets', alias));
  assetAliases[alias] = localized;
}
writeFileSync(resolve(root, 'assets/localization-manifest.json'), JSON.stringify({ schema: 1, renderedOn: manifest.capturedOn, environment: manifest.environment, catalogHash: sha(readFileSync(resolve(root, 'assets/localization.json'))), generatorHash: sha(readFileSync(resolve(root, 'scripts/generate-localized-assets.mjs'))), images: assetImages, aliases: assetAliases }, null, 2) + '\n');
console.log(`Recorded ${images.length} localized screenshots; refreshed 3 Korean compatibility aliases.`);
console.log(`Recorded ${assetImages.length} localized SVG/PNG assets; refreshed 4 Korean guide aliases.`);
