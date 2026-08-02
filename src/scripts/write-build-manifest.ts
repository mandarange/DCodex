#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { writeTextAtomic } from '../core/fsx.js';
import { writeDistFreshStamp, sourceSnapshot } from './lib/ensure-dist-fresh.js';

const root = path.resolve(
  process.env.SKS_BUILD_SOURCE_ROOT
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
);
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const distRoot = path.resolve(process.env.SKS_BUILD_OUTPUT_DIR || path.join(root, 'dist'));
const srcRoot = path.join(root, 'src');

if (!fs.existsSync(distRoot)) {
  throw new Error('dist directory does not exist; run npm run build first');
}

const files = [];
await collect(distRoot, files);

const sorted = files.sort();
const mjsRuntime = sorted.filter((f) => f.endsWith('.mjs')).length;
const compiledJsCount = sorted.filter((f) => f.endsWith('.js')).length;
const compiledDtsCount = sorted.filter((f) => f.endsWith('.d.ts')).length;
const source = sourceSnapshot();
const distStamp = writeDistFreshStamp();
const srcMjsRuntimeFiles = await collectSrcMjsRuntimeFiles();

await writeTextAtomic(
  path.join(distRoot, 'build-manifest.json'),
  `${JSON.stringify(
    {
      schema: 'sks.dist-build.v2',
      version: pkg.version,
      package_version: pkg.version,
      typescript: true,
      mjs_runtime_files: mjsRuntime,
      compiled_file_count: compiledJsCount + compiledDtsCount,
      compiled_js_count: compiledJsCount,
      compiled_dts_count: compiledDtsCount,
      source_digest: source.digest,
      source_file_count: source.file_count,
      source_files_hash: sha256(source.files.join('\n')),
      source_list_hash: sha256(source.files.join('\n')),
      src_mjs_runtime_files: srcMjsRuntimeFiles.length,
      dist_stamp_schema: distStamp.schema,
      files: sorted,
    },
    null,
    2,
  )}\n`,
);

async function collect(dir, out) {
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await collect(file, out);
    else if (entry.isFile()) out.push(path.relative(distRoot, file).split(path.sep).join('/'));
  }
}

async function collectSrcMjsRuntimeFiles() {
  const out = [];
  await collectSrcMjs(srcRoot, out);
  return out.sort();
}

async function collectSrcMjs(dir, out) {
  if (!fs.existsSync(dir)) return;
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await collectSrcMjs(file, out);
    else if (entry.isFile() && entry.name.endsWith('.mjs')) {
      out.push(path.relative(srcRoot, file).split(path.sep).join('/'));
    }
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
