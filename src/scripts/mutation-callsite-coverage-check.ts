#!/usr/bin/env node
// @ts-nocheck
// Repo-wide risky mutation callsite gate. Every raw mutation must be either a
// guarded call or an external allowlist entry with a concrete function/symbol and
// reason. The allowlist is intentionally data, not code, so unused/stale entries
// fail the release gate.
import fs from 'node:fs';
import path from 'node:path';
import { assertGate, emitGate, root } from './gate-lib.js';

const allowlistPath = path.join(root, 'safety-mutation-allowlist.json');
const allowlist = readAllowlist();
const allowlistHits = new Set();

const scanFiles = listScanFiles();
const covered = [];
const allowlisted = [];
const uncovered = [];

const GUARD_CALL = /\bguarded(WriteFile|Rm|Rename|Chmod|Xattr|Chflags|GlobalCodexConfigWrite|ProcessKill|PackageInstall|SkillSnapshotPromotion|Apply)\(/;
const RISKY = [
  { kind: 'write_file', token: 'fs.writeFile', re: /\bfs\.writeFile\(/ },
  { kind: 'write_file', token: 'fs.promises.writeFile', re: /\bfs\.promises\.writeFile\(/ },
  { kind: 'write_file', token: 'fsp.writeFile', re: /\bfsp\.writeFile\(/ },
  { kind: 'write_file', token: 'writeFileSync', re: /\b(?:fs\.)?writeFileSync\(/ },
  { kind: 'rm', token: 'fs.rm', re: /\bfs\.rm\(/ },
  { kind: 'rm', token: 'fsp.rm', re: /\bfsp\.rm\(/ },
  { kind: 'rm', token: 'rmSync', re: /\b(?:fs\.)?rmSync\(/ },
  { kind: 'unlink', token: 'unlink', re: /\b(?:fs\.|fsp\.)?unlink\(/ },
  { kind: 'unlink', token: 'unlinkSync', re: /\b(?:fs\.)?unlinkSync\(/ },
  { kind: 'rename', token: 'rename', re: /\b(?:fs\.|fsp\.)?rename\(/ },
  { kind: 'rename', token: 'renameSync', re: /\b(?:fs\.)?renameSync\(/ },
  { kind: 'chmod', token: 'chmod', re: /\b(?:fs\.|fsp\.)?chmod\(/ },
  { kind: 'chmod', token: 'chmodSync', re: /\b(?:fs\.)?chmodSync\(/ },
  { kind: 'process_kill', token: 'process.kill', re: /\bprocess\.kill\(/ },
  { kind: 'package_install', token: 'runProcess(npm/brew)', re: /runProcess\(\s*(?:npmBin|['"](?:npm|brew)['"])/ },
  { kind: 'package_install', token: 'spawn(npm install)', re: /\bspawn(?:Sync)?\(\s*['"]npm['"][\s\S]{0,80}(?:install|i)\b/ },
  { kind: 'xattr', token: 'xattr', re: /runProcess\(\s*['"]xattr['"]/ },
  { kind: 'chflags', token: 'chflags', re: /runProcess\(\s*['"]chflags['"]/ },
  { kind: 'codex_home_write', token: 'codex config write', re: /(?:~\/\.codex|CODEX_HOME|auth\.json|config\.toml)/ }
];

for (const rel of scanFiles) {
  const text = fs.readFileSync(path.join(root, rel), 'utf8');
  const lines = text.split('\n');
  let currentSymbol = 'module';
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    currentSymbol = symbolFromLine(line) || currentSymbol;
    if (isIgnoredLine(line)) continue;
    if (GUARD_CALL.test(line)) {
      covered.push({ file: rel, line: i + 1, symbol: currentSymbol, kind: 'guarded_call', snippet: snippet(line) });
    }
    for (const risky of RISKY) {
      if (!risky.re.test(line)) continue;
      if (risky.kind === 'package_install' && !packageMutationOnLine(line)) continue;
      if (risky.kind === 'codex_home_write' && !codexHomeMutationOnLine(line)) continue;
      if (risky.kind === 'process_kill' && processKillIsLivenessProbe(line)) continue;
      const entry = { file: rel, line: i + 1, symbol: currentSymbol, kind: risky.kind, token: risky.token, snippet: snippet(line) };
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

const unused_allowlist = allowlist.filter((entry) => !allowlistHits.has(entry.id)).map(({ id, file, symbol, token, reason }) => ({ id, file, symbol, token, reason }));
const blanket_allowlist = allowlist.filter((entry) => !entry.symbol || entry.symbol === '*' || !entry.token || entry.token === '*');
const ok = uncovered.length === 0 && unused_allowlist.length === 0 && blanket_allowlist.length === 0;
const report = {
  schema: 'sks.mutation-callsite-coverage.v2',
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
  assertGate(raw.schema === 'sks.safety-mutation-allowlist.v1', 'mutation allowlist schema mismatch', raw);
  assertGate(Array.isArray(raw.entries), 'mutation allowlist entries must be an array', raw);
  return raw.entries.map((entry, index) => {
    for (const key of ['file', 'symbol', 'token', 'reason']) {
      assertGate(typeof entry[key] === 'string' && entry[key].trim().length > 0, `allowlist entry missing ${key}`, { index, entry });
    }
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
  return allowlist.find((allow) => entry.file === allow.file && entry.symbol === allow.symbol && entry.token === allow.token);
}

function symbolFromLine(line) {
  const match = line.match(/(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/)
    || line.match(/(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\(/)
    || line.match(/class\s+([A-Za-z0-9_$]+)/);
  return match?.[1] || null;
}

function isIgnoredLine(line) {
  const trimmed = line.trim();
  return !trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

function packageMutationOnLine(line) {
  return /\b(?:install|i|add|uninstall|remove|publish)\b/.test(line);
}

function processKillIsLivenessProbe(line) {
  return /\bprocess\.kill\([^,\n]+,\s*0\s*\)/.test(line);
}

function codexHomeMutationOnLine(line) {
  return /\b(?:writeTextAtomic|writeJsonAtomic|writeFileSync|fs\.writeFile|fs\.promises\.writeFile|fsp\.writeFile|fs\.rm|fsp\.rm|fs\.rename|fsp\.rename|fs\.chmod|fsp\.chmod|copyFile|open)\b/.test(line)
    && /(?:~\/\.codex|CODEX_HOME|codexHome|codexLbHome|auth\.json|config\.toml)/.test(line);
}

function snippet(line) {
  return line.trim().slice(0, 160);
}

function rel(file) {
  return path.relative(root, file).split(path.sep).join('/');
}
