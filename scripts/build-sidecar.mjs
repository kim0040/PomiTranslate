// Builds the translation core as a PyInstaller *onedir* folder: build/sidecar/dist/pomi-sidecar/
// (the executable next to its _internal/ folder). tauri.conf.json maps that folder into the
// installer's resources; nothing is extracted at run time and the process the shell starts is the
// real core, so the shell can supervise it (see docs/build.md).
//
//   node scripts/build-sidecar.mjs                 build (incremental)
//   node scripts/build-sidecar.mjs --clean         build from scratch (PyInstaller --clean)
//   node scripts/build-sidecar.mjs --no-smoke      skip the start-up check of the built core
//   node scripts/build-sidecar.mjs --list-nested   only list the nested binaries of an existing build
//
// Nothing here signs anything. The nested-binary list (build/sidecar/nested-binaries.json) is the
// input a later signing step consumes.
import { spawnSync } from 'node:child_process';
import {
  chmodSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync,
  readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const flags = new Set(process.argv.slice(2));
const isWindows = process.platform === 'win32';
const exeName = isWindows ? 'pomi-sidecar.exe' : 'pomi-sidecar';

const buildDir = join(root, 'build', 'sidecar');
const distDir = join(buildDir, 'dist');
const outDir = join(distDir, 'pomi-sidecar');
const exePath = join(outDir, exeName);
const nestedFile = join(buildDir, 'nested-binaries.json');

// --- what is inside the folder -----------------------------------------------------------------

const MACHO = new Set(['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe']);

/** 'macho' | 'elf' | 'pe' | null from the first bytes of a file. */
function binaryKind(path, size) {
  if (size < 4) return null;
  const head = Buffer.alloc(8);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, head, 0, 8, 0);
  } finally {
    closeSync(fd);
  }
  const magic = head.subarray(0, 4).toString('hex');
  if (MACHO.has(magic)) return 'macho';
  // 0xCAFEBABE starts a universal Mach-O (a small architecture count) and also a Java class file
  // (a version of 45 or more); only the first is a binary to sign.
  if (magic === 'cafebabe' && head.readUInt32BE(4) < 45) return 'macho';
  if (magic === '7f454c46') return 'elf';
  if (head[0] === 0x4d && head[1] === 0x5a && /\.(exe|dll|pyd|sys)$/i.test(path)) return 'pe';
  return null;
}

function walk(dir, visit) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, visit);
    else visit(path, entry);
  }
}

/** Every native binary in the folder, deepest first - the order an inside-out signing pass needs. */
function listNested() {
  const files = [];
  const symlinks = [];
  walk(outDir, (path) => {
    const info = lstatSync(path);
    const rel = relative(outDir, path).split(sep).join('/');
    if (info.isSymbolicLink()) {
      symlinks.push(rel);
      return;
    }
    const kind = binaryKind(path, info.size);
    if (kind) files.push({ path: rel, kind, size: info.size, executable: (info.mode & 0o111) !== 0 });
  });
  const depth = (file) => file.path.split('/').length;
  // The main executable is signed last, after everything it loads; deeper files before shallower ones.
  files.sort((a, b) => (a.path === exeName) - (b.path === exeName) || depth(b) - depth(a) || a.path.localeCompare(b.path));
  return { platform: process.platform, arch: process.arch, root: 'build/sidecar/dist/pomi-sidecar', main: exeName, files, symlinks };
}

function writeNestedList() {
  const list = listNested();
  mkdirSync(buildDir, { recursive: true });
  writeFileSync(nestedFile, `${JSON.stringify(list, null, 2)}\n`);
  const counts = {};
  for (const file of list.files) counts[file.kind] = (counts[file.kind] ?? 0) + 1;
  const summary = Object.entries(counts).map(([kind, count]) => `${count} ${kind}`).join(', ') || 'none';
  process.stdout.write(`Nested native binaries: ${summary}; ${list.symlinks.length} symbolic links (kept as they are)\n`);
  process.stdout.write(`Signing input: ${relative(root, nestedFile)}\n`);
  return list;
}

// --- POSIX modes ---------------------------------------------------------------------------------

/** The executable bit is what makes the packaged core start on Linux and macOS. */
function fixPosixModes() {
  if (isWindows) return;
  chmodSync(exePath, 0o755);
  walk(outDir, (path) => {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) return;
    const kind = binaryKind(path, info.size);
    // Shared libraries and extension modules are mapped, not executed, but keeping them executable
    // is what PyInstaller does and what signing tools expect.
    if (kind && (info.mode & 0o111) === 0) chmodSync(path, info.mode | 0o755);
  });
  const mode = statSync(exePath).mode & 0o777;
  if ((mode & 0o111) !== 0o111) throw new Error(`The core is not executable (mode ${mode.toString(8)})`);
}

