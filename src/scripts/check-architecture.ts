#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

interface ArchitectureBudgetRule {
  id: string;
  match: string;
  max_lines: number;
  new_file_max_lines?: number;
}

interface ArchitectureBudgetConfig {
  schema: 'sks.architecture-budgets.v1';
  scan_roots: string[];
  source_extensions: string[];
  split_review_lines: number;
  default_new_file_max_lines: number;
  budgets: ArchitectureBudgetRule[];
  waiver_policy: {
    mode: 'shrink-only';
    required_fields: string[];
  };
}

interface ArchitectureWaiver {
  schema: 'sks.architecture-waiver.v1';
  file: string;
  reason: string;
  policy: 'shrink-only';
  baseline_lines: number;
}

const CURRENT_ROUTE_DOMAIN_IMPORT_SEGMENTS = Object.freeze([
  'naruto',
  'qa-loop',
  'research',
  'ppt',
  'image-ux-review',
  'db',
  'gx',
  'wiki'
]);

const root = process.cwd();
const failures: string[] = [];
const args = process.argv.slice(2);
const strictAll = args.includes('--strict-all');
const budgets = loadBudgetConfig();
const waivers = loadWaivers();
const baseRef = optionValue('--base-ref') || process.env.SKS_ARCH_BASE_REF || defaultBaseRef();
const baseSha = mergeBaseSha(baseRef);
const baseFiles = trackedFileSet(baseSha);
const renamedPredecessors = renamedPredecessorMap(baseSha);
const changedFiles = changedFileSet(baseSha);
let scannedFiles = 0;

runGate('pipeline-budget:check');
runGate('pipeline-runtime:check');
checkLargeFiles();
checkTsImports();
checkDistRuntime();

const report = {
  schema: 'sks.architecture-check.v2',
  ok: failures.length === 0,
  mode: strictAll ? 'strict-all' : 'merge-base-changed',
  budget_config: 'config/architecture-budgets.v1.json',
  base_ref: baseRef,
  merge_base: baseSha,
  changed_files: [...changedFiles].sort(),
  scanned_files: scannedFiles,
  waiver_policy: budgets.waiver_policy.mode,
  failures
};
writeReport(report);

