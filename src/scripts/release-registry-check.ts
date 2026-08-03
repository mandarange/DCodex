#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCurrentNpmPackProof } from '../core/release/npm-pack-proof.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const expectedRegistry = 'https://registry.npmjs.org/';
const requireUnpublished = process.argv.includes('--require-unpublished');
const requirePublishAuth = process.argv.includes('--require-publish-auth');
const requirePackProof = process.argv.includes('--require-pack-proof');
const publishAuthMode = String(process.env.SKS_PUBLISH_AUTH_MODE || 'token').trim().toLowerCase();
const skipNetwork = process.env.SKS_SKIP_REGISTRY_NETWORK_CHECK === '1';
const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const publishAuthReportPath = process.env.SKS_RELEASE_PUBLISH_AUTH_REPORT_PATH
  ? path.resolve(process.env.SKS_RELEASE_PUBLISH_AUTH_REPORT_PATH)
  : path.join(root, '.sneakoscope', 'reports', 'release-publish-auth.json');

type AnyRecord = Record<string, any>;

function fail(message: string, detail = ''): never {
  console.error(`Release registry check failed: ${message}`);
  if (detail) console.error(detail.trim());
  process.exit(2);
}

function normalizeRegistry(value: unknown): string {
  if (!value) return '';
  return String(value).trim().replace(/\/?$/, '/');
}

function readJson(file: string): AnyRecord {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  } catch (err: unknown) {
    fail(`unable to read ${file}`, err instanceof Error ? err.message : String(err));
  }
}

function run(cmd: string, args: string[], options: AnyRecord = {}) {
  return spawnSync(cmd, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000,
    ...options
  });
}

function npmRegistryReadEnv(overrides: Record<string, string | undefined> = {}) {
  const env = { ...process.env, ...overrides };
  delete env.npm_config_tag;
  delete env.NPM_CONFIG_TAG;
  return env;
}

function checkPackagePublishConfig(pkg: AnyRecord) {
  if (pkg.private) fail('package.json private=true would block public npm publication');
  if (pkg.publishConfig?.access !== 'public') {
    fail('package.json publishConfig.access must be public', `found: ${pkg.publishConfig?.access || 'missing'}`);
  }
  const registry = normalizeRegistry(pkg.publishConfig?.registry);
  if (registry !== expectedRegistry) {
    fail('package.json publishConfig.registry must target npmjs', `found: ${registry || 'missing'}\nexpected: ${expectedRegistry}`);
  }
  const isPrerelease = /-/.test(String(pkg.version || ''));
  if (isPrerelease && pkg.publishConfig?.tag !== 'rc') {
    fail('package.json publishConfig.tag must be rc for prerelease versions', `found: ${pkg.publishConfig?.tag || 'missing'}\nversion: ${pkg.version}`);
  }
  if (!isPrerelease && pkg.publishConfig?.tag && pkg.publishConfig.tag !== 'latest' && !isBackfillTag(pkg.publishConfig.tag)) {
    fail('package.json publishConfig.tag must be latest, omitted, or explicit backfill-* for stable backfill versions', `found: ${pkg.publishConfig.tag}\nversion: ${pkg.version}`);
  }
}

