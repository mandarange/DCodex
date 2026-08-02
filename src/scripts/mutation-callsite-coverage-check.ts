#!/usr/bin/env node
// @ts-nocheck
// Repo-wide risky mutation callsite gate. Every raw mutation must be either a
// guarded call or an external allowlist entry with a concrete function/symbol and
// reason. The allowlist is intentionally data, not code, so unused/stale entries
// fail the release gate.
import fs from 'node:fs';
import path from 'node:path';
import { assertGate, emitGate, root } from './gate-lib.js';
import {
  buildMutationAstIndex,
  mutationCallsiteSha256
} from './mutation-callsite-analysis.js';

const allowlistPath = path.join(root, 'safety-mutation-allowlist.json');
const allowlist = readAllowlist();
const allowlistHits = new Set();
const callsiteOccurrences = new Map();

const scanFiles = listScanFiles();
const covered = [];
const allowlisted = [];
const uncovered = [];

const GUARDED_CALLEES = new Set([
  'guardedWriteFile',
  'guardedRm',
  'guardedRename',
  'guardedChmod',
  'guardedXattr',
  'guardedChflags',
  'guardedGlobalCodexConfigWrite',
  'guardedProcessKill',
  'guardedPackageInstall',
  'guardedSkillSnapshotPromotion',
  'guardedApply'
]);

const DIRECT_RISKY = new Map([
  ['fs.writeFile', { kind: 'write_file', token: 'fs.writeFile' }],
  ['fs.promises.writeFile', { kind: 'write_file', token: 'fs.promises.writeFile' }],
  ['fsp.writeFile', { kind: 'write_file', token: 'fsp.writeFile' }],
  ['fs.writeFileSync', { kind: 'write_file', token: 'writeFileSync' }],
  ['writeFileSync', { kind: 'write_file', token: 'writeFileSync' }],
  ['fs.rm', { kind: 'rm', token: 'fs.rm' }],
  ['fs.promises.rm', { kind: 'rm', token: 'fs.promises.rm' }],
  ['fsp.rm', { kind: 'rm', token: 'fsp.rm' }],
  ['fs.rmSync', { kind: 'rm', token: 'rmSync' }],
  ['rmSync', { kind: 'rm', token: 'rmSync' }],
  ['fs.unlink', { kind: 'unlink', token: 'unlink' }],
  ['fs.promises.unlink', { kind: 'unlink', token: 'unlink' }],
  ['fsp.unlink', { kind: 'unlink', token: 'unlink' }],
  ['unlink', { kind: 'unlink', token: 'unlink' }],
  ['fs.unlinkSync', { kind: 'unlink', token: 'unlinkSync' }],
  ['unlinkSync', { kind: 'unlink', token: 'unlinkSync' }],
  ['fs.rename', { kind: 'rename', token: 'rename' }],
  ['fs.promises.rename', { kind: 'rename', token: 'rename' }],
  ['fsp.rename', { kind: 'rename', token: 'rename' }],
  ['rename', { kind: 'rename', token: 'rename' }],
  ['fs.renameSync', { kind: 'rename', token: 'renameSync' }],
  ['renameSync', { kind: 'rename', token: 'renameSync' }],
  ['fs.chmod', { kind: 'chmod', token: 'chmod' }],
  ['fs.promises.chmod', { kind: 'chmod', token: 'chmod' }],
  ['fsp.chmod', { kind: 'chmod', token: 'chmod' }],
  ['chmod', { kind: 'chmod', token: 'chmod' }],
  ['fs.chmodSync', { kind: 'chmod', token: 'chmodSync' }],
  ['chmodSync', { kind: 'chmod', token: 'chmodSync' }],
  ['process.kill', { kind: 'process_kill', token: 'process.kill' }]
]);

for (const rel of scanFiles) {
  const text = fs.readFileSync(path.join(root, rel), 'utf8');
  const ast = buildMutationAstIndex(rel, text);
  for (const call of ast.calls) {
    const callee = call.canonical_callee;
    if (callee && GUARDED_CALLEES.has(lastPathSegment(callee))) {
      covered.push({
        file: rel,
        line: call.line,
        symbol: call.symbol,
        kind: 'guarded_call',
        snippet: snippet(call.normalized_call)
      });
    }
    for (const risky of risksForCall(call)) {
      if (risky.kind === 'process_kill' && processKillIsLivenessProbe(call.normalized_call)) continue;
      const callsiteSha256 = mutationCallsiteSha256({
        file: rel,
        symbol: call.symbol,
        token: risky.token,
        normalizedCall: call.normalized_call,
        scopeContractSha256: call.scope_contract_sha256
      });
      const occurrence = (callsiteOccurrences.get(callsiteSha256) || 0) + 1;
      callsiteOccurrences.set(callsiteSha256, occurrence);
      const entry = {
        file: rel,
        line: call.line,
        symbol: call.symbol,
        kind: risky.kind,
        token: risky.token,
        snippet: snippet(call.normalized_call),
        normalized_call: call.normalized_call,
        scope_contract_sha256: call.scope_contract_sha256,
        callsite_sha256: callsiteSha256,
        occurrence
      };
      const allow = findAllow(entry);
      if (allow) {
        allowlistHits.add(allow.id);
        allowlisted.push({ ...entry, reason: allow.reason });
      } else {
        uncovered.push(entry);
      }
    }
  }
}

