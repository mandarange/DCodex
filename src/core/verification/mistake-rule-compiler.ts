import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, nowIso, readJson, readText, runProcess, which, writeJsonAtomic } from '../fsx.js';
import { search, SEARCH_SCHEMA_VERSION } from '../search/index.js';
import { readWrongnessLedger, writeWrongnessLedger } from '../triwiki-wrongness/wrongness-ledger.js';

export interface CompiledRule {
  schema: 'sks.mistake-rule.v1';
  id: string;
  source: 'wrongness-ledger';
  description: string;
  detector: { kind: 'ast-grep'; pattern: string; lang: string } | { kind: 'regex'; pattern: string; file_glob: string };
  severity: 'error' | 'warn';
  examples: { bad: string; good: string };
}

export interface RuleViolation {
  rule_id: string;
  severity: 'error' | 'warn';
  file: string;
  line: number;
  description: string;
  good_example: string;
}

export async function compileMistakeRules(root: string): Promise<{ compiled: CompiledRule[]; skipped: string[] }> {
  const ledger = await readWrongnessLedger(root);
  const compiled: CompiledRule[] = [];
  const skipped: string[] = [];
  const records = Array.isArray(ledger.records) ? ledger.records : [];
  let changed = false;
  for (const record of records as any[]) {
    if (record.rule_compiled === true) continue;
    const rule = synthesizeRule(record);
    if (rule && await validateRule(root, rule)) {
      await writeRule(root, rule);
      record.rule_compiled = true;
      record.compiled_rule_id = rule.id;
      record.updated_at = nowIso();
      compiled.push(rule);
      changed = true;
    } else {
      skipped.push(String(record.id || 'unknown'));
    }
  }
  if (changed) await writeWrongnessLedger(root, { ...ledger, records } as any);
  await writeJsonAtomic(path.join(root, '.sneakoscope', 'rules', 'compiled-index.json'), {
    schema: 'sks.mistake-rule-index.v1',
    generated_at: nowIso(),
    compiled: compiled.map((rule) => rule.id),
    skipped
  });
  return { compiled, skipped };
}

export async function runCompiledRules(root: string, changedFiles: string[]): Promise<{ ok: boolean; violations: RuleViolation[]; rule_count: number; skipped_reason?: string }> {
  const rules = await readCompiledRules(root);
  if (!rules.length) return { ok: true, violations: [], rule_count: 0, skipped_reason: 'no_rules' };
  const files = changedFiles.length
    ? changedFiles
    : (await search({
        schemaVersion: SEARCH_SCHEMA_VERSION,
        mode: 'files',
        root,
        exclude: ['.git/**', 'node_modules/**', 'dist/**'],
        limits: { maxMatches: 2000, maxFiles: 2000 }
      })).matches.map((m) => m.path);
  const astGrep = await which('ast-grep');
  const violations: RuleViolation[] = [];
  let skippedAstGrep = 0;
  for (const rule of rules) {
    if (rule.detector.kind === 'ast-grep') {
      if (!astGrep) {
        // Capability gap: do not silently reinterpret as text/regex.
        skippedAstGrep += 1;
        continue;
      }
      violations.push(...await runAstGrepRule(root, rule, files));
    } else {
      violations.push(...await runRegexRule(root, rule, files));
    }
  }
  return {
    ok: !violations.some((violation) => violation.severity === 'error'),
    violations,
    rule_count: rules.length,
    ...(skippedAstGrep ? { skipped_reason: `ast_grep_unavailable:skipped_rules=${skippedAstGrep}` } : {})
  };
}

async function readCompiledRules(root: string): Promise<CompiledRule[]> {
  const dir = path.join(root, '.sneakoscope', 'rules');
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const rules: CompiledRule[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.rule.json')) continue;
    const rule = await readJson<CompiledRule | null>(path.join(dir, entry.name), null);
    if (rule?.schema === 'sks.mistake-rule.v1') rules.push(rule);
  }
  return rules;
}

function synthesizeRule(record: any): CompiledRule | null {
  const id = `wl-${String(record?.id || '').replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 96)}`;
  const text = [
    record?.avoidance_rule?.text,
    record?.claim?.text,
    record?.corrective_action?.summary,
    record?.detected_by?.detail
  ].map((part) => String(part || '')).join('\n');
  const bad = String(record?.examples?.bad || record?.example_bad || record?.bad || '');
  const good = String(record?.examples?.good || record?.example_good || record?.good || '');
  const explicitPattern = String(record?.detector?.pattern || record?.regex || record?.forbidden_pattern || '');
  const nPlusOne = /n\+1|query.*loop|loop.*query|쿼리.*반복/i.test(text);
  const emptyCatch = /empty\s+catch|catch\s*\{\s*\}|빈\s*catch/i.test(text);
  const pattern = explicitPattern
    || (nPlusOne ? String.raw`for\s*\([^)]*\)\s*\{[\s\S]{0,500}\b(?:query|findMany|findUnique|select|fetch)\s*\(` : '')
    || (emptyCatch ? String.raw`catch\s*\([^)]*\)\s*\{\s*\}` : '');
  if (!pattern) return null;
  return {
    schema: 'sks.mistake-rule.v1',
    id,
    source: 'wrongness-ledger',
    description: String(record?.avoidance_rule?.text || record?.claim?.text || record?.wrongness_kind || 'Compiled wrongness rule').slice(0, 500),
    detector: { kind: 'regex', pattern, file_glob: String(record?.detector?.file_glob || '**/*.{ts,tsx,js,mjs,cjs}') },
    severity: record?.severity === 'low' ? 'warn' : 'error',
    examples: {
      bad: bad || exampleForPattern(pattern, true),
      good: good || exampleForPattern(pattern, false)
    }
  };
}

