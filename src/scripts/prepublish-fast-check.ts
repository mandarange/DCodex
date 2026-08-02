#!/usr/bin/env node
// @ts-nocheck
// Fast prepublish eligibility check. Self-contained: reads the existing release
// stamp written by dist/scripts/release-check-stamp.js and decides whether the cheap
// fast-path (no full release:check rebuild) is eligible by comparing only the
// lightweight comparators it can recompute without a build.
//
// Output: a single JSON line on stdout (schema sks.prepublish-fast-check.v1).
// Exit 0 when the fast path is eligible; exit 1 otherwise (incl. no stamp).
// Tolerant of missing stamp fields; only compares fields present in the stamp.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { root } from './gate-lib.js';

const stampPath =
  process.env.SKS_RELEASE_STAMP_PATH || path.join(root, '.sneakoscope', 'reports', 'release-check-stamp.json');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function safeGitCommit() {
  try {
    const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
    if (result.status === 0) return String(result.stdout || '').trim() || null;
  } catch {
    // git unavailable; commit comparison is informational only.
  }
  return null;
}

function readPackageJson() {
  const raw = fs.readFileSync(path.join(root, 'package.json'));
  return { raw, json: JSON.parse(raw.toString('utf8')) };
}

function packageFilesListHash(pkg) {
  const files = Array.isArray(pkg.files) ? [...pkg.files].sort() : [];
  return sha256(JSON.stringify(files));
}

function main() {
  // No stamp -> not eligible; print and exit 1.
  if (!fs.existsSync(stampPath)) {
    console.log(JSON.stringify({ ok: false, reason: 'no_release_stamp', hint: 'run npm run release:check:full' }));
    process.exit(1);
  }

  let stamp;
  try {
    stamp = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
  } catch (err) {
    console.log(
      JSON.stringify({
        schema: 'sks.prepublish-fast-check.v1',
        ok: false,
        fast_path: false,
        version: null,
        git_commit: safeGitCommit(),
        mismatched: ['stamp_unreadable'],
        reasons: [`stamp_unreadable:${err && err.message ? err.message : 'unknown'}`]
      })
    );
    process.exit(1);
  }

  const { raw: pkgRaw, json: pkg } = readPackageJson();
  const currentVersion = pkg.version;
  const currentPkgSha = sha256(pkgRaw);
  const currentFilesHash = packageFilesListHash(pkg);
  const gitCommit = safeGitCommit();

  const mismatched = [];
  const reasons = [];

  // Always-compared comparator: package version.
  if (Object.prototype.hasOwnProperty.call(stamp, 'package_version')) {
    if (stamp.package_version !== currentVersion) {
      mismatched.push('package_version');
      reasons.push(`package_version: stamp=${stamp.package_version ?? 'missing'} current=${currentVersion}`);
    }
  } else {
    mismatched.push('package_version');
    reasons.push('package_version: absent from stamp');
  }

  // Compared only if the stamp carries it.
  if (Object.prototype.hasOwnProperty.call(stamp, 'package_json_sha256')) {
    if (stamp.package_json_sha256 !== currentPkgSha) {
      mismatched.push('package_json_sha256');
      reasons.push(`package_json_sha256: stamp=${stamp.package_json_sha256 ?? 'missing'} current=${currentPkgSha}`);
    }
  }

  // package.files list hash: informational unless the stamp recorded one.
  if (Object.prototype.hasOwnProperty.call(stamp, 'package_files_list_sha256')) {
    if (stamp.package_files_list_sha256 !== currentFilesHash) {
      mismatched.push('package_files_list_sha256');
      reasons.push(
        `package_files_list_sha256: stamp=${stamp.package_files_list_sha256 ?? 'missing'} current=${currentFilesHash}`
      );
    }
  }
  if (Object.prototype.hasOwnProperty.call(stamp, 'package_files_sha256')) {
    // Full package file hashing is owned by release-check-stamp.js; this check
    // confirms the fast stamp carries the comparator and leaves exact matching to
    // `release-check-stamp verify`.
    if (!stamp.package_files_sha256) {
      mismatched.push('package_files_sha256');
      reasons.push('package_files_sha256: absent from stamp');
    }
  }
  if (Object.prototype.hasOwnProperty.call(stamp, 'release_gate_sha256') && !stamp.release_gate_sha256) {
    mismatched.push('release_gate_sha256');
    reasons.push('release_gate_sha256: absent from stamp');
  }

  // This lightweight eligibility probe reports git_commit drift without deciding it.
  // The authoritative `release-check-stamp verify` that follows compares the stamp
  // to the exact current HEAD as well as the content hashes, so a post-stamp commit
  // requires rerunning the full release check before publish.
  const stampedGitCommit = Object.prototype.hasOwnProperty.call(stamp, 'git_commit') ? stamp.git_commit || null : null;

  const eligible = mismatched.length === 0;
  console.log(
    JSON.stringify({
      schema: 'sks.prepublish-fast-check.v1',
      ok: eligible,
      fast_path: eligible,
      version: currentVersion,
      git_commit: gitCommit,
      stamped_git_commit: stampedGitCommit,
      git_commit_changed_since_stamp: Boolean(stampedGitCommit && gitCommit && stampedGitCommit !== gitCommit),
      mismatched,
      reasons
    })
  );
  process.exit(eligible ? 0 : 1);
}

main();