function checkRootNpmrc(pkg: AnyRecord) {
  const npmrcPath = path.join(root, '.npmrc');
  const publishConfigTag = String(pkg.publishConfig?.tag || '');
  if (!fs.existsSync(npmrcPath)) {
    if (isBackfillTag(publishConfigTag)) {
      fail('root .npmrc must pin the backfill publish tag for npm publish --ignore-scripts', `expected: tag=${publishConfigTag}`);
    }
    return;
  }
  const text = fs.readFileSync(npmrcPath, 'utf8');
  const unsafe: string[] = [];
  const isPrerelease = /-/.test(String(pkg.version || ''));
  let npmrcTag = '';
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    const match = trimmed.match(/^(?:@[^:]+:)?registry\s*=\s*(.+)$/);
    if (match && normalizeRegistry(match[1]) !== expectedRegistry) unsafe.push(`${index + 1}: ${trimmed}`);
    const tagMatch = trimmed.match(/^tag\s*=\s*(.+)$/);
    if (tagMatch) {
      const tag = String(tagMatch[1] || '').trim();
      npmrcTag = tag;
      if (isPrerelease && tag !== 'rc') unsafe.push(`${index + 1}: ${trimmed}`);
      if (!isPrerelease && tag !== 'latest' && !isBackfillTag(tag)) unsafe.push(`${index + 1}: ${trimmed}`);
    }
  }
  if (unsafe.length) {
    fail('root .npmrc contains publish config incompatible with this release', unsafe.join('\n'));
  }
  if (publishConfigTag && npmrcTag && publishConfigTag !== npmrcTag) {
    fail('root .npmrc tag disagrees with package.json publishConfig.tag', `.npmrc tag: ${npmrcTag}\npublishConfig.tag: ${publishConfigTag}`);
  }
  if (isBackfillTag(publishConfigTag) && npmrcTag !== publishConfigTag) {
    fail('root .npmrc must pin the backfill publish tag for npm publish --ignore-scripts', `.npmrc tag: ${npmrcTag || 'missing'}\nexpected: ${publishConfigTag}`);
  }
}

function checkLockfile(pkg: AnyRecord) {
  const lock = readJson('package-lock.json');
  const rootPackage = lock.packages?.[''];
  const mismatches = [
    ['package-lock.json name', lock.name, pkg.name],
    ['package-lock.json version', lock.version, pkg.version],
    ['package-lock root package name', rootPackage?.name, pkg.name],
    ['package-lock root package version', rootPackage?.version, pkg.version]
  ].filter(([, actual, expected]) => actual !== expected);
  if (mismatches.length) {
    fail('package-lock metadata is not synchronized', mismatches.map(([label, actual, expected]) => `${label}: ${actual || 'missing'} (expected ${expected})`).join('\n'));
  }

  const unsafeResolved: string[] = [];
  for (const [entry, meta] of Object.entries(lock.packages || {})) {
    const resolved = (meta as AnyRecord)?.resolved;
    if (!resolved || resolved.startsWith('file:') || resolved.startsWith('link:')) continue;
    let parsed;
    try {
      parsed = new URL(resolved);
    } catch {
      unsafeResolved.push(`${entry || '<root>'}: ${resolved}`);
      continue;
    }
    if (parsed.protocol === 'https:' && parsed.hostname === 'registry.npmjs.org') continue;
    unsafeResolved.push(`${entry || '<root>'}: ${resolved}`);
  }
  if (unsafeResolved.length) {
    fail('package-lock contains dependencies resolved outside registry.npmjs.org', unsafeResolved.join('\n'));
  }
}

function checkPackedMetadata(pkg: AnyRecord) {
  const packProof = readCurrentNpmPackProof(root);
  if (!packProof.ok || !packProof.proof) fail('current npm pack proof is required', packProof.blockers.join('\n'));
  const info = packProof.proof.info;
  if (info.name !== pkg.name || info.version !== pkg.version) {
    fail('packed package metadata differs from package.json', `pack: ${info.name || 'missing'}@${info.version || 'missing'}\npackage.json: ${pkg.name}@${pkg.version}`);
  }
}

function compareVersions(a: unknown, b: unknown): number {
  const pa = String(a || '').split(/[.-]/).map((part) => Number.parseInt(part, 10));
  const pb = String(b || '').split(/[.-]/).map((part) => Number.parseInt(part, 10));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const paValue = pa[i];
    const pbValue = pb[i];
    const da = Number.isFinite(paValue) ? paValue || 0 : 0;
    const db = Number.isFinite(pbValue) ? pbValue || 0 : 0;
    if (da !== db) return da > db ? 1 : -1;
  }
  return 0;
}

