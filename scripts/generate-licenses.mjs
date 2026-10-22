// Collect the license texts of everything the desktop app ships and write them where the app shows
// them (public/licenses/). Run it before a release build on each platform you package:
//
//   node scripts/generate-licenses.mjs            # rewrite public/licenses/
//   node scripts/generate-licenses.mjs --check    # fail when the committed file is out of date
//
// It covers the Rust crates compiled into the shell for every desktop target, the JavaScript that
// the page bundles, the font in public/fonts/, and the Python packages and interpreter inside the
// translation core. Proc-macro
// and build-only crates run on the build machine and are not shipped, so they are left out.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const outDir = join(root, 'public', 'licenses');
const outFile = join(outDir, 'THIRD_PARTY_LICENSES.txt');
const TARGETS = ['aarch64-apple-darwin', 'x86_64-apple-darwin', 'x86_64-pc-windows-msvc', 'x86_64-unknown-linux-gnu'];
const LICENSE_FILE = /^(licen[cs]e|copying|notice|unlicense|copyright)([-._].*)?$/i;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr}`);
  return result.stdout;
}

function licenseTexts(dir) {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => LICENSE_FILE.test(name) && statSync(join(dir, name)).isFile())
    .sort()
    .map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8').replace(/\r\n/g, '\n').trim() }));
}

// --- Rust ---------------------------------------------------------------------------------------
function rustPackages() {
  const shipped = new Map();
  for (const target of TARGETS) {
    const meta = JSON.parse(run('cargo', ['metadata', '--format-version', '1', '--locked', '--filter-platform', target], { cwd: join(root, 'src-tauri') }));
    const byId = new Map(meta.packages.map((pkg) => [pkg.id, pkg]));
    const nodes = new Map(meta.resolve.nodes.map((node) => [node.id, node]));
    const rootId = meta.resolve.root;
    const seen = new Set([rootId]);
    const queue = [rootId];
    while (queue.length) {
      const node = nodes.get(queue.shift());
      for (const dep of node?.deps ?? []) {
        // Only normal dependencies end up in the binary; build scripts and dev tools do not.
        if (!dep.dep_kinds.some((kind) => kind.kind === null)) continue;
        const pkg = byId.get(dep.pkg);
        if (!pkg || pkg.targets.every((t) => t.kind.includes('proc-macro'))) continue;
        if (seen.has(dep.pkg)) continue;
        seen.add(dep.pkg);
        queue.push(dep.pkg);
      }
    }
    seen.delete(rootId);
    for (const id of seen) {
      const pkg = byId.get(id);
      const key = `${pkg.name} ${pkg.version}`;
      const entry = shipped.get(key) ?? { name: pkg.name, version: pkg.version, license: pkg.license || (pkg.license_file ? 'see file' : 'unspecified'),
        source: pkg.repository || `https://crates.io/crates/${pkg.name}/${pkg.version}`, dir: resolve(pkg.manifest_path, '..'), targets: [] };
      entry.targets.push(target);
      shipped.set(key, entry);
    }
  }
  return [...shipped.values()].map((entry) => ({
    ...entry,
    note: entry.targets.length === TARGETS.length ? '' : `only on ${entry.targets.join(', ')}`,
    texts: licenseTexts(entry.dir)
  }));
}

// --- JavaScript ---------------------------------------------------------------------------------
function javascriptPackages() {
  const listed = JSON.parse(run('pnpm', ['licenses', 'list', '--prod', '--json']));
  const out = [];
  for (const [license, packages] of Object.entries(listed)) {
    for (const pkg of packages) {
      for (const [index, version] of (pkg.versions ?? [pkg.version]).entries()) {
        const dir = pkg.paths?.[index] ?? pkg.path;
        out.push({ name: pkg.name, version, license, source: pkg.homepage || `https://www.npmjs.com/package/${pkg.name}`, note: '', texts: licenseTexts(dir) });
      }
    }
  }
  return out;
}

