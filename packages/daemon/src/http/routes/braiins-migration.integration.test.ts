import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBraiinsClient, type BraiinsClient } from '@hashrate-autopilot/braiins-client';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { applyBootMode } from '../../config/boot-mode.js';
import { prepareBraiinsAccount, V1MigrationGuard } from '../../config/braiins.js';
import { APP_CONFIG_DEFAULTS } from '../../config/schema.js';
import { V2BidMutations } from '../../services/v2-bid-mutations.js';
import { createSetupModeServer } from '../../setup-mode.js';
import { closeDatabase, openDatabase, type DatabaseHandle } from '../../state/db.js';
import { BidEventsRepo } from '../../state/repos/bid_events.js';
import { ConfigRepo } from '../../state/repos/config.js';
import { RuntimeStateRepo } from '../../state/repos/runtime_state.js';
import { SecretsRepo } from '../../state/repos/secrets.js';
import { registerRunModeRoute } from './run-mode.js';
import { registerSecurityRoutes } from './security.js';

const password = 'synthetic-password';
const account = 'matched-account';
const key = 'synthetic-braiins-key';
const rotate = { kind: 'v2', current_password: password, token: key, account_id: account };
const apps: FastifyInstance[] = [];
let directory: string;
let handle: DatabaseHandle;
let config: ConfigRepo;
let runtime: RuntimeStateRepo;
let secrets: SecretsRepo;

async function open() {
  handle = await openDatabase({ path: join(directory, 'state.sqlite') });
  config = new ConfigRepo(handle.db);
  runtime = new RuntimeStateRepo(handle.db);
  secrets = new SecretsRepo(handle.db);
  await runtime.initializeIfMissing();
}

async function close() {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await closeDatabase(handle);
}

async function routes(client: BraiinsClient, guard = new V1MigrationGuard()) {
  const app = Fastify();
  apps.push(app);
  await registerSecurityRoutes(app, {
    secretsRepo: secrets,
    secretSource: 'db',
    braiinsVersion: client.apiVersion ?? 'v1',
    v1MigrationGuard: guard,
    getCurrentPassword: () => password,
    setDashboardPassword: () => {
      throw new Error('Unexpected password update');
    },
  });
  await registerRunModeRoute(app, {
    runtimeRepo: runtime,
    secretsRepo: secrets,
    bidEventsRepo: new BidEventsRepo(handle.db),
    secretSource: 'db',
    braiinsClient: client,
  });
  return {
    state: async () => (await app.inject({ url: '/api/security/state' })).json(),
    migrate: () =>
      app.inject({ method: 'POST', url: '/api/security/braiins-token', payload: rotate }),
    mode: (run_mode: 'DRY_RUN' | 'LIVE') =>
      app.inject({ method: 'POST', url: '/api/run-mode', payload: { run_mode } }),
  };
}

async function boot() {
  const credentials = await secrets.get();
  const cfg = await config.get();
  if (!credentials || !cfg) throw new Error('Missing fixture configuration');
  const { clientConfig, requireDryRun } = await prepareBraiinsAccount(secrets, credentials);
  await applyBootMode(runtime, cfg.boot_mode, requireDryRun);
  return createBraiinsClient(clientConfig);
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'braiins-ui-migration-'));
  await open();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await close();
  await rm(directory, { recursive: true, force: true });
});