// --- build ---------------------------------------------------------------------------------------

function pinnedPyInstaller() {
  const text = readFileSync(join(root, 'requirements-build.txt'), 'utf8');
  return text.match(/^pyinstaller==([\w.]+)/im)?.[1];
}

function build() {
  const python = process.env.POMI_BUILD_PYTHON ||
    (isWindows ? join(root, '.venv', 'Scripts', 'python.exe') : join(root, '.venv', 'bin', 'python'));
  const version = spawnSync(python, ['-m', 'PyInstaller', '--version'], { cwd: root, encoding: 'utf8' });
  if (version.status !== 0) {
    throw new Error(`PyInstaller is not available for ${python}. Install it with: ${python} -m pip install -r requirements-build.txt`);
  }
  const pin = pinnedPyInstaller();
  const have = version.stdout.trim();
  if (pin && have !== pin && !process.env.POMI_BUILD_ALLOW_PYINSTALLER_MISMATCH) {
    throw new Error(`PyInstaller ${have} is installed but requirements-build.txt pins ${pin}`);
  }

  const workDir = join(buildDir, 'work');
  const specDir = join(buildDir, 'spec');
  const cacheDir = join(buildDir, 'cache');
  // A stale or placeholder folder must never be mixed into a build.
  rmSync(outDir, { recursive: true, force: true });
  for (const dir of [distDir, workDir, specDir, cacheDir]) mkdirSync(dir, { recursive: true });

  const built = spawnSync(python, [
    '-m', 'PyInstaller', '--noconfirm', '--onedir', '--contents-directory', '_internal',
    ...(flags.has('--clean') ? ['--clean'] : []),
    '--name', 'pomi-sidecar', '--paths', root,
    '--hidden-import', 'lz4.block',
    '--hidden-import', 'keyring', '--hidden-import', 'mwt.desktop_entry',
    '--hidden-import', 'mc_world_translator', '--hidden-import', 'llm_backends',
    '--hidden-import', 'env_utils', '--hidden-import', 'mwt.nbtio', '--hidden-import', 'mwt.extract',
    '--distpath', distDir, '--workpath', workDir, '--specpath', specDir,
    join(root, 'packaging', 'pomi_desktop.py'),
  ], { cwd: root, stdio: 'inherit', env: { ...process.env, PYINSTALLER_CONFIG_DIR: cacheDir } });
  if (built.status !== 0) throw new Error(`PyInstaller failed with status ${built.status}`);
  if (!existsSync(exePath)) throw new Error(`PyInstaller did not produce ${exePath}`);
  if (!existsSync(join(outDir, '_internal'))) throw new Error('PyInstaller did not produce the _internal folder (is this an onedir build?)');
}

/** The built core must start and say hello with its stdin closed - the cheapest proof it is whole. */
function smoke() {
  const scratch = mkdtempSync(join(tmpdir(), 'pomi sidecar smoke '));
  try {
    const started = Date.now();
    const run = spawnSync(exePath, ['--jsonl', '--data-dir', scratch, '--report-dir', scratch, '--cancel-file', join(scratch, 'cancel')], {
      input: '', encoding: 'utf8', timeout: 90_000, windowsHide: true,
    });
    const first = (run.stdout ?? '').split(/\r?\n/).find((line) => line.trim());
    let hello;
    try { hello = JSON.parse(first ?? ''); } catch { /* reported below */ }
    if (run.status !== 0 || hello?.type !== 'system.hello') {
      throw new Error(`The built core did not start cleanly (status ${run.status}).\nstdout: ${run.stdout}\nstderr: ${run.stderr}`);
    }
    process.stdout.write(`Start-up check: system.hello (protocol ${hello.payload?.protocolVersion}) after ${Date.now() - started} ms including exit\n`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function folderSize(dir) {
  let total = 0;
  walk(dir, (path) => { total += lstatSync(path).size; });
  return total;
}

if (flags.has('--list-nested')) {
  if (!existsSync(exePath)) throw new Error(`There is no build at ${outDir}; run pnpm sidecar:build first`);
  writeNestedList();
} else {
  build();
  fixPosixModes();
  writeNestedList();
  if (!flags.has('--no-smoke')) smoke();
  process.stdout.write(`Bundled sidecar: ${outDir} (${(folderSize(outDir) / 1024 / 1024).toFixed(1)} MiB)\n`);
}
