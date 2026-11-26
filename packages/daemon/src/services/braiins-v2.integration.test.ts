import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBraiinsClient } from '@hashrate-autopilot/braiins-client';
import { expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../state/db.js';
import { OwnedBidsRepo } from '../state/repos/owned_bids.js';
import { RuntimeStateRepo } from '../state/repos/runtime_state.js';
import { V2BidMutations } from './v2-bid-mutations.js';

it('recovers one accepted v2 placement after a lost reply and an on-disk restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'braiins-journal-test-'));
  const path = join(dir, 'test.sqlite');
  let handle = await openDatabase({ path });
  const account = 'account-a';
  const attempts: string[] = [];
  const remoteOrders = new Map<string, string>();
  const mockExchange: typeof fetch = async (input, init) => {
    const r = new Request(input, init);
    expect(r.headers.get('Authorization')).toBe('Bearer synthetic');
    if (new URL(r.url).pathname === '/v2/accounts') {
      return Response.json({ accounts: [{ account_id: account }] });
    }
    expect(r.method).toBe('POST');
    expect(new URL(r.url).pathname).toBe('/v2/spot/accounts/account-a/bids');
    const body = await r.text();
    const { request_id } = JSON.parse(body) as { request_id: string };
    attempts.push(body);
    if (!remoteOrders.has(request_id)) {
      remoteOrders.set(request_id, 'B123');
      throw new TypeError('connection closed after accepting bid');
    }
    return Response.json({ bid_id: remoteOrders.get(request_id), state: 'BID_STATE_CREATING' });
  };
  const newService = () =>
    new V2BidMutations(
      handle.db,
      createBraiinsClient({
        apiVersion: 'v2',
        accountId: account,
        apiKey: 'synthetic',
        fetch: mockExchange,
        maxRetries: 1,
      }),
    );
  const proposal = {
    kind: 'CREATE_BID',
    reason: 'fixture',
    price_sat: 40_000_000,
    amount_sat: 25_000,
    speed_limit_ph: 1,
    dest_pool_url: 'stratum+tcp://pool.example:3333',
    dest_worker_name: 'worker',
  } as const;
  try {
    const runtime = new RuntimeStateRepo(handle.db);
    await runtime.initializeIfMissing();
    await handle.db
      .insertInto('braiins_account_binding')
      .values({ id: 1, account_id: account, needs_live_confirmation: 0 })
      .execute();
    let service = newService();
    await expect(service.run(proposal)).rejects.toThrow(/LIVE/);
    expect(attempts).toHaveLength(0);
    await runtime.patch({ run_mode: 'LIVE' });
    await expect(service.run(proposal)).rejects.toThrow(/connection closed/);
    expect(await service.pending()).not.toBeNull();
    await closeDatabase(handle);
    handle = await openDatabase({ path });
    service = newService();
    await service.run(proposal);
    expect(await service.pending()).toBeNull();
    expect(remoteOrders.size).toBe(1);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toBe(attempts[0]);
    expect(await new OwnedBidsRepo(handle.db).findById('B123')).toMatchObject({
      braiins_order_id: 'B123',
      last_known_status: 'BID_STATUS_CREATING',
      amount_sat: 25_000,
    });
  } finally {
    await closeDatabase(handle);
    await rm(dir, { recursive: true, force: true });
  }
});
