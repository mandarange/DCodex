import path from 'node:path';
import { exists, PACKAGE_VERSION, packageRoot, readText, runProcess, which } from './fsx.js';
import { sha256File } from './wiki-image/image-hash.js';
import { validateImageVoxelLedger } from './wiki-image/validation.js';
import { readImageVoxelLedger } from './wiki-image/image-voxel-ledger.js';

export const RUST_ACCELERATOR_CAPABILITIES = Object.freeze([
  'compact-info',
  'jsonl-tail',
  'secret-scan',
  'evidence-secret-scan',
  'image-hash',
  'image-voxel-index',
  'voxel-validate',
  'image-voxel-validate-fast',
  'search-files',
  'search-text',
  'search-batch'
]);

export function rustBuildHint() {
  return 'cargo build --release --manifest-path crates/sks-core/Cargo.toml';
}

export async function findRustAccelerator() {
  const env = process.env.SKS_RS_BIN || process.env.DCODEX_RS_BIN;
  if (env) return await exists(env) ? env : null;
  const global = await which(process.platform === 'win32' ? 'sks-rs.exe' : 'sks-rs');
  if (global) return global;
  const binName = process.platform === 'win32' ? 'sks-rs.exe' : 'sks-rs';
  const candidate = path.join(packageRoot(), 'crates', 'sks-core', 'target', 'release', binName);
  if (await exists(candidate)) return candidate;
  const cargoTarget = process.env.CARGO_TARGET_DIR;
  if (cargoTarget) {
    const redirected = path.join(cargoTarget, 'release', binName);
    if (await exists(redirected)) return redirected;
  }
  return null;
}

export async function runRustOrFallback(command: any, args: any = [], fallbackFn: any = async () => null) {
  const probe = await rustAcceleratorProbe();
  if (!probe.bin) return normalizeAcceleratorResult(command, { engine: 'js', available: false, result: await fallbackFn() });
  if (!probe.compatible) {
    return normalizeAcceleratorResult(command, {
      engine: 'js',
      available: false,
      rust_error: { kind: 'version_mismatch', command, message: `native ${probe.version || 'unknown'} does not match package ${PACKAGE_VERSION}` },
      result: await fallbackFn()
    });
  }
  const bin = probe.bin;
  const result = await runProcess(bin, [command, ...args], { timeoutMs: 10000, maxOutputBytes: 1024 * 1024 }).catch((err: any) => ({ code: 1, stdout: '', stderr: err.message }));
  if (result.code !== 0) return normalizeAcceleratorResult(command, { engine: 'js', available: true, rust_error: classifyRustError(command, result.stderr || result.stdout), result: await fallbackFn() });
  return normalizeAcceleratorResult(command, { engine: 'rust', available: true, stdout: result.stdout.trim(), result: parseRustJson(result.stdout) });
}

export async function rustImageHash(file: any) {
  return runRustOrFallback('image-hash', [file], async () => ({ ok: true, engine: 'js', path: file, sha256: await sha256File(file) }));
}

export async function rustVoxelValidate(file: any, opts: any = {}) {
  const args = [file, ...(opts.requireAnchors ? ['--require-anchors'] : []), ...(opts.requireRelations ? ['--require-relations'] : [])];
  return runRustOrFallback('voxel-validate', args, async () => {
    const validation = validateImageVoxelLedger(await readImageVoxelLedger(packageRoot(), file), {
      requireAnchors: opts.requireAnchors,
      requireRelations: opts.requireRelations,
      route: opts.route
    });
    return { ok: validation.ok, engine: 'js', schema: 'sks.image-voxel-ledger.v1', images: validation.summary.images, anchors: validation.summary.anchors, issues: validation.issues };
  });
}

export async function rustSecretScan(file: any) {
  return runRustOrFallback('secret-scan', [file], async () => {
    const text = await readText(file, '');
    return { ok: !/(CODEX_ACCESS_TOKEN|OPENAI_API_KEY|CODEX_LB_API_KEY|sk-proj-|sk-clb-|github_pat_)/.test(text) };
  });
}

export async function rustInfo(): Promise<any> {
  const probe = await rustAcceleratorProbe();
  const sourceIncluded = await exists(path.join(packageRoot(), 'crates', 'sks-core', 'Cargo.toml'));
  const base = {
    schema: 'sks.rust-accelerator-status.v1',
    capabilities: [...RUST_ACCELERATOR_CAPABILITIES],
    packaging: 'source_checkout_or_optional_path',
    source_included: sourceIncluded,
    prebuilt_available: false,
    build_hint: rustBuildHint(),
    fallback: 'dependency-free Node.js implementations remain active when Rust is missing'
  };
  if (!probe.bin) {
    return {
      ...base,
      available: false,
      mode: 'js_fallback',
      status: 'optional_missing',
      note: 'Rust accelerator is optional; SKS continues through JS fallback paths until SKS_RS_BIN or a local source build is available.'
    };
  }
  return {
    ...base,
    available: probe.compatible,
    mode: probe.compatible ? 'rust_accelerated' : 'js_fallback',
    status: probe.compatible ? 'available' : (probe.version_mismatch ? 'version_mismatch' : 'optional_error'),
    bin: probe.bin,
    version: probe.version,
    expected_version: `sks-rs ${PACKAGE_VERSION}`,
    error: probe.compatible ? null : (probe.version_mismatch ? `native ${probe.version || 'unknown'} does not match package ${PACKAGE_VERSION}` : probe.error)
  };
}

async function rustAcceleratorProbe() {
  const bin = await findRustAccelerator();
  if (!bin) return { bin: null, compatible: false };
  const result = await runProcess(bin, ['--version'], { timeoutMs: 5000, maxOutputBytes: 20_000 }).catch((err: any) => ({ code: 1, stdout: '', stderr: err.message }));
  const version = `${result.stdout || ''}${result.stderr || ''}`.trim();
  const compatible = result.code === 0 && version === `sks-rs ${PACKAGE_VERSION}`;
  return {
    bin,
    version,
    compatible,
    version_mismatch: result.code === 0 && !compatible,
    error: result.code === 0 ? null : version
  };
}

function parseRustJson(text: any = '') {
  try { return JSON.parse(text); } catch { return text.trim(); }
}

function classifyRustError(command: any, text: any = '') {
  const s = String(text || '');
  if (/unknown|Commands:|optional accelerator/i.test(s)) return { kind: 'command_missing', command, message: s };
  return { kind: 'runtime_error', command, message: s };
}

function normalizeAcceleratorResult(command: any, value: any) {
  const result = value.result && typeof value.result === 'object' ? value.result : { ok: false, value: value.result };
  return {
    command,
    engine: value.engine,
    available: Boolean(value.available),
    rust_error: value.rust_error || null,
    stdout: value.stdout || null,
    result
  };
}
