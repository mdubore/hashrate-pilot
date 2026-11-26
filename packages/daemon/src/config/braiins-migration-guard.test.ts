import { describe, expect, it, vi } from 'vitest';
import type { BraiinsClient } from '@hashrate-autopilot/braiins-client';
import { execute, type ExecuteDeps } from '../controller/execute.js';
import type { State } from '../controller/types.js';
import { V1MigrationGuard } from './braiins.js';

describe('legacy writes during the protocol switch', () => {
  it('drains a running cancel before migration and blocks subsequent writes until restart', async () => {
    let complete!: () => void;
    const cancelBid = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    const guard = new V1MigrationGuard();
    const client = guard.wrap({ cancelBid } as unknown as BraiinsClient);
    const pending = client.cancelBid({ order_id: 'B1' });
    await expect(guard.migrate(async () => {})).rejects.toThrow(/in flight/i);
    complete();
    await pending;
    await guard.migrate(async () => {
      await expect(client.cancelBid({ order_id: 'B1' })).rejects.toThrow(/restart/i);
    });
    await expect(client.cancelBid({ order_id: 'B1' })).rejects.toThrow(/restart/i);
    expect(cancelBid).toHaveBeenCalledOnce();
  });

  it('keeps the account history stable until the controller commits the returned public bid ID', async () => {
    const guard = new V1MigrationGuard();
    const placeBid = vi.fn(async () => ({ id: 'B1' }));
    let release!: () => void;
    const inserted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const insert = vi.fn(async () => inserted);
    const deps = {
      braiinsClient: guard.wrap({ placeBid } as unknown as BraiinsClient),
      v1MigrationGuard: guard,
      ownedBidsRepo: { insert },
      decisionsRepo: { insertTick: vi.fn() },
      bidEventsRepo: { insert: vi.fn() },
      now: () => 1,
    } as unknown as ExecuteDeps;
    const result = execute(deps, { run_mode: 'LIVE', config: {} } as State, [
      {
        allowed: true,
        proposal: {
          kind: 'CREATE_BID',
          price_sat: 10,
          amount_sat: 100,
          speed_limit_ph: 1,
          dest_pool_url: 'stratum+tcp://pool.test:123',
          dest_worker_name: 'worker',
          reason: 'test',
        },
      },
    ]);
    await vi.waitFor(() => expect(insert).toHaveBeenCalledOnce());
    await expect(guard.migrate(async () => {})).rejects.toThrow(/in flight/i);
    release();
    expect((await result)[0]?.outcome).toBe('EXECUTED');
    await guard.migrate(async () => {});
  });

  it('reopens the old client if saving the new credential fails', async () => {
    const cancelBid = vi.fn(async () => ({}));
    const guard = new V1MigrationGuard();
    const client = guard.wrap({ cancelBid } as unknown as BraiinsClient);
    await expect(
      guard.migrate(async () => {
        throw new Error('save failed');
      }),
    ).rejects.toThrow('save failed');
    await client.cancelBid({ order_id: 'B1' });
    expect(cancelBid).toHaveBeenCalledOnce();
  });
});
