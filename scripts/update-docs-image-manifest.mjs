// Run after the current UI has been captured in every supported UI language.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { release } from 'node:os';
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
const capturedOn = new Date().toISOString().slice(0, 10);
// The screenshots are taken wherever the capture ran; POMI_CAPTURE_ENVIRONMENT overrides the detected OS name.
const osName = process.platform === 'win32' ? (Number(release().split('.')[2]) >= 22000 ? 'Windows 11' : 'Windows 10') : process.platform === 'darwin' ? 'macOS' : 'Linux';
const environment = process.env.POMI_CAPTURE_ENVIRONMENT || `${osName} / Playwright Chromium`;
const locales = ['ko', 'en', 'ja', 'zh'];
const captures = [{ locales, capturedOn, environment, sourceHash, note: 'All screenshots were captured in one run from the same UI source.' }];
const manifest = { schema: 1, capturedOn, environment, theme: 'light', synthetic: true, externalRequests: 0, paidRequests: 0, sourceHash, sourceFiles: sources, images, aliases: { 'review.png': 'locales/ko/review.png', 'settings.png': 'locales/ko/settings.png', 'run.png': 'locales/ko/run.png' }, captures };
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
// Only the screenshots are retaken by a normal recapture; the card PNGs keep their render date and environment unless
// they were re-rendered too (pass --assets-rendered), so another OS's fonts do not rewrite them.
const assetsManifestPath = resolve(root, 'assets/localization-manifest.json');
const previousAssets = existsSync(assetsManifestPath) ? JSON.parse(readFileSync(assetsManifestPath, 'utf8')) : {};
const assetsRendered = process.argv.includes('--assets-rendered') || !previousAssets.renderedOn;
writeFileSync(assetsManifestPath, JSON.stringify({ schema: 1, renderedOn: assetsRendered ? manifest.capturedOn : previousAssets.renderedOn, environment: assetsRendered ? manifest.environment : previousAssets.environment, catalogHash: sha(readFileSync(resolve(root, 'assets/localization.json'))), generatorHash: sha(readFileSync(resolve(root, 'scripts/generate-localized-assets.mjs'))), images: assetImages, aliases: assetAliases }, null, 2) + '\n');
console.log(`Recorded ${images.length} localized screenshots; refreshed 3 Korean compatibility aliases.`);
console.log(`Recorded ${assetImages.length} localized SVG/PNG assets; refreshed 4 Korean guide aliases.`);