const unused_allowlist = allowlist.filter((entry) => !allowlistHits.has(entry.id)).map(({
  id,
  file,
  symbol,
  token,
  scope_contract_sha256,
  callsite_sha256,
  occurrence,
  reason
}) => ({ id, file, symbol, token, scope_contract_sha256, callsite_sha256, occurrence, reason }));
const blanket_allowlist = allowlist.filter((entry) => !entry.symbol || entry.symbol === '*' || !entry.token || entry.token === '*');
const ok = uncovered.length === 0 && unused_allowlist.length === 0 && blanket_allowlist.length === 0;
const report = {
  schema: 'sks.mutation-callsite-coverage.v4',
  ok,
  repo_wide: true,
  allowlist_path: 'safety-mutation-allowlist.json',
  scanned_file_count: scanFiles.length,
  covered,
  allowlisted,
  uncovered,
  unused_allowlist,
  blanket_allowlist
};
const reportDir = path.join(root, '.sneakoscope', 'reports');
fs.mkdirSync(reportDir, { recursive: true });
fs.writeFileSync(path.join(reportDir, 'mutation-callsite-coverage.json'), `${JSON.stringify(report, null, 2)}\n`);

assertGate(ok, 'repo-wide risky mutation call sites must be guarded or allowlisted-with-reason', {
  scanned_file_count: scanFiles.length,
  uncovered,
  unused_allowlist,
  blanket_allowlist
});
emitGate('safety:mutation-callsite-coverage', {
  scanned_file_count: scanFiles.length,
  covered: covered.length,
  allowlisted: allowlisted.length,
  uncovered: uncovered.length
});

function readAllowlist() {
  const raw = JSON.parse(fs.readFileSync(allowlistPath, 'utf8'));
  assertGate(raw.schema === 'sks.safety-mutation-allowlist.v3', 'mutation allowlist schema mismatch', raw);
  assertGate(Array.isArray(raw.entries), 'mutation allowlist entries must be an array', raw);
  return raw.entries.map((entry, index) => {
    for (const key of ['file', 'symbol', 'token', 'scope_contract_sha256', 'callsite_sha256', 'reason']) {
      assertGate(typeof entry[key] === 'string' && entry[key].trim().length > 0, `allowlist entry missing ${key}`, { index, entry });
    }
    assertGate(/^[a-f0-9]{64}$/.test(entry.scope_contract_sha256), 'allowlist scope_contract_sha256 must be lowercase sha256', { index, entry });
    assertGate(/^[a-f0-9]{64}$/.test(entry.callsite_sha256), 'allowlist callsite_sha256 must be lowercase sha256', { index, entry });
    assertGate(Number.isInteger(entry.occurrence) && entry.occurrence > 0, 'allowlist occurrence must be a positive integer', { index, entry });
    assertGate(entry.reason.length >= 12, 'allowlist reason must be concrete', { index, entry });
    return { ...entry, id: `${entry.file}:${entry.symbol}:${entry.token}:${index}` };
  });
}

function listScanFiles() {
  const files = [];
  walk(path.join(root, 'src'), (file) => {
    const relative = rel(file);
    if (isTestSource(relative)) return;
    if (file.endsWith('.ts')) files.push(relative);
  });
  return files.sort();
}

function isTestSource(relative: string) {
  return /(^|\/)__tests__\//.test(relative) || /\.test\.ts$/.test(relative);
}

function walk(dir, visit) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!['node_modules', 'dist', 'target'].includes(entry.name)) walk(file, visit);
    } else if (entry.isFile()) {
      visit(file);
    }
  }
}

function findAllow(entry) {
  return allowlist.find((allow) =>
    !allowlistHits.has(allow.id)
    && entry.file === allow.file
    && entry.symbol === allow.symbol
    && entry.token === allow.token
    && entry.scope_contract_sha256 === allow.scope_contract_sha256
    && entry.callsite_sha256 === allow.callsite_sha256
    && entry.occurrence === allow.occurrence
  );
}

function processKillIsLivenessProbe(call) {
  return /^process\.kill\([^,\n]+,\s*0\s*\)$/.test(call);
}

function risksForCall(call) {
  const risks = [];
  const callee = call.canonical_callee;
  const direct = (call.written_callee && DIRECT_RISKY.get(call.written_callee))
    || (call.written_callee && DIRECT_RISKY.get(lastPathSegment(call.written_callee)))
    || (callee ? DIRECT_RISKY.get(callee) : null);
  if (direct) risks.push(direct);

  const firstArgument = call.node.arguments[0]?.getText(call.node.getSourceFile()) || '';
  if (callee === 'runProcess') {
    if (/^(?:npmBin|['"](?:npm|brew)['"])$/.test(firstArgument.trim())
      && /\b(?:install|i|add|uninstall|remove|publish)\b/.test(call.normalized_call)) {
      risks.push({ kind: 'package_install', token: 'runProcess(npm/brew)' });
    }
    if (/^['"]xattr['"]$/.test(firstArgument.trim())) risks.push({ kind: 'xattr', token: 'xattr' });
    if (/^['"]chflags['"]$/.test(firstArgument.trim())) risks.push({ kind: 'chflags', token: 'chflags' });
  }
  if (callee && ['spawn', 'spawnSync', 'child_process.spawn', 'child_process.spawnSync'].includes(callee)
    && /^['"]npm['"]$/.test(firstArgument.trim())
    && /\b(?:install|i)\b/.test(call.normalized_call)) {
    risks.push({ kind: 'package_install', token: 'spawn(npm install)' });
  }

  if (direct && direct.kind !== 'process_kill'
    && /(?:~\/\.codex|CODEX_HOME|codexHome|codexLbHome|auth\.json|config\.toml)/.test(call.normalized_call)) {
    risks.push({ kind: 'codex_home_write', token: 'codex config write' });
  }
  return risks;
}

function lastPathSegment(value) {
  return value.slice(value.lastIndexOf('.') + 1);
}

function snippet(line) {
  return line.trim().slice(0, 160);
}

function rel(file) {
  return path.relative(root, file).split(path.sep).join('/');
}