async function validateRule(root: string, rule: CompiledRule): Promise<boolean> {
  if (rule.detector.kind === 'ast-grep') {
    if (!(await which('ast-grep'))) return false;
    const tmp = path.join(root, '.sneakoscope', 'tmp', 'rule-validate', rule.id);
    await ensureDir(tmp);
    const bad = path.join(tmp, `bad.${rule.detector.lang || 'ts'}`);
    const good = path.join(tmp, `good.${rule.detector.lang || 'ts'}`);
    await fs.writeFile(bad, rule.examples.bad, 'utf8');
    await fs.writeFile(good, rule.examples.good, 'utf8');
    const badRun = await runProcess('ast-grep', ['run', '-p', rule.detector.pattern, bad], { cwd: root, timeoutMs: 10_000, maxOutputBytes: 64 * 1024 });
    const goodRun = await runProcess('ast-grep', ['run', '-p', rule.detector.pattern, good], { cwd: root, timeoutMs: 10_000, maxOutputBytes: 64 * 1024 });
    return Boolean(badRun.stdout.trim()) && !goodRun.stdout.trim();
  }
  try {
    const re = new RegExp(rule.detector.pattern, 'm');
    return re.test(rule.examples.bad) && !re.test(rule.examples.good);
  } catch {
    return false;
  }
}

async function writeRule(root: string, rule: CompiledRule): Promise<void> {
  await writeJsonAtomic(path.join(root, '.sneakoscope', 'rules', `${rule.id}.rule.json`), rule);
}

async function runRegexRule(root: string, rule: CompiledRule, files: string[]): Promise<RuleViolation[]> {
  if (rule.detector.kind !== 'regex') return [];
  const detector = rule.detector;
  let re: RegExp;
  try {
    re = new RegExp(detector.pattern, 'gm');
  } catch {
    return [];
  }
  const out: RuleViolation[] = [];
  for (const file of files.filter((candidate) => fileGlobMatches(candidate, detector.file_glob))) {
    const text = await readText(path.join(root, file), '').catch(() => '');
    re.lastIndex = 0;
    for (const match of String(text).matchAll(re)) {
      out.push(ruleViolation(rule, file, lineForIndex(String(text), match.index || 0)));
      if (out.length >= 100) return out;
    }
  }
  return out;
}

async function runAstGrepRule(root: string, rule: CompiledRule, files: string[]): Promise<RuleViolation[]> {
  const out: RuleViolation[] = [];
  for (const file of files) {
    const run = await runProcess('ast-grep', ['run', '-p', rule.detector.pattern, path.join(root, file)], {
      cwd: root,
      timeoutMs: 10_000,
      maxOutputBytes: 64 * 1024
    }).catch(() => null);
    if (!run?.stdout.trim()) continue;
    out.push(ruleViolation(rule, file, 1));
  }
  return out;
}

function ruleViolation(rule: CompiledRule, file: string, line: number): RuleViolation {
  return {
    rule_id: rule.id,
    severity: rule.severity,
    file,
    line,
    description: rule.description,
    good_example: rule.examples.good
  };
}

function fileGlobMatches(file: string, glob: string): boolean {
  const normalized = file.replace(/\\/g, '/');
  if (glob.includes('{ts,tsx,js,mjs,cjs}')) return /\.(?:tsx?|mjs|cjs|js)$/.test(normalized);
  if (glob === '**/*') return true;
  const suffix = glob.replace(/^\*\*\/*/, '').replace(/^\*/, '');
  return suffix ? normalized.endsWith(suffix) : true;
}

function lineForIndex(text: string, index: number): number {
  return text.slice(0, index).split(/\r?\n/).length;
}

function exampleForPattern(pattern: string, bad: boolean): string {
  if (/catch/.test(pattern)) return bad ? 'try { run(); } catch (err) {}' : 'try { run(); } catch (err) { throw err; }';
  return bad
    ? 'for (const id of ids) { await db.user.findUnique({ where: { id } }); }'
    : 'await db.user.findMany({ where: { id: { in: ids } } });';
}
