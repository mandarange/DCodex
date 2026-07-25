import fs from 'node:fs/promises';
import path from 'node:path';
import { assertGate, emitGate, makeTempRoot, writeText } from './skill-fixture-check-lib.js';
import { importDist } from './gate-lib.js';

const tmp = await makeTempRoot('sks-build-once-');
await writeText(path.join(tmp, 'package.json'), JSON.stringify({
  version: '4.0.2',
  scripts: {
    'build:clean': 'node build.mjs',
    'build:incremental': 'node build.mjs'
  }
}, null, 2));
await writeText(path.join(tmp, 'package-lock.json'), JSON.stringify({ name: 'fixture', version: '4.0.2', lockfileVersion: 3, packages: { '': { version: '4.0.2' } } }, null, 2));
await writeText(path.join(tmp, 'tsconfig.json'), JSON.stringify({ compilerOptions: { outDir: 'dist' } }, null, 2));
await writeText(path.join(tmp, 'src/index.ts'), 'export const value = 1;\n');
await writeText(path.join(tmp, 'build.mjs'), "import fs from 'node:fs'; fs.mkdirSync('dist/bin',{recursive:true}); fs.writeFileSync('dist/bin/sks.js','#!/usr/bin/env node\\n');\n");

const mod = await importDist('core/build/build-once-runner.js');
const first = mod.runBuildOnce({ root: tmp, mode: 'clean', force: true });
const second = mod.runBuildOnce({ root: tmp, mode: 'incremental' });
await writeText(path.join(tmp, 'src/index.ts'), 'export const value = 2;\n');
const third = mod.runBuildOnce({ root: tmp, mode: 'incremental' });
await writeText(path.join(tmp, 'build.mjs'), "import fs from 'node:fs'; fs.mkdirSync('dist/bin',{recursive:true});\n");
await fs.rm(path.join(tmp, 'dist', 'bin', 'sks.js'), { force: true });
const broken = mod.runBuildOnce({ root: tmp, mode: 'incremental', force: true });
await writeText(path.join(tmp, 'build.mjs'), "import fs from 'node:fs'; fs.mkdirSync('dist/bin',{recursive:true}); fs.writeFileSync('dist/bin/sks.js','#!/usr/bin/env node\\n');\n");
await writeText(path.join(tmp, 'package-lock.json'), JSON.stringify({ name: 'fixture', version: '4.0.2', lockfileVersion: 3, packages: { '': { version: '4.0.2' } }, changed: true }, null, 2));
const lockChanged = mod.runBuildOnce({ root: tmp, mode: 'incremental' });

assertGate(first.ok === true && first.reused === false, 'clean build must write an initial proof', first);
assertGate(second.ok === true && second.reused === true, 'second unchanged incremental run must reuse proof', second);
assertGate(third.ok === true && third.reused === false && third.source_hash !== first.source_hash, 'source edit must invalidate proof', { first, third });
assertGate(broken.ok === false && broken.blockers.some((item: string) => item.includes('dist_target_missing:dist/bin/sks.js')), 'missing dist/bin/sks.js must fail proof', broken);
assertGate(lockChanged.ok === true && lockChanged.package_lock_hash !== third.package_lock_hash, 'package-lock change must invalidate proof', { third, lockChanged });
emitGate('build-once:runner-blackbox', { first: first.ok, reused: second.reused, broken: broken.ok });
