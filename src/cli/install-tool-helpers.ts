import fsp from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { EMPTY_CODEX_INFO, getCodexInfo } from '../core/codex-adapter.js'
import { exists, globalSksRoot, PACKAGE_VERSION, runProcess, which } from '../core/fsx.js'
import { hasContext7ConfigText } from '../core/routes.js'
import { createRequestedScopeContract } from '../core/safety/requested-scope-contract.js'
import { guardedPackageInstall, guardContextForRoute } from '../core/safety/mutation-guard.js'

export async function ensureRelatedCliTools(args: any = []) {
  const skip = args.includes('--skip-cli-tools') || process.env.SKS_SKIP_CLI_TOOLS === '1'
  const codex = await ensureCodexCliTool({ skip, args })
  return { codex }
}

export async function ensureCodexCliTool({ skip = false, args = [] }: any = {}) {
  if (skip) return { status: 'skipped', reason: 'SKS_SKIP_CLI_TOOLS=1 or --skip-cli-tools' }
  const before = await getCodexInfo().catch(() => EMPTY_CODEX_INFO)
  if (before.bin) return { status: 'present', bin: before.bin, version: before.version || null }
  const npmBin = await which('npm')
  if (!npmBin) return { status: 'failed', error: 'npm not found on PATH; install Codex CLI manually with npm i -g @openai/codex@latest.' }
  const command = 'npm i -g @openai/codex@latest'
  if (args.includes('--dry-run')) return { status: 'dry_run', command, error: 'Codex CLI not found on PATH.' }
  if (!await confirmInstallYesDefault(`Codex CLI is missing. Install latest Codex CLI with ${command}?`, args)) {
    return { status: 'needs_approval', command, error: 'Codex CLI not found on PATH.' }
  }
  const installRoot = globalSksRoot()
  const installContract = createRequestedScopeContract({
    route: 'install', userRequest: command, projectRoot: installRoot, overrides: { package_install: true }
  })
  const install = await guardedPackageInstall(
    guardContextForRoute(installRoot, installContract, command),
    '@openai/codex@latest',
    { confirmed: true, command: npmBin, args: ['i', '-g', '@openai/codex@latest'], timeoutMs: 120000 }
  ).catch((err: any) => ({ code: 1, stdout: '', stderr: err.message }))
  if (install.code !== 0) return { status: 'failed', error: `${install.stderr || install.stdout || 'npm i -g @openai/codex@latest failed'}`.trim() }
  const after = await getCodexInfo().catch(() => EMPTY_CODEX_INFO)
  return {
    status: after.bin ? 'installed' : 'installed_not_on_path',
    bin: after.bin || null,
    version: after.version || null,
    hint: after.bin ? null : 'npm completed, but codex is not on PATH. Restart the shell or set SKS_CODEX_BIN.'
  }
}

export async function maybePromptCodexUpdateForLaunch(args: any = [], opts: any = {}) {
  if (hasFlag(args, '--json') || hasFlag(args, '--skip-cli-tools') || hasFlag(args, '--skip-codex-update') || process.env.SKS_SKIP_CODEX_UPDATE === '1') return { status: 'skipped' }
  const latest = await npmPackageVersion('@openai/codex')
  const codex = await getCodexInfo().catch(() => EMPTY_CODEX_INFO)
  const current = codexCliVersionNumber(codex.version)
  const command = 'npm i -g @openai/codex@latest'
  const label = opts.label || 'Codex launch'
  const missing = !codex.bin
  const updateAvailable = Boolean(latest.version && current && compareVersions(latest.version, current) > 0)
  if (!missing && !updateAvailable) return { status: 'current', latest: latest.version || null, current, bin: codex.bin || null, error: latest.error || null }
  const prompt = missing
    ? `Codex CLI missing. Install @openai/codex${latest.version ? ` ${latest.version}` : '@latest'} before ${label}? [Y/n] `
    : `Codex CLI ${current} -> ${latest.version} update before ${label}? [Y/n] `
  if (shouldAutoApproveInstall(args)) return installCodexLatest(command, latest.version, current)
  if (!canAskYesNo()) {
    const reason = missing ? 'Codex CLI missing' : `Codex CLI update available: ${current} -> ${latest.version}`
    console.log(`${reason}. Run: ${command}`)
    return { status: missing ? 'missing' : 'available', latest: latest.version || null, current, command, bin: codex.bin || null }
  }
  const answer = (await askQuestion(prompt)).trim()
  if (!(answer === '' || /^(y|yes|예|네|응)$/i.test(answer))) return { status: 'skipped_by_user', latest: latest.version || null, current, command, bin: codex.bin || null }
  return installCodexLatest(command, latest.version, current)
}

