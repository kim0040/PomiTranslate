// The local gate: everything that GitHub Actions would have checked, run on this machine.
// (Actions is not available for this project; see docs/ci-policy.md.)
//
//   pnpm verify:local                       all groups
//   pnpm verify:local --only rust           one group: python | frontend | rust
//   pnpm verify:local --skip python,rust    all but these groups
//   pnpm verify:local --verbose             show the output of passing steps too
//
// Every step prints PASS or FAIL with its time; a failing step shows its last lines, the run goes on
// with the next step, and the exit code is 1 if any step failed. The Python interpreter is
// $POMI_PYTHON, else `python`. This is a source gate: it does not build the sidecar or the installer
// and does not replace the native / real-provider / release gates (docs/verification-policy.md).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const isWindows = process.platform === 'win32';
const python = process.env.POMI_PYTHON || 'python';

// Python test scripts, in the order of .github/workflows/ci.yml. New test files are appended here.
const PYTHON_TESTS = [
  ['Core regression', 'test_core.py'],
  ['Compatibility fixtures', 'tests/test_release_fixtures.py'],
  ['Brand and secret surfaces', 'tests/test_brand_secrets.py'],
  ['Desktop entry', 'tests/test_desktop_entry.py'],
  ['Providers and remembered settings', 'tests/test_providers.py'],
  ['Desktop credential routing boundary', 'tests/test_desktop_provider.py'],
  ['Settings validation and recovery', 'tests/test_settings_transaction.py'],
  ['Scan scope settings', 'tests/test_scan_settings.py'],
  ['Provider usage and credential redaction', 'tests/test_desktop_usage.py'],
  ['Desktop prompt enhancement', 'tests/test_desktop_prompt.py'],
  ['Safe legacy settings preview', 'tests/test_legacy_settings_import.py'],
  ['Desktop overrides and file write policy', 'tests/test_desktop_parity.py'],
  ['Resource pack settings', 'tests/test_resource_pack_settings.py'],
  ['Resource pack safe preflight', 'tests/test_resource_pack_preflight.py'],
  ['World input path containment', 'tests/test_world_path_boundary.py'],
  ['Explicit external ZIP scan and restore', 'tests/test_desktop_external_packs.py'],
  ['New external chunk creation and recovery', 'tests/test_external_chunk_restore.py'],
  ['Cancellation usage reporting', 'tests/test_cancelled_usage.py'],
  ['Failure reporting and retry', 'tests/test_reliability.py'],
  ['Text extraction and NBT round trip', 'tests/test_extraction.py'],
  ['SNBT command text (Java 1.21.5+)', 'tests/test_snbt_commands.py'],
  ['Launcher world discovery is read-only', 'tests/test_world_discovery.py'],
  ['Saved data survives damage and reset keeps backups', 'tests/test_user_data_durability.py'],
  ['World write lock and session lock survive crashes', 'tests/test_world_locking.py'],
  ['Durable writes flush only writable handles and clean up', 'tests/test_durable_writes.py'],
  ['Region slots, ZIP members, restore guards and resumable partial runs', 'tests/test_core_integrity.py'],
  ['Batch request budget, failure codes and untrusted-data prompt', 'tests/test_batch_budget.py'],
  ['JSONL channel is UTF-8, protocol-only and crash-proof', 'tests/test_jsonl_channel.py'],
  ['Provider redirects, own-key routing, redaction, request budgets', 'tests/test_provider_hardening.py'],
  ['Formatter and Minecraft placeholder preservation', 'tests/test_text_tokens.py'],
  ['Legacy web UI token, Host, Origin and JSON checks', 'tests/test_webui_security.py'],
  ['Write journal, staged transaction and fault-injection matrix', 'tests/test_journal.py'],
  ['Guarded recovery, conflicts and interrupted restores', 'tests/test_recovery.py'],
  ['Provider/core retry contract by error kind', 'tests/test_retry_contract.py'],
  ['Review follow-ups for write reporting, layout gate, locks and diagnostics', 'tests/test_review_a_followups.py'],
  ['Review drafts survive restarts and stay bounded', 'tests/test_review_drafts.py'],
  ['Backup deletion and pruning respect locks, last copies and open recoveries', 'tests/test_backup_admin.py'],
  ['Journal review fixes: one reconciliation gate, verify-only keep, identity checks', 'tests/test_journal_review.py'],
  ['Interrupted resume reconciled, keep quarantines every conflict, per-world generation counter', 'tests/test_journal_reconcile.py'],
  ['Real process kills at every write, durable replace and recovery boundary', 'tests/test_journal_kill.py'],
  ['The core cancels and exits when the shell closes its stdin', 'tests/test_eof_shutdown.py'],
  ['Review drafts and backup administration through the desktop dispatch', 'tests/test_desktop_dispatch.py'],
];

const GROUPS = ['python', 'frontend', 'rust'];

function parseGroups(argv) {
  const list = (name) => {
    const values = [];
    argv.forEach((arg, index) => {
      if (arg === name) values.push(...(argv[index + 1] ?? '').split(','));
      else if (arg.startsWith(`${name}=`)) values.push(...arg.slice(name.length + 1).split(','));
    });
    return values.map((value) => value.trim()).filter(Boolean);
  };
  const only = list('--only');
  const skip = list('--skip');
  for (const name of [...only, ...skip]) {
    if (!GROUPS.includes(name)) {
      process.stderr.write(`Unknown group "${name}"; use one of: ${GROUPS.join(', ')}\n`);
      process.exit(2);
    }
  }
  return GROUPS.filter((group) => (only.length === 0 || only.includes(group)) && !skip.includes(group));
}

