type FastInlineFs = {
  existsSync(path: string): boolean
  readFileSync(path: string, encoding: BufferEncoding): string
}

export function rootJsonFastInline(fs: { existsSync(path: string): boolean }, cwd = process.cwd()): void {
  const project = findProjectRootSync(fs, cwd);
  const global = joinPath(process.env.HOME || process.env.USERPROFILE || cwd, '.sneakoscope');
  const active = project || global;
  process.stdout.write(`${JSON.stringify({
    cwd,
    mode: project ? 'project' : 'global',
    active_root: active,
    project_root: project,
    global_root: global,
    using_global_root: !project
  })}\n`);
}

export async function doctorJsonFastInline(input: {
  write?: (text: string) => void
  home?: string
  processEnv?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
} = {}): Promise<void> {
  const startedAt = Date.now();
  const secretResolution = await inspectCodexLbSecretResolutionFastInline(input)
  const write = input.write || ((text: string) => process.stdout.write(text))
  write(`${JSON.stringify({
    schema: 'sks.doctor-status.v3',
    elapsed_ms: Math.max(0, Date.now() - startedAt),
    ok: true,
    status: 'fast_readonly_ok',
    diagnostic_depth: 'fast',
    deep_diagnostics_skipped: true,
    deep_ok: null,
    not_counted_as_full_doctor: true,
    next_actions: ['Run sks doctor --full --json for deep diagnostics.'],
    fast_path: true,
    profile: 'fast-readonly',
    root: process.cwd(),
    arg_warnings: [],
    node: { ok: true, version: process.version },
    runtime_readiness: {
      hook_evidence_policy: 'unknown-do-not-count',
      agent_role_strategy: 'message-role'
    },
    codex: { bin: null, version: null, available: null, skipped: true, reason: 'fast_readonly_json' },
    repair: {
      setup: null,
      sks_temp_sweep: { ok: true, skipped: true, reason: 'doctor_without_fix', actions: [] }
    },
    doctor_fix_transaction: null,
    blockers: [],
    warnings: ['fast_readonly_doctor_skipped_optional_deep_diagnostics'],
    codex_lb: {
      secret_resolution: secretResolution
    }
  }, null, 2)}\n`);
}

export async function narutoHelpJsonFastInline(): Promise<void> {
  const { buildNarutoHelpResult } = await import('../core/subagents/naruto-help-contract.js');
  process.stdout.write(`${JSON.stringify(buildNarutoHelpResult(), null, 2)}\n`);
}

export async function hookUserPromptSubmitPerfInline(): Promise<void> {
  const raw = await readStdinInline();
  let payload: any = {};
  try { payload = raw.trim() ? JSON.parse(raw) : {}; } catch { payload = { raw }; }
  const cwd = String(payload.cwd || process.cwd());
  const root = findProjectRootSync(fsInline(), cwd) || cwd;
  const state = readJsonSyncInline(joinPath(joinPath(root, '.sneakoscope'), 'state/current.json')) || {};
  const prompt = String(payload.prompt || payload.user_prompt || payload.message || payload.raw || '');
  const noQuestion = (state.mode === 'RESEARCH' && state.phase === 'RESEARCH_RUNNING_NO_QUESTIONS')
    || (state.mode === 'QALOOP' && state.phase === 'QALOOP_RUNNING_NO_QUESTIONS');
  if (noQuestion) {
    process.stdout.write(`${JSON.stringify({
      decision: 'block',
      reason: 'SKS no-question/no-interruption mode is active. User prompt has been queued until the run completes.'
    })}\n`);
    return;
  }
  const route = /\$(?:sks-)?Super-Search|\bsuper-search\b|site:(?:x|twitter)\.com/i.test(prompt)
    ? '$sks-super-search'
    : /\b(?:fix|failing|failing tests|고쳐|수정|깨져)\b/i.test(prompt)
      ? '$sks-naruto'
      : '$sks-answer';
  const contexts = [
    'SKS hook perf inline path active for bounded latency measurement.',
    `Route: ${route}`,
    state.mission_id ? `Active mission: ${state.mission_id}` : ''
  ].filter(Boolean);
  process.stdout.write(`${JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: contexts.join('\n')
    },
    systemMessage: `SKS: ${route} perf fast path.`
  })}\n`);
}

