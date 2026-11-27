import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerSecurityRoutes, type SecurityRouteDeps } from './security.js';
import { hashPassword } from '../../config/password-hash.js';

// Mock the Braiins client so token validation doesn't hit the network:
// "GOOD" authenticates, anything else is rejected.
vi.mock('@hashrate-autopilot/braiins-client', () => ({
  createBraiinsClient: (cfg: { ownerToken?: string; readOnlyToken?: string; apiKey?: string }) => ({
    getAccountId: async () => {
      if (cfg.apiKey !== 'TEST_API_KEY') throw new Error('unauthenticated');
      return 'account-one';
    },
    getBalance: async () => {
      const tok = cfg.ownerToken ?? cfg.readOnlyToken;
      if (tok === 'GOOD') return { available_sat: 0 };
      throw new Error('grpc: unauthenticated');
    },
  }),
}));

const CURRENT = 'current-pw-123';

function build(source: 'env' | 'sops' | 'db') {
  const applied: string[] = [];
  const setBraiinsToken = vi.fn(async () => true);
  const setDashboardPassword = vi.fn(async (_pw: string) => hashPassword('irrelevant'));
  const saveV2Key = vi.fn();
  const deps: SecurityRouteDeps = {
    secretsRepo: {
      setDashboardPassword, setBraiinsToken, saveV2Key,
      getBraiinsSettings: async () => ({ braiins_api_version: 'v1', braiins_account_id: null }),
      getAccountBinding: async () => undefined,
      getAccountWitness: async () => undefined,
    } as never,
    secretSource: source,
    getCurrentPassword: () => hashPassword(CURRENT),
    setDashboardPassword: (h) => applied.push(h),
  };
  const app: FastifyInstance = Fastify();
  return { app, deps, applied, setBraiinsToken, setDashboardPassword, saveV2Key };
}

describe('security routes (#332)', () => {
  let app: FastifyInstance;
  afterEach(async () => { vi.unstubAllEnvs(); await app?.close(); });

  it('keeps DB credentials editable with unrelated environment settings', async () => {
    vi.stubEnv('BHA_BRAIINS_PRICE_SMOOTHING_MINUTES', '4');
    const h = build('db'); app = h.app;
    await registerSecurityRoutes(app, h.deps); await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/security/state' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ secret_source: 'db', editable: true, braiins_editable: true,
      braiins_active_api_version: 'v1', braiins_api_version: 'v1', braiins_account_id: null,
      braiins_env_override_names: [], braiins_needs_live_confirmation: false });
  });

  it.each([
    ['sops', 'BHA_BRAIINS_API_KEY'],
    ['db', 'BHA_BRAIINS_ACCOUNT_ID'],
    ['env', 'BHA_BRAIINS_API_VERSION'],
  ] as const)('reports the %s credential source and %s override without exposing its value', async (source, variable) => {
    vi.stubEnv(variable, 'synthetic-override');
    const h = build(source); app = h.app;
    let flag: 0 | 1 = 1;
    vi.spyOn(h.deps.secretsRepo, 'getAccountBinding').mockImplementation(async () => ({
      id: 1, account_id: 'bound-account', needs_live_confirmation: flag,
    }));
    await registerSecurityRoutes(app, { ...h.deps, braiinsVersion: 'v2' });
    const state = await app.inject({ url: '/api/security/state' });
    expect(state.json()).toMatchObject({
      secret_source: source, editable: source === 'db', braiins_editable: false,
      braiins_active_api_version: 'v2', braiins_env_override_names: [variable],
      braiins_needs_live_confirmation: true,
    });
    expect(state.body).not.toContain('synthetic-override');
    flag = 0;
    expect((await app.inject({ url: '/api/security/state' })).json().braiins_needs_live_confirmation).toBe(false);
  });

  it('reports editable=false and refuses edits for env/SOPS', async () => {
    const h = build('env'); app = h.app;
    await registerSecurityRoutes(app, h.deps); await app.ready();
    expect((await app.inject({ method: 'GET', url: '/api/security/state' })).json().editable).toBe(false);
    const res = await app.inject({
      method: 'POST', url: '/api/security/password',
      payload: { current_password: CURRENT, new_password: 'longenough1' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('managed_externally');
  });

  it('rejects a wrong current password (403)', async () => {
    const h = build('db'); app = h.app;
    await registerSecurityRoutes(app, h.deps); await app.ready();
    const res = await app.inject({
      method: 'POST', url: '/api/security/password',
      payload: { current_password: 'wrong', new_password: 'longenough1' },
    });
    expect(res.statusCode).toBe(403);
    expect(h.applied).toHaveLength(0);
  });

  it('rejects a too-short new password (422)', async () => {
    const h = build('db'); app = h.app;
    await registerSecurityRoutes(app, h.deps); await app.ready();
    const res = await app.inject({
      method: 'POST', url: '/api/security/password',
      payload: { current_password: CURRENT, new_password: 'short' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('changes the password and hot-applies the new hash', async () => {
    const h = build('db'); app = h.app;
    await registerSecurityRoutes(app, h.deps); await app.ready();
    const res = await app.inject({
      method: 'POST', url: '/api/security/password',
      payload: { current_password: CURRENT, new_password: 'a-good-new-password' },
    });
    expect(res.statusCode).toBe(200);
    expect(h.setDashboardPassword).toHaveBeenCalledOnce();
    // The hash returned by the repo is what got hot-applied to the verifier.
    expect(h.applied).toHaveLength(1);
    expect(h.applied[0]!.startsWith('scrypt$')).toBe(true);
  });

  it('rotates a valid Braiins token (validated against Braiins), applies on restart', async () => {
    const h = build('db'); app = h.app;
    await registerSecurityRoutes(app, h.deps); await app.ready();
    const res = await app.inject({
      method: 'POST', url: '/api/security/braiins-token',
      payload: { kind: 'owner', current_password: CURRENT, token: 'GOOD' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, applies_on_restart: true });
    expect(h.setBraiinsToken).toHaveBeenCalledWith('owner', 'GOOD');
  });

  it('switches with a read-only v2 account probe and never stores a mismatched key', async () => {
    const h = build('db'); app = h.app;
    await registerSecurityRoutes(app, h.deps);
    const rotate = (account_id: string) => app.inject({
      method: 'POST', url: '/api/security/braiins-token',
      payload: { kind: 'v2', current_password: CURRENT, token: 'TEST_API_KEY', account_id },
    });
    expect((await rotate('different')).statusCode).toBe(422);
    expect(h.saveV2Key).not.toHaveBeenCalled();
    expect((await rotate('account-one')).statusCode).toBe(200);
    expect(h.saveV2Key).toHaveBeenCalledWith('TEST_API_KEY', 'account-one', 'account-one');
    expect(h.setBraiinsToken).not.toHaveBeenCalled();
  });

  it('refuses a Braiins token that fails validation (422), stores nothing', async () => {
    const h = build('db'); app = h.app;
    await registerSecurityRoutes(app, h.deps); await app.ready();
    const res = await app.inject({
      method: 'POST', url: '/api/security/braiins-token',
      payload: { kind: 'owner', current_password: CURRENT, token: 'TYPO' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('Braiins rejected this token');
    expect(h.setBraiinsToken).not.toHaveBeenCalled();
  });
});
