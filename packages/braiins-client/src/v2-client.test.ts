import { describe, expect, it, vi } from 'vitest';
import { createBraiinsClient } from './client.js';

const account = '49ab5245-2127-4aab-b624-54b9667b4da0';
const uuid = 'ed140290-3736-43e5-853f-33698d83dbec';
const order = {
  dest_upstream: { url: 'stratum+tcp://pool.example:3333', identity: 'worker' },
  price_sat: 42000000,
  amount_sat: 25000,
  speed_limit_ph: 3,
};
function setup(...responses: Response[]) {
  const requests: Request[] = [];
  const sleep = vi.fn(async () => {});
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    requests.push(new Request(input, init));
    const response = responses.shift();
    if (!response) throw new Error('unexpected request');
    return response;
  });
  const client = createBraiinsClient({ apiVersion: 'v2', apiKey: 'synthetic', fetch, sleep });
  return { client, requests, sleep, fetch };
}
const accounts = () => Response.json({ accounts: [{ account_id: account }] });
const bid = (state = 'BID_STATE_CREATED') => Response.json({ bid_id: 'B123', state });

describe('Braiins v2 transport and bid operations', () => {
  it('discovers the account once and authenticates with its bearer key', async () => {
    const { client, requests } = setup(accounts());
    expect(await Promise.all([client.getAccountId!(), client.getAccountId!()])).toEqual([
      account,
      account,
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://hashpower.braiins.com/v2/accounts');
    expect(requests[0]?.headers.get('Authorization')).toBe('Bearer synthetic');
    expect(requests[0]?.headers.has('apikey')).toBe(false);
  });

  it('maps place, edit and cancel to the v2 wire contract', async () => {
    const { client, requests } = setup(
      accounts(),
      bid(),
      bid('BID_STATE_UPDATING'),
      bid('BID_STATE_CANCELING'),
    );
    expect((await client.placeBid(order, uuid)).id).toBe('B123');
    await client.editBid(
      { bid_id: 'B123', new_price_sat: 41000000, new_speed_limit_ph: { value: 0 } },
      uuid,
    );
    expect((await client.cancelBid({ order_id: 'B123' }, uuid)).bidState).toBe(
      'BID_STATE_CANCELING',
    );
    const base = '/v2/spot/accounts/' + account + '/bids';
    expect(requests.slice(1).map((r) => [r.method, new URL(r.url).pathname])).toEqual([
      ['POST', base],
      ['PATCH', base + '/B123'],
      ['POST', base + '/B123:cancel'],
    ]);
    expect(await Promise.all(requests.slice(1).map((r) => r.json()))).toEqual([
      {
        request_id: uuid,
        destination: { pool_url: order.dest_upstream.url, worker: 'worker' },
        price_sat: '42000000',
        amount_sat: '25000',
        speed_limit_ph: 3,
      },
      { request_id: uuid, price_sat: '41000000', speed_limit_ph: 0 },
      { request_id: uuid },
    ]);
  });

  it('backs off for throttling and sends the identical intent after an unknown outcome', async () => {
    const { client, requests, sleep } = setup(
      accounts(),
      new Response(null, {
        status: 429,
        headers: { 'X-RateLimit-Reset': '3' },
      }),
      Response.json({ code: 14 }, { status: 503 }),
      bid(),
    );
    await client.placeBid(order, uuid);
    const bodies = await Promise.all(requests.slice(1).map((r) => r.text()));
    expect(bodies).toHaveLength(3);
    expect(new Set(bodies).size).toBe(1);
    expect(sleep).toHaveBeenCalledWith(3000);
  });

  it('rejects an unjournaled change and unsafe numeric amounts before HTTP', async () => {
    const { client, requests } = setup();
    await expect(client.placeBid(order)).rejects.toThrow(/request.*id/i);
    await expect(client.placeBid({ ...order, amount_sat: 2 ** 53 }, uuid)).rejects.toThrow(
      /amount_sat/,
    );
    expect(requests).toHaveLength(0);
  });

  it('surfaces a Viewer denial without downgrading to v1', async () => {
    const { client, requests } = setup(
      accounts(),
      Response.json(
        {
          code: 7,
          message: 'Permission denied',
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
              reason: 'INSUFFICIENT_PERMISSION',
            },
          ],
        },
        { status: 403 },
      ),
    );
    await expect(client.placeBid(order, uuid)).rejects.toMatchObject({
      status: 403,
      reason: 'INSUFFICIENT_PERMISSION',
      message: expect.stringMatching(/Admin/),
    });
    expect(requests).toHaveLength(2);
  });

  it('hands long throttles back to the journal without scheduling a delayed trade', async () => {
    const { client, requests, sleep } = setup(
      accounts(),
      new Response(null, {
        status: 429,
        headers: { 'X-RateLimit-Reset': '90' },
      }),
      bid(),
    );
    await expect(client.placeBid(order, uuid)).rejects.toMatchObject({ status: 429 });
    expect(sleep).not.toHaveBeenCalled();
    expect(requests).toHaveLength(2);
  });

  it('bounds replay by the original journal deadline after restart', async () => {
    const { client, requests, sleep } = setup(
      accounts(),
      new Response(null, { status: 429, headers: { 'X-RateLimit-Reset': '3' } }),
      bid(),
    );
    await expect(client.placeBid(order, uuid, Date.now() + 1000)).rejects.toMatchObject({
      status: 429,
    });
    expect(sleep).not.toHaveBeenCalled();
    expect(requests).toHaveLength(2);
  });

  it('preserves the last rate limit when the retry timer wakes after the deadline', async () => {
    const { client, requests, sleep } = setup(
      accounts(),
      new Response(null, { status: 429 }),
      bid(),
    );
    const clock = vi.spyOn(Date, 'now').mockReturnValue(10_000);
    try {
      sleep.mockImplementation(async () => {
        clock.mockReturnValue(12_000);
      });
      await expect(client.placeBid(order, uuid, 11_000)).rejects.toMatchObject({ status: 429 });
      expect(requests).toHaveLength(2);
    } finally {
      clock.mockRestore();
    }
  });

  it('does not transmit an expired journal replay after account discovery', async () => {
    const { client, requests } = setup(accounts(), bid());
    await expect(
      client.cancelBid({ order_id: 'B123' }, uuid, Date.now() - 1),
    ).rejects.toMatchObject({ name: 'BraiinsNetworkError' });
    expect(requests.map((r) => r.method)).toEqual(['GET']);
  });

  it('keeps a placement ambiguous when its confirmation is lost and the key then expires', async () => {
    const { client, requests } = setup(
      accounts(),
      new Response(null, { status: 503 }),
      new Response('unauthenticated', { status: 401 }),
    );
    await expect(client.placeBid(order, uuid)).rejects.toMatchObject({
      name: 'BraiinsNetworkError',
    });
    expect(await requests[1]?.text()).toBe(await requests[2]?.text());
  });

  it('keeps a throttled retry ambiguous if the previous write may have landed', async () => {
    const { client, requests } = setup(
      accounts(),
      new Response(null, { status: 503 }),
      new Response(null, { status: 429, headers: { 'X-RateLimit-Reset': '90' } }),
    );
    await expect(client.placeBid(order, uuid)).rejects.toMatchObject({
      name: 'BraiinsNetworkError',
      cause: { status: 429, retryAt: expect.any(Number) },
    });
    expect(requests).toHaveLength(3);
  });

  it('treats a malformed success body as an unknown outcome', async () => {
    const { client } = setup(accounts(), Response.json({}));
    await expect(client.placeBid(order, uuid)).rejects.toMatchObject({
      name: 'BraiinsNetworkError',
    });
  });

  it('never sends a write to a different account after a key change', async () => {
    const { fetch, requests } = setup(accounts());
    const client = createBraiinsClient({
      apiVersion: 'v2',
      apiKey: 'test',
      accountId: 'other',
      fetch,
    });
    await expect(client.cancelBid({ order_id: 'B123' }, uuid)).rejects.toThrow(/account/i);
    expect(requests).toHaveLength(1);
  });
});
