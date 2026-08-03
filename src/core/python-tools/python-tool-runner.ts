import { spawn } from 'node:child_process'
import path from 'node:path'
import { exists, nowIso, writeJsonAtomic } from '../fsx.js'

export const PYTHON_TOOL_RUNNER_SCHEMA = 'sks.python-tool-runner.v1'

export interface PythonToolProbe {
  schema: typeof PYTHON_TOOL_RUNNER_SCHEMA
  generated_at: string
  ok: boolean
  python_bin: string | null
  optional: true
  core_runtime_requires_python: false
  allowed_domains: string[]
  forbidden_runtime_paths: string[]
  blockers: string[]
}

export async function probePythonTools(root: string = process.cwd()): Promise<PythonToolProbe> {
  const pythonBin = await findPython()
  const pytoolsExists = await exists(path.join(root, 'pytools'))
  const blockers = pytoolsExists ? [] : ['pytools_directory_missing']
  return {
    schema: PYTHON_TOOL_RUNNER_SCHEMA,
    generated_at: nowIso(),
    ok: blockers.length === 0,
    python_bin: pythonBin,
    optional: true,
    core_runtime_requires_python: false,
    allowed_domains: ['log_analysis', 'jsonl_summarization', 'performance_report_aggregation', 'platform_diagnostics'],
    forbidden_runtime_paths: ['postinstall', 'publish', 'config_write', 'global_state_write'],
    blockers
  }
}

export async function writePythonToolProbe(root: string = process.cwd(), reportPath: string = path.join(root, '.sneakoscope', 'reports', 'python-tool-runner.json')) {
  const report = await probePythonTools(root)
  await writeJsonAtomic(reportPath, report)
  return { ...report, report_path: reportPath }
}

async function findPython() {
  for (const bin of ['python3', 'python']) {
    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn(bin, ['--version'], { stdio: 'ignore' })
      child.on('error', () => resolve(false))
      child.on('close', (code) => resolve(code === 0))
    })
    if (ok) return bin
  }
  return null
}