export async function maybePromptSksUpdateForLaunch(args: any = [], opts: any = {}) {
  void args
  void opts
  return { status: 'skipped', reason: 'manual_update_commands_only', current: PACKAGE_VERSION, latest: null, command: null }
}

export function shouldAutoApproveInstall(args: any = [], env: any = process.env) {
  if (hasFlag(args, '--from-postinstall') && env.SKS_POSTINSTALL_AUTO_INSTALL_CLI_TOOLS !== '1') return false
  if (hasFlag(args, '--from-postinstall') && env.SKS_POSTINSTALL_AUTO_INSTALL_CLI_TOOLS === '1') return true
  return hasFlag(args, '--yes') || hasFlag(args, '-y') || isAgentRuntime(env)
}

export function canAskYesNo() {
  return Boolean(input.isTTY && output.isTTY && process.env.CI !== 'true')
}

export function compareVersions(a: any, b: any) {
  const pa = String(a || '').split(/[.-]/).map((value) => Number.parseInt(value, 10) || 0)
  const pb = String(b || '').split(/[.-]/).map((value) => Number.parseInt(value, 10) || 0)
  for (let index = 0; index < Math.max(pa.length, pb.length, 3); index += 1) {
    if ((pa[index] || 0) > (pb[index] || 0)) return 1
    if ((pa[index] || 0) < (pb[index] || 0)) return -1
  }
  return 0
}

export async function isProjectSetupCandidate(root: any) {
  for (const marker of ['package.json', '.git', 'AGENTS.md', '.codex', '.sneakoscope']) {
    if (await exists(path.join(root, marker))) return true
  }
  return false
}

export function hasTopLevelCodexModeLock(text: any = '') {
  const lines = String(text || '').split('\n')
  const firstTable = lines.findIndex((line) => /^\s*\[.+\]\s*$/.test(line))
  const top = (firstTable === -1 ? lines : lines.slice(0, firstTable)).join('\n')
  return /(^|\n)\s*model_reasoning_effort\s*=/.test(top)
}

export function hasDeprecatedCodexHooksFeatureFlag(text: any = '') {
  const lines = String(text || '').split('\n')
  const start = lines.findIndex((line) => line.trim() === '[features]')
  if (start === -1) return false
  const end = lines.findIndex((line, index) => index > start && /^\s*\[.+\]\s*$/.test(line))
  return lines.slice(start + 1, end === -1 ? lines.length : end).some((line) => /^\s*codex_hooks\s*=/.test(line))
}