function findProjectRootSync(fs: { existsSync(path: string): boolean }, start: string): string | null {
  let dir = normalizeStart(start);
  for (;;) {
    if (fs.existsSync(joinPath(dir, '.sneakoscope'))) return dir;
    if (fs.existsSync(joinPath(dir, 'AGENTS.md')) && fs.existsSync(joinPath(dir, 'package.json'))) return dir;
    const parent = parentDir(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function inspectCodexLbSecretResolutionFastInline(input: {
  home?: string
  processEnv?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}): Promise<{
  source: 'env-file' | 'process.env' | 'missing'
  path: string | null
  prompt_risk: 'none' | 'unknown_keychain_not_probed'
}> {
  const processEnv = input.processEnv || process.env
  const home = input.home || processEnv.HOME || processEnv.USERPROFILE || process.cwd()
  const codexHome = joinPath(home, '.codex')
  const envPath = joinPath(codexHome, 'sks-codex-lb.env')
  const metadataPath = joinPath(codexHome, 'sks-codex-lb.json')
  const [{ inspectConfinedPath }, { readPrivateCredentialFile }] = await Promise.all([
    import('../core/managed-path-safety.js'),
    import('../core/security/private-credential-file.js')
  ])
  let envFilePresent = false
  let envFilePrivate = false
  try {
    const inspected = await inspectConfinedPath(codexHome, envPath)
    envFilePresent = inspected.exists
    const expectedUid = typeof process.getuid === 'function' ? process.getuid() : null
    envFilePrivate = inspected.exists
      && !inspected.leafSymlink
      && inspected.stat?.isFile() === true
      && (inspected.stat.mode & 0o777) === 0o600
      && (expectedUid === null || inspected.stat.uid === expectedUid)
  } catch {
    envFilePresent = false
  }
  let metadataValid = false
  if (envFilePrivate) {
    try {
      const snapshot = await readPrivateCredentialFile(
        codexHome,
        metadataPath,
        'codex_lb_metadata',
        { maxBytes: 64 * 1024 }
      )
      const metadata = JSON.parse(snapshot.bytes.toString('utf8'))
      metadataValid = metadata?.schema === 'sks.codex-lb-metadata.v1'
        && /^[a-f0-9]{64}$/.test(String(metadata?.api_key?.sha256 || '').trim().toLowerCase())
        && Boolean(String(metadata?.base_url || '').trim())
    } catch {
      metadataValid = false
    }
  }
  const processKeyPresent = Boolean(String(processEnv.CODEX_LB_API_KEY || '').trim())
  const source = envFilePrivate && metadataValid ? 'env-file' : processKeyPresent ? 'process.env' : 'missing'
  return {
    source,
    path: source === 'env-file' || envFilePresent ? envPath : null,
    prompt_risk: (input.platform || process.platform) === 'darwin'
      ? 'unknown_keychain_not_probed'
      : 'none'
  }
}

function fsInline(): FastInlineFs {
  return (process as unknown as { getBuiltinModule?: (name: string) => any }).getBuiltinModule?.('node:fs') || require('node:fs');
}

function readJsonSyncInline(file: string, fs: FastInlineFs = fsInline()): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readStdinInline(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

function normalizeStart(start: string): string {
  const value = stripTrailingSlash(start || process.cwd());
  if (value.startsWith('/')) return value || '/';
  return joinPath(process.cwd(), value);
}

function joinPath(left: string, right: string): string {
  const base = stripTrailingSlash(left || '/');
  return `${base === '/' ? '' : base}/${right}`;
}

function parentDir(value: string): string {
  const dir = stripTrailingSlash(value);
  if (dir === '/') return dir;
  const index = dir.lastIndexOf('/');
  return index <= 0 ? '/' : dir.slice(0, index);
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '') || '/';
}
