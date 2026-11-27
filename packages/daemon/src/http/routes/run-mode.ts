import type { FastifyInstance } from 'fastify';

import type { RunMode } from '@hashrate-autopilot/shared';

import { braiinsCredentialManagement } from '../../config/env-overrides.js';
import type { HttpServerDeps } from '../server.js';
import type { UpdateRunModeBody } from '../types.js';

const VALID_MODES: ReadonlySet<RunMode> = new Set<RunMode>(['DRY_RUN', 'LIVE', 'PAUSED']);

export async function registerRunModeRoute(
  app: FastifyInstance,
  deps: Pick<
    HttpServerDeps,
    'braiinsClient' | 'bidEventsRepo' | 'runtimeRepo' | 'secretsRepo' | 'secretSource'
  >,
): Promise<void> {
  const management = braiinsCredentialManagement(deps.secretSource, process.env);
  app.post<{ Body: UpdateRunModeBody }>(
    '/api/run-mode',
    async (req, reply): Promise<{ run_mode: RunMode } | { error: string }> => {
      const candidate = req.body?.run_mode;
      if (!candidate || !VALID_MODES.has(candidate)) {
        reply.code(422);
        return { error: `run_mode must be one of ${[...VALID_MODES].join(', ')}` };
      }
      // #287: log the transition to bid_events so it shows on the
      // History page. Only when the mode actually changes - clicking
      // LIVE while already LIVE writes nothing.
      if (candidate === 'LIVE') {
        if (deps.braiinsClient.apiVersion === 'v2') {
          try {
            const accountId = await deps.braiinsClient.getAccountId!();
            await deps.secretsRepo.confirmLiveAccount(accountId);
          } catch {
            reply.code(409);
            return { error: 'The configured Braiins account must be verified before enabling LIVE.' };
          }
        } else if (
          management.editable &&
          (await deps.secretsRepo.getBraiinsSettings())?.braiins_api_version === 'v2'
        ) {
          reply.code(409);
          return { error: 'Restart the daemon to apply the Braiins API migration before enabling LIVE.' };
        }
      }
      const prior = (await deps.runtimeRepo.get())?.run_mode ?? null;
      await deps.runtimeRepo.patch({ run_mode: candidate });
      if (prior !== null && prior !== candidate) {
        await deps.bidEventsRepo.insert({
          occurred_at: Date.now(),
          source: 'OPERATOR',
          kind: 'MODE_CHANGE',
          braiins_order_id: null,
          old_price_sat: null,
          new_price_sat: null,
          speed_limit_ph: null,
          amount_sat: null,
          reason: `${prior} → ${candidate}`,
          overpay_sat_per_eh_day: null,
          max_overpay_vs_hashprice_sat_per_eh_day: null,
        });
      }
      return { run_mode: candidate };
    },
  );
}