function checkPublishedVersion(pkg: AnyRecord) {
  if (skipNetwork) {
    console.log('Registry network check skipped by SKS_SKIP_REGISTRY_NETWORK_CHECK=1.');
    return;
  }
  const env = npmRegistryReadEnv({
    npm_config_cache: process.env.SKS_RELEASE_NPM_CACHE || path.join(os.tmpdir(), 'sneakoscope-npm-cache')
  });
  const result = run(npmBin, ['view', `${pkg.name}@latest`, 'version', 'dist-tags', '--json', '--registry', expectedRegistry], { env });
  if (result.status !== 0) fail('npm registry metadata lookup failed', `${result.stdout || ''}\n${result.stderr || ''}`);
  let info;
  try {
    info = JSON.parse(result.stdout);
  } catch {
    fail('npm registry metadata lookup returned non-json output', result.stdout || '');
  }
  const latest = info?.['dist-tags']?.latest || info?.version || null;
  if (!latest) fail('npm registry metadata lookup did not return a latest version');
  const exact = run(npmBin, ['view', `${pkg.name}@${pkg.version}`, 'version', '--json', '--registry', expectedRegistry], { env });
  let exactPublished = false;
  if (exact.status === 0) {
    try {
      const exactInfo = JSON.parse(exact.stdout);
      exactPublished = Array.isArray(exactInfo) ? exactInfo.includes(pkg.version) : exactInfo === pkg.version;
    } catch {
      exactPublished = String(exact.stdout || '').includes(pkg.version);
    }
  } else if (!/E404|No match found|not in this registry/i.test(`${exact.stdout || ''}\n${exact.stderr || ''}`)) {
    fail('npm exact-version lookup failed', `${exact.stdout || ''}\n${exact.stderr || ''}`);
  }
  if (requireUnpublished && exactPublished) {
    fail('package version is already published on npm', `${pkg.name}@${pkg.version}`);
  }
  const cmp = compareVersions(pkg.version, latest);
  if (requireUnpublished && cmp <= 0 && !isBackfillTag(pkg.publishConfig?.tag || '')) {
    fail('package version is not newer than the npm latest dist-tag', `package.json: ${pkg.version}\nnpm latest: ${latest}`);
  }
  const note = exactPublished
    ? `exact version already exists; current npm latest is ${latest}`
    : (cmp > 0 ? `ready for new publish over npm latest ${latest}` : `ready as backfill over current npm latest ${latest} with tag ${pkg.publishConfig?.tag || 'missing'}`);
  console.log(`Registry metadata check passed: ${pkg.name}@${pkg.version}; ${note}.`);
}

function isBackfillTag(value: unknown): boolean {
  return /^backfill(?:[-_][a-z0-9.-]+)?$/i.test(String(value || ''));
}

