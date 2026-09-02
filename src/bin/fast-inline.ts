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

/**
 * The one Desktop Bridge fact the fast path can afford: whether the serving
 * process's own log shows it dialing an unreachable upstream. State file plus
 * a bounded log tail — no launchctl, no probes, no secret stores — so SKS
 * Center's Diagnostics view (which calls exactly `doctor --json`) stops
 * reporting a bridge that rejects every request as merely "not checked".
 * The fast contract (`ok: true`, `fast_readonly_ok`) is untouched: evidence
 * lands in `desktop_bridge` and `warnings`, where the full doctor turns the
 * same evidence into a blocker.
 */
async function fastDesktopBridgeUpstreamEvidence(home: string): Promise<{
  section: Record<string, unknown>; warnings: string[]; nextActions: string[];
}> {
  const notChecked = (reason: string) => ({
    section: { schema: 'sks.desktop-bridge-fast-status.v1', status: 'not_checked', reason, secret_stores_read: false },
    warnings: [] as string[], nextActions: [] as string[],
  });
  try {
    const getBuiltinModule = (process as unknown as { getBuiltinModule?: (name: string) => any }).getBuiltinModule;
    const fs = typeof getBuiltinModule === 'function' ? getBuiltinModule('node:fs') : await import('node:fs');
    const runtime = joinPath(joinPath(home, '.codex'), 'sks');
    const statePath = joinPath(runtime, 'desktop-bridge-state.json');
    if (!fs.existsSync(statePath)) return notChecked('bridge_state_missing');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { pid?: unknown; started_at?: unknown };
    const startedAt = typeof state.started_at === 'string' ? state.started_at : null;
    const logPath = joinPath(joinPath(runtime, 'logs'), 'desktop-bridge.out.log');
    const { BRIDGE_LOG_TAIL_BYTES, UNREACHABLE_UPSTREAM_RECOVERY_ACTION, detectUnreachableUpstreamEvidence } =
      await import('../core/codex-lb/desktop-bridge/upstream-evidence.js');
    let tail = '';
    if (fs.existsSync(logPath)) {
      const handle = fs.openSync(logPath, 'r');
      try {
        const size = fs.fstatSync(handle).size;
        const start = Math.max(0, size - BRIDGE_LOG_TAIL_BYTES);
        const buffer = Buffer.alloc(size - start);
        fs.readSync(handle, buffer, 0, buffer.length, start);
        tail = buffer.toString('utf8');
      } finally { fs.closeSync(handle); }
    }
    const code = detectUnreachableUpstreamEvidence(tail, startedAt, Date.now());
    const blockers = code ? [`desktop_bridge_upstream_unreachable:${code}`] : [];
    return {
      section: {
        schema: 'sks.desktop-bridge-fast-status.v1',
        status: code ? 'upstream_unreachable_evidence' : 'log_evidence_clear',
        reason: 'fast_readonly_json_log_evidence',
        secret_stores_read: false,
        serving_pid: typeof state.pid === 'number' ? state.pid : null,
        started_at: startedAt,
        blockers,
        recovery_actions: code ? [UNREACHABLE_UPSTREAM_RECOVERY_ACTION] : [],
      },
      warnings: blockers,
      nextActions: code ? [UNREACHABLE_UPSTREAM_RECOVERY_ACTION] : [],
    };
  } catch {
    return notChecked('evidence_read_failed');
  }
}

export async function doctorJsonFastInline(input: {
  write?: (text: string) => void
  home?: string
  processEnv?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
} = {}): Promise<void> {
  const startedAt = Date.now();
  const write = input.write || ((text: string) => process.stdout.write(text))
  const env = input.processEnv || process.env;
  const home = input.home || env.HOME || env.USERPROFILE || process.cwd();
  const bridge = await fastDesktopBridgeUpstreamEvidence(home);
  write(`${JSON.stringify({
    schema: 'sks.doctor-status.v3',
    elapsed_ms: Math.max(0, Date.now() - startedAt),
    ok: true,
    status: 'fast_readonly_ok',
    diagnostic_depth: 'fast',
    deep_diagnostics_skipped: true,
    deep_ok: null,
    not_counted_as_full_doctor: true,
    next_actions: ['Run sks doctor --full --json for deep diagnostics.', ...bridge.nextActions],
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
    warnings: ['fast_readonly_doctor_skipped_optional_deep_diagnostics', ...bridge.warnings],
    desktop_bridge: bridge.section
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
  // Same judgment as core/fsx findProjectRoot: markers sitting directly in the
  // home directory are global state (`~/.sneakoscope` IS the global root this
  // very file reports), never a project. Skipping home keeps `sks root` from
  // claiming the home directory as a project on every machine with menubar
  // assets or an update cache in `~/.sneakoscope`.
  const home = process.env.HOME || process.env.USERPROFILE || null;
  const homeDir = home ? stripTrailingSlash(home) : null;
  let dir = normalizeStart(start);
  for (;;) {
    if (dir !== homeDir) {
      if (fs.existsSync(joinPath(dir, '.sneakoscope'))) return dir;
      if (fs.existsSync(joinPath(dir, 'AGENTS.md')) && fs.existsSync(joinPath(dir, 'package.json'))) return dir;
    }
    const parent = parentDir(dir);
    if (parent === dir) return null;
    dir = parent;
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
