#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const issues = [];

if (pkg.bin?.sks !== 'dist/bin/sks.js') issues.push('package_bin_sks_not_dist');
if (pkg.bin?.sneakoscope !== 'dist/bin/sks.js') issues.push('package_bin_sneakoscope_not_dist');
if ((pkg.files || []).includes('src')) issues.push('package_files_include_src');
const devSks = String(pkg.scripts?.['dev:sks'] || '');
if (devSks && (!devSks.includes('dist/bin/sks.js') || /(?:^|[\\/])src[\\/]/.test(devSks))) {
  issues.push('dev_sks_not_dist_only');
}

for (const file of walk(path.join(root, 'src'))) {
  const rel = path.relative(root, file).split(path.sep).join('/');
  if (rel.endsWith('.mjs')) issues.push(`src_mjs_runtime_shadow:${rel}`);
  if (!rel.endsWith('.ts')) continue;
  const text = fs.readFileSync(file, 'utf8');
  if (/from\s+['"][^'"]+\.mjs['"]|import\(\s*['"][^'"]+\.mjs['"]\s*\)/.test(text)) {
    issues.push(`ts_imports_mjs:${rel}`);
  }
}

const binShim = path.join(root, 'bin', 'sks.mjs');
if (fs.existsSync(binShim)) {
  const text = fs.readFileSync(binShim, 'utf8');
  if (text.includes('/src/') || text.includes('../src/') || text.includes('FAST_PACKAGE_VERSION')) {
    issues.push('bin_sks_mjs_not_dist_only');
  }
}

const result = {
  schema: 'sks.runtime-ts-source-of-truth.v1',
  ok: issues.length === 0,
  issues
};
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file, out);
    else if (entry.isFile()) out.push(file);
  }
  return out;
}