function checkPublishAuth(pkg: AnyRecord) {
  if (publishAuthMode === 'trusted-publisher') {
    checkTrustedPublisherAuth(pkg);
    return;
  }
  if (publishAuthMode !== 'token') {
    fail('unsupported npm publish auth mode', `SKS_PUBLISH_AUTH_MODE=${publishAuthMode}`);
  }
  if (skipNetwork) {
    fail('publish auth check cannot run when SKS_SKIP_REGISTRY_NETWORK_CHECK=1 is set');
  }

  const env = npmRegistryReadEnv({
    npm_config_cache: process.env.SKS_RELEASE_NPM_CACHE || path.join(os.tmpdir(), 'sneakoscope-npm-cache')
  });
  const whoami = run(npmBin, ['whoami', '--registry', expectedRegistry], { env });
  if (whoami.status !== 0) {
    const authHints = npmAuthSourceHints(env);
    fail(
      'npm publish auth is missing or invalid',
      [
        tail(`${whoami.stdout || ''}\n${whoami.stderr || ''}`),
        '',
        ...publishAuthRepairInstructions(pkg, authHints)
      ].join('\n')
    );
  }

  const user = normalizeNpmUser(whoami.stdout);
  if (!user) fail('npm whoami returned an empty username', whoami.stdout || '');

  const maintainers = packageMaintainers(pkg, env);
  if (maintainers.length > 0 && !maintainers.includes(user)) {
    fail(
      'authenticated npm user is not a package maintainer',
      [
        `npm whoami: ${user}`,
        `${pkg.name} maintainers: ${maintainers.join(', ')}`,
        `Log in as one of the listed maintainers or ask an owner to run \`npm owner add ${user} ${pkg.name}\`.`
      ].join('\n')
    );
  }

  const report = {
    schema: 'sks.release-publish-auth.v1',
    ok: true,
    package: pkg.name,
    version: pkg.version,
    registry: expectedRegistry,
    npm_user: user,
    maintainers,
    maintainer_match: maintainers.length === 0 ? null : maintainers.includes(user),
    generated_at: new Date().toISOString()
  };
  const out = publishAuthReportPath;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Publish auth check passed: ${pkg.name}@${pkg.version} as ${user}.`);
}

function checkTrustedPublisherAuth(pkg: AnyRecord) {
  const expectedRepository = githubRepositorySlug(pkg);
  const workflowRef = String(process.env.GITHUB_WORKFLOW_REF || '');
  const blockers = [
    process.env.GITHUB_ACTIONS === 'true' ? null : 'github_actions_environment_missing',
    process.env.GITHUB_REF === 'refs/heads/main' ? null : 'trusted_publish_ref_not_main',
    process.env.GITHUB_REPOSITORY === expectedRepository ? null : 'trusted_publish_repository_mismatch',
    workflowRef.includes(`${expectedRepository}/.github/workflows/publish-npm.yml@refs/heads/main`)
      ? null
      : 'trusted_publish_workflow_ref_mismatch',
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL ? null : 'oidc_request_url_missing',
    process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ? null : 'oidc_request_token_missing'
  ].filter(Boolean);
  if (blockers.length > 0) {
    fail(
      'npm trusted-publisher environment is incomplete',
      `${blockers.join('\n')}\nUse the manual publish-npm.yml workflow on refs/heads/main with id-token: write.`
    );
  }

  const report = {
    schema: 'sks.release-publish-auth.v1',
    ok: true,
    package: pkg.name,
    version: pkg.version,
    registry: expectedRegistry,
    auth_mode: 'trusted-publisher',
    github_repository: expectedRepository,
    github_ref: process.env.GITHUB_REF,
    workflow_file: 'publish-npm.yml',
    oidc_environment_present: true,
    identity_verified_by_registry_at_publish: false,
    generated_at: new Date().toISOString()
  };
  const out = publishAuthReportPath;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Trusted-publisher environment check passed: ${pkg.name}@${pkg.version} from ${expectedRepository}.`);
}

