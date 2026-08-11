import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

/**
 * Registry authentication preflight for `npm publish`.
 *
 * `publish-preflight` verified that the package was built correctly but never
 * that it could be uploaded, so a run could pass every lifecycle stage and then
 * fail at the very end. npm answers an unauthorized PUT with **404**, not 401,
 * to avoid disclosing whether a package exists — so an expired token surfaces
 * as `404 Not Found - PUT .../sneakoscope`, which reads like the package is
 * missing rather than like a login problem. That happened after a full 2.7 MB
 * tarball had already been built and streamed.
 *
 * This checks the one prerequisite that failure depends on, before the work.
 */
export const NPM_REGISTRY = 'https://registry.npmjs.org/';

export type PublishRegistryAuthStatus =
  | 'authenticated'
  | 'unauthenticated'
  | 'not_a_maintainer'
  | 'skipped_trusted_publisher'
  | 'skipped_offline'
  | 'skipped_not_publishing';

export interface PublishRegistryAuthReport {
  schema: 'sks.publish-registry-auth.v1';
  ok: boolean;
  status: PublishRegistryAuthStatus;
  registry: string;
  package: string | null;
  npm_user: string | null;
  maintainers: string[];
  blockers: string[];
  operator_actions: string[];
}

function npmBinary(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

/**
 * A read-only npm environment. `npm_config_*` variables injected by the running
 * lifecycle would otherwise leak into these probes (for example a `dry-run`
 * flag turning `npm view` into a no-op).
 */
function registryReadEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^npm_config_/i.test(key) && !/^npm_config_(?:registry|cache|userconfig|globalconfig|prefix)$/i.test(key)) continue;
    if (/^npm_(?:command|lifecycle_event|package_)/i.test(key)) continue;
    env[key] = value;
  }
  env.npm_config_registry = NPM_REGISTRY;
  env.npm_config_cache = process.env.SKS_RELEASE_NPM_CACHE || path.join(os.tmpdir(), 'sneakoscope-npm-cache');
  return env;
}

function runNpm(args: readonly string[], timeoutMs = 30_000) {
  return spawnSync(npmBinary(), [...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    env: registryReadEnv(),
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

/** npm prints the username alone; anything else is treated as no identity. */
function normalizeNpmUser(value: unknown): string | null {
  const user = String(value || '').trim().split('\n').pop()?.trim() || '';
  return /^[A-Za-z0-9._~-]{1,128}$/.test(user) ? user : null;
}

function maintainerLogins(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows
      // `npm view maintainers` yields either "login <email>" strings or objects.
      .map((row) => (typeof row === 'string' ? row.split('<')[0] : (row as { name?: string })?.name))
      .map((login) => String(login || '').trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function inspectPublishRegistryAuth(input: {
  packageName?: string | null;
  /** True only for a real upload; a dry run needs no credentials. */
  publishing?: boolean;
} = {}): PublishRegistryAuthReport {
  const base = {
    schema: 'sks.publish-registry-auth.v1' as const,
    registry: NPM_REGISTRY,
    package: input.packageName || null,
    npm_user: null,
    maintainers: [] as string[],
    blockers: [] as string[],
    operator_actions: [] as string[]
  };
  if (input.publishing === false) {
    return { ...base, ok: true, status: 'skipped_not_publishing' };
  }
  // CI publishes through OIDC trusted publishing, which has no `npm whoami`
  // identity; that path is validated by the release workflow instead.
  if (String(process.env.SKS_PUBLISH_AUTH_MODE || 'token').trim().toLowerCase() === 'trusted-publisher') {
    return { ...base, ok: true, status: 'skipped_trusted_publisher' };
  }
  if (process.env.SKS_SKIP_REGISTRY_NETWORK_CHECK === '1') {
    return { ...base, ok: true, status: 'skipped_offline' };
  }

  const whoami = runNpm(['whoami', '--registry', NPM_REGISTRY]);
  const user = whoami.status === 0 ? normalizeNpmUser(whoami.stdout) : null;
  if (!user) {
    return {
      ...base,
      ok: false,
      status: 'unauthenticated',
      blockers: ['npm_publish_auth_missing_or_expired'],
      operator_actions: [
        `Not authenticated to ${NPM_REGISTRY}. Run \`npm login --registry ${NPM_REGISTRY}\` and publish again.`,
        'npm answers an unauthorized publish with 404, not 401, so this would otherwise surface as '
        + '"404 Not Found - PUT" after the whole tarball had already been built.'
      ]
    };
  }

  const maintainers = input.packageName
    ? maintainerLogins(runNpm(['view', input.packageName, 'maintainers', '--json', '--registry', NPM_REGISTRY]).stdout || '')
    : [];
  if (maintainers.length > 0 && !maintainers.includes(user)) {
    return {
      ...base,
      ok: false,
      status: 'not_a_maintainer',
      npm_user: user,
      maintainers,
      blockers: ['npm_publish_user_is_not_a_maintainer'],
      operator_actions: [
        `Authenticated as \`${user}\`, who is not a maintainer of ${input.packageName} `
        + `(${maintainers.join(', ')}). Log in as a maintainer, or have an owner run `
        + `\`npm owner add ${user} ${input.packageName}\`.`
      ]
    };
  }

  return { ...base, ok: true, status: 'authenticated', npm_user: user, maintainers };
}

/**
 * True when this process is a real upload rather than `npm pack`, a dry run, or
 * an ordinary script invocation.
 */
export function isRealNpmPublish(env: NodeJS.ProcessEnv = process.env): boolean {
  if (String(env.npm_command || '').trim() !== 'publish') return false;
  return String(env.npm_config_dry_run || '').trim() !== 'true';
}
