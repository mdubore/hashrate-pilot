import type { BidConfirmation, BraiinsClient, BraiinsClientConfig } from './client.js';
import { BraiinsInvalidRequestError, BraiinsNetworkError } from './errors.js';
import type { components, operations } from './generated/v2.js';
import { bidPath } from './v2-bid.js';
import { createV2Reads } from './v2-reads.js';
import { createV2Transport } from './v2-transport.js';

type Bid = components['schemas']['braiins.hashpower.trading.v2.Bid'];
type Update = operations['BidService_UpdateBid']['requestBody']['content']['application/json'];

function requestId(id?: string): string {
  if (!id || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id)) {
    throw new BraiinsInvalidRequestError(
      'A persisted UUID request_id is required for Braiins v2 bid changes',
    );
  }
  return id;
}
function sats(n: number, field: string): string {
  if (!Number.isSafeInteger(n) || n < 0)
    throw new BraiinsInvalidRequestError(field + ' must be a safe non-negative integer');
  return String(n);
}
function speed(n: number): number {
  if (!Number.isFinite(n) || n < 0)
    throw new BraiinsInvalidRequestError('speed_limit_ph must be finite and non-negative');
  return n;
}
function confirmation(bid: Bid, expectedId?: string): BidConfirmation & { id: string } {
  // The exchange may already have accepted the command. Missing confirmation is ambiguous.
  if (
    !bid?.bid_id ||
    typeof bid.bid_id !== 'string' ||
    bid.bid_id === '.' ||
    bid.bid_id === '..' ||
    typeof bid.state !== 'string' ||
    !bid.state ||
    (expectedId !== undefined && bid.bid_id !== expectedId)
  ) {
    throw new BraiinsNetworkError(
      'bid confirmation',
      'unexpected bid identity or state in the reply',
    );
  }
  const result: BidConfirmation & { id: string } = { id: bid.bid_id, bidState: bid.state };
  const settled = bid.settled?.amount_consumed_sat;
  if (settled !== undefined) {
    if (
      typeof settled !== 'string' ||
      !/^\d+$/.test(settled) ||
      !Number.isSafeInteger(Number(settled))
    ) {
      throw new BraiinsNetworkError(
        'bid confirmation',
        'invalid settled satoshi amount in the reply',
      );
    }
    result.settledAmountSat = Number(settled);
  }
  return result;
}

export function createV2Client(config: BraiinsClientConfig): BraiinsClient {
  const transport = createV2Transport(config);
  return {
    ...createV2Reads(transport),
    apiVersion: 'v2',
    getAccountId: transport.accountId,
    async placeBid(req, id, deadlineMs) {
      if (req.cl_order_id)
        throw new BraiinsInvalidRequestError('Braiins v2 does not accept a client order ID');
      if (!req.dest_upstream.url || !req.dest_upstream.identity) {
        throw new BraiinsInvalidRequestError('A pool URL and worker are required');
      }
      const body: operations['BidService_PlaceBid']['requestBody']['content']['application/json'] =
        {
          request_id: requestId(id),
          price_sat: sats(req.price_sat, 'price_sat'),
          amount_sat: sats(req.amount_sat, 'amount_sat'),
          destination: { pool_url: req.dest_upstream.url, worker: req.dest_upstream.identity },
          ...(req.speed_limit_ph === undefined || req.speed_limit_ph === 0
            ? {}
            : { speed_limit_ph: speed(req.speed_limit_ph) }),
          ...(req.memo !== undefined ? { memo: req.memo } : {}),
        };
      const bid = await transport.write<Bid>(
        'POST',
        await transport.accountPath('/bids', true),
        body,
        deadlineMs,
      );
      return confirmation(bid);
    },
    async editBid(req, id, deadlineMs) {
      const body: Update = { request_id: requestId(id) };
      if (req.new_price_sat !== undefined) body.price_sat = sats(req.new_price_sat, 'price_sat');
      if (req.new_amount_sat !== undefined)
        body.amount_sat = sats(req.new_amount_sat, 'amount_sat');
      if (req.new_speed_limit_ph?.value !== undefined)
        body.speed_limit_ph = speed(req.new_speed_limit_ph.value);
      if (req.memo !== undefined) body.memo = req.memo;
      const path = await transport.accountPath(bidPath(req.bid_id), true);
      const bid = await transport.write<Bid>('PATCH', path, body, deadlineMs);
      return confirmation(bid, req.bid_id);
    },
    async cancelBid(req, id, deadlineMs) {
      const body = { request_id: requestId(id) };
      const path = await transport.accountPath(bidPath(req.order_id) + ':cancel', true);
      const bid = await transport.write<Bid>('POST', path, body, deadlineMs);
      const { id: confirmedId, ...result } = confirmation(bid, req.order_id);
      return { affected_ids: { id: [confirmedId] }, ...result };
    },
  };
}