function githubRepositorySlug(pkg: AnyRecord): string {
  const repository = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  const match = String(repository || '').match(/github\.com[/:]([^/]+\/[^/#]+?)(?:\.git)?$/i);
  if (!match?.[1]) fail('package.json repository must identify the GitHub trusted-publisher repository');
  return match[1].replace(/\.git$/i, '');
}

function publishAuthRepairInstructions(pkg: AnyRecord, authHints: string[]): string[] {
  const lines: string[] = [];
  if (authHints.length > 0) {
    lines.push(`npm auth config was found (${authHints.join(', ')}), but the npm registry rejected it.`);
    lines.push('That usually means the token is expired, revoked, not valid for npmjs.org, or not publish-capable for this package.');
  } else {
    lines.push('No npm auth token was found in the checked npm config/env locations.');
  }
  lines.push(`Refresh local auth: \`npm logout --registry ${expectedRegistry}\`, then \`npm login --registry ${expectedRegistry}\` as a maintainer of ${pkg.name}.`);
  lines.push(`Verify before publishing: \`npm whoami --registry ${expectedRegistry}\`.`);
  lines.push('For token-based publishing, configure npm itself with a registry token, for example `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}` in the npm userconfig/project .npmrc and export a publish-capable token. A raw `NPM_TOKEN` environment variable alone is not enough unless npm config references it.');
  return lines;
}

function npmAuthSourceHints(env: Record<string, string | undefined>): string[] {
  const hints: string[] = [];
  if (env.NODE_AUTH_TOKEN) hints.push('NODE_AUTH_TOKEN env');
  if (env.NPM_TOKEN) hints.push('NPM_TOKEN env (requires npmrc interpolation)');
  for (const file of npmConfigCandidateFiles(env)) {
    for (const hint of npmAuthHintsFromFile(file)) hints.push(hint);
  }
  return [...new Set(hints)];
}

function npmConfigCandidateFiles(env: Record<string, string | undefined>): string[] {
  const files = [
    path.join(root, '.npmrc'),
    env.npm_config_userconfig,
    env.NPM_CONFIG_USERCONFIG,
    path.join(os.homedir(), '.npmrc')
  ].filter(Boolean);
  return [...new Set(files.map((file) => path.resolve(String(file))))];
}

function npmAuthHintsFromFile(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const hints: string[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    const lower = trimmed.toLowerCase();
    const hasAuthKey = /(?::|^)_authtoken\s*=|(?::|^)_auth\s*=|(?::|^)username\s*=|(?::|^)_password\s*=/.test(lower);
    if (!hasAuthKey) continue;
    const scopedToExpectedRegistry = lower.includes('//registry.npmjs.org/') || lower.startsWith('_auth');
    if (scopedToExpectedRegistry) hints.push(`${file}:${index + 1}`);
  }
  return hints;
}

function packageMaintainers(pkg: AnyRecord, env: Record<string, string | undefined>): string[] {
  const result = run(npmBin, ['view', pkg.name, 'maintainers', '--json', '--registry', expectedRegistry], { env });
  if (result.status !== 0) {
    const text = `${result.stdout || ''}\n${result.stderr || ''}`;
    if (/E404|not in this registry|No match found/i.test(text)) return [];
    fail('npm maintainer lookup failed', text);
  }
  try {
    const parsed = JSON.parse(result.stdout);
    const rows = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
    return [...new Set(rows.map(normalizeNpmUser).filter(Boolean))].sort();
  } catch {
    return [...new Set(String(result.stdout || '').split(/\r?\n/).map(normalizeNpmUser).filter(Boolean))].sort();
  }
}

function normalizeNpmUser(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'object') {
    const record = value as AnyRecord;
    return normalizeNpmUser(record.name || record.username || '');
  }
  const text = String(value).trim();
  if (/^["[{]/.test(text)) {
    try {
      return normalizeNpmUser(JSON.parse(text));
    } catch {
      // Fall through for legacy plain-text npm output.
    }
  }
  return String(text.replace(/^@/, '').split(/\s+/)[0] || '').toLowerCase();
}

function tail(value: unknown, limit = 1200): string {
  const text = String(value || '').trim();
  return text.length > limit ? text.slice(-limit) : text;
}

const pkg = readJson('package.json');
checkPackagePublishConfig(pkg);
checkRootNpmrc(pkg);
checkLockfile(pkg);
if (skipNetwork && (requireUnpublished || requirePublishAuth)) {
  fail('registry network checks cannot be skipped for publish-authorizing validation');
}
if (requirePackProof) checkPackedMetadata(pkg);
checkPublishedVersion(pkg);
if (requirePublishAuth) checkPublishAuth(pkg);
console.log(`Release registry check passed: ${pkg.name}@${pkg.version} -> ${expectedRegistry}`);
