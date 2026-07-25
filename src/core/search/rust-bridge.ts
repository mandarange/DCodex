import { findRustAccelerator, rustInfo } from '../rust-accelerator.js';
import { PACKAGE_VERSION, runProcess } from '../fsx.js';

export { findRustAccelerator };

export async function rustAcceleratorProbeForSearch(): Promise<{
  bin: string | null;
  compatible: boolean;
  version: string | null;
}> {
  const bin = await findRustAccelerator();
  if (!bin) return { bin: null, compatible: false, version: null };
  const result = await runProcess(bin, ['--version'], { timeoutMs: 5000, maxOutputBytes: 20_000 }).catch(
    (err: Error) => ({ code: 1, stdout: '', stderr: err.message })
  );
  const version = `${result.stdout || ''}${result.stderr || ''}`.trim();
  const compatible = result.code === 0 && version === `sks-rs ${PACKAGE_VERSION}`;
  return { bin, compatible, version };
}

export async function rustSupportsSearchCommand(): Promise<boolean> {
  const probe = await rustAcceleratorProbeForSearch();
  if (!probe.bin || !probe.compatible) return false;
  const help = await runProcess(probe.bin, ['search', '--help'], { timeoutMs: 5000, maxOutputBytes: 20_000 }).catch(
    () => ({ code: 1, stdout: '', stderr: '' })
  );
  const text = `${help.stdout || ''}${help.stderr || ''}`;
  // Unknown command exits 2 with accelerator help; search help mentions files/text/batch.
  return help.code === 0 || /search files|search text|search batch/i.test(text);
}

export async function rustSearchInfoNote(): Promise<string> {
  const info = await rustInfo();
  return info.mode === 'rust_accelerated' ? 'rust_accelerated' : 'js_fallback';
}