// --- Python -------------------------------------------------------------------------------------
const PYTHON_SCRIPT = String.raw`
import json, sys, sysconfig
from pathlib import Path
from importlib import metadata

wanted = [line.split('==')[0].strip() for line in open(sys.argv[1], encoding='utf-8')
          if line.strip() and not line.startswith('#')]
wanted = [name for name in wanted if name.lower() != 'nbt']  # test-only, never packaged
seen, queue, out = set(), list(wanted), []
while queue:
    name = queue.pop(0)
    key = name.lower().replace('_', '-')
    if key in seen:
        continue
    seen.add(key)
    try:
        dist = metadata.distribution(name)
    except metadata.PackageNotFoundError:
        out.append({"name": name, "version": "not installed here", "license": "check on the release machine", "texts": []})
        continue
    for requirement in dist.requires or []:
        if 'extra ==' in requirement:
            continue
        marker_ok = True
        if ';' in requirement:
            try:
                try:
                    from packaging.markers import Marker
                except ImportError:
                    from pip._vendor.packaging.markers import Marker
                marker_ok = Marker(requirement.split(';', 1)[1]).evaluate()
            except Exception:
                marker_ok = True
        if marker_ok:
            queue.append(requirement.split(';')[0].split('[')[0].split('<')[0].split('>')[0].split('=')[0].split('!')[0].split('~')[0].strip())
    texts = []
    for file in dist.files or []:
        parts = Path(str(file)).parts
        base = parts[-1]
        if ('licenses' in parts or base.upper().startswith(('LICENSE', 'LICENCE', 'COPYING', 'NOTICE'))) and '.dist-info' in str(file):
            try:
                texts.append({"name": base, "text": Path(dist.locate_file(file)).read_text(encoding='utf-8').strip()})
            except Exception:
                pass
    meta = dist.metadata
    out.append({"name": meta["Name"], "version": dist.version,
                "license": meta.get("License-Expression") or meta.get("License") or "see file",
                "source": meta.get("Home-page") or f"https://pypi.org/project/{meta['Name']}/{dist.version}/",
                "texts": texts})
lic = None
for candidate in [Path(sys.base_prefix) / "LICENSE.txt", Path(sysconfig.get_paths()["stdlib"]) / "LICENSE.txt"]:
    if candidate.is_file():
        lic = candidate.read_text(encoding='utf-8').strip()
        break
version = ".".join(map(str, sys.version_info[:3]))
out.append({"name": "Python", "version": version, "license": "PSF-2.0 and the licenses of bundled components",
            "source": f"https://docs.python.org/{sys.version_info[0]}.{sys.version_info[1]}/license.html",
            "texts": [{"name": "LICENSE.txt", "text": lic}] if lic else []})
try:
    import PyInstaller
    out.append({"name": "PyInstaller bootloader", "version": PyInstaller.__version__,
                "license": "GPL-2.0-or-later WITH Bootloader-exception",
                "source": "https://pyinstaller.org/en/stable/license.html", "texts": []})
except Exception:
    out.append({"name": "PyInstaller bootloader", "version": "build tool",
                "license": "GPL-2.0-or-later WITH Bootloader-exception",
                "source": "https://pyinstaller.org/en/stable/license.html", "texts": []})
print(json.dumps(out))
`;

function pythonPackages() {
  const python = process.env.POMI_BUILD_PYTHON ||
    (process.platform === 'win32' ? join(root, '.venv', 'Scripts', 'python.exe') : join(root, '.venv', 'bin', 'python'));
  const interpreter = existsSync(python) ? python : process.platform === 'win32' ? 'python' : 'python3';
  return JSON.parse(run(interpreter, ['-c', PYTHON_SCRIPT, join(root, 'requirements.txt')])).map((pkg) => ({ note: '', ...pkg }));
}

