import { afterEach, expect, it, vi } from 'vitest';
import { api } from './api';

afterEach(() => vi.unstubAllGlobals());

it('sends a non-placement confirmation only with the original UUID and an independent reference', async () => {
  const storage = { getItem: () => null };
  vi.stubGlobal('window', { localStorage: storage, sessionStorage: storage });
  const fetch = vi.fn(async () => Response.json({ error: 'Pause first.' }, { status: 409 }));
  vi.stubGlobal('fetch', fetch);
  expect(await api.confirmBraiinsNonPlacement('request-one', 'support-case')).toMatchObject({
    ok: false,
    error: 'Pause first.',
  });
  expect(fetch).toHaveBeenCalledWith(
    '/api/braiins/pending-mutation/confirm-not-placed',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ request_id: 'request-one', confirmation_reference: 'support-case' }),
    }),
  );
});
