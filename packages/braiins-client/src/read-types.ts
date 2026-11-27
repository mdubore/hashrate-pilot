// The read model retains v1 field names used by the controller. Fields that
// exist in just one API version stay absent when the other version answers.
import type { components } from './generated/types.js';

type V1 = components['schemas'];
type OptionalFields<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

export type MarketStats = OptionalFields<
  V1['SpotGetMarketStatsResponse'],
  'volume_24h_m' | 'best_bid_sat' | 'best_ask_sat' | 'last_avg_price_sat'
> & {
  volume_24h_eh_day?: number;
  last_price_sat?: number;
};
export type MarketSettings = OptionalFields<
  V1['MarketSettings'],
  | 'status'
  | 'created'
  | 'min_ask_price_sat'
  | 'max_ask_price_sat'
  | 'max_bid_idle_time_s'
  | 'max_asks_per_subaccount'
  | 'ask_grace_period_s'
>;
export type OrderbookSnapshot = {
  bids: OptionalFields<V1['BidItem'], 'speed_limit_ph'>[];
  asks: V1['AskItem'][];
};
export type FeeSchedule = { spot_fees: OptionalFields<V1['SpotFeePublic'], 'symbol'>[] };

export type AccountBalance = Partial<V1['AccountBalance']> &
  Pick<
    V1['AccountBalance'],
    | 'subaccount'
    | 'currency'
    | 'total_balance_sat'
    | 'blocked_balance_sat'
    | 'available_balance_sat'
  >;
export type AccountBalances = { accounts: AccountBalance[] };

type Bid = Omit<Partial<V1['SpotMarketBid']>, 'id' | 'price_sat' | 'status' | 'is_current'> & {
  id: string;
  price_sat: number;
  status: V1['SpotMarketBidStatus'] | 'BID_STATUS_CREATING' | 'BID_STATUS_UPDATING';
  is_current: boolean;
  amount_sat?: number;
  speed_limit_ph?: number;
};
export type BidItem = {
  bid: Bid;
  counters_committed?: Partial<V1['SpotMarketBidCounters']>;
  counters_estimate?: Partial<V1['SpotMarketBidCounters']>;
  state_estimate?: V1['SpotMarketBidState'];
  last_network_failure?: V1['UpstreamFailure'];
};
export type BidsResponse = { items: BidItem[]; next_page_token?: string };
export type BidDetail = BidItem & Pick<V1['SpotGetBidDetailResponse'], 'history'>;
export type Transaction = OptionalFields<V1['Transaction'], 'details'> & {
  transaction_id?: string;
  bid_id?: string;
  contract_id?: string;
  available_change_sat?: number;
  blocked_change_sat?: number;
};
export type TransactionsResponse = { transactions: Transaction[] };
export type OnChainTransactionType = V1['OnChainTransactionType'] | string;
export type DepositStatus = V1['DepositStatus'] | string;
export type OnChainTransaction = Omit<V1['OnChainTransaction'], 'tx_type' | 'deposit_status'> & {
  tx_type: OnChainTransactionType;
  deposit_status?: DepositStatus;
};
export type OnChainTransactionsResponse = { transactions: OnChainTransaction[] };
export type BidDeliveryHistoryItem = V1['SpotBidDeliveryHistoryItem'];
export interface BidDeliveryHistory {
  items: BidDeliveryHistoryItem[];
  /** v2 interval-average hashrates, in PH/s. v1 provides share counts in items. */
  samples?: {
    start_time: string;
    purchased_ph: number;
    accepted_ph: number;
    rejected_ph: number;
  }[];
}
