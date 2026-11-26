import Fastify from 'fastify';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { BraiinsClient } from '@hashrate-autopilot/braiins-client';
import type { V2BidMutations } from '../../services/v2-bid-mutations.js';
import type { OwnedBidsRepo } from '../../state/repos/owned_bids.js';
import type { ConfigRepo } from '../../state/repos/config.js';
import { registerBraiinsRecoveryRoutes } from './braiins-recovery.js';
import { registerStaleUrlsRoute } from './stale-urls.js';

let server: ReturnType<typeof Fastify>;
beforeEach(() => {
  server = Fastify();
});
afterEach(() => server.close());

it('returns the original UUID and payload for operator review', async () => {
  const journal = {
    pendingForOperator: vi.fn().mockResolvedValue({
      id: 1,
      account_id: 'acct',
      request_id: 'uuid',
      created_at: 42,
      command: { kind: 'place', body: { memo: 'hashrate-autopilot uuid' } },
      needs_review: true,
    }),
    resolvePlacement: vi.fn().mockResolvedValue(undefined),
    confirmNotPlaced: vi.fn(),
  };
  registerBraiinsRecoveryRoutes(server, journal as unknown as V2BidMutations);
  const prefix = '/api/braiins/pending-mutation';
  const read = await server.inject({ method: 'GET', url: prefix });
  expect(read.statusCode).toBe(200);
  expect(read.json().pending).toMatchObject({
    request_id: 'uuid',
    needs_review: true,
    command: { kind: 'place' },
  });
  const resolve = await server.inject({
    method: 'POST',
    url: prefix + '/resolve-placement',
    payload: { request_id: 'uuid', bid_id: 'B9' },
  });
  expect(resolve.statusCode).toBe(200);
  expect(journal.resolvePlacement).toHaveBeenCalledWith('uuid', 'B9');
  const missing = await server.inject({
    method: 'POST',
    url: prefix + '/confirm-not-placed',
    payload: { request_id: 'uuid' },
  });
  expect(missing.statusCode).toBe(400);
  expect(journal.confirmNotPlaced).not.toHaveBeenCalled();
});

it('routes manual v2 cancellation through the same journal and leaves the ledger pending on failure', async () => {
  const journal = { run: vi.fn().mockRejectedValue(new Error('pending')) };
  const owned = {
    findById: vi
      .fn()
      .mockResolvedValue({ abandoned: false, last_known_status: 'BID_STATUS_ACTIVE' }),
    markCancelled: vi.fn(),
  };
  const client = { apiVersion: 'v2', cancelBid: vi.fn() };
  await registerStaleUrlsRoute(server, {
    configRepo: {} as ConfigRepo,
    ownedBidsRepo: owned as unknown as OwnedBidsRepo,
    braiinsClient: client as unknown as BraiinsClient,
    v2BidMutations: journal as unknown as V2BidMutations,
  });
  const result = await server.inject({
    method: 'POST',
    url: '/api/stale-urls/cancel',
    payload: { bid_id: 'B9' },
  });
  expect(result.statusCode).toBe(502);
  expect(journal.run).toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'CANCEL_BID', braiins_order_id: 'B9' }),
  );
  expect(client.cancelBid).not.toHaveBeenCalled();
  expect(owned.markCancelled).not.toHaveBeenCalled();
});