if (failures.length) {
  console.error('Architecture check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`Architecture check passed (${report.mode}, base ${baseSha || 'unavailable'})`);

function runGate(script: string) {
  const pkg = readJson(path.join(root, 'package.json'));
  if (!pkg?.scripts?.[script]) {
    failures.push(`${script}: package script missing`);
    return;
  }
  const result = spawnSync('npm', ['run', script], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  if (result.status !== 0) failures.push(`${script}: ${result.stderr || result.stdout}`.trim());
}

function checkLargeFiles() {
  const files: string[] = [];
  for (const scanRoot of budgets.scan_roots) {
    const absolute = path.join(root, scanRoot);
    if (fs.existsSync(absolute)) walk(absolute, files);
  }
  for (const file of files) {
    const relPath = normalize(path.relative(root, file));
    if (!budgets.source_extensions.includes(path.extname(file))) continue;
    if (isGeneratedPath(relPath)) continue;
    scannedFiles += 1;
    const lines = lineCount(fs.readFileSync(file, 'utf8'));
    const rule = budgetRule(relPath);
    const basePath = basePathFor(relPath);
    const existedAtBase = basePath !== null;
    const changed = changedFiles.has(relPath);
    if (!strictAll && !changed) continue;

    if (lines >= budgets.split_review_lines) {
      const baseLines = basePath ? baseLineCount(basePath, baseSha) : null;
      const waiverFailure = waiverFailureFor(relPath, lines, baseLines);
      if (waiverFailure) failures.push(`${relPath}: handwritten file ${lines} lines >= ${budgets.split_review_lines} split-review gate (${waiverFailure})`);
      continue;
    }

    const maxLines = existedAtBase
      ? rule.max_lines
      : Math.min(rule.max_lines, rule.new_file_max_lines ?? budgets.default_new_file_max_lines);
    if (lines > maxLines) {
      const baseLines = basePath ? baseLineCount(basePath, baseSha) : null;
      const waiverFailure = waiverFailureFor(relPath, lines, baseLines);
      if (waiverFailure) failures.push(`${relPath}: ${lines} lines > ${maxLines} ${rule.id} budget (${waiverFailure})`);
    }
    if ((strictAll || changed) && !isRouteDomainAggregator(relPath) && importsUnrelatedRouteDomains(file)) {
      failures.push(`${relPath}: imports 5+ unrelated route domains`);
    }
  }
}

function budgetRule(relPath: string): ArchitectureBudgetRule {
  for (const rule of budgets.budgets) {
    if (new RegExp(rule.match).test(relPath)) return rule;
  }
  throw new Error(`architecture budget missing for ${relPath}`);
}

function waiverFailureFor(relPath: string, lines: number, baseLines: number | null): string | null {
  const waiver = waivers.find((candidate) => candidate.file === relPath);
  if (!waiver) return 'no shrink-only waiver';
  if (waiver.policy !== budgets.waiver_policy.mode) return `waiver policy ${String(waiver.policy || 'missing')} is not shrink-only`;
  if (!Number.isInteger(waiver.baseline_lines) || waiver.baseline_lines < 1) return 'waiver baseline_lines missing';
  if (!waiver.reason) return 'waiver reason missing';
  if (baseLines === null) return 'new files cannot use architecture waivers';
  const ceiling = Math.min(baseLines, waiver.baseline_lines);
  return lines <= ceiling ? null : `shrink-only ceiling ${ceiling} exceeded`;
}

function checkTsImports() {
  const files: string[] = [];
  const src = path.join(root, 'src');
  if (!fs.existsSync(src)) return;
  walk(src, files);
  for (const file of files.filter((item) => item.endsWith('.ts'))) {
    const relPath = normalize(path.relative(root, file));
    const text = fs.readFileSync(file, 'utf8');
    if (/from\s+['"][^'"]+\.mjs['"]|import\(\s*['"][^'"]+\.mjs['"]\s*\)/.test(text)) {
      failures.push(`${relPath}: TypeScript imports .mjs runtime`);
    }
  }
}

function checkDistRuntime() {
  const dist = path.join(root, 'dist');
  if (!fs.existsSync(dist)) return;
  const files: string[] = [];
  walk(dist, files);
  for (const file of files) {
    const relPath = normalize(path.relative(root, file));
    if (relPath.endsWith('.mjs')) failures.push(`${relPath}: dist .mjs runtime forbidden`);
  }
}

function loadBudgetConfig(): ArchitectureBudgetConfig {
  const file = path.join(root, 'config', 'architecture-budgets.v1.json');
  const parsed = readJson(file);
  if (parsed?.schema !== 'sks.architecture-budgets.v1' || !Array.isArray(parsed?.budgets)) {
    throw new Error('config/architecture-budgets.v1.json is missing or invalid');
  }
  if (parsed?.waiver_policy?.mode !== 'shrink-only') throw new Error('architecture waiver policy must be shrink-only');
  return parsed as ArchitectureBudgetConfig;
}

function loadWaivers(): ArchitectureWaiver[] {
  const file = path.join(root, 'src', 'generated', 'architecture-waivers.json');
  const parsed = readJson(file);
  return Array.isArray(parsed?.waivers) ? parsed.waivers : [];
}

function changedFileSet(base: string | null): Set<string> {
  const out = new Set<string>();
  if (base) {
    for (const line of gitLines(['diff', '--name-only', '--diff-filter=ACMR', `${base}...HEAD`, '--'])) out.add(normalize(line));
  }
  for (const line of gitLines(['diff', '--name-only', '--diff-filter=ACMR', '--'])) out.add(normalize(line));
  for (const line of gitLines(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '--'])) out.add(normalize(line));
  for (const line of gitLines(['ls-files', '--others', '--exclude-standard'])) out.add(normalize(line));
  return out;
}

function trackedFileSet(base: string | null): Set<string> {
  if (!base) return new Set<string>();
  return new Set(gitLines(['ls-tree', '-r', '--name-only', base]));
}

function renamedPredecessorMap(base: string | null): Map<string, string> {
  const predecessors = new Map<string, string>();
  if (!base) return predecessors;
  for (const line of gitLines(['diff', '--name-status', '--find-renames', base, '--'])) {
    const [status, predecessor, current] = line.split('\t');
    if (!/^R\d*$/.test(status || '') || !predecessor || !current) continue;
    predecessors.set(normalize(current), normalize(predecessor));
  }
  return predecessors;
}

function basePathFor(relPath: string): string | null {
  if (baseFiles.has(relPath)) return relPath;
  const predecessor = renamedPredecessors.get(relPath);
  return predecessor && baseFiles.has(predecessor) ? predecessor : null;
}

function baseLineCount(relPath: string, base: string | null): number | null {
  if (!base) return null;
  const result = spawnSync('git', ['show', `${base}:${relPath}`], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) return null;
  return lineCount(String(result.stdout || ''));
}

function defaultBaseRef(): string {
  for (const candidate of ['origin/main', 'main']) {
    if (gitOk(['rev-parse', '--verify', candidate])) return candidate;
  }
  return 'HEAD';
}

function mergeBaseSha(ref: string): string | null {
  const result = spawnSync('git', ['merge-base', 'HEAD', ref], { cwd: root, encoding: 'utf8' });
  if (result.status === 0 && String(result.stdout || '').trim()) return String(result.stdout).trim();
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  return head.status === 0 ? String(head.stdout || '').trim() || null : null;
}

function optionValue(name: string): string {
  const index = args.indexOf(name);
  return index >= 0 ? String(args[index + 1] || '').trim() : '';
}

function isGeneratedPath(relPath: string): boolean {
  return /^src\/generated\//.test(relPath);
}

function isRouteDomainAggregator(relPath: string): boolean {
  return [
    'src/core/pipeline-internals/runtime-core.ts',
    'src/core/pipeline-internals/runtime-gates.ts'
  ].includes(relPath);
}

function importsUnrelatedRouteDomains(file: string): boolean {
  const text = fs.readFileSync(file, 'utf8');
  const domains = new Set<string>();
  const imports = importSpecs(text);
  for (const domain of CURRENT_ROUTE_DOMAIN_IMPORT_SEGMENTS) {
    if (imports.some((spec) => new RegExp(`(^|[/_-])${domain}([/_-]|\\.|$)`, 'i').test(spec))) domains.add(domain);
  }
  return domains.size >= 5;
}

function importSpecs(text: string): string[] {
  const specs: string[] = [];
  const re = /^\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    if (match[1]) specs.push(match[1]);
  }
  return specs;
}

function walk(dir: string, out: string[]) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file, out);
    else if (entry.isFile()) out.push(file);
  }
}

function lineCount(text: string): number {
  return text ? text.split(/\r?\n/).length : 0;
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function gitLines(gitArgs: string[]): string[] {
  const result = spawnSync('git', gitArgs, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) return [];
  return String(result.stdout || '').split(/\r?\n/).map(normalize).filter(Boolean);
}

function gitOk(gitArgs: string[]): boolean {
  return spawnSync('git', gitArgs, { cwd: root, stdio: 'ignore' }).status === 0;
}

function writeReport(value: unknown) {
  const dir = path.join(root, '.sneakoscope', 'reports');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'architecture-check.json'), `${JSON.stringify(value, null, 2)}\n`);
}

function normalize(file: string): string {
  return String(file || '').replace(/\\/g, '/');
}
