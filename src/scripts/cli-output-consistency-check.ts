#!/usr/bin/env node
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { assertGate, emitGate, root } from './gate-lib.js';
import { PACKAGE_VERSION } from '../core/version.js';

const executed = [
  ['review'],
  ['fast-mode', 'status'],
  ['menubar', 'status'],
  ['uninstall', '--dry-run', '--yes'],
  ['naruto', 'help']
];

const staticFiles = [
  'src/commands/doctor.ts',
  'src/core/commands/basic-cli.ts',
  'src/core/commands/naruto-command.ts',
  'src/core/commands/review-command.ts',
  'src/core/commands/fast-mode-command.ts',
  'src/core/commands/menubar-command.ts',
  'src/core/commands/uninstall-command.ts'
];

const runs = executed.map((args) => run(args));
const staticMissing = staticFiles.filter((file) => !fs.readFileSync(file, 'utf8').includes('.banner('));
const badFirstLines = runs.filter((row) => !row.first_line.startsWith(`SKS ${PACKAGE_VERSION} ·`));
const missingVocabulary = runs.filter((row) => !/[✔▲✖]/.test(row.stdout));
const report = {
  schema: 'sks.cli-output-consistency.v1',
  ok: badFirstLines.length === 0 && missingVocabulary.length === 0 && staticMissing.length === 0,
  executed: runs,
  static_files_checked: staticFiles,
  bad_first_lines: badFirstLines,
  missing_status_vocabulary: missingVocabulary,
  static_missing_banner: staticMissing
};

assertGate(report.ok, 'CLI output consistency check failed', report);
emitGate('cli:output-consistency', report);

function run(args: string[]) {
  const result = spawnSync(process.execPath, ['./dist/bin/sks.js', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', SKS_UNINSTALL_SKIP_TMP_SWEEP: '1' },
    timeout: 120000,
    maxBuffer: 1024 * 1024
  });
  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || '');
  return {
    args,
    code: result.status,
    first_line: stdout.split(/\r?\n/).find(Boolean) || '',
    stdout: stdout.slice(0, 4000),
    stderr: stderr.slice(0, 1000)
  };
}