// --- Bundled fonts ------------------------------------------------------------------------------
// public/fonts/ ships with the page, so the font's own license text goes into the notices too. The
// brand lockup in src/components/Brand.svelte is traced from Pretendard glyph outlines, which the OFL
// permits for a derivative that does not use the Reserved Font Name; the entry says so.
function fontPackages() {
  const file = join(root, 'public', 'fonts', 'Pretendard-OFL.txt');
  if (!existsSync(file)) throw new Error('public/fonts/Pretendard-OFL.txt is missing; the bundled font needs its license text');
  return [{
    name: 'Pretendard Variable',
    version: '1.3.9',
    license: 'OFL-1.1',
    source: 'https://github.com/orioncactus/pretendard',
    note: '',
    texts: [
      { name: 'NOTICE', text: 'Bundled as public/fonts/PretendardVariable.woff2 (Copyright (c) 2021 Kil Hyung-jin). The PomiTranslate logo lettering in the interface is vector outlines derived from Pretendard, which the SIL Open Font License permits.' },
      { name: 'Pretendard-OFL.txt', text: readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trim() }
    ]
  }];
}

// --- Output -------------------------------------------------------------------------------------
function section(title, packages) {
  const sorted = [...packages].sort((a, b) => a.name.localeCompare(b.name) || String(a.version).localeCompare(String(b.version)));
  const lines = [`${'='.repeat(78)}`, title, `${'='.repeat(78)}`, ''];
  for (const pkg of sorted) {
    lines.push(`${pkg.name} ${pkg.version} — ${pkg.license}${pkg.note ? ` (${pkg.note})` : ''}`);
    if (pkg.source) lines.push(`  ${pkg.source}`);
  }
  lines.push('');
  // Identical texts are printed once, after the list of packages that carry them.
  const groups = new Map();
  for (const pkg of sorted) {
    for (const text of pkg.texts) {
      if (!text.text) continue;
      const group = groups.get(text.text) ?? [];
      group.push(`${pkg.name} ${pkg.version}`);
      groups.set(text.text, group);
    }
  }
  for (const [text, owners] of groups) {
    lines.push('-'.repeat(78), `Applies to: ${[...new Set(owners)].join(', ')}`, '-'.repeat(78), text, '');
  }
  const missing = sorted.filter((pkg) => !pkg.texts.length).map((pkg) => `${pkg.name} ${pkg.version}`);
  if (missing.length) {
    lines.push('-'.repeat(78), 'No license file in the published package; the license named above applies:', ...missing.map((name) => `  ${name}`), '');
  }
  return lines.join('\n');
}

const rust = rustPackages();
const javascript = javascriptPackages();
const python = pythonPackages();
const fonts = fontPackages();
const lockHash = (file) => {
  const result = spawnSync('git', ['hash-object', file], { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim().slice(0, 12) : 'unknown';
};
const header = [
  'PomiTranslate — third-party software notices',
  '',
  'PomiTranslate is MIT licensed (see LICENSE.txt). It includes the software listed below, each under',
  'its own license; those licenses are not replaced by the MIT license. Generated by',
  `scripts/generate-licenses.mjs from Cargo.lock ${lockHash('src-tauri/Cargo.lock')}, pnpm-lock.yaml ${lockHash('pnpm-lock.yaml')} and`,
  'requirements.txt. Python packages are listed as installed on the machine that generated this file;',
  'regenerate on each release platform before packaging.',
  '',
  'NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.',
  ''
].join('\n');
const body = [
  header,
  section(`Desktop shell (Rust crates, ${rust.length})`, rust),
  section(`Interface (JavaScript packages, ${javascript.length})`, javascript),
  section(`Translation core (Python, ${python.length})`, python),
  section(`Bundled fonts (${fonts.length})`, fonts)
].join('\n');

if (process.argv.includes('--check')) {
  const current = existsSync(outFile) ? readFileSync(outFile, 'utf8') : '';
  if (current !== body) {
    console.error('public/licenses/THIRD_PARTY_LICENSES.txt is out of date; run node scripts/generate-licenses.mjs');
    process.exit(1);
  }
  console.log('Third-party notices are current.');
} else {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outFile, body);
  copyFileSync(join(root, 'LICENSE'), join(outDir, 'LICENSE.txt'));
  console.log(`Wrote ${outFile}: ${rust.length} Rust, ${javascript.length} JavaScript, ${python.length} Python, ${fonts.length} font entries, ${(body.length / 1024).toFixed(0)} KB`);
}
