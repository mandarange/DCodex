#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeTextAtomic } from '../core/fsx.js';

const root = path.resolve(
  process.env.SKS_BUILD_SOURCE_ROOT
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
);
const srcRoot = path.join(root, 'src');
const distRoot = path.resolve(process.env.SKS_BUILD_OUTPUT_DIR || path.join(root, 'dist'));

await fsp.mkdir(distRoot, { recursive: true });
await removeDistMjs(distRoot);
await copyRuntimeConfigFiles();
await copyNativeMenuBarSources();
await writeSkillsManifest();
await removeDistNonRuntimeArtifacts(distRoot);
await writeCommonJsBinScope();
await import('./write-build-manifest.js');

async function removeDistMjs(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await removeDistMjs(file);
    else if (entry.isFile() && entry.name.endsWith('.mjs')) await fsp.rm(file, { force: true });
  }
}

async function removeDistNonRuntimeArtifacts(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await removeDistNonRuntimeArtifacts(file);
    else if (entry.isFile() && (entry.name.endsWith('.js.map') || entry.name.endsWith('.d.ts.map') || entry.name.endsWith('.d.ts'))) {
      await fsp.rm(file, { force: true });
    }
  }
}

async function copyRuntimeConfigFiles() {
  const configs = ['core/performance-budgets.json'];
  for (const rel of configs) {
    const from = path.join(srcRoot, rel);
    const to = path.join(distRoot, rel);
    if (!fs.existsSync(from)) continue;
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.copyFile(from, to);
  }
  await copyDirIfPresent(
    path.join(srcRoot, 'vendor', 'openai-codex'),
    path.join(distRoot, 'vendor', 'openai-codex')
  );
}

async function copyNativeMenuBarSources() {
  await copyDirIfPresent(
    path.join(root, 'native', 'sks-menubar'),
    path.join(distRoot, 'native', 'sks-menubar'),
    { excludedDirectories: new Set(['Tests', 'UITests', 'QAFixtures']) }
  );
}

async function writeSkillsManifest() {
  const out = path.join(distRoot, 'config', 'skills-manifest.json');
  const ledgerPath = path.join(root, 'config', 'skills-hash-ledger.v1.json');
  const ledger = JSON.parse(await fsp.readFile(ledgerPath, 'utf8'));
  const {
    generatePackagedSkillsManifest,
    mergePackagedSkillsManifestHashHistory
  } = await import('../core/init/skills.js');
  const generated = await generatePackagedSkillsManifest();
  assertSkillsHashLedgerCoversGeneratedManifest(ledger, generated);
  const ledgerManifest = {
    skills: ledger.skills.map((row) => ({
      canonical_name: row.canonical_name,
      content_sha256: row.trusted_sha256[0],
      hash_history: row.trusted_sha256.slice(1)
    }))
  };
  const manifest = mergePackagedSkillsManifestHashHistory(generated, ledgerManifest);
  await fsp.mkdir(path.dirname(out), { recursive: true });
  await writeTextAtomic(out, `${JSON.stringify(manifest, null, 2)}\n`);
}

function assertSkillsHashLedgerCoversGeneratedManifest(ledger, generated) {
  if (ledger?.schema !== 'sks.skills-hash-ledger.v1' || !Array.isArray(ledger.skills)) {
    throw new Error('skills_hash_ledger_invalid');
  }
  const rows = new Map();
  for (const row of ledger.skills) {
    if (!/^[a-z0-9-]+$/.test(String(row?.canonical_name || ''))
      || rows.has(row.canonical_name)
      || !Array.isArray(row?.trusted_sha256)
      || !row.trusted_sha256.length
      || row.trusted_sha256.some((digest) => !/^[a-f0-9]{64}$/.test(String(digest)))) {
      throw new Error(`skills_hash_ledger_row_invalid:${String(row?.canonical_name || 'unknown')}`);
    }
    rows.set(row.canonical_name, new Set(row.trusted_sha256));
  }
  for (const skill of generated.skills || []) {
    if (!rows.get(skill.canonical_name)?.has(skill.content_sha256)) {
      throw new Error(`skills_hash_ledger_missing_current_digest:${skill.canonical_name}`);
    }
  }
}

async function writeCommonJsBinScope() {
  const binDir = path.join(distRoot, 'bin');
  if (!fs.existsSync(binDir)) return;
  await writeTextAtomic(path.join(binDir, 'package.json'), '{"type":"commonjs"}\n');
  await rewriteIfPresent(path.join(binDir, 'sks.js'), (text) =>
    stripSourceMap(text)
      .replace(/^import \{ PACKAGE_VERSION \} from '\.\.\/core\/version\.js';$/m, "const { version: PACKAGE_VERSION } = require('../../package.json');")
      .replace(/\nexport \{\};\n?/, '\n')
  );
  await rewriteIfPresent(path.join(binDir, 'sks-dispatch.js'), (text) => {
    const next = stripGeneratedCommonJsExports(
      stripSourceMap(text).replace(/^export async function runSks/m, 'async function runSks'),
      ['runSks']
    );
    return `${next}\n\nexports.runSks = runSks;\n`;
  });
  await rewriteIfPresent(path.join(binDir, 'fast-inline.js'), (text) => {
    const names = [
      'rootJsonFastInline',
      'doctorJsonFastInline',
      'narutoHelpJsonFastInline',
      'hookUserPromptSubmitPerfInline'
    ];
    let next = stripSourceMap(text);
    for (const name of names) {
      next = next.replace(new RegExp(`^export (async )?function ${name}`, 'm'), '$1function ' + name);
    }
    next = stripGeneratedCommonJsExports(next, names);
    return `${next}\n\n${names.map((name) => `exports.${name} = ${name};`).join('\n')}\n`;
  });
  await rewriteIfPresent(path.join(binDir, 'install.js'), () => `#!/usr/bin/env node
import('../core/commands/install-package-command.js')
  .then(({ installPackageCommand }) => installPackageCommand())
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
`);
}

async function rewriteIfPresent(file, rewrite) {
  if (!fs.existsSync(file)) return;
  const text = await fsp.readFile(file, 'utf8');
  await writeTextAtomic(file, rewrite(text));
}

function stripSourceMap(text) {
  return text.replace(/\n\/\/# sourceMappingURL=.*\.map\s*$/s, '\n');
}

function stripGeneratedCommonJsExports(text, names) {
  const escaped = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return text
    .replace(new RegExp(`^exports\\.(${escaped}) = \\1;\\s*$`, 'gm'), '')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}

async function copyDirIfPresent(from, to, options = {}) {
  from = fileURLToPathIfNeeded(from);
  if (!fs.existsSync(from)) return;
  await fsp.rm(to, { recursive: true, force: true });
  await fsp.mkdir(to, { recursive: true });
  for (const entry of await fsp.readdir(from, { withFileTypes: true })) {
    if (entry.isDirectory() && options.excludedDirectories?.has(entry.name)) continue;
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) await copyDirIfPresent(source, target, options);
    else if (entry.isFile()) await fsp.copyFile(source, target);
  }
}

function fileURLToPathIfNeeded(value) {
  return value instanceof URL ? fileURLToPath(value) : value;
}
