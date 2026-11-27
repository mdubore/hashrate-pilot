import type { FastifyInstance } from 'fastify';
import type { V2BidMutations } from '../../services/v2-bid-mutations.js';

/** Recovery reads the bound account or records a local operator resolution.
 * None of these handlers send a marketplace mutation. */
export function registerBraiinsRecoveryRoutes(app: FastifyInstance, journal: V2BidMutations): void {
  app.get('/api/braiins/pending-mutation', async () => {
    return { pending: await journal.pendingForOperator() };
  });
  app.post<{ Body?: { request_id?: string; confirmation_reference?: string } }>(
    '/api/braiins/pending-mutation/confirm-not-placed',
    async (req, reply) => {
      const { request_id, confirmation_reference } = req.body ?? {};
      if (
        typeof request_id !== 'string' ||
        !request_id ||
        typeof confirmation_reference !== 'string' ||
        !confirmation_reference.trim()
      ) {
        return reply
          .code(400)
          .send({ error: 'request_id and confirmation_reference are required' });
      }
      try {
        await journal.confirmNotPlaced(request_id, confirmation_reference);
        return { ok: true };
      } catch (err) {
        return reply.code(409).send({ ok: false, error: (err as Error).message });
      }
    },
  );
  app.post<{ Body?: { request_id?: string; bid_id?: string } }>(
    '/api/braiins/pending-mutation/resolve-placement',
    async (req, reply) => {
      const { request_id, bid_id } = req.body ?? {};
      if (typeof request_id !== 'string' || !request_id || typeof bid_id !== 'string' || !bid_id) {
        return reply.code(400).send({ error: 'request_id and bid_id are required' });
      }
      try {
        await journal.resolvePlacement(request_id, bid_id);
        return { ok: true };
      } catch (err) {
        return reply.code(409).send({ ok: false, error: (err as Error).message });
      }
    },
  );
}
