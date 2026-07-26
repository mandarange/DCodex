#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs'
import path from 'node:path'
import { writeReleaseProofTruth } from '../core/release/release-proof-truth.js'
import { assertGate, emitGate, root } from './gate-lib.js'

const truth = await writeReleaseProofTruth(root)
assertGate(truth.schema === 'sks.release-proof-truth.v1', 'release proof truth schema mismatch', truth)
assertGate(truth.package_version === JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version, 'release proof truth version mismatch', truth)
assertGate(Boolean(truth.package_json_sha256 && truth.package_lock_sha256 && truth.version_ts_sha256 && truth.changelog_sha256 && truth.release_gates_sha256), 'release proof truth file hashes missing', truth)
assertGate(fs.existsSync(path.join(root, '.sneakoscope', 'release-proof-truth.json')), 'root release proof truth artifact missing')
assertGate(fs.existsSync(path.join(root, 'dist', 'release-proof-truth.json')), 'dist release proof truth artifact missing')
emitGate('release:proof-truth', truth)
