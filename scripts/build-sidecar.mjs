import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const rust = spawnSync('rustc', ['-vV'], { cwd: root, encoding: 'utf8' });
if (rust.status !== 0) throw new Error('rustc is required to identify the sidecar target');
const triple = rust.stdout.match(/^host: (.+)$/m)?.[1];
if (!triple) throw new Error('Could not read the Rust host target');

const python = process.env.POMI_BUILD_PYTHON ||
  (process.platform === 'win32' ? join(root, '.venv', 'Scripts', 'python.exe') : join(root, '.venv', 'bin', 'python'));
const buildDir = join(root, 'build', 'sidecar');
const distDir = join(buildDir, 'dist');
const workDir = join(buildDir, 'work');
const specDir = join(buildDir, 'spec');
const cacheDir = join(buildDir, 'cache');
mkdirSync(distDir, { recursive: true });
mkdirSync(workDir, { recursive: true });
mkdirSync(specDir, { recursive: true });
mkdirSync(cacheDir, { recursive: true });

const built = spawnSync(python, [
  '-m', 'PyInstaller', '--noconfirm', '--onefile',
  ...(process.argv.includes('--clean') ? ['--clean'] : []),
  '--name', 'pomi-sidecar', '--paths', root,
  // UTF-8 mode: pipes, files and paths use UTF-8 whatever the Windows code page is (cp949, cp1252).
  '--python-option', 'X utf8',
  '--hidden-import', 'lz4.block',
  '--hidden-import', 'keyring', '--hidden-import', 'mwt.desktop_entry',
  '--hidden-import', 'mc_world_translator', '--hidden-import', 'llm_backends',
  '--hidden-import', 'env_utils', '--hidden-import', 'mwt.nbtio', '--hidden-import', 'mwt.extract',
  '--distpath', distDir, '--workpath', workDir, '--specpath', specDir,
  join(root, 'packaging', 'pomi_desktop.py')
], { cwd: root, stdio: 'inherit', env: { ...process.env, PYINSTALLER_CONFIG_DIR: cacheDir } });
if (built.status !== 0) throw new Error(`PyInstaller failed with status ${built.status}`);

const extension = process.platform === 'win32' ? '.exe' : '';
const source = join(distDir, `pomi-sidecar${extension}`);
const target = join(root, 'src-tauri', 'binaries', `pomi-sidecar-${triple}${extension}`);
copyFileSync(source, target);
process.stdout.write(`Bundled sidecar: ${target}\n`);
