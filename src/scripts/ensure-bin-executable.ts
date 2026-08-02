#!/usr/bin/env node
// @ts-nocheck
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(
  process.env.SKS_BUILD_SOURCE_ROOT
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
);
const distRoot = path.resolve(process.env.SKS_BUILD_OUTPUT_DIR || path.join(root, 'dist'));
const bins = [
  path.join(distRoot, 'bin', 'sks.js'),
  path.join(distRoot, 'bin', 'install.js')
];
for (const bin of bins) {
  await fsp.chmod(bin, 0o755).catch((err: any) => {
    if (err?.code !== 'ENOENT') throw err;
  });
  console.log(`bin executable: ${path.relative(root, bin)}`);
}
