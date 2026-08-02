import test from 'node:test';
import assert from 'node:assert/strict';
import { printJson } from '../output.js';

test('JSON ok:false always establishes a nonzero process exit code', () => {
  const originalExitCode = process.exitCode;
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    process.exitCode = 0;
    printJson({ schema: 'sks.research-run.v1', ok: false, mock: true });
    assert.equal(process.exitCode, 1);
    assert.equal(JSON.parse(lines[0] || '{}').ok, false);

    process.exitCode = 2;
    printJson({ ok: false });
    assert.equal(process.exitCode, 2, 'an explicit command-specific failure code must be preserved');

    process.exitCode = 0;
    printJson({ ok: true });
    assert.equal(process.exitCode, 0);
  } finally {
    console.log = originalLog;
    process.exitCode = originalExitCode;
  }
});
