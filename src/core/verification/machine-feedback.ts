import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exists, listFilesRecursive, readJson, runProcess } from '../fsx.js';
import { runCompiledRules } from './mistake-rule-compiler.js';

export interface FeedbackAxis {
  ok: boolean;
  errors: string[];
  skipped_reason?: string;
}

export interface MachineFeedback {
  schema: 'sks.machine-feedback.v1';
  ok: boolean;
  typecheck: FeedbackAxis;
  lint: FeedbackAxis;
  tests: { ok: boolean; selected: string[]; failed: string[]; skipped_reason?: string };
  duration_ms: number;
}

const TEST_DISCOVERY_IGNORES = [
  '.git',
  'node_modules',
  'dist',
  '.claude',
  '.codex/worktrees',
  '.codex/tmp',
  '.codex/cache',
  '.opensks/runtime/worktrees',
  '.sneakoscope/arenas',
  '.sneakoscope/blocked-worktrees',
  '.sneakoscope/cache',
  '.sneakoscope/tmp'
];

export async function runMachineFeedback(root: string, changedFiles: string[], opts: { timeoutMs?: number } = {}): Promise<MachineFeedback> {
  const t0 = Date.now();
  const timeoutMs = Math.max(5_000, opts.timeoutMs ?? 60_000);
  const [typecheck, lint, tests] = await Promise.all([
    runTypecheck(root, changedFiles, timeoutMs),
    runLint(root, changedFiles, timeoutMs),
    runSelectedTests(root, changedFiles, timeoutMs)
  ]);
  return {
    schema: 'sks.machine-feedback.v1',
    ok: typecheck.ok && lint.ok && tests.ok,
    typecheck,
    lint,
    tests,
    duration_ms: Date.now() - t0
  };
}

/** A test this runner can actually execute: it spawns the file with node. */
function directlyRunnable(file: string): boolean {
  return /\.(?:mjs|cjs|js)$/.test(file);
}

/**
 * Related tests, runnable ones first.
 *
 * The cut used to be `[...out].sort().slice(0, 20)` — alphabetical, and applied
 * *before* `runSelectedTests` filtered to the files it can execute. That is not
 * an arbitrary sample: runnable tests live under `test/**` and unrunnable ones
 * under `src/**\/__tests__/`, and `'src/' < 'test/'`, so the alphabetical cut
 * deterministically kept the ones that cannot run. Measured on a four-file
 * change touching the release gates: 27 related tests of which 7 were runnable,
 * and the combined call returned 20 selected and **0** runnable — including
 * dropping `release-version-sync.test.mjs`, the regression test for those exact
 * files. The patch queue then accepted the patch, because `tests.ok` is true
 * when nothing ran.
 *
 * Ordering by runnability before the cut is the whole fix. Within each group the
 * sort stays alphabetical so the selection is still deterministic.
 */
export async function selectTests(root: string, changedFiles: string[]): Promise<string[]> {
  const out = new Set<string>();
  for (const file of changedFiles.map(normalizePath).filter(Boolean)) {
    const base = path.basename(file).replace(/\.(?:[cm]?[jt]sx?)$/, '');
    for (const cand of await globTests(root, base)) out.add(cand);
    for (const cand of await testsImporting(root, file)) out.add(cand);
  }
  const ordered = [...out].sort((a, b) => {
    const byRunnable = Number(directlyRunnable(b)) - Number(directlyRunnable(a));
    return byRunnable || (a < b ? -1 : a > b ? 1 : 0);
  });
  return ordered.slice(0, TEST_SELECTION_LIMIT);
}

const TEST_SELECTION_LIMIT = 20;

async function runTypecheck(root: string, changedFiles: string[], timeoutMs: number): Promise<FeedbackAxis> {
  if (!changedFiles.some((file) => /\.(?:tsx?|mts|cts)$/.test(file))) return { ok: true, errors: [], skipped_reason: 'no_ts_files_changed' };
  const pkg = await packageJson(root);
  const script = scriptNamed(pkg, 'typecheck');
  const tsconfig = await exists(path.join(root, 'tsconfig.json'));
  if (!script && !tsconfig) return { ok: true, errors: [], skipped_reason: 'tool_not_found' };
  const command = script ? ['npm', ['run', 'typecheck', '--silent']] as const : await resolveTypeScriptCommand(root);
  const result = await runProcess(command[0], command[1], { cwd: root, timeoutMs, maxOutputBytes: 512 * 1024 });
  if (result.timedOut) return { ok: false, errors: ['typecheck_timeout'] };
  return {
    ok: result.code === 0,
    errors: result.code === 0 ? [] : summarizeErrors(result.stderr || result.stdout)
  };
}

async function resolveTypeScriptCommand(root: string): Promise<readonly [string, string[]]> {
  const localTsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  if (await exists(localTsc)) return [process.execPath, [localTsc, '--noEmit', '-p', 'tsconfig.json']];
  const bundledTsc = path.join(repoRootFromImportMeta(), 'node_modules', 'typescript', 'bin', 'tsc');
  if (await exists(bundledTsc)) return [process.execPath, [bundledTsc, '--noEmit', '-p', 'tsconfig.json']];
  return ['npx', ['tsc', '--noEmit', '-p', 'tsconfig.json']];
}