export function hasCodexUnstableFeatureWarningSuppression(text: any = '') {
  return /(^|\n)\s*suppress_unstable_features_warning\s*=\s*true\s*(?:#.*)?(?=\n|$)/.test(String(text || ''))
}

export async function checkContext7(root: any) {
  const projectPath = path.join(root, '.codex', 'config.toml')
  const globalPath = path.join(process.env.HOME || '', '.codex', 'config.toml')
  const [projectText, globalText] = await Promise.all([safeReadText(projectPath), safeReadText(globalPath)])
  const codex = await getCodexInfo().catch(() => EMPTY_CODEX_INFO)
  let list = { checked: false, ok: false, stdout: '', stderr: '' }
  if (codex.bin) {
    const out = await runProcess(codex.bin, ['mcp', 'list'], { timeoutMs: 8000, maxOutputBytes: 32 * 1024 }).catch((err: any) => ({ code: 1, stderr: err.message, stdout: '' }))
    list = { checked: true, ok: out.code === 0 && /context7/i.test(`${out.stdout}\n${out.stderr}`), stdout: out.stdout || '', stderr: out.stderr || '' }
  }
  const result = {
    ok: false,
    project: { path: projectPath, ok: hasContext7ConfigText(projectText) },
    global: { path: globalPath, ok: hasContext7ConfigText(globalText) },
    codex_mcp_list: list
  }
  result.ok = result.project.ok || result.codex_mcp_list.ok || (result.global.ok && !list.checked)
  return result
}

async function confirmInstallYesDefault(question: any, args: any = []) {
  if (hasFlag(args, '--from-postinstall') && process.env.SKS_POSTINSTALL_AUTO_INSTALL_CLI_TOOLS !== '1') return false
  if (shouldAutoApproveInstall(args)) return true
  if (!canAskYesNo()) return false
  const answer = (await askQuestion(`${question} [Y/n] `)).trim()
  return answer === '' || /^(y|yes|예|네|응)$/i.test(answer)
}

async function askQuestion(question: string) {
  const rl = readline.createInterface({ input, output })
  try {
    return await rl.question(question)
  } finally {
    rl.close()
  }
}

function hasFlag(args: any[] = [], name: string) {
  return args.includes(name)
}

function isAgentRuntime(env: any = process.env) {
  return ['SKS_OPENCLAW', 'OPENCLAW', 'OPENCLAW_AGENT', 'OPENCLAW_RUN_ID', 'OPENCLAW_SESSION_ID', 'SKS_HERMES', 'HERMES_AGENT', 'HERMES_RUN_ID', 'HERMES_SESSION_ID']
    .some((key) => /^(1|true|yes|y)$/i.test(String(env[key] || '').trim()))
}

async function installCodexLatest(command: any, latestVersion: any, previousVersion: any = null) {
  const npm = await which('npm').catch(() => null)
  if (!npm) return { status: 'failed', latest: latestVersion || null, previous: previousVersion || null, command, error: 'npm not found on PATH' }
  const install = await runProcess(npm, ['i', '-g', '@openai/codex@latest'], { timeoutMs: 180000, maxOutputBytes: 128 * 1024 }).catch((err: any) => ({ code: 1, stdout: '', stderr: err.message }))
  if (install.code !== 0) return { status: 'failed', latest: latestVersion || null, previous: previousVersion || null, command, error: `${install.stderr || install.stdout || command + ' failed'}`.trim() }
  const after = await getCodexInfo().catch(() => EMPTY_CODEX_INFO)
  const afterVersion = codexCliVersionNumber(after.version)
  if (!after.bin) return { status: 'updated_not_reflected', latest: latestVersion || null, previous: previousVersion || null, version: afterVersion || null, command, error: 'npm completed, but codex is not on PATH. Restart the shell or set SKS_CODEX_BIN.' }
  if (latestVersion && afterVersion && compareVersions(afterVersion, latestVersion) < 0) {
    return { status: 'updated_not_reflected', latest: latestVersion, previous: previousVersion || null, version: afterVersion, bin: after.bin, command, error: `npm completed, but PATH still resolves Codex CLI ${afterVersion}; expected ${latestVersion}.` }
  }
  console.log(`Codex CLI ready: ${previousVersion || 'missing'} -> ${after.version || after.bin}`)
  return { status: previousVersion ? 'updated' : 'installed', latest: latestVersion || null, previous: previousVersion || null, version: afterVersion || null, raw_version: after.version || null, bin: after.bin || null, command }
}

function codexCliVersionNumber(versionText: any = '') {
  return String(versionText || '').match(/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/)?.[1] || null
}

async function npmPackageVersion(name: any) {
  const envName = `SKS_NPM_VIEW_${String(name || '').replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}_VERSION`
  if (process.env[envName]) return { version: process.env[envName] }
  const npm = await which('npm').catch(() => null)
  if (!npm) return { error: 'npm not found' }
  const result = await runProcess(npm, ['view', name, 'version'], { timeoutMs: 5000, maxOutputBytes: 4096 })
  if (result.code !== 0) return { error: `${result.stderr || result.stdout || 'npm view failed'}`.trim() }
  return { version: result.stdout.trim().split(/\s+/).pop() }
}

async function safeReadText(file: string) {
  try {
    return await fsp.readFile(file, 'utf8')
  } catch {
    return ''
  }
}
