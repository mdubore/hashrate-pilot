import type { components } from './generated/v2.js';
import type { BidItem } from './read-types.js';
import { BraiinsInvalidRequestError } from './errors.js';

export function bidPath(id?: string): string {
  if (!id || id === '.' || id === '..')
    throw new BraiinsInvalidRequestError('The public Braiins bid ID is required');
  return '/bids/' + encodeURIComponent(id);
}

type V2BidState = components['schemas']['braiins.hashpower.trading.v2.BidState'];

const bidStates = new Map<string, BidItem['bid']['status']>(
  Object.entries({
    BID_STATE_UNSPECIFIED: 'BID_STATUS_UNSPECIFIED',
    BID_STATE_ACTIVE: 'BID_STATUS_ACTIVE',
    BID_STATE_CANCELING: 'BID_STATUS_PENDING_CANCEL',
    BID_STATE_CANCELED: 'BID_STATUS_CANCELED',
    BID_STATE_FULFILLED: 'BID_STATUS_FULFILLED',
    BID_STATE_PAUSED: 'BID_STATUS_PAUSED',
    BID_STATE_FROZEN: 'BID_STATUS_FROZEN',
    BID_STATE_CREATED: 'BID_STATUS_CREATED',
    BID_STATE_CREATING: 'BID_STATUS_CREATING',
    BID_STATE_UPDATING: 'BID_STATUS_UPDATING',
  } satisfies Record<V2BidState, BidItem['bid']['status']>),
);

export function normalizeV2BidState(state: string | undefined): BidItem['bid']['status'] {
  return bidStates.get(state ?? '') ?? 'BID_STATUS_UNSPECIFIED';
}
