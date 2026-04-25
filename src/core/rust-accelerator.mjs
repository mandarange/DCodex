import path from 'node:path';
import { exists, packageRoot, runProcess, which } from './fsx.mjs';

export async function findRustAccelerator() {
  const env = process.env.SKS_RS_BIN || process.env.DCODEX_RS_BIN;
  if (env && await exists(env)) return env;
  const global = await which(process.platform === 'win32' ? 'sks-rs.exe' : 'sks-rs');
  if (global) return global;
  const candidate = path.join(packageRoot(), 'crates', 'sks-core', 'target', 'release', process.platform === 'win32' ? 'sks-rs.exe' : 'sks-rs');
  if (await exists(candidate)) return candidate;
  return null;
}

export async function rustInfo() {
  const bin = await findRustAccelerator();
  if (!bin) return { available: false };
  const result = await runProcess(bin, ['--version'], { timeoutMs: 3000, maxOutputBytes: 20_000 });
  return { available: result.code === 0, bin, version: `${result.stdout}${result.stderr}`.trim() };
}
