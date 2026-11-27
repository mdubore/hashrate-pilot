import type { BraiinsClient } from './client.js';
import type { components } from './generated/v2.js';
import type { BidDetail, MarketStats } from './read-types.js';
import { bidPath, normalizeV2BidState } from './v2-bid.js';
import type { V2Transport } from './v2-transport.js';

type Schemas = components['schemas'];
type Trading<K extends string> = Schemas[`braiins.hashpower.trading.v2.${K}` & keyof Schemas];
type Market<K extends string> = Schemas[`braiins.hashpower.market.v2.${K}` & keyof Schemas];
type Delivery<K extends string> = Schemas[`braiins.hashpower.delivery.v2.${K}` & keyof Schemas];
type Reads = Pick<
  BraiinsClient,
  | 'getStats'
  | 'getOrderbook'
  | 'getSettings'
  | 'getFee'
  | 'getBalance'
  | 'getCurrentBids'
  | 'listBids'
  | 'getTransactions'
  | 'getOnChainTransactions'
  | 'getBidDetail'
  | 'getBidDeliveryHistory'
>;

function integer(value: string | undefined, field: string): number {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`Invalid v2 ${field}: expected an integer in the safe range`);
  }
  return Number(value);
}

function numeric(value: number | undefined, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid v2 ${field}`);
  return value;
}

function seconds(value: string | undefined, field: string): number {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,9})?s$/.test(value)) {
    throw new Error(`Invalid v2 duration ${field}`);
  }
  return Number(value.slice(0, -1));
}

function required(value: string | undefined, field: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`Missing v2 ${field}`);
  return value;
}

function rows<T>(value: T[] | undefined, field: string): T[] {
  if (!Array.isArray(value)) throw new Error(`Invalid v2 ${field} list`);
  return value;
}

function progress(value: Trading<'BidProgress'>) {
  return {
    amount_consumed_sat: integer(value.amount_consumed_sat, 'amount_consumed_sat'),
    fee_paid_sat: integer(value.fee_paid_sat, 'fee_paid_sat'),
  };
}

function bidItem(raw: Trading<'Bid'>): BidDetail {
  const status = normalizeV2BidState(raw.state);
  return {
    bid: {
      id: required(raw.bid_id, 'bid_id'),
      price_sat: integer(raw.price_sat, 'price_sat'),
      amount_sat: integer(raw.amount_sat, 'amount_sat'),
      status,
      is_current: status !== 'BID_STATUS_CANCELED' && status !== 'BID_STATUS_FULFILLED',
      ...(raw.speed_limit_ph != null && {
        speed_limit_ph: numeric(raw.speed_limit_ph, 'speed_limit_ph'),
      }),
      ...(raw.fee_rate_pct != null && { fee_rate_pct: numeric(raw.fee_rate_pct, 'fee_rate_pct') }),
      ...(raw.destination && {
        dest_upstream: { url: raw.destination.pool_url, identity: raw.destination.worker },
      }),
      ...(raw.memo !== undefined && { memo: raw.memo }),
      ...(raw.pause_reason !== undefined && { last_pause_reason: raw.pause_reason }),
      ...(raw.create_time && { created: raw.create_time }),
      ...(raw.update_time && { last_updated: raw.update_time }),
    },
    ...(raw.settled && { counters_committed: progress(raw.settled) }),
    ...(raw.estimated && { counters_estimate: progress(raw.estimated) }),
    state_estimate: {
      amount_remaining_sat: integer(raw.amount_remaining_sat, 'amount_remaining_sat'),
      progress_pct: numeric(raw.progress_pct, 'progress_pct'),
      avg_speed_ph: numeric(raw.avg_speed_ph, 'avg_speed_ph'),
    },
  };
}

interface Page<T> {
  values: T[];
  next: string;
}
function page<T>(values: T[] | undefined, token: string | undefined): Page<T> {
  // The published v2 JSON contract emits [] and an empty last-page token,
  // even for an empty account. Missing fields indicate an incomplete read.
  if (typeof token !== 'string') throw new Error('Invalid v2 next_page_token');
  return { values: rows(values, 'page'), next: token };
}

// Some v1 callers specify an offset or request more than v2's page cap.
// Walk the server cursor; a short page can still have a successor.
async function windowOf<T>(
  fetchPage: (size: number, token: string) => Promise<Page<T>>,
  cap: number,
  limit: number,
  offset = 0,
  initialToken = '',
): Promise<Page<T>> {
  if (
    (!Number.isSafeInteger(limit) && limit !== Infinity) ||
    limit < 1 ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  )
    throw new Error('Invalid v2 page bounds');
  const values: T[] = [];
  const seen = new Set<string>();
  let token = initialToken;
  do {
    if (seen.has(token)) throw new Error('Repeated v2 page token');
    seen.add(token);
    const res = await fetchPage(Math.min(cap, offset + limit - values.length), token);
    const skip = Math.min(offset, res.values.length);
    values.push(...res.values.slice(skip));
    offset -= skip;
    token = res.next;
    if (token && seen.has(token)) throw new Error('Repeated v2 page token');
  } while (token && values.length < limit);
  return { values, next: token };
}

function paging(page_size: number, token: string) {
  return { page_size, ...(token && { page_token: token }) };
}

export function createV2Reads(transport: V2Transport): Reads {
  const bidsPage = async (current: boolean, size: number, token: string) => {
    const path = await transport.accountPath('/bids', true);
    const res = await transport.get<Trading<'ListBidsResponse'>>(path, {
      current_only: current,
      ...paging(size, token),
    });
    return page(res.bids, res.next_page_token);
  };
  return {
    async getStats() {
      const s = await transport.get<Market<'MarketStats'>>('/spot/stats');
      const status: MarketStats['status'] =
        s.status === 'MARKET_STATUS_OPEN'
          ? 'SPOT_INSTRUMENT_STATUS_ACTIVE'
          : s.status === 'MARKET_STATUS_HALTED'
            ? 'SPOT_INSTRUMENT_STATUS_HALTED'
            : 'SPOT_INSTRUMENT_STATUS_UNSPECIFIED';
      return {
        status,
        hash_rate_matched_10m_ph: numeric(s.hashrate_matched_ph, 'hashrate_matched_ph'),
        hash_rate_available_10m_ph: numeric(s.hashrate_available_ph, 'hashrate_available_ph'),
        volume_24h_eh_day: numeric(s.volume_24h_eh_day, 'volume_24h_eh_day'),
        ...(s.best_bid_price_sat != null && {
          best_bid_sat: integer(s.best_bid_price_sat, 'best_bid_price_sat'),
        }),
        ...(s.best_ask_price_sat != null && {
          best_ask_sat: integer(s.best_ask_price_sat, 'best_ask_price_sat'),
        }),
        ...(s.last_price_sat != null && {
          last_price_sat: integer(s.last_price_sat, 'last_price_sat'),
        }),
      };
    },
    async getOrderbook() {
      const book = await transport.get<Market<'OrderBook'>>('/spot/orderbook');
      return {
        bids: rows(book.bids, 'bids').map((b) => ({
          price_sat: integer(b.price_sat, 'price_sat'),
          amount_sat: integer(b.amount_sat, 'amount_sat'),
          hr_matched_ph: numeric(b.hashrate_matched_ph, 'hashrate_matched_ph'),
          ...(b.speed_limit_ph != null && {
            speed_limit_ph: numeric(b.speed_limit_ph, 'speed_limit_ph'),
          }),
        })),
        asks: rows(book.asks, 'asks').map((a) => ({
          price_sat: integer(a.price_sat, 'price_sat'),
          hr_matched_ph: numeric(a.hashrate_matched_ph, 'hashrate_matched_ph'),
          hr_available_ph: numeric(a.hashrate_available_ph, 'hashrate_available_ph'),
        })),
      };
    },
    async getSettings() {
      const s = await transport.get<Trading<'SpotSettings'>>('/spot/settings');
      return {
        hr_unit: 'EH/day',
        hr_multiplier_log10: 18,
        tick_size_sat: integer(s.tick_size_sat, 'tick_size_sat'),
        min_bid_price_sat: integer(s.min_price_sat, 'min_price_sat'),
        max_bid_price_sat: integer(s.max_price_sat, 'max_price_sat'),
        min_bid_amount_sat: integer(s.min_amount_sat, 'min_amount_sat'),
        max_bid_amount_sat: integer(s.max_amount_sat, 'max_amount_sat'),
        min_limited_bid_amount_sat: integer(s.min_limited_amount_sat, 'min_limited_amount_sat'),
        max_limited_bid_amount_sat: integer(s.max_limited_amount_sat, 'max_limited_amount_sat'),
        min_bid_speed_limit_ph: numeric(s.min_speed_limit_ph, 'min_speed_limit_ph'),
        max_bid_speed_limit_ph: numeric(s.max_speed_limit_ph, 'max_speed_limit_ph'),
        max_bids_per_subaccount: numeric(s.max_current_bids, 'max_current_bids'),
        bid_grace_period_s: seconds(s.cancel_grace_period, 'cancel_grace_period'),
        min_limited_bid_duration_s: seconds(s.min_limited_duration, 'min_limited_duration'),
        min_bid_price_decrease_period_s: seconds(
          s.price_decrease_interval,
          'price_decrease_interval',
        ),
        min_bid_speed_limit_decrease_period_s: seconds(
          s.speed_limit_decrease_interval,
          'speed_limit_decrease_interval',
        ),
      };
    },
    async getFee() {
      const fee = await transport.get<Trading<'SpotFees'>>(
        await transport.accountPath('/fees', true),
      );
      return {
        spot_fees: [
          {
            fee_type: 'SPOT_FEE_TYPE_BUY',
            fee: { fee_rate_pct: numeric(fee.fee_rate_pct, 'fee_rate_pct') },
          },
        ],
      };
    },
    async getBalance() {
      const account = await transport.accountId();
      const b = await transport.get<Trading<'Balance'>>(await transport.accountPath('/balance'));
      return {
        accounts: [
          {
            subaccount: account,
            currency: 'BTC',
            total_balance_sat: integer(b.total_sat, 'total_sat'),
            available_balance_sat: integer(b.available_sat, 'available_sat'),
            blocked_balance_sat: integer(b.blocked_sat, 'blocked_sat'),
          },
        ],
      };
    },
    async getCurrentBids() {
      const res = await windowOf((n, t) => bidsPage(true, n, t), 500, Infinity);
      const items = res.values.map(bidItem);
      if (new Set(items.map((i) => i.bid.id)).size !== items.length)
        throw new Error('Duplicate bid in v2 current bids');
      return { items };
    },
    async listBids({
      limit = 200,
      offset = 0,
      page_token = '',
      reverse = false,
      exclude_active = false,
    } = {}) {
      const res = await windowOf(
        async (n, t) => {
          const bids = await bidsPage(false, n, t);
          let values = bids.values.map(bidItem);
          if (exclude_active) values = values.filter((i) => !i.bid.is_current);
          return { values, next: bids.next };
        },
        500,
        reverse ? Infinity : limit,
        reverse ? 0 : offset,
        page_token,
      );
      return {
        items: reverse ? res.values.reverse().slice(offset, offset + limit) : res.values,
        next_page_token: res.next,
      };
    },
    async getBidDetail(id) {
      const path = await transport.accountPath(bidPath(id), true);
      const bid = bidItem(await transport.get<Trading<'Bid'>>(path));
      if (bid.bid.id !== id) throw new Error('Unexpected bid ID in v2 bid detail');
      return bid;
    },
    async getTransactions({ limit = 200, offset = 0 } = {}) {
      const path = await transport.accountPath('/transactions');
      const res = await windowOf(
        async (n, t) => {
          const data = await transport.get<Trading<'ListTransactionsResponse'>>(path, paging(n, t));
          return page(data.transactions, data.next_page_token);
        },
        500,
        limit,
        offset,
      );
      return {
        transactions: res.values.map((t) => ({
          tx_type: t.type ?? 'TRANSACTION_TYPE_UNSPECIFIED',
          amount_sat: integer(t.amount_sat, 'amount_sat'),
          timestamp: required(t.time, 'time'),
          transaction_id: required(t.transaction_id, 'transaction_id'),
          available_change_sat: integer(t.available_change_sat, 'available_change_sat'),
          blocked_change_sat: integer(t.blocked_change_sat, 'blocked_change_sat'),
          ...(t.bid_id && { bid_id: t.bid_id }),
          ...(t.contract_id && { contract_id: t.contract_id }),
        })),
      };
    },
    async getOnChainTransactions({ limit = 200 } = {}) {
      const path = await transport.accountPath('/on-chain-transactions');
      const res = await windowOf(
        async (n, t) => {
          const data = await transport.get<Trading<'ListOnChainTransactionsResponse'>>(
            path,
            paging(n, t),
          );
          return page(data.transactions, data.next_page_token);
        },
        100,
        limit,
      );
      return {
        transactions: res.values.map((t) => ({
          tx_type: (t.type ?? 'ON_CHAIN_TRANSACTION_TYPE_UNSPECIFIED').replace(
            /^ON_CHAIN_/,
            'ONCHAIN_',
          ),
          amount_sat: integer(t.amount_sat, 'amount_sat'),
          timestamp: required(t.time, 'time'),
          address: t.address ?? '',
          ...(t.tx_id && { tx_id: t.tx_id }),
          ...(t.output_index != null && { order_no: t.output_index }),
          ...(t.deposit_status && { deposit_status: t.deposit_status }),
          ...(t.return_tx_id && { return_tx_id: t.return_tx_id }),
        })),
      };
    },
    async getBidDeliveryHistory(id) {
      const path = await transport.accountPath(bidPath(id) + '/hashrate', true);
      const data = await transport.get<Delivery<'BidHashrate'>>(path, {
        interval: 'HASHRATE_INTERVAL_5M',
      });
      return {
        items: [],
        samples: rows(data.samples, 'samples').map((s) => ({
          start_time: required(s.start_time, 'start_time'),
          purchased_ph: numeric(s.purchased_ph, 'purchased_ph'),
          accepted_ph: numeric(s.accepted_ph, 'accepted_ph'),
          rejected_ph: numeric(s.rejected_ph, 'rejected_ph'),
        })),
      };
    },
  };
}