it('verifies, migrates, and holds an ALWAYS_LIVE installation through restarts until the operator confirms', async () => {
  const requests: Request[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const req = new Request(input, init);
    requests.push(req);
    if (req.method !== 'GET') throw new Error('Unexpected marketplace write');
    const path = new URL(req.url).pathname;
    if (path === '/v2/accounts') {
      const id = req.headers.get('Authorization') === 'Bearer ' + key ? account : 'other-account';
      return Response.json({ accounts: [{ account_id: id, display_name: 'Fixture Mining' }] });
    }
    if (path === '/v2/spot/accounts/' + account + '/bids') {
      return Response.json({
        next_page_token: '',
        bids: [
          {
            bid_id: 'B1',
            state: 'BID_STATE_ACTIVE',
            price_sat: '50000000',
            amount_sat: '25000',
            avg_speed_ph: 1,
            amount_remaining_sat: '25000',
            progress_pct: 0,
          },
        ],
      });
    }
    throw new Error('Unexpected marketplace read ' + path);
  };
  vi.stubGlobal('fetch', fetch);
  const setup = await createSetupModeServer({
    configRepo: config,
    secretsRepo: secrets,
    onSetupComplete: () => {
      throw new Error('Unexpected setup save');
    },
  });
  apps.push(setup.app);
  const preview = await setup.app.inject({
    method: 'POST',
    url: '/api/setup/braiins/verify',
    payload: { api_key: key },
  });
  expect(preview.statusCode).toBe(200);
  expect(preview.json().account_id).toBe(account);
  expect(requests).toHaveLength(1);
  expect(await secrets.get()).toBeNull();

  await config.upsert({
    ...APP_CONFIG_DEFAULTS,
    destination_pool_url: 'stratum+tcp://pool.example:3333',
    destination_pool_worker_name: 'worker',
    btc_payout_address: 'bc1qfixture',
    boot_mode: 'ALWAYS_LIVE',
  });
  await secrets.upsert({ braiins_owner_token: 'legacy', dashboard_password: password });
  handle.raw
    .prepare(
      "INSERT INTO owned_bids(braiins_order_id, created_at, last_known_status) VALUES ('B1', 0, 'BID_STATUS_ACTIVE')",
    )
    .run();
  const guard = new V1MigrationGuard();
  const legacy = await routes(await boot(), guard);
  expect((await runtime.get())?.run_mode).toBe('LIVE');
  const refusedLive = await legacy.migrate();
  expect(refusedLive.statusCode, refusedLive.body).toBe(409);
  expect(refusedLive.json().error).toMatch(/DRY-RUN|PAUSED/);
  expect((await legacy.mode('DRY_RUN')).statusCode).toBe(200);
  const finishWrite = guard.beginWrite();
  try {
    const refusedWrite = await legacy.migrate();
    expect(refusedWrite.statusCode, refusedWrite.body).toBe(409);
    expect(refusedWrite.json().error).toMatch(/in flight/);
  } finally {
    finishWrite();
  }
  expect((await legacy.migrate()).statusCode).toBe(200);
  expect(await legacy.state()).toMatchObject({
    braiins_active_api_version: 'v1',
    braiins_api_version: 'v2',
  });
  expect((await legacy.mode('LIVE')).statusCode).toBe(409);

  for (let restart = 0; restart < 2; restart++) {
    await close();
    await open();
    const client = await boot();
    const active = await routes(client);
    expect((await runtime.get())?.run_mode).toBe('DRY_RUN');
    expect(await active.state()).toMatchObject({
      braiins_active_api_version: 'v2',
      braiins_needs_live_confirmation: true,
    });
    const journal = new V2BidMutations(handle.db, client);
    await expect(
      journal.run({
        kind: 'EDIT_PRICE',
        braiins_order_id: 'B1',
        old_price_sat: 50_000_000,
        new_price_sat: 51_000_000,
        reason: 'fixture',
      }),
    ).rejects.toThrow(/require LIVE/);
    expect(await journal.pending()).toBeNull();
  }

  const beforeMismatch = requests.length;
  const wrong = await routes(
    createBraiinsClient({ apiVersion: 'v2', apiKey: 'wrong-account', accountId: account }),
  );
  expect((await wrong.mode('LIVE')).statusCode).toBe(409);
  expect(requests).toHaveLength(beforeMismatch + 1);
  expect(new URL(requests[beforeMismatch]!.url).pathname).toBe('/v2/accounts');
  expect((await secrets.getAccountBinding())?.needs_live_confirmation).toBe(1);
  const matching = await routes(await boot());
  expect((await matching.mode('LIVE')).statusCode).toBe(200);
  expect((await matching.state()).braiins_needs_live_confirmation).toBe(false);
  await close();
  await open();
  await boot();
  expect((await runtime.get())?.run_mode).toBe('LIVE');
  expect(requests.every((r) => r.method === 'GET')).toBe(true);
});

it('honors externally managed v1 when a shadowed DB row contains v2', async () => {
  vi.stubEnv('BHA_BRAIINS_API_VERSION', 'v1');
  await secrets.upsert({
    braiins_api_version: 'v2',
    braiins_api_key: key,
    dashboard_password: password,
  });
  const externallyManaged = await routes(
    createBraiinsClient({ apiVersion: 'v1', ownerToken: 'synthetic-legacy' }),
  );
  expect(await externallyManaged.state()).toMatchObject({
    braiins_active_api_version: 'v1',
    braiins_editable: false,
  });
  expect((await externallyManaged.mode('LIVE')).statusCode).toBe(200);
});
