#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { emitGate } from './real-execution-check-lib.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-dfix-fast-blackbox-'));
fs.mkdirSync(path.join(root, '.sneakoscope'), { recursive: true });
fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
  private: true,
  type: 'module',
  scripts: {
    test: 'node test.mjs',
    'test:unit': 'node test.mjs',
    'dfix:fixture': 'node test.mjs',
    'dfix:verification': 'node test.mjs'
  }
}, null, 2));
fs.writeFileSync(path.join(root, 'value.js'), 'export const value = "bad";\n');
fs.writeFileSync(path.join(root, 'test.mjs'), 'import { value } from "./value.js"; if (value !== "good") throw new Error("expected good");\n');
const sks = path.join(process.cwd(), 'dist', 'bin', 'sks.js');
const env = { ...process.env, SKS_DISABLE_UPDATE_CHECK: '1' };
const diagnose = run(root, sks, ['dfix', 'diagnose', 'fix value', '--file', 'value.js', '--error', 'AssertionError: expected good at value.js:1', '--json'], env);
const mission = JSON.parse(diagnose.stdout).mission_id;
const patch = run(root, sks, ['dfix', 'patch', mission, '--file', 'value.js', '--find', 'bad', '--replace', 'good', '--apply', '--json'], env);
const verify = run(root, sks, ['dfix', 'verify', mission, '--command', 'node test.mjs', '--verify-auto', '--json'], env);
const ok = diagnose.status === 0 && patch.status === 0 && verify.status === 0 && fs.readFileSync(path.join(root, 'value.js'), 'utf8').includes('"good"');
console.log(JSON.stringify({ schema: 'sks.dfix-fast-blackbox-check.v1', ok, mission_id: mission, root }, null, 2));
if (!ok) process.exitCode = 1;
else emitGate('dfix:blackbox-fast', { mission_id: mission });

function run(cwd, bin, args, env) {
  return spawnSync(process.execPath, [bin, ...args], { cwd, env, encoding: 'utf8', timeout: 30_000 });
}
