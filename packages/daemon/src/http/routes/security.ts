/**
 * #332: in-app credential rotation for DB/wizard installs (Umbrel), where
 * there's no shell or SOPS to change the wizard-only secrets.
 *
 * - GET  /api/security/state          -> { secret_source, editable }
 * - POST /api/security/password        -> change the dashboard password (live)
 * - POST /api/security/braiins-token   -> rotate owner/read-only token (restart to apply)
 *
 * Every mutation requires the current dashboard password. Edits are
 * refused unless secrets are DB-sourced (env/SOPS would silently win on
 * next boot). New Braiins tokens are validated against Braiins before
 * they're committed, so a typo can't quietly disable order authorization.
 */

import type { FastifyInstance } from 'fastify';

import { createBraiinsClient } from '@hashrate-autopilot/braiins-client';

import { type V1MigrationGuard, verifyV2Credentials } from '../../config/braiins.js';
import { hasBraiinsCredentialOverrides } from '../../config/env-overrides.js';
import { verifyPassword } from '../../config/password-hash.js';
import type { SecretsRepo } from '../../state/repos/secrets.js';

export interface SecurityRouteDeps {
  readonly secretsRepo: SecretsRepo;
  /** Where the running secrets came from - editing only makes sense for 'db'. */
  readonly braiinsVersion?: 'v1' | 'v2';
  readonly v1MigrationGuard?: V1MigrationGuard;
  readonly secretSource: 'env' | 'sops' | 'db';
  /** Current stored dashboard password (hash or plaintext) for verification. */
  readonly getCurrentPassword: () => string;
  /** Hot-apply a new dashboard password to the live auth verifier + clear its cache. */
  readonly setDashboardPassword: (hashedOrPlain: string) => void;
  readonly log?: (msg: string) => void;
}

const MIN_PASSWORD_LEN = 8;

class CandidateKeyError extends Error {}

export async function registerSecurityRoutes(
  app: FastifyInstance,
  deps: SecurityRouteDeps,
): Promise<void> {
  const editable = deps.secretSource === 'db';

  const braiinsEditable = editable && !hasBraiinsCredentialOverrides(process.env);
  app.get('/api/security/state', async () => {
    const saved = editable ? await deps.secretsRepo.getBraiinsSettings() : undefined;
    return {
      secret_source: deps.secretSource,
      editable,
      braiins_editable: braiinsEditable,
      braiins_active_api_version: deps.braiinsVersion ?? 'v1',
      braiins_api_version: saved?.braiins_api_version ?? deps.braiinsVersion ?? 'v1',
      braiins_account_id: saved?.braiins_account_id ?? null,
    };
  });

  app.post<{ Body: { current_password?: string; new_password?: string } }>(
    '/api/security/password',
    async (req, reply) => {
      if (!editable) {
        reply.code(409);
        return { error: 'managed_externally', secret_source: deps.secretSource };
      }
      const { current_password = '', new_password = '' } = req.body ?? {};
      if (!verifyPassword(current_password, deps.getCurrentPassword())) {
        reply.code(403);
        return { error: 'current password is incorrect' };
      }
      if (new_password.length < MIN_PASSWORD_LEN) {
        reply.code(422);
        return { error: `new password must be at least ${MIN_PASSWORD_LEN} characters` };
      }
      const hash = await deps.secretsRepo.setDashboardPassword(new_password);
      if (!hash) {
        reply.code(409);
        return { error: 'no stored secrets to update' };
      }
      // Hot-apply: point the live verifier at the same hash we just
      // stored. The new password works on the next request; the old one
      // stops immediately (which also boots anyone still using it).
      deps.setDashboardPassword(hash);
      deps.log?.('[security] dashboard password changed');
      return { ok: true };
    },
  );

  app.post<{
    Body: { kind?: 'owner' | 'read_only' | 'v2'; current_password?: string; token?: string; account_id?: string };
  }>('/api/security/braiins-token', async (req, reply) => {
    if (!braiinsEditable) {
      reply.code(409);
      return { error: 'managed_externally', secret_source: deps.secretSource };
    }
    const { kind = 'owner', current_password = '', token = '', account_id = '' } = req.body ?? {};
    if (kind !== 'owner' && kind !== 'read_only' && kind !== 'v2') {
      reply.code(422);
      return { error: 'Unknown Braiins credential type' };
    }
    if (!verifyPassword(current_password, deps.getCurrentPassword())) {
      reply.code(403);
      return { error: 'current password is incorrect' };
    }
    if (typeof token !== 'string' || token.trim().length === 0) {
      reply.code(422);
      return { error: 'token is required' };
    }
    if (kind === 'v2') {
      if (typeof account_id !== 'string' || !account_id.trim()) {
        return reply.code(422).send({ error: 'Enter the account ID shown in Braiins ID.' });
      }
      const verifyAndSave = async () => {
        let actual: string;
        try {
          actual = await verifyV2Credentials(deps.secretsRepo, {
            apiVersion: 'v2', apiKey: token.trim(), accountId: account_id.trim(),
          });
        } catch {
          throw new CandidateKeyError('Could not verify the API key for this account and its saved bid or deposit history.');
        }
        await deps.secretsRepo.saveV2Key(token.trim(), actual, account_id.trim());
      };
      try {
        if (deps.braiinsVersion !== 'v2' && deps.v1MigrationGuard) {
          await deps.v1MigrationGuard.migrate(verifyAndSave);
        } else {
          await verifyAndSave();
        }
      } catch (err) {
        return reply.code(err instanceof CandidateKeyError ? 422 : 409).send({ error: (err as Error).message });
      }
      return { ok: true, applies_on_restart: true };
    }
    const saved = await deps.secretsRepo.getBraiinsSettings();
    if (saved?.braiins_api_version === 'v2' || token.startsWith('brn_key_')) {
      return reply.code(422).send({ error: 'Select the Braiins ID API key editor for v2 credentials.' });
    }
    // Validate against Braiins before committing - a typo/wrong token
    // would otherwise silently break bidding. Build a throwaway client
    // that uses ONLY the candidate token in the right role, and make a
    // lightweight authenticated read.
    const probe = createBraiinsClient(
      kind === 'owner' ? { ownerToken: token } : { readOnlyToken: token },
    );
    try {
      await probe.getBalance();
    } catch (err) {
      reply.code(422);
      return {
        error: 'Braiins rejected this token',
        detail: (err as Error).message,
      };
    }
    const ok = await deps.secretsRepo.setBraiinsToken(kind, token);
    if (!ok) {
      reply.code(409);
      return { error: 'no stored secrets to update' };
    }
    deps.log?.(`[security] braiins ${kind} token rotated (takes effect on restart)`);
    // Applied on restart - the running Braiins client keeps the old token
    // until then (documented in the UI).
    return { ok: true, applies_on_restart: true };
  });
}
