import { afterEach, expect, it, vi } from 'vitest';

import { api } from './api';

afterEach(() => vi.unstubAllGlobals());

it('verifies a candidate key with a public POST and returns only the account summary', async () => {
  const fetch = vi.fn(async () =>
    Response.json({ account_id: 'account-one', display_name: 'Mining team', extra: 'ignored' }),
  );
  vi.stubGlobal('fetch', fetch);
  expect(await api.verifyBraiinsConnection(' candidate ')).toEqual({
    account_id: 'account-one', display_name: 'Mining team',
  });
  expect(fetch).toHaveBeenCalledWith('/api/setup/braiins/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ api_key: 'candidate' }),
  });
});

it('keeps the account ID when a display name is missing', async () => {
  vi.stubGlobal('fetch', async () => Response.json({ account_id: 'account-one' }));
  expect(await api.verifyBraiinsConnection('candidate')).toEqual({ account_id: 'account-one' });
});

it.each<[number, string, string]>([
  [400, 'invalid_input', 'invalid_input'],
  [422, 'credential_rejected', 'credential_rejected'],
  [422, 'account_unavailable', 'account_unavailable'],
  [503, 'temporarily_unavailable', 'temporarily_unavailable'],
  [500, 'credential_rejected', 'temporarily_unavailable'],
  [422, 'internal detail', 'temporarily_unavailable'],
])('interprets status %s and error %s', async (status, error, expected) => {
  vi.stubGlobal('fetch', async () => Response.json({ error }, { status }));
  expect(await api.verifyBraiinsConnection('candidate')).toEqual({ error: expected });
});

it.each([
  () => Promise.reject(new Error('unreachable')),
  () => Promise.resolve(new Response('<html>')),
  () => Promise.resolve(Response.json({ account_id: '' })),
])('offers retry for a failed or unusable verification reply', async (fetch) => {
  vi.stubGlobal('fetch', fetch);
  expect(await api.verifyBraiinsConnection('candidate')).toEqual({ error: 'temporarily_unavailable' });
});
