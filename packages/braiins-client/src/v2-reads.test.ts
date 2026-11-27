import { describe, expect, it, vi } from 'vitest';
import { createV2Reads } from './v2-reads.js';
import type { V2Transport } from './v2-transport.js';

function mockReads(...responses: unknown[]) {
  const get = vi.fn(async () => {
    if (responses.length === 0) throw new Error('Unexpected request');
    return responses.shift();
  });
  const reads = createV2Reads({
    get,
    accountId: async () => 'account-one',
    accountPath: async (suffix: string, spot = false) =>
      (spot ? '/spot' : '') + '/accounts/account-one' + suffix,
  } as unknown as V2Transport);
  return { reads, get };
}

function bid(bid_id: string, state = 'BID_STATE_ACTIVE') {
  return {
    bid_id,
    state,
    price_sat: '20301',
    amount_sat: '5000',
    amount_remaining_sat: '4250',
    speed_limit_ph: 9,
    avg_speed_ph: 7.4,
    progress_pct: 15,
    fee_rate_pct: 0,
    estimated: { amount_consumed_sat: '750', fee_paid_sat: '0' },
    settled: { amount_consumed_sat: '600', fee_paid_sat: '0' },
    destination: { pool_url: 'stratum+tcp://example.org:3333', worker: 'private-worker' },
  };
}

describe('v2 marketplace reads', () => {
  it('translates total, matched, and unmatched capacity without changing PH/s', async () => {
    const { reads } = mockReads({
      bids: [],
      asks: [{ price_sat: '24000', hashrate_available_ph: 12, hashrate_matched_ph: 5 }],
    });
    expect(await reads.getOrderbook()).toEqual({
      bids: [],
      asks: [{ price_sat: 24000, hr_available_ph: 12, hr_matched_ph: 5 }],
    });
  });
  it('converts the current wallet balance and leaves lifetime counters absent', async () => {
    const { reads, get } = mockReads({ total_sat: '110', available_sat: '100', blocked_sat: '10' });
    const { accounts } = await reads.getBalance();
    expect(accounts).toEqual([
      {
        subaccount: 'account-one',
        currency: 'BTC',
        total_balance_sat: 110,
        available_balance_sat: 100,
        blocked_balance_sat: 10,
      },
    ]);
    expect(get).toHaveBeenCalledWith('/accounts/account-one/balance');
  });
  it('rejects an amount outside the safe integer range', async () => {
    const { reads } = mockReads({
      total_sat: '9007199254740993',
      available_sat: '0',
      blocked_sat: '0',
    });
    await expect(reads.getBalance()).rejects.toThrow(/safe|range/i);
  });
  it('finishes every current-bid page and distinguishes settled from estimated spend', async () => {
    const { reads, get } = mockReads(
      { bids: [bid('B1')], next_page_token: 'next' },
      { bids: [bid('B2', 'BID_STATE_CANCELING')], next_page_token: '' },
    );
    const { items } = await reads.getCurrentBids();
    expect(get.mock.calls[1]).toEqual([
      '/spot/accounts/account-one/bids',
      { current_only: true, page_size: 500, page_token: 'next' },
    ]);
    expect(items.map((i) => i.bid.id)).toEqual(['B1', 'B2']);
    expect(items[0]?.counters_committed).toEqual({ amount_consumed_sat: 600, fee_paid_sat: 0 });
    expect(items[0]?.state_estimate?.amount_remaining_sat).toBe(4250);
    expect(items[1]?.bid).toMatchObject({ status: 'BID_STATUS_PENDING_CANCEL', is_current: true });
  });
  it('preserves unknown states as nonterminal and rejects partial or cyclic current lists', async () => {
    const future = mockReads(bid('B1', 'BID_STATE_FUTURE'));
    expect((await future.reads.getBidDetail('B1')).bid).toMatchObject({
      status: 'BID_STATUS_UNSPECIFIED',
      is_current: true,
    });
    await expect(mockReads({}).reads.getCurrentBids()).rejects.toThrow();
    await expect(
      mockReads(
        { bids: [], next_page_token: 'loop' },
        { bids: [], next_page_token: 'loop' },
      ).reads.getCurrentBids(),
    ).rejects.toThrow(/page|cursor/i);
  });
  it('converts deposit enum names to the values understood by the existing watcher', async () => {
    const { reads } = mockReads({
      transactions: [
        {
          type: 'ON_CHAIN_TRANSACTION_TYPE_DEPOSIT',
          time: '2026-11-22T12:00:00Z',
          amount_sat: '7',
          tx_id: 'tx1',
          address: 'addr',
          deposit_status: 'DEPOSIT_STATUS_CREDITED',
          output_index: 0,
        },
      ],
      next_page_token: '',
    });
    expect((await reads.getOnChainTransactions()).transactions[0]).toMatchObject({
      tx_type: 'ONCHAIN_TRANSACTION_TYPE_DEPOSIT',
      deposit_status: 'DEPOSIT_STATUS_CREDITED',
      order_no: 0,
      amount_sat: 7,
    });
  });
  it('keeps v2 delivery samples in PH/s and never passes them off as share counts', async () => {
    const sample = {
      start_time: '2026-11-22T12:00:00Z',
      purchased_ph: 2.1,
      accepted_ph: 2,
      rejected_ph: 0.1,
    };
    const { reads, get } = mockReads({ samples: [sample] });
    expect(await reads.getBidDeliveryHistory('B1')).toEqual({ items: [], samples: [sample] });
    expect(get.mock.calls[0]).toEqual([
      '/spot/accounts/account-one/bids/B1/hashrate',
      { interval: 'HASHRATE_INTERVAL_5M' },
    ]);
  });
});

