import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSecretsFromEnv, hasBraiinsCredentialOverrides } from './env-overrides.js';
import { verifyV2Credentials } from './braiins.js';
import { SecretsSchema } from './schema.js';
import { SecretCrypto } from './secret-crypto.js';
import { openDatabase, closeDatabase, type DatabaseHandle } from '../state/db.js';
import { SecretsRepo } from '../state/repos/secrets.js';

const credentials = {
  braiins_api_version: 'v2' as const,
  braiins_api_key: 'synthetic-key',
  dashboard_password: 'synthetic-password',
};
describe('Braiins v2 credentials', () => {
  let handle: DatabaseHandle;
  let repo: SecretsRepo;
  beforeEach(async () => {
    handle = await openDatabase({ path: ':memory:' });
    repo = new SecretsRepo(handle.db, new SecretCrypto(Buffer.alloc(32, 1)));
  });
  afterEach(async () => {
    await closeDatabase(handle);
  });
  it('requires the explicitly selected credential and accepts v2-only environment installs', () => {
    expect(hasBraiinsCredentialOverrides({ BHA_BRAIINS_PRICE_SMOOTHING_MINUTES: '4' })).toBe(false);
    expect(hasBraiinsCredentialOverrides({ BHA_BRAIINS_API_KEY: 'from-env' })).toBe(true);
    expect(SecretsSchema.safeParse(credentials).success).toBe(true);
    expect(SecretsSchema.safeParse({ ...credentials, braiins_api_version: 'v1' }).success).toBe(
      false,
    );
    expect(
      buildSecretsFromEnv({
        BHA_BRAIINS_API_VERSION: 'v2',
        BHA_BRAIINS_API_KEY: 'synthetic-key',
        BHA_DASHBOARD_PASSWORD: 'synthetic-password',
      }),
    ).toEqual(credentials);
  });
  it('encrypts a v2 key and round trips without a dummy legacy owner token', async () => {
    await repo.upsert(credentials);
    expect(await repo.get()).toMatchObject({
      braiins_api_version: 'v2',
      braiins_api_key: 'synthetic-key',
    });
    const row = handle.raw.prepare('SELECT * FROM secrets').get() as Record<string, string | null>;
    expect(row.braiins_owner_token).toBeNull();
    expect(row.braiins_api_key).toMatch(/^enc:v1:/);
  });
  it('preserves the encrypted legacy row byte-for-byte when upgrading an existing database', async () => {
    const legacySql = readFileSync(
      new URL('../state/migrations/0047_secrets_table.sql', import.meta.url),
      'utf8',
    );
    const migrate = readFileSync(
      new URL('../state/migrations/0125_braiins_v2_credentials.sql', import.meta.url),
      'utf8',
    );
    handle.raw.exec('DROP TABLE secrets; DROP TABLE braiins_account_binding;');
    handle.raw.exec(legacySql);
    handle.raw.exec('ALTER TABLE secrets DROP COLUMN telegram_webhook_secret');
    const cipher = new SecretCrypto(Buffer.alloc(32, 1));
    const owner = cipher.encrypt('braiins_owner_token', 'old-owner');
    const reader = cipher.encrypt('braiins_read_only_token', 'old-reader');
    handle.raw
      .prepare(
        'INSERT INTO secrets(id, braiins_owner_token, braiins_read_only_token, dashboard_password, updated_at) VALUES(1, ?, ?, ?, 42)',
      )
      .run(owner, reader, 'old-dash');
    handle.raw.transaction(() => handle.raw.exec(migrate))();
    expect(
      handle.raw
        .prepare('SELECT braiins_owner_token, braiins_read_only_token, updated_at FROM secrets')
        .get(),
    ).toEqual({ braiins_owner_token: owner, braiins_read_only_token: reader, updated_at: 42 });
    expect(await repo.get()).toEqual({
      braiins_owner_token: 'old-owner',
      braiins_read_only_token: 'old-reader',
      dashboard_password: 'old-dash',
    });
  });
  it('refuses a LIVE v1 migration; once paused, switching preserves the legacy secrets and password', async () => {
    await repo.upsert({
      braiins_owner_token: 'owner',
      braiins_read_only_token: 'reader',
      dashboard_password: 'password-only',
    });
    const { RuntimeStateRepo } = await import('../state/repos/runtime_state.js');
    const runtime = new RuntimeStateRepo(handle.db);
    await runtime.initializeIfMissing();
    await runtime.patch({ run_mode: 'LIVE' });
    await expect(repo.saveV2Key('synthetic-key', 'mine', 'mine')).rejects.toThrow(/DRY-RUN/);
    expect((await repo.get())?.braiins_api_key).toBeUndefined();
    await runtime.patch({ run_mode: 'PAUSED' });
    const previous = await repo.get();
    await repo.saveV2Key('synthetic-key', 'mine', 'mine');
    expect(await repo.get()).toEqual({
      ...previous,
      braiins_api_version: 'v2',
      braiins_api_key: 'synthetic-key',
      braiins_account_id: 'mine',
    });
  });
  it('verifies all owned and cached legacy bid IDs against the selected account history', async () => {
    handle.raw
      .prepare("INSERT INTO owned_bids(braiins_order_id, created_at) VALUES ('B1', 0)")
      .run();
    handle.raw.prepare("INSERT INTO closed_bids_cache VALUES ('B2', 15, 0, 0)").run();
    let secondId = 'OTHER';
    const fetch: typeof globalThis.fetch = async (url, init) => {
      expect(init?.method).toBe('GET');
      const path = new URL(String(url));
      if (path.pathname === '/v2/accounts')
        return Response.json({ accounts: [{ account_id: 'mine' }] });
      expect(path.pathname).toBe('/v2/spot/accounts/mine/bids');
      const second = path.searchParams.get('page_token') === 'page-two';
      const bid = {
        bid_id: second ? secondId : 'B1',
        state: 'BID_STATE_FULFILLED',
        price_sat: '1',
        amount_sat: '15000',
        avg_speed_ph: 1,
        amount_remaining_sat: '0',
        progress_pct: 100,
      };
      return Response.json({ bids: [bid], next_page_token: second ? '' : 'page-two' });
    };
    const config = { apiVersion: 'v2' as const, apiKey: 'fixture', fetch };
    await expect(verifyV2Credentials(repo, config)).rejects.toThrow(/all historical bids/);
    secondId = 'B2';
    expect(await verifyV2Credentials(repo, config)).toBe('mine');
  });

  it('requires the matching deposit output when multiple customers share a batched transaction', async () => {
    handle.raw
      .prepare(
        'INSERT INTO braiins_deposits(tx_id, address, amount_sat, last_seen_status, first_seen_at_ms, updated_at_ms) VALUES(?, ?, 10, 1, 0, 0)',
      )
      .run('shared-tx', 'our-address');
    let address = 'other-address';
    const fetch: typeof globalThis.fetch = async (url, init) => {
      expect(init?.method).toBe('GET');
      if (new URL(String(url)).pathname === '/v2/accounts') {
        return Response.json({ accounts: [{ account_id: 'account' }] });
      }
      return Response.json({
        next_page_token: '',
        transactions: [
          {
            type: 'ON_CHAIN_TRANSACTION_TYPE_DEPOSIT',
            amount_sat: '10',
            tx_id: 'shared-tx',
            address,
            time: '2026-11-26T00:00:00Z',
          },
        ],
      });
    };
    const config = { apiVersion: 'v2' as const, apiKey: 'fixture', fetch };
    await expect(verifyV2Credentials(repo, config)).rejects.toThrow(/deposit history/);
    address = 'our-address';
    expect(await verifyV2Credentials(repo, config)).toBe('account');
  });

  it('rejects the wrong account without creating a binding or changing the saved key', async () => {
    await repo.upsert({ braiins_owner_token: 'legacy', dashboard_password: 'password-only' });
    await expect(repo.saveV2Key('synthetic-key', 'other', 'mine')).rejects.toThrow(/account/i);
    expect((await repo.get())?.braiins_owner_token).toBe('legacy');
    expect((await repo.get())?.braiins_api_key).toBeUndefined();
  });
  it('requires the operator to enable live explicitly even across a second boot', async () => {
    expect(await repo.bindV2Account('mine')).toBe(true);
    expect(await repo.bindV2Account('mine')).toBe(true);
    await expect(repo.bindV2Account('other')).rejects.toThrow(/account/i);
    await repo.confirmLiveAccount('mine');
    expect(await repo.bindV2Account('mine')).toBe(false);
  });
});
