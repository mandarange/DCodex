import type { DesktopBridgeStatus } from './types.js';
import { isDesktopBridgeStateFresh, readDesktopBridgeState } from './state.js';
import { safeBridgeErrorCode } from './security.js';

export type DesktopBridgeProcessProbe = (pid: number) => boolean;

export const desktopBridgeProcessExists: DesktopBridgeProcessProbe = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

export async function getDesktopBridgeStatus(input: {
  statePath: string;
  expectedConfigGeneration?: string;
  processExists?: DesktopBridgeProcessProbe;
}): Promise<DesktopBridgeStatus> {
  let state;
  try {
    state = await readDesktopBridgeState(input.statePath);
  } catch (error) {
    return { status: 'invalid', state: null, blocker: safeBridgeErrorCode(error) };
  }
  if (!state) return { status: 'missing', state: null };
  if (input.expectedConfigGeneration && state.config_generation !== input.expectedConfigGeneration) {
    return {
      status: 'configuration_mismatch',
      state,
      blocker: 'bridge_config_generation_mismatch',
    };
  }
  const processExists = input.processExists || desktopBridgeProcessExists;
  if (!processExists(state.pid)) {
    return { status: 'stale', state, blocker: 'bridge_process_not_running' };
  }
  if (!isDesktopBridgeStateFresh(state)) {
    return { status: 'stale', state, blocker: 'bridge_state_stale' };
  }
  return { status: 'running', state };
}
