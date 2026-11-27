import type { AppConfig } from './schema.js';
import type { RuntimeStateRepo } from '../state/repos/runtime_state.js';

export async function applyBootMode(
  runtime: RuntimeStateRepo,
  preference: AppConfig['boot_mode'],
  requireDryRun: boolean,
) {
  const priorMode = (await runtime.get())?.run_mode ?? 'DRY_RUN';
  // PAUSED is a reactive state. LAST_MODE only restores an explicit LIVE choice.
  const restoreLive =
    preference === 'ALWAYS_LIVE' || (preference === 'LAST_MODE' && priorMode === 'LIVE');
  const bootMode = restoreLive && !requireDryRun ? 'LIVE' : 'DRY_RUN';
  await runtime.patch({ run_mode: bootMode });
  return { priorMode, bootMode };
}