describe('v2 read contract', () => {
  it('keeps an absent best quote unknown and reports volume in EH·day', async () => {
    const { reads } = mockReads({
      status: 'MARKET_STATUS_OPEN',
      volume_24h_eh_day: 2.5,
      hashrate_matched_ph: 0,
      hashrate_available_ph: 4.5,
      last_price_sat: '931',
    });
    expect(await reads.getStats()).toEqual({
      status: 'SPOT_INSTRUMENT_STATUS_ACTIVE',
      volume_24h_eh_day: 2.5,
      hash_rate_matched_10m_ph: 0,
      hash_rate_available_10m_ph: 4.5,
      last_price_sat: 931,
    });
  });
  it('normalizes live settings and keeps fractional seconds and zero fees', async () => {
    const { reads } = mockReads(
      {
        tick_size_sat: '2',
        min_price_sat: '10',
        max_price_sat: '4096',
        min_amount_sat: '50',
        max_amount_sat: '500',
        min_limited_amount_sat: '5',
        max_limited_amount_sat: '50',
        min_limited_duration: '6.4s',
        min_speed_limit_ph: 1,
        max_speed_limit_ph: 70,
        max_current_bids: 10,
        cancel_grace_period: '30s',
        price_decrease_interval: '600s',
        speed_limit_decrease_interval: '12s',
      },
      { fee_rate_pct: 0 },
    );
    expect(await reads.getSettings()).toMatchObject({
      tick_size_sat: 2,
      min_bid_amount_sat: 50,
      min_limited_bid_amount_sat: 5,
      min_limited_bid_duration_s: 6.4,
      bid_grace_period_s: 30,
      min_bid_price_decrease_period_s: 600,
      min_bid_speed_limit_decrease_period_s: 12,
    });
    expect(await reads.getFee()).toEqual({
      spot_fees: [{ fee_type: 'SPOT_FEE_TYPE_BUY', fee: { fee_rate_pct: 0 } }],
    });
  });
  it('walks cursors for ledger movements and retains signed balance changes', async () => {
    const tx = {
      time: '2026-11-10T12:00:00Z',
      type: 'TRANSACTION_TYPE_BID_SETTLEMENT',
      amount_sat: '20',
      available_change_sat: '0',
      blocked_change_sat: '-20',
      bid_id: 'B1',
    };
    const { reads, get } = mockReads(
      { transactions: [{ ...tx, transaction_id: 'T1' }], next_page_token: 'older' },
      { transactions: [{ ...tx, transaction_id: 'T2' }], next_page_token: '' },
    );
    const response = await reads.getTransactions({ limit: 1, offset: 1 });
    expect(response.transactions).toHaveLength(1);
    expect(response.transactions[0]).toMatchObject({
      transaction_id: 'T2',
      bid_id: 'B1',
      amount_sat: 20,
      blocked_change_sat: -20,
    });
    expect(get.mock.calls[1]).toEqual([
      '/accounts/account-one/transactions',
      { page_size: 1, page_token: 'older' },
    ]);
  });
  it('preserves v1 historical filter semantics over cursor pages', async () => {
    const { reads } = mockReads(
      {
        bids: [bid('B3', 'BID_STATE_ACTIVE'), bid('B2', 'BID_STATE_CANCELED')],
        next_page_token: 'p2',
      },
      { bids: [bid('B1', 'BID_STATE_FULFILLED')], next_page_token: '' },
    );
    expect(
      (await reads.listBids({ exclude_active: true, reverse: true, limit: 1 })).items.map(
        (i) => i.bid.id,
      ),
    ).toEqual(['B1']);
  });
  it('rejects a malformed public bid ID before requesting a detail or delivery endpoint', async () => {
    const { reads, get } = mockReads();
    await expect(reads.getBidDetail('..')).rejects.toThrow(/bid ID/);
    await expect(reads.getBidDeliveryHistory('..')).rejects.toThrow(/bid ID/);
    expect(get).not.toHaveBeenCalled();
  });
});

it('accepts a creating bid without projection objects or optional prices/limits', async () => {
  const constructing = {
    bid_id: 'B1',
    state: 'BID_STATE_CREATING',
    price_sat: '20000',
    amount_sat: '10000',
    amount_remaining_sat: '10000',
    avg_speed_ph: 0,
    progress_pct: 0,
  };
  const { reads } = mockReads(constructing);
  const detail = await reads.getBidDetail('B1');
  expect(detail.bid).toMatchObject({ status: 'BID_STATUS_CREATING', is_current: true });
  expect(detail.bid.fee_rate_pct).toBeUndefined();
  expect(detail.counters_committed).toBeUndefined();
  expect(detail.counters_estimate).toBeUndefined();
});

it('distinguishes a degraded orderbook level with a zero cap from an unknown or unlimited level', async () => {
  const level = { price_sat: '8000', amount_sat: '12345', hashrate_matched_ph: 0 };
  const { reads } = mockReads({ bids: [level, { ...level, speed_limit_ph: 0 }], asks: [] });
  const book = await reads.getOrderbook();
  expect(book.bids[0]?.speed_limit_ph).toBeUndefined();
  expect(book.bids[1]?.speed_limit_ph).toBe(0);
});
