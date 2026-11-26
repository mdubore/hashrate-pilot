import { mkdtemp, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BraiinsApiError,
  BraiinsNetworkError,
  type BraiinsClient,
} from '@hashrate-autopilot/braiins-client';
import { openDatabase, closeDatabase, type DatabaseHandle } from '../state/db.js';
import { RuntimeStateRepo } from '../state/repos/runtime_state.js';
import { OwnedBidsRepo } from '../state/repos/owned_bids.js';
import { V2BidMutations } from './v2-bid-mutations.js';

const create = {
  kind: 'CREATE_BID',
  price_sat: 10000,
  amount_sat: 50000,
  speed_limit_ph: 2,
  dest_pool_url: 'stratum+tcp://pool.test:3333',
  dest_worker_name: 'a.worker',
  reason: 'test',
} as const;
const cancel = { kind: 'CANCEL_BID', braiins_order_id: 'B1', reason: 'test' } as const;

describe('v2 mutation journal', () => {
  let handle: DatabaseHandle;
  let owned: OwnedBidsRepo;
  let now: number;
  let dir: string;
  let seed: string;
  let service: V2BidMutations;
  const client = {
    apiVersion: 'v2',
    getAccountId: vi.fn(),
    placeBid: vi.fn(),
    editBid: vi.fn(),
    cancelBid: vi.fn(),
    getBidDetail: vi.fn(),
  };
  const boot = () => new V2BidMutations(handle.db, client as unknown as BraiinsClient, () => now);
  beforeAll(async () => {
    seed = await mkdtemp(join(tmpdir(), 'braiins-journal-template-'));
    const template = await openDatabase({ path: join(seed, 'template.sqlite') });
    await closeDatabase(template);
  });
  afterAll(() => rm(seed, { recursive: true, force: true }));
  beforeEach(async () => {
    vi.resetAllMocks();
    dir = await mkdtemp(join(tmpdir(), 'braiins-journal-'));
    await copyFile(join(seed, 'template.sqlite'), join(dir, 'test.sqlite'));
    handle = await openDatabase({ path: join(dir, 'test.sqlite') });
    const runtime = new RuntimeStateRepo(handle.db);
    await runtime.initializeIfMissing();
    await runtime.patch({ run_mode: 'LIVE' });
    await handle.db
      .insertInto('braiins_account_binding')
      .values({ id: 1, account_id: 'acct', needs_live_confirmation: 0 })
      .execute();
    client.getAccountId.mockResolvedValue('acct');
    owned = new OwnedBidsRepo(handle.db);
    now = 10_000;
    service = boot();
  });
  afterEach(async () => {
    await closeDatabase(handle);
    await rm(dir, { recursive: true, force: true });
  });

  it('reuses the original UUID and payload across a restart, then saves ownership', async () => {
    client.placeBid
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValue({ id: 'B1' });
    await expect(service.run(create)).rejects.toThrow('connection reset');
    const pending = await service.pending();
    expect(pending?.account_id).toBe('acct');
    await closeDatabase(handle);
    handle = await openDatabase({ path: join(dir, 'test.sqlite') });
    owned = new OwnedBidsRepo(handle.db);
    service = boot();
    await service.run({ ...create, reason: 'next tick' });
    expect(client.placeBid.mock.calls[0]).toEqual(client.placeBid.mock.calls[1]);
    expect(client.placeBid.mock.calls[0]?.[1]).toBe(pending?.request_id);
    expect((await owned.findById('B1'))?.amount_sat).toBe(50000);
    expect(await service.pending()).toBeNull();
    await expect(service.run(create)).rejects.toThrow(/owned bid/i);
    expect(client.placeBid).toHaveBeenCalledTimes(2);
  });

  it('retries a rate-limited placement with the original UUID and body across a 90s reset and restart', async () => {
    const retryAt = now + 90_000;
    client.placeBid.mockRejectedValueOnce(
      new BraiinsApiError({ status: 429, endpoint: 'place', retryAt }),
    );
    await expect(service.run(create)).rejects.toThrow('429');
    const pending = (await service.pending())!;
    expect(pending.retry_at).toBe(retryAt);
    await closeDatabase(handle);
    handle = await openDatabase({ path: join(dir, 'test.sqlite') });
    service = boot();
    now += 65_000;
    expect((await service.pendingForOperator())?.needs_review).toBe(false);
    await expect(service.run(create)).rejects.toThrow(/rate limit/i);
    await expect(service.resolvePlacement(pending.request_id, 'B2')).rejects.toThrow(/rate limit/i);
    await expect(service.confirmNotPlaced(pending.request_id, 'evidence')).rejects.toThrow(
      /rate limit/i,
    );
    expect(client.placeBid).toHaveBeenCalledTimes(1);
    now = retryAt;
    client.placeBid.mockImplementationOnce(async () => {
      expect(await service.pending()).toMatchObject({
        request_id: pending.request_id,
        retry_at: null,
        created_at: now,
      });
      return { id: 'B1' };
    });
    await service.run(create);
    expect(client.placeBid.mock.calls[1]?.slice(0, 2)).toEqual(
      client.placeBid.mock.calls[0]?.slice(0, 2),
    );
    expect(client.placeBid.mock.calls[1]?.[2]).toBe(retryAt + 60_000);
    expect(await service.pending()).toBeNull();
  });

  it('can supersede an entirely rate-limited placement when the next tick wants different terms', async () => {
    const retryAt = now + 90_000;
    client.placeBid
      .mockRejectedValueOnce(new BraiinsApiError({ status: 429, endpoint: 'place', retryAt }))
      .mockRejectedValueOnce(new Error('timeout'));
    await expect(service.run(create)).rejects.toThrow('429');
    const changed = { ...create, price_sat: 11111 };
    await expect(service.run(changed)).rejects.toThrow(/rate limit/i);
    now = retryAt;
    await expect(boot().run(changed)).rejects.toThrow('timeout');
    const [first, second] = client.placeBid.mock.calls;
    expect(second?.[1]).not.toBe(first?.[1]);
    expect(second?.[0]).toMatchObject({
      price_sat: changed.price_sat,
      memo: 'hashrate-autopilot ' + second?.[1],
    });
    expect(await service.pending()).toMatchObject({
      request_id: second?.[1],
      retry_at: null,
      created_at: now,
    });
    now += 60_000;
    expect((await service.pendingForOperator())?.needs_review).toBe(true);
  });

  it('retains an uncertain outcome when an identical replay only receives a rate limit', async () => {
    client.placeBid
      .mockRejectedValueOnce(new Error('timeout'))
      .mockRejectedValueOnce(
        new BraiinsApiError({ status: 429, endpoint: 'place', retryAt: now + 90_000 }),
      );
    await expect(service.run(create)).rejects.toThrow('timeout');
    const first = (await service.pending())!;
    now += 59_000;
    await expect(boot().run(create)).rejects.toThrow('429');
    expect(client.placeBid.mock.calls[1]?.[2]).toBe(first.created_at + 60_000);
    expect(await service.pending()).toMatchObject({
      request_id: first.request_id,
      unexecuted: 0,
      retry_at: first.created_at + 90_000,
      created_at: first.created_at,
    });
    await expect(boot().run(create)).rejects.toThrow(/rate limit/i);
    now += 90_000;
    expect((await service.pendingForOperator())?.needs_review).toBe(true);
    await expect(boot().run(create)).rejects.toThrow(/placement/);
    expect(client.placeBid).toHaveBeenCalledTimes(2);
  });

  it('honors a wrapped rate limit across restarts without losing the placement uncertainty', async () => {
    const retryAt = now + 20_000;
    client.placeBid.mockRejectedValue(
      new BraiinsNetworkError(
        'place',
        new BraiinsApiError({ status: 429, endpoint: 'place', retryAt }),
      ),
    );
    await expect(service.run(create)).rejects.toThrow('429');
    const first = (await service.pending())!;
    expect(first).toMatchObject({ unexecuted: 0, retry_at: retryAt });
    await expect(boot().run(create)).rejects.toThrow(/rate limit/i);
    expect(client.placeBid).toHaveBeenCalledTimes(1);
    now = retryAt;
    await expect(boot().run({ ...create, price_sat: 4000 })).rejects.toThrow(/pending/);
    client.placeBid.mockImplementationOnce(async () => {
      expect(await service.pending()).toMatchObject({
        unexecuted: 0,
        retry_at: null,
        request_id: first.request_id,
        created_at: first.created_at,
      });
      throw new Error('lost reply');
    });
    await expect(boot().run(create)).rejects.toThrow('lost reply');
    expect(client.placeBid.mock.calls[0]).toEqual(client.placeBid.mock.calls[1]);
    now = first.created_at + 60_000;
    expect((await service.pendingForOperator())?.needs_review).toBe(true);
  });

  it('pauses on a wrapped permission denial while retaining the unknown result', async () => {
    client.placeBid.mockRejectedValue(
      new BraiinsNetworkError('place', new BraiinsApiError({ status: 403, endpoint: 'place' })),
    );
    await expect(service.run(create)).rejects.toThrow('403');
    expect((await new RuntimeStateRepo(handle.db).get())?.run_mode).toBe('PAUSED');
    expect(await service.pending()).toMatchObject({ unexecuted: 0, retry_at: null });
  });

  it('rolls back local completion if recording the remotely accepted bid fails', async () => {
    client.placeBid.mockResolvedValue({ id: 'B1' });
    handle.raw.exec(
      "CREATE TRIGGER fail_insert BEFORE INSERT ON owned_bids BEGIN SELECT RAISE(ABORT, 'storage failed'); END",
    );
    await expect(service.run(create)).rejects.toThrow('storage failed');
    expect(await service.pending()).not.toBeNull();
    handle.raw.exec('DROP TRIGGER fail_insert');
    await boot().run(create);
    expect(client.placeBid.mock.calls[0]).toEqual(client.placeBid.mock.calls[1]);
    expect((await owned.findById('B1'))?.amount_sat).toBe(create.amount_sat);
  });

  it('holds an ambiguous placement even when the next tick wants different terms', async () => {
    client.placeBid.mockRejectedValueOnce(new Error('timeout'));
    await expect(service.run(create)).rejects.toThrow();
    expect((await service.pendingForOperator())?.needs_review).toBe(false);
    now += 61000;
    expect((await service.pendingForOperator())?.needs_review).toBe(true);
    await expect(boot().run({ ...create, price_sat: 20000 })).rejects.toThrow(/placement/);
    await expect(boot().run(create)).rejects.toThrow(/placement/);
    expect(client.placeBid).toHaveBeenCalledTimes(1);
    const pending = (await service.pending())!;
    client.getBidDetail.mockResolvedValue({ bid: { id: 'B4', memo: 'someone else' } });
    await expect(service.resolvePlacement(pending.request_id, 'B4')).rejects.toThrow(/memo/);
    expect(await owned.findById('B4')).toBeNull();
    const destination = { url: create.dest_pool_url, identity: create.dest_worker_name };
    const memo = client.placeBid.mock.calls[0]?.[0].memo;
    const created = new Date(pending.created_at).toISOString();
    client.getBidDetail.mockResolvedValue({
      bid: {
        id: 'B4',
        memo,
        created,
        dest_upstream: { ...destination, identity: 'different.worker' },
      },
    });
    await expect(service.resolvePlacement(pending.request_id, 'B4')).rejects.toThrow(/destination/);
    await owned.insert({
      braiins_order_id: 'B4',
      cl_order_id: null,
      created_at: 0,
      dest_url: create.dest_pool_url,
      price_sat: 10000,
      amount_sat: 10000,
      speed_limit_ph: 2,
    });
    client.getBidDetail.mockResolvedValue({
      bid: { id: 'B4', memo, created, dest_upstream: destination },
    });
    await expect(service.resolvePlacement(pending.request_id, 'B4')).rejects.toThrow(
      /already belongs/,
    );
    expect(await service.pending()).not.toBeNull();
    client.getBidDetail.mockResolvedValue({
      bid: {
        id: 'B5',
        created,
        dest_upstream: destination,
        status: 'BID_STATUS_FULFILLED',
        memo: client.placeBid.mock.calls[0]?.[0].memo,
      },
    });
    await service.resolvePlacement(pending.request_id, 'B5');
    expect((await owned.findById('B5'))?.last_known_status).toBe('BID_STATUS_FULFILLED');
    expect(await service.pending()).toBeNull();
  });

  it('refuses a write when the run mode, account or ownership changes', async () => {
    await expect(service.run(cancel)).rejects.toThrow(/own/i);
    client.getAccountId.mockResolvedValue('other');
    await expect(service.run(create)).rejects.toThrow(/account/i);
    client.getAccountId.mockResolvedValue('acct');
    await new RuntimeStateRepo(handle.db).patch({ run_mode: 'DRY_RUN' });
    await expect(service.run(create)).rejects.toThrow(/LIVE/);
    expect(client.placeBid).not.toHaveBeenCalled();
    expect(client.cancelBid).not.toHaveBeenCalled();
    expect(await service.pending()).toBeNull();
  });

  it('preserves ownership after a cancel 404 and waits for confirmed settlement', async () => {
    client.placeBid.mockResolvedValue({ id: 'B1' });
    await service.run(create);
    client.cancelBid.mockRejectedValueOnce(
      new BraiinsApiError({ status: 404, endpoint: 'cancel' }),
    );
    await expect(service.run(cancel)).rejects.toThrow();
    expect((await owned.findById('B1'))?.last_known_status).toBe('BID_STATUS_CREATED');
    client.cancelBid.mockResolvedValue({ bidState: 'BID_STATE_CANCELING' });
    await service.run(cancel);
    expect((await owned.findById('B1'))?.last_known_status).toBe('BID_STATUS_PENDING_CANCEL');
    await expect(service.run(create)).rejects.toThrow(/owned bid/i);
    await expect(service.run(cancel)).rejects.toThrow(/pending/i);
    expect(client.cancelBid).toHaveBeenCalledTimes(2);
  });

  it.each(['BID_STATE_CREATING', 'BID_STATE_UPDATING'])(
    'keeps an accepted %s edit reserved until the new terms become visible',
    async (bidState) => {
      client.placeBid.mockResolvedValue({ id: 'B1', bidState: 'BID_STATE_ACTIVE' });
      await service.run(create);
      client.editBid.mockResolvedValue({ bidState });
      const price = {
        kind: 'EDIT_PRICE',
        braiins_order_id: 'B1',
        old_price_sat: 10000,
        new_price_sat: 9000,
        reason: 'test',
      } as const;
      await service.run(price);
      expect((await service.pending())?.accepted).toBe(1);
      client.getBidDetail
        .mockResolvedValueOnce({ bid: { id: 'B1', status: 'BID_STATUS_ACTIVE', price_sat: 10000 } })
        .mockResolvedValueOnce({ bid: { id: 'B1', status: 'BID_STATUS_ACTIVE', price_sat: 9000 } });
      expect((await owned.findById('B1'))?.price_sat).toBe(create.price_sat);
      await service.reconcile();
      await expect(service.run(price)).rejects.toThrow(/confirmation/);
      await service.reconcile();
      expect(await service.pending()).toBeNull();
      expect((await owned.findById('B1'))?.price_sat).toBe(9000);
      expect(client.editBid).toHaveBeenCalledTimes(1);
    },
  );

  it('preserves the last confirmed price if a pending decrease is canceled before it applies', async () => {
    client.placeBid.mockResolvedValue({ id: 'B1', bidState: 'BID_STATE_ACTIVE' });
    await service.run(create);
    client.editBid.mockResolvedValue({ bidState: 'BID_STATE_UPDATING' });
    await service.run({
      kind: 'EDIT_PRICE',
      braiins_order_id: 'B1',
      old_price_sat: 10000,
      new_price_sat: 9000,
      reason: 'test',
    });
    client.getBidDetail.mockResolvedValue({
      bid: { id: 'B1', status: 'BID_STATUS_CANCELED', price_sat: 10000 },
    });
    await service.reconcile();
    expect(await owned.findById('B1')).toMatchObject({
      last_known_status: 'BID_STATUS_CANCELED',
      price_sat: 10000,
      last_price_decrease_at: null,
    });
    expect(await service.pending()).toBeNull();
  });

  it('holds a newly accepted bid while Braiins is creating it', async () => {
    client.placeBid.mockResolvedValue({ id: 'B1', bidState: 'BID_STATE_CREATING' });
    await service.run(create);
    expect((await owned.findById('B1'))?.last_known_status).toBe('BID_STATUS_CREATING');
    await expect(service.run(cancel)).rejects.toThrow(/confirm/);
    expect(client.cancelBid).not.toHaveBeenCalled();
  });

  it('requires a paused operator and independent confirmation to release a placement that never executed', async () => {
    client.placeBid.mockRejectedValue(new Error('timeout'));
    await expect(service.run(create)).rejects.toThrow();
    const pending = (await service.pending())!;
    now += 61000;
    await expect(service.confirmNotPlaced(pending.request_id, 'Support case #123')).rejects.toThrow(
      /pause/i,
    );
    await new RuntimeStateRepo(handle.db).patch({ run_mode: 'PAUSED' });
    await expect(service.confirmNotPlaced('wrong', 'Support case #123')).rejects.toThrow();
    await service.confirmNotPlaced(pending.request_id, 'Support case #123');
    expect(await service.pending()).toBeNull();
    expect((await new RuntimeStateRepo(handle.db).get())?.run_mode).toBe('PAUSED');
    expect(
      (await handle.db.selectFrom('system_events').select('detail').executeTakeFirst())?.detail,
    ).toContain(pending.request_id);
    expect(client.placeBid).toHaveBeenCalledTimes(1);
  });

  it('refuses a malformed amount before reserving a placement', async () => {
    await expect(service.run({ ...create, amount_sat: Infinity })).rejects.toThrow(/amount_sat/);
    expect(await service.pending()).toBeNull();
    expect(client.placeBid).not.toHaveBeenCalled();
  });

  it('records settlement if a cancel reply returns a fulfilled bid immediately', async () => {
    client.placeBid.mockResolvedValue({ id: 'B1' });
    await service.run(create);
    client.cancelBid.mockResolvedValue({
      bidState: 'BID_STATE_FULFILLED',
      settledAmountSat: 43210,
    });
    await service.run(cancel);
    expect(await owned.findById('B1')).toMatchObject({
      last_known_status: 'BID_STATUS_FULFILLED',
      amount_consumed_sat: 43210,
    });
  });

  it('keeps a pending cancel and terminal disposition when a stale list arrives', async () => {
    client.placeBid.mockResolvedValue({ id: 'B1' });
    await service.run(create);
    client.cancelBid.mockResolvedValue({ bidState: 'BID_STATE_CANCELING' });
    await service.run(cancel);
    const active = {
      braiins_order_id: 'B1',
      status: 'BID_STATUS_ACTIVE',
      price_sat: 10000,
      amount_sat: 50000,
      speed_limit_ph: 2,
      amount_consumed_sat: 5,
    };
    await owned.reconcileFromApi(now, [active], true);
    expect((await owned.findById('B1'))?.last_known_status).toBe('BID_STATUS_PENDING_CANCEL');
    await owned.reconcileFromApi(now, [{ ...active, status: 'BID_STATUS_FULFILLED' }], true);
    await owned.reconcileFromApi(now, [active], true);
    expect((await owned.findById('B1'))?.last_known_status).toBe('BID_STATUS_FULFILLED');
    await owned.setKnownStatus('B1', 'BID_STATUS_ACTIVE', 1);
    expect((await owned.findById('B1'))?.last_known_status).toBe('BID_STATUS_FULFILLED');
  });

  it('pauses after a Viewer denial without leaving a definitively rejected placement pending', async () => {
    client.placeBid.mockRejectedValue(
      new BraiinsApiError({ status: 403, endpoint: 'place', reason: 'INSUFFICIENT_PERMISSION' }),
    );
    await expect(service.run(create)).rejects.toThrow();
    expect(await service.pending()).toBeNull();
    expect((await new RuntimeStateRepo(handle.db).get())?.run_mode).toBe('PAUSED');
  });

  it('retains the UUID if re-authentication fails after an earlier lost response', async () => {
    client.placeBid
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockRejectedValueOnce(new BraiinsApiError({ status: 401, endpoint: 'place' }));
    await expect(service.run(create)).rejects.toThrow();
    const pending = await service.pending();
    await expect(boot().run(create)).rejects.toThrow();
    expect((await service.pending())?.request_id).toBe(pending?.request_id);
  });

  it('reads detail after an ambiguous cancellation and releases only its confirmed status', async () => {
    client.placeBid.mockResolvedValue({ id: 'B1' });
    await service.run(create);
    client.cancelBid.mockRejectedValue(new Error('timeout'));
    await expect(service.run(cancel)).rejects.toThrow();
    now += 61000;
    client.getBidDetail.mockRejectedValueOnce(new Error('not visible')).mockResolvedValueOnce({
      bid: { id: 'B1', status: 'BID_STATUS_FULFILLED' },
    });
    await expect(service.reconcile()).rejects.toThrow();
    expect(await service.pending()).not.toBeNull();
    await service.reconcile();
    expect(await service.pending()).toBeNull();
    expect((await owned.findById('B1'))?.last_known_status).toBe('BID_STATUS_FULFILLED');
    expect(client.cancelBid).toHaveBeenCalledTimes(1);
  });

  it('keeps an overlapping replay uncertain when a previous sender later receives 429', async () => {
    let lateRateLimit!: (err: Error) => void;
    client.placeBid
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            lateRateLimit = reject;
          }),
      )
      .mockRejectedValueOnce(new Error('connection lost'));
    const first = service.run(create);
    await vi.waitFor(() => expect(client.placeBid).toHaveBeenCalledTimes(1));
    await expect(boot().run(create)).rejects.toThrow('connection lost');
    lateRateLimit(new BraiinsApiError({ status: 429, endpoint: 'place', retryAt: now + 90_000 }));
    await expect(first).rejects.toThrow('429');
    expect(await service.pending()).toMatchObject({ unexecuted: 0, retry_at: now + 90_000 });
    now += 90_000;
    expect((await service.pendingForOperator())?.needs_review).toBe(true);
    await expect(boot().run({ ...create, price_sat: 8888 })).rejects.toThrow(/placement/);
    expect(client.placeBid).toHaveBeenCalledTimes(2);
  });

  it('rejects overlapping controller and dashboard commands until the first one finishes', async () => {
    let finish!: (value: { id: string }) => void;
    client.placeBid.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = service.run(create);
    await vi.waitFor(() => expect(client.placeBid).toHaveBeenCalledTimes(1));
    await expect(service.run(create)).rejects.toThrow(/in progress/);
    finish({ id: 'B1' });
    await first;
    expect(client.placeBid).toHaveBeenCalledTimes(1);
  });
});
