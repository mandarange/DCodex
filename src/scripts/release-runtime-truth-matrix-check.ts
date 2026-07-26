#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { buildRuntimeTruthMatrix, writeRuntimeTruthMatrix } from '../core/proof/runtime-truth-matrix.js';
import { assertGate, emitGate, root } from './gate-lib.js';

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const matrix = await buildRuntimeTruthMatrix({
  root,
  releaseVersion: String(pkg.version || '')
});
await writeRuntimeTruthMatrix(root, matrix);
assertGate(matrix.ok === true, 'runtime truth matrix contains blocking evidence', {
  blockers: matrix.blockers,
  required_rows: matrix.rows.filter((row) => row.required_mode)
});
emitGate('release:runtime-truth-matrix', {
  report: `.sneakoscope/reports/runtime-truth-matrix-${pkg.version}.json`,
  rows: matrix.rows.length,
  priorities: matrix.priorities
});
