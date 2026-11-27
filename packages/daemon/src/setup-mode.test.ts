import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfigRepo } from './state/repos/config.js';
import { SecretsRepo } from './state/repos/secrets.js';
import { closeDatabase, openDatabase, type DatabaseHandle } from './state/db.js';
import {
  createSetupModeServer,
  detectBitcoindEnv,
  type SetupModeServer,
} from './setup-mode.js';
import { APP_CONFIG_DEFAULTS } from './config/schema.js';

function validSetupPayload() {
  return {
    config: {
      ...APP_CONFIG_DEFAULTS,
      destination_pool_url: 'stratum+tcp://datum.local:23334',
      destination_pool_worker_name: 'bc1qexample.rig1',
      btc_payout_address: 'bc1qexample',
    },
    secrets: {
      braiins_owner_token: 'owner-tok',
      dashboard_password: 'pw-12345678',
    },
  };
}

describe('createSetupModeServer', () => {
  let handle: DatabaseHandle;
  let configRepo: ConfigRepo;
  let secretsRepo: SecretsRepo;
  let server: SetupModeServer;
  const onSetupComplete = vi.fn();
  const log = vi.fn();

  beforeEach(async () => {
    handle = await openDatabase({ path: ':memory:' });
    configRepo = new ConfigRepo(handle.db);
    secretsRepo = new SecretsRepo(handle.db);
    server = await createSetupModeServer({
      configRepo,
      secretsRepo,
      onSetupComplete: onSetupComplete.mockClear(),
      log: log.mockClear(),
    });
    await server.app.ready();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server.stop();
    await closeDatabase(handle);
  });

  describe('POST /api/setup/braiins/verify', () => {
    const url = '/api/setup/braiins/verify';
    const apiKey = 'synthetic-preview-key';
    const account = { account_id: 'acct-1', display_name: 'Acme Mining' };
    const verify = () =>
      server.app.inject({
        method: 'POST',
        url,
        payload: { api_key: '  ' + apiKey + '  ' },
      });

    it('makes one read to the v2 origin per check, without saving or completing setup', async () => {
      const exchange = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new Error('unexpected exchange call'))
        .mockResolvedValueOnce(Response.json({ accounts: [{ ...account, extra: apiKey }] }))
        .mockResolvedValueOnce(Response.json({ accounts: [{ account_id: 'acct-2' }] }));
      const first = await verify();
      expect(first.statusCode).toBe(200);
      expect(first.json()).toEqual(account);
      const second = await verify();
      expect(second.json()).toEqual({ account_id: 'acct-2' });
      expect(exchange).toHaveBeenCalledTimes(2);
      for (const [input, init] of exchange.mock.calls) {
        expect(String(input)).toBe('https://hashpower.braiins.com/v2/accounts');
        expect(init?.method).toBe('GET');
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ' + apiKey);
        expect(init?.body).toBeUndefined();
      }
      expect(await configRepo.get()).toBeNull();
      expect(await secretsRepo.exists()).toBe(false);
      expect(await secretsRepo.getAccountBinding()).toBeUndefined();
      expect(onSetupComplete).not.toHaveBeenCalled();
      expect(JSON.stringify(log.mock.calls)).not.toContain(apiKey);
    });

    it.each([
      '{}',
      '{"api_key":"   "}',
      '{"api_key":7}',
      JSON.stringify({ api_key: apiKey, baseUrl: 'https://example.invalid' }),
      '{"api_key":"' + apiKey,
    ])('rejects invalid input with only an error code', async (payload) => {
      const exchange = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new Error('unexpected call'));
      const response = await server.app.inject({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/json' },
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'invalid_input' });
      expect(exchange).not.toHaveBeenCalled();
    });

    it.each([
      ['401', () => new Response(apiKey, { status: 401 }), 422, 'credential_rejected'],
      ['403', () => new Response(apiKey, { status: 403 }), 422, 'credential_rejected'],
      ['empty accounts', () => Response.json({ accounts: [] }), 422, 'account_unavailable'],
      ['omitted accounts', () => Response.json({}), 422, 'account_unavailable'],
      [
        'multiple accounts',
        () => Response.json({ accounts: [account, { account_id: 'acct-2' }] }),
        422,
        'account_unavailable',
      ],
      ['429', () => new Response(apiKey, { status: 429 }), 503, 'temporarily_unavailable'],
      ['502', () => new Response(apiKey, { status: 502 }), 503, 'temporarily_unavailable'],
      [
        'timeout',
        () => {
          throw new DOMException(apiKey, 'TimeoutError');
        },
        503,
        'temporarily_unavailable',
      ],
      ['invalid JSON', () => new Response(apiKey), 503, 'temporarily_unavailable'],
      ['null account list', () => Response.json({ accounts: null }), 503, 'temporarily_unavailable'],
      ['null response', () => Response.json(null), 503, 'temporarily_unavailable'],
      ['array response', () => Response.json([]), 503, 'temporarily_unavailable'],
      [
        'unexpected shape',
        () => Response.json({ accounts: apiKey }),
        503,
        'temporarily_unavailable',
      ],
    ] as const)(
      'classifies %s without retrying or echoing upstream details',
      async (_label, respond, code, error) => {
        const exchange = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => respond());
        const response = await verify();
        expect(response.statusCode).toBe(code);
        expect(response.json()).toEqual({ error });
        expect(exchange).toHaveBeenCalledOnce();
        expect(onSetupComplete).not.toHaveBeenCalled();
        expect(JSON.stringify(log.mock.calls)).not.toContain(apiKey);
      },
    );

    it.each(['revoked key', 'different history'] as const)(
      'rechecks final credentials and preserves the database after a successful preview and %s',
      async (failure) => {
        const original = validSetupPayload();
        await configRepo.upsert(original.config);
        await secretsRepo.upsert(original.secrets);
        handle.raw
          .prepare("INSERT INTO owned_bids(braiins_order_id, created_at) VALUES ('B1', 0)")
          .run();
        const previousSecrets = await secretsRepo.get();
        const previousConfig = await configRepo.get();
        const accountReply = () => Response.json({ accounts: [account] });
        const exchange = vi
          .spyOn(globalThis, 'fetch')
          .mockRejectedValue(new Error('unexpected exchange call'))
          .mockResolvedValueOnce(accountReply())
          .mockResolvedValueOnce(
            failure === 'revoked key' ? new Response(null, { status: 401 }) : accountReply(),
          );
        if (failure === 'different history')
          exchange.mockResolvedValueOnce(Response.json({ bids: [], next_page_token: '' }));
        expect((await verify()).json()).toEqual(account);
        const finalKey = failure === 'revoked key' ? apiKey : 'synthetic-other-key';
        const final = await server.app.inject({
          method: 'POST',
          url: '/api/setup',
          payload: {
            config: { ...original.config, destination_pool_worker_name: 'replacement' },
            secrets: {
              braiins_api_version: 'v2',
              braiins_api_key: finalKey,
              dashboard_password: 'replacement-password',
            },
          },
        });
        expect(final.statusCode).toBe(422);
        const paths = ['/v2/accounts', '/v2/accounts'];
        if (failure === 'different history') paths.push('/v2/spot/accounts/acct-1/bids');
        expect(exchange.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual(
          paths,
        );
        expect(exchange.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
        expect(new Headers(exchange.mock.calls[1]?.[1]?.headers).get('authorization')).toBe(
          'Bearer ' + finalKey,
        );
        expect(await configRepo.get()).toEqual(previousConfig);
        expect(await secretsRepo.get()).toEqual(previousSecrets);
        expect(await secretsRepo.getAccountBinding()).toBeUndefined();
        expect(await secretsRepo.getAccountWitness()).toEqual({ bidIds: ['B1'] });
        expect(onSetupComplete).not.toHaveBeenCalled();
        expect((await server.app.inject({ url: '/api/health' })).json().mode).toBe('NEEDS_SETUP');
      },
    );
  });

  it('verifies a v2-only first run using just GET accounts and keeps the key out of setup-info', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      expect(new URL(String(url)).pathname).toBe('/v2/accounts');
      expect(options?.method).toBe('GET');
      expect(new Headers(options?.headers).get('authorization')).toBe('Bearer synthetic-v2');
      return Response.json({ accounts: [{ account_id: 'matched-account' }] });
    });
    try {
      const res = await server.app.inject({
        method: 'POST', url: '/api/setup',
        payload: {
          config: validSetupPayload().config,
          secrets: { braiins_api_version: 'v2', braiins_api_key: 'synthetic-v2', dashboard_password: 'pw-12345678' },
        },
      });
      expect(res.statusCode).toBe(200);
      expect(fetch).toHaveBeenCalledOnce();
      expect(await secretsRepo.get()).toMatchObject({ braiins_api_version: 'v2', braiins_account_id: 'matched-account' });
      expect((await server.app.inject({ url: '/api/setup-info' })).body).not.toContain('synthetic-v2');
    } finally {
      fetch.mockRestore();
    }
  });

  it('GET /api/health returns NEEDS_SETUP mode without auth', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', mode: 'NEEDS_SETUP' });
  });

  it('GET /api/setup-info exposes defaults and existing flags (no row yet)', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/api/setup-info' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      has_existing_config: boolean;
      has_existing_secrets: boolean;
      defaults: { target_hashrate_ph: number; destination_pool_url: string };
      current_config: unknown;
    };
    expect(body.has_existing_config).toBe(false);
    expect(body.has_existing_secrets).toBe(false);
    expect(body.defaults.target_hashrate_ph).toBe(APP_CONFIG_DEFAULTS.target_hashrate_ph);
    expect(body.defaults.destination_pool_url).toBe('stratum+tcp://your-public-host:23334');
    expect(body.current_config).toBeNull();
  });

  it('GET /api/setup-info reports existing config when one exists', async () => {
    await configRepo.upsert(validSetupPayload().config);
    const res = await server.app.inject({ method: 'GET', url: '/api/setup-info' });
    const body = res.json() as { has_existing_config: boolean; current_config: unknown };
    expect(body.has_existing_config).toBe(true);
    expect(body.current_config).not.toBeNull();
  });

  it('GET /api/setup-info blanks stored credentials (GHSA-35jm-xg76-3hh4)', async () => {
    await configRepo.upsert({
      ...validSetupPayload().config,
      bitcoind_rpc_url: 'http://node.local:8332',
      bitcoind_rpc_user: 'rpcuser',
      bitcoind_rpc_password: 'rpc-secret',
      telegram_bot_token: 'bot:SECRET',
      ddns_credential: 'ddns-secret',
    });
    const res = await server.app.inject({ method: 'GET', url: '/api/setup-info' });
    expect(res.body).not.toContain('rpc-secret');
    expect(res.body).not.toContain('bot:SECRET');
    expect(res.body).not.toContain('ddns-secret');
    const body = res.json() as { current_config: Record<string, unknown> };
    expect(body.current_config['bitcoind_rpc_user']).toBe('rpcuser');
    expect(body.current_config['bitcoind_rpc_password']).toBe('');
  });

  it('POST /api/setup keeps stored credentials sent back blank', async () => {
    await configRepo.upsert({
      ...validSetupPayload().config,
      telegram_bot_token: 'bot:SECRET',
      ddns_credential: 'ddns-secret',
    });
    const res = await server.app.inject({ method: 'POST', url: '/api/setup', payload: validSetupPayload() });
    expect(res.statusCode).toBe(200);
    const saved = await configRepo.get();
    expect(saved?.telegram_bot_token).toBe('bot:SECRET');
    expect(saved?.ddns_credential).toBe('ddns-secret');
  });

  it('POST /api/setup refuses to send a stored RPC password to a new URL', async () => {
    await configRepo.upsert({
      ...validSetupPayload().config,
      bitcoind_rpc_url: 'http://node.local:8332',
      bitcoind_rpc_user: 'rpcuser',
      bitcoind_rpc_password: 'rpc-secret',
    });
    const payload = validSetupPayload();
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: {
        ...payload,
        config: {
          ...payload.config,
          bitcoind_rpc_url: 'http://evil.example:8332',
          bitcoind_rpc_user: 'rpcuser',
          bitcoind_rpc_password: '',
        },
      },
    });
    expect(res.statusCode).toBe(400);
    expect((await configRepo.get())?.bitcoind_rpc_url).toBe('http://node.local:8332');
  });

  it('does not reflect a foreign Origin (same-origin CORS)', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/setup-info',
      headers: { origin: 'https://evil.example', host: 'umbrel.local:3010' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('POST /api/setup writes config + secrets and returns 200', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: validSetupPayload(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    const cfg = await configRepo.get();
    expect(cfg).not.toBeNull();
    expect(cfg!.btc_payout_address).toBe('bc1qexample');
    const secrets = await secretsRepo.get();
    expect(secrets).not.toBeNull();
    expect(secrets!.braiins_owner_token).toBe('owner-tok');
  });

  it('POST /api/setup invokes onSetupComplete after a successful write', async () => {
    let called = false;
    const ad = await openDatabase({ path: ':memory:' });
    const cr = new ConfigRepo(ad.db);
    const sr = new SecretsRepo(ad.db);
    const s = await createSetupModeServer({
      configRepo: cr,
      secretsRepo: sr,
      onSetupComplete: () => {
        called = true;
      },
    });
    try {
      await s.app.ready();
      const res = await s.app.inject({
        method: 'POST',
        url: '/api/setup',
        payload: validSetupPayload(),
      });
      expect(res.statusCode).toBe(200);
      expect(called).toBe(true);
    } finally {
      await s.stop();
      await closeDatabase(ad);
    }
  });

  it('does NOT invoke onSetupComplete on a malformed payload', async () => {
    let called = false;
    const ad = await openDatabase({ path: ':memory:' });
    const cr = new ConfigRepo(ad.db);
    const sr = new SecretsRepo(ad.db);
    const s = await createSetupModeServer({
      configRepo: cr,
      secretsRepo: sr,
      onSetupComplete: () => {
        called = true;
      },
    });
    try {
      await s.app.ready();
      const res = await s.app.inject({
        method: 'POST',
        url: '/api/setup',
        payload: { config: {}, secrets: {} },
      });
      expect(res.statusCode).toBe(400);
      expect(called).toBe(false);
    } finally {
      await s.stop();
      await closeDatabase(ad);
    }
  });

  it('POST /api/setup rejects malformed payload with 400 + Zod error details', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: {
        config: { target_hashrate_ph: -1 }, // missing required fields, negative
        secrets: { braiins_owner_token: '' }, // empty
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string; details: unknown[] };
    expect(body.error).toBe('invalid_setup_payload');
    expect(body.details.length).toBeGreaterThan(0);
  });

  it('POST /api/setup rejects floor > target invariant', async () => {
    const payload = validSetupPayload();
    payload.config.minimum_floor_hashrate_ph = 99;
    payload.config.target_hashrate_ph = 1;
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/setup',
      payload,
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 412 + needs_setup on any unrecognised /api/* path', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/status',
    });
    expect(res.statusCode).toBe(412);
    expect(res.json()).toEqual({ error: 'needs_setup', needs_setup: true });
  });

  it('returns 412 on /api/config/whatever (not just exact paths)', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/api/config' });
    expect(res.statusCode).toBe(412);
  });

  it('non-/api paths get the SPA fallback (404 since no static root)', async () => {
    // No staticRoot configured for these tests, so the SPA fallback's
    // sendFile fails - but the handler should still NOT return 412
    // for non-/api paths. We expect a 5xx from the missing static
    // file rather than the 412 from the API gate.
    const res = await server.app.inject({ method: 'GET', url: '/setup' });
    expect(res.statusCode).not.toBe(412);
  });
});

describe('detectBitcoindEnv', () => {
  it('returns all-null when no env vars are set', () => {
    expect(detectBitcoindEnv({})).toEqual({ url: null, user: null, password: null });
  });

  it('uses BITCOIN_RPC_URL when present', () => {
    expect(
      detectBitcoindEnv({ BITCOIN_RPC_URL: 'http://10.0.0.1:8332' }),
    ).toEqual({ url: 'http://10.0.0.1:8332', user: null, password: null });
  });

  it('synthesises URL from BITCOIN_RPC_HOST + BITCOIN_RPC_PORT when URL is absent', () => {
    expect(
      detectBitcoindEnv({
        BITCOIN_RPC_HOST: '10.21.21.8',
        BITCOIN_RPC_PORT: '8332',
      }),
    ).toEqual({ url: 'http://10.21.21.8:8332', user: null, password: null });
  });

  it('host alone (no port) does not synthesise a URL', () => {
    expect(
      detectBitcoindEnv({ BITCOIN_RPC_HOST: '10.21.21.8' }),
    ).toEqual({ url: null, user: null, password: null });
  });

  it('explicit URL wins over the host+port pair', () => {
    expect(
      detectBitcoindEnv({
        BITCOIN_RPC_URL: 'http://from-url:18332',
        BITCOIN_RPC_HOST: 'ignored',
        BITCOIN_RPC_PORT: '8332',
      }),
    ).toEqual({ url: 'http://from-url:18332', user: null, password: null });
  });

  it('captures user + password', () => {
    expect(
      detectBitcoindEnv({
        BITCOIN_RPC_URL: 'http://10.0.0.1:8332',
        BITCOIN_RPC_USER: 'alice',
        BITCOIN_RPC_PASSWORD: 'secret',
      }),
    ).toEqual({
      url: 'http://10.0.0.1:8332',
      user: 'alice',
      password: 'secret',
    });
  });

  it('accepts BITCOIN_RPC_PASS as a synonym for BITCOIN_RPC_PASSWORD', () => {
    expect(
      detectBitcoindEnv({
        BITCOIN_RPC_URL: 'http://10.0.0.1:8332',
        BITCOIN_RPC_PASS: 'pass-via-PASS',
      }),
    ).toEqual({
      url: 'http://10.0.0.1:8332',
      user: null,
      password: 'pass-via-PASS',
    });
  });

  it('whitespace-only values are treated as missing', () => {
    expect(
      detectBitcoindEnv({
        BITCOIN_RPC_URL: '   ',
        BITCOIN_RPC_USER: '\t\n',
      }),
    ).toEqual({ url: null, user: null, password: null });
  });
});
