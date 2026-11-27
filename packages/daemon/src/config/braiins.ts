import {
  createBraiinsClient,
  type BraiinsClient,
  type BraiinsClientConfig,
} from '@hashrate-autopilot/braiins-client';
import type { SecretsRepo } from '../state/repos/secrets.js';
import type { Secrets } from './schema.js';

export function braiinsClientConfig(secrets: Secrets): BraiinsClientConfig {
  return secrets.braiins_api_version === 'v2'
    ? {
        apiVersion: 'v2',
        ...(secrets.braiins_api_key ? { apiKey: secrets.braiins_api_key } : {}),
        ...(secrets.braiins_account_id ? { accountId: secrets.braiins_account_id } : {}),
      }
    : {
        ...(secrets.braiins_owner_token ? { ownerToken: secrets.braiins_owner_token } : {}),
        ...(secrets.braiins_read_only_token
          ? { readOnlyToken: secrets.braiins_read_only_token }
          : {}),
      };
}

// All probes use read access. A successful probe cannot establish trading permission.
export async function verifyV2Credentials(
  repo: SecretsRepo,
  config: BraiinsClientConfig,
): Promise<string> {
  const client = createBraiinsClient(config);
  const accountId = await client.getAccountId?.();
  if (!accountId || (config.accountId && config.accountId !== accountId)) {
    throw new Error('The API key does not grant the selected Braiins account.');
  }
  const pin = await repo.getAccountBinding();
  if (pin) {
    if (pin.account_id !== accountId)
      throw new Error('This state database belongs to a different Braiins account.');
    return accountId;
  }
  const witness = await repo.getAccountWitness();
  if (witness?.bidIds) {
    // Legacy credentials could have been rotated between accounts. Verify every
    // locally owned or cached bid, including settled orders, before adopting that history.
    const missing = new Set(witness.bidIds);
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await client.listBids({ limit: 500, ...(cursor && { page_token: cursor }) });
      for (const item of page.items) missing.delete(item.bid.id);
      if (!missing.size) break;
      cursor = page.next_page_token;
      if (cursor && seen.has(cursor))
        throw new Error('Braiins returned a repeated bid-history cursor.');
      if (cursor) seen.add(cursor);
    } while (cursor);
    if (missing.size)
      throw new Error('The key cannot access all historical bids in this database.');
  } else if (witness?.deposit) {
    const deposit = witness.deposit;
    if (!deposit.address)
      throw new Error('Historical deposits have no recorded address to verify this account.');
    // A wallet can have transactions newer than the entire local observation window.
    // The v2 read adapter follows page tokens up to the requested limit.
    const { transactions } = await client.getOnChainTransactions({ limit: Infinity });
    if (
      !transactions.some(
        (tx) =>
          tx.tx_id === deposit.tx_id &&
          tx.tx_type === 'ONCHAIN_TRANSACTION_TYPE_DEPOSIT' &&
          tx.address === deposit.address &&
          tx.amount_sat === deposit.amount_sat,
      )
    ) {
      throw new Error('The key cannot be matched to the deposit history in this database.');
    }
  }
  return accountId;
}

export async function prepareBraiinsAccount(repo: SecretsRepo, secrets: Secrets) {
  const clientConfig = braiinsClientConfig(secrets);
  const pin = await repo.getAccountBinding();
  if (clientConfig.apiVersion !== 'v2') {
    if (pin)
      throw new Error(
        'This database is bound to Braiins v2. Configure a key for its existing account.',
      );
    return { clientConfig, requireDryRun: false };
  }
  if (pin) {
    if (clientConfig.accountId && clientConfig.accountId !== pin.account_id) {
      throw new Error('The configured account differs from the existing Braiins account binding.');
    }
    return {
      clientConfig: { ...clientConfig, accountId: pin.account_id },
      requireDryRun: !!pin.needs_live_confirmation,
    };
  }
  const accountId = await verifyV2Credentials(repo, clientConfig);
  const requireDryRun = await repo.bindV2Account(accountId);
  return { clientConfig: { ...clientConfig, accountId }, requireDryRun };
}

// Gate all v1 writers, including manual stale-bid cleanup, while the operator
// changes protocol. The old in-memory client lives until process restart.
export class V1MigrationGuard {
  private writes = 0;
  private closed = false;

  wrap(client: BraiinsClient): BraiinsClient {
    if (client.apiVersion === 'v2') return client;
    return {
      ...client,
      placeBid: (...args) => this.write(() => client.placeBid(...args)),
      editBid: (...args) => this.write(() => client.editBid(...args)),
      cancelBid: (...args) => this.write(() => client.cancelBid(...args)),
    };
  }

  beginWrite(): () => void {
    if (this.closed) throw new Error('A Braiins API migration is pending. Restart the daemon.');
    this.writes++;
    return () => {
      this.writes--;
    };
  }

  private async write<T>(action: () => Promise<T>): Promise<T> {
    const finish = this.beginWrite();
    try {
      return await action();
    } finally {
      finish();
    }
  }

  async migrate(action: () => Promise<void>): Promise<void> {
    if (this.closed) throw new Error('A Braiins API migration is pending. Restart the daemon.');
    if (this.writes)
      throw new Error('A legacy bid change is still in flight. Wait for it to settle.');
    this.closed = true;
    try {
      await action();
    } catch (err) {
      this.closed = false;
      throw err;
    }
  }
}
