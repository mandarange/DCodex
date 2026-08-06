#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const issues = [];
const oldMainModule = ['legacy', 'main.mjs'].join('-');
const oldMaintenanceModule = ['maintenance', 'commands.mjs'].join('-');
const oldDirectoryName = ['leg', 'acy'].join('');
const retiredDirectProviderRecoverySymbol = ['codex', 'LbTool', 'OutputRecovery'].join('');
const retiredDirectProviderRecoveryModules = [
  ['codex', '-lb-tool-output-recovery'].join(''),
  ['codex', '-lb-launch-recovery'].join('')
];
const registry = await read('src/cli/command-registry.ts');
if (registry.includes(oldMainModule)) issues.push('registry_legacy_main');
if (/lazy\s*:\s*legacy/.test(registry)) issues.push('registry_lazy_legacy');
if (/const\s+legacy\s*=/.test(registry)) issues.push('registry_legacy_const');

for (const file of await listFiles(path.join(root, 'src', 'commands'))) {
  const text = await fs.readFile(file, 'utf8');
  if (text.includes(oldMaintenanceModule)) issues.push(`${rel(file)}:maintenance_import`);
  if (text.includes(oldMainModule)) issues.push(`${rel(file)}:legacy_import`);
}
for (const file of await listFiles(path.join(root, 'src'))) {
  const text = await fs.readFile(file, 'utf8');
  if (/lazy\s*:\s*legacy/.test(text)) issues.push(`${rel(file)}:lazy_legacy`);
  if (text.includes(retiredDirectProviderRecoverySymbol)) issues.push(`${rel(file)}:retired_direct_provider_recovery_symbol`);
  for (const moduleName of retiredDirectProviderRecoveryModules) {
    if (text.includes(moduleName)) issues.push(`${rel(file)}:retired_direct_provider_recovery_module`);
  }
}
for (const dir of await listDirectories(path.join(root, 'src'))) {
  if (path.basename(dir).toLowerCase() === oldDirectoryName) issues.push(`${rel(dir)}:dedicated_legacy_directory`);
}
const bin = await read('src/bin/sks.ts');
const main = await read('src/cli/main.ts');
const router = await read('src/cli/router.ts');
if (!bin.includes('./sks-dispatch.js')) issues.push('bin_entrypoint');
if (!main.includes('./router.js')) issues.push('main_router');
if (!router.includes('command-registry.js')) issues.push('router_registry');
if (router.includes(oldMainModule)) issues.push('router_legacy_main');
const pkg = JSON.parse(await read('package.json'));
if ((pkg.files || []).some((entry) => String(entry).startsWith('archive'))) issues.push('archive_in_package_files');

if (issues.length) {
  console.error(`Legacy-free check failed: ${issues.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log('Legacy-free check passed');
}

async function read(relPath) {
  return fs.readFile(path.join(root, relPath), 'utf8');
}

async function listFiles(dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await listFiles(file));
    else if (entry.isFile() && /\.(?:[cm]?[jt]s)$/.test(file)) out.push(file);
  }
  return out;
}

async function listDirectories(dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const child = path.join(dir, entry.name);
    out.push(child, ...await listDirectories(child));
  }
  return out;
}

function rel(file) {
  return path.relative(root, file).split(path.sep).join('/');
}
