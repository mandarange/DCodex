#!/usr/bin/env node
// @ts-nocheck
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { root, assertGate, emitGate, importDist, readText, readJson } from './gate-lib.js';

// Proves TypeScript is the runtime source-of-truth and Rust is an OPTIONAL accelerator:
//  - publish/build never compiles Rust,
//  - the JS fallback is always available and produces identical results,
//  - the native binary is never required to ship or run SKS.

// 1) No cargo/rustc anywhere in build or publish.
assertGate(!/cargo|rustc/.test(readText('src/scripts/build-dist.ts')), 'build-dist must not invoke cargo/rustc');
assertGate(!/cargo|rustc/.test(readText('src/scripts/clean-dist.ts')), 'clean-dist must not invoke cargo/rustc');

const pkg = readJson('package.json');
for (const s of ['prepack', 'prepublishOnly', 'release:pack-receipt', 'runtime:installed-smoke', 'publish:npm']) {
  assertGate(!String(pkg.scripts?.[s] || '').includes('cargo'), `publish_script_compiles_rust:${s}`);
}

// 2) The published binary is JS; no prebuilt native artifact is shipped or required.
assertGate(pkg.bin?.sks === 'dist/bin/sks.js', 'package bin.sks must point at the JS entrypoint dist/bin/sks.js');
assertGate(
  !(pkg.files || []).some((f) => f === 'native' || f.includes('target') || f.endsWith('.node')),
  'package files must not ship a prebuilt native binary (native/target/*.node)'
);

// 3) Doctor readiness has no Rust dependency (audit confirmed zero rust references).
const matrix = readText('src/core/doctor/doctor-readiness-matrix.ts');
assertGate(!/rust/i.test(matrix), 'doctor readiness matrix must not depend on Rust');

// 4) Behavioral: JS fallback parity. The normalized result hash must equal the TS sha256.
const acc = await importDist('core/rust-accelerator.js');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-rust-boundary-'));
const tempFile = path.join(tmpDir, 'sneakoscope-rust-boundary.bin');
const fileBytes = Buffer.from('sneakoscope-rust-boundary');
fs.writeFileSync(tempFile, fileBytes);

const tsHash = crypto.createHash('sha256').update(fileBytes).digest('hex');

const r = await acc.rustImageHash(tempFile);

// The result shape: { command, engine, available, rust_error, stdout, result }.
// The 64-hex sha256 lives inside `result` (result.sha256 for the JS fallback, or the
// rust JSON payload's hash field). Extract robustly: prefer known fields, fall back to a
// regex scan over the whole normalized object.
const directHash =
  (r.result && (r.result.sha256 || r.result.hash || r.result.image_hash)) || null;
const scannedHash = (JSON.stringify(r).match(/\b[0-9a-f]{64}\b/) || [])[0] || null;
const acceleratorHash = (typeof directHash === 'string' && /^[0-9a-f]{64}$/.test(directHash))
  ? directHash
  : scannedHash;

assertGate(acceleratorHash === tsHash, 'rust_ts_hash_mismatch', {
  engine: r.engine,
  accelerator_hash: acceleratorHash,
  ts_hash: tsHash
});

// 5) Accelerator status must report a known mode; JS fallback readiness must be true when present.
const info = await acc.rustInfo();
assertGate(['js_fallback', 'rust_accelerated'].includes(info.mode), 'rust accelerator mode must be js_fallback or rust_accelerated', {
  mode: info.mode
});
if (typeof info.js_fallback_ready !== 'undefined') {
  assertGate(info.js_fallback_ready === true, 'js fallback must be ready when reported');
}

try {
  fs.rmSync(tmpDir, { recursive: true, force: true });
} catch {
  // temp cleanup is best-effort
}

const report = {
  schema: 'sks.runtime-ts-rust-boundary.v1',
  ok: true,
  engine: r.engine,
  mode: info.mode,
  no_cargo_in_publish: true,
  native_binary_required: false,
  js_fallback_parity: true
};
const out = path.join(root, '.sneakoscope/reports/runtime-ts-rust-boundary.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

emitGate('runtime:ts-rust-boundary', { engine: r.engine, no_cargo_in_publish: true });