async function runLint(root: string, changedFiles: string[], timeoutMs: number): Promise<FeedbackAxis> {
  const rules = await runCompiledRules(root, changedFiles).catch((err) => ({
    ok: false,
    violations: [{ rule_id: 'rule-runner', severity: 'error' as const, file: '', line: 0, description: err instanceof Error ? err.message : String(err), good_example: '' }],
    rule_count: 0
  }));
  const ruleErrors = rules.violations.map((violation) =>
    `${violation.file}${violation.line ? `:${violation.line}` : ''} ${violation.rule_id}: ${violation.description}${violation.good_example ? ` | good: ${singleLine(violation.good_example)}` : ''}`
  );
  const pkg = await packageJson(root);
  const lintScript = scriptNamed(pkg, 'lint');
  if (!lintScript) {
    return {
      ok: rules.ok,
      errors: ruleErrors.slice(0, 20),
      ...(rules.rule_count ? {} : { skipped_reason: 'skipped_reason' in rules ? rules.skipped_reason || 'tool_not_found' : 'tool_not_found' })
    };
  }
  const args = ['run', 'lint', '--silent'];
  const result = await runProcess('npm', args, { cwd: root, timeoutMs, maxOutputBytes: 512 * 1024 });
  if (result.timedOut) return { ok: false, errors: ['lint_timeout', ...ruleErrors].slice(0, 20) };
  return {
    ok: result.code === 0 && rules.ok,
    errors: [...(result.code === 0 ? [] : summarizeErrors(result.stderr || result.stdout)), ...ruleErrors].slice(0, 20)
  };
}

async function runSelectedTests(root: string, changedFiles: string[], timeoutMs: number): Promise<MachineFeedback['tests']> {
  const candidates = await selectTests(root, changedFiles);
  if (!candidates.length) return { ok: true, selected: [], failed: [], skipped_reason: 'no_related_tests' };
  const failed: string[] = [];
  const runnable = candidates.filter(directlyRunnable);
  const selected = runnable.slice(0, RUNNABLE_TEST_LIMIT);
  // A cap that says nothing lets `ok: true` mean "everything related passed"
  // when it means "the first ten of them did".
  const dropped = runnable.length - selected.length;
  if (!selected.length) {
    return { ok: true, selected: [], failed: [], skipped_reason: 'no_directly_runnable_tests' };
  }
  await Promise.all(selected.map(async (file) => {
    const result = await runProcess(process.execPath, [file], { cwd: root, timeoutMs: Math.max(5_000, Math.floor(timeoutMs / selected.length)), maxOutputBytes: 256 * 1024 });
    if (result.timedOut) {
      failed.push(`${file}: timeout`);
      return;
    }
    if (result.code !== 0) failed.push(`${file}: ${summarizeErrors(result.stderr || result.stdout).join(' | ')}`);
  }));
  return {
    ok: failed.length === 0,
    selected,
    failed: failed.slice(0, 10),
    ...(dropped > 0 ? { skipped_reason: `runnable_tests_capped:${dropped}` } : {})
  };
}

const RUNNABLE_TEST_LIMIT = 10;

async function globTests(root: string, base: string): Promise<string[]> {
  const currentTest = currentTestPath(root);
  const files = await listFilesRecursive(root, { ignore: TEST_DISCOVERY_IGNORES, maxFiles: 30_000 });
  return files
    .map((file) => normalizePath(path.relative(root, file)))
    .filter((file) => isTestFile(file))
    .filter((file) => file !== currentTest)
    .filter((file) => {
      const name = path.basename(file);
      return name.startsWith(`${base}.test.`)
        || name.startsWith(`${base}.spec.`)
        || file.includes(`/__tests__/${base}`);
    });
}

async function testsImporting(root: string, changedFile: string): Promise<string[]> {
  const currentTest = currentTestPath(root);
  const files = await listFilesRecursive(root, { ignore: TEST_DISCOVERY_IGNORES, maxFiles: 30_000 });
  const stem = normalizePath(changedFile).replace(/\.(?:[cm]?[jt]sx?)$/, '');
  const out: string[] = [];
  await Promise.all(files.map(async (abs) => {
    const rel = normalizePath(path.relative(root, abs));
    if (!isTestFile(rel) || rel === currentTest) return;
    const text = await import('node:fs/promises').then((fs) => fs.readFile(abs, 'utf8')).catch(() => '');
    if (String(text).includes(changedFile) || String(text).includes(stem) || String(text).includes(`../${stem}`)) out.push(rel);
  }));
  return out;
}

function isTestFile(file: string): boolean {
  return /(?:^|\/)__tests__\//.test(file) || /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/.test(file);
}

function currentTestPath(root: string): string {
  const entrypoint = process.argv[1];
  if (!entrypoint) return '';
  const relative = normalizePath(path.relative(root, path.resolve(entrypoint)));
  return relative === '..' || relative.startsWith('../') ? '' : relative;
}

async function packageJson(root: string): Promise<any> {
  return readJson(path.join(root, 'package.json'), {}).catch(() => ({}));
}

function scriptNamed(pkg: any, name: string): string | null {
  const script = pkg?.scripts?.[name];
  return typeof script === 'string' && script.trim() ? script : null;
}

function summarizeErrors(text: string): string[] {
  return String(text || '').split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 20);
}

function normalizePath(value: string): string {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\/+/, '');
}

function singleLine(value: string): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 240);
}

function repoRootFromImportMeta(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}