const selected = parseGroups(process.argv.slice(2));
const verbose = process.argv.includes('--verbose');

// --- steps ---------------------------------------------------------------------------------------

/** A step is { group, name, run() -> { ok, output } }. */
const steps = [];

function command(group, name, program, args, options = {}) {
  steps.push({
    group,
    name,
    run: () => {
      // pnpm is a .cmd shim on Windows and needs a shell; it gets one command line (fixed words from
      // this file), which also avoids Node's warning about arguments passed next to `shell`.
      const viaShell = isWindows && program === 'pnpm';
      const result = spawnSync(viaShell ? [program, ...args].join(' ') : program, viaShell ? [] : args, {
        cwd: options.cwd ?? root,
        encoding: 'utf8',
        shell: viaShell,
        maxBuffer: 256 * 1024 * 1024,
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', ...(options.env ?? {}) },
      });
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (result.error) return { ok: false, output: `${output}\n${result.error.message}` };
      return { ok: result.status === 0, output };
    },
  });
}

function check(group, name, run) {
  steps.push({ group, name, run });
}

for (const [name, file] of PYTHON_TESTS) {
  check('python', `${file} - ${name}`, () => {
    if (!existsSync(join(root, file))) return { ok: false, output: `${file} does not exist` };
    const result = spawnSync(python, ['-B', file], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (result.error) return { ok: false, output: `${output}\n${result.error.message} (set POMI_PYTHON to the interpreter with the pinned requirements)` };
    return { ok: result.status === 0, output };
  });
}

/** One version in package.json, Cargo.toml and tauri.conf.json: the app has a single version. */
function versionsAgree() {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const conf = JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8')).version;
  const cargo = readFileSync(join(root, 'src-tauri', 'Cargo.toml'), 'utf8').match(/^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)?.[1];
  const ok = pkg && pkg === conf && pkg === cargo;
  return { ok: Boolean(ok), output: `package.json ${pkg}, tauri.conf.json ${conf}, Cargo.toml ${cargo}` };
}

check('frontend', 'app version is the same in package.json, tauri.conf.json and Cargo.toml', versionsAgree);
command('frontend', 'pnpm check (svelte-check + tsc)', 'pnpm', ['check']);
command('frontend', 'pnpm test:frontend (vitest)', 'pnpm', ['test:frontend']);
command('frontend', 'pnpm licenses:check', 'pnpm', ['licenses:check']);

/** `tauri build` maps build/sidecar/dist/pomi-sidecar/ as a resource, so Cargo needs the folder to
 *  exist even when the core was not built (it is git-ignored). A placeholder stands in for it. */
function ensureSidecarPlaceholder() {
  const folder = join(root, 'build', 'sidecar', 'dist', 'pomi-sidecar');
  if (existsSync(folder)) return { ok: true, output: `${folder} exists` };
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'PLACEHOLDER.txt'), 'placeholder so cargo can build without the sidecar; pnpm sidecar:build replaces this folder\n');
  return { ok: true, output: `created the placeholder ${folder}` };
}

const tauriDir = join(root, 'src-tauri');
check('rust', 'sidecar resource folder exists for cargo', ensureSidecarPlaceholder);
command('rust', 'cargo fmt --check', 'cargo', ['fmt', '--check'], { cwd: tauriDir });
command('rust', 'cargo clippy --lib -- -D warnings', 'cargo', ['clippy', '--lib', '--', '-D', 'warnings'], { cwd: tauriDir });
command('rust', 'cargo test --lib', 'cargo', ['test', '--lib'], { cwd: tauriDir });

// --- run -----------------------------------------------------------------------------------------

const results = [];
const started = Date.now();
const planned = steps.filter((candidate) => selected.includes(candidate.group));
if (planned.length === 0) {
  // An empty plan must not look like a pass: --only/--skip left nothing to run.
  process.stderr.write(
    `No verification steps selected (groups: ${selected.join(', ') || 'none'}). ` +
      `Check --only/--skip; the groups are: ${GROUPS.join(', ')}.
`,
  );
  process.exit(2);
}
for (const step of planned) {
  const begin = Date.now();
  process.stdout.write(`... [${step.group}] ${step.name}\n`);
  let outcome;
  try {
    outcome = step.run();
  } catch (error) {
    outcome = { ok: false, output: String(error?.stack ?? error) };
  }
  const seconds = ((Date.now() - begin) / 1000).toFixed(1);
  process.stdout.write(`${outcome.ok ? 'PASS' : 'FAIL'}    [${step.group}] ${step.name} (${seconds}s)\n`);
  if (!outcome.ok || verbose) {
    const lines = outcome.output.trimEnd().split(/\r?\n/);
    const shown = outcome.ok ? lines : lines.slice(-60);
    if (!outcome.ok && lines.length > shown.length) process.stdout.write(`      ... (${lines.length - shown.length} earlier lines not shown)\n`);
    for (const line of shown) process.stdout.write(`      ${line}\n`);
  }
  results.push({ ...step, ok: outcome.ok });
}

const failed = results.filter((result) => !result.ok);
const total = ((Date.now() - started) / 1000).toFixed(1);
process.stdout.write(`\n${results.length - failed.length}/${results.length} steps passed in ${total}s (groups: ${selected.join(', ') || 'none'})\n`);
if (failed.length > 0) {
  process.stdout.write('FAILED:\n');
  for (const result of failed) process.stdout.write(`  [${result.group}] ${result.name}\n`);
  process.exit(1);
}
process.stdout.write('verify:local PASS\n');
