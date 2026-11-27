import { describe, it, expect, vi, afterEach } from 'vitest';

import { DatumService } from './datum.js';

function mockFetch(impl: () => unknown): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.stubGlobal('fetch', vi.fn(impl as any));
}

const service = () =>
  new DatumService({
    apiUrl: 'http://umbrel:21000',
    timeoutMs: 1000,
    now: () => 1000,
    log: () => {},
  });

afterEach(() => vi.unstubAllGlobals());

describe('DatumService.poll error hints (#310)', () => {
  it('parses the happy-path three-stats JSON', async () => {
    mockFetch(() => ({
      type: 'basic',
      status: 200,
      ok: true,
      text: async () =>
        JSON.stringify({
          items: [
            { title: 'Connections', text: '3' },
            { title: 'Hashrate', text: '2.50', subtext: 'Ph/s' },
          ],
        }),
    }));
    const r = await service().poll();
    expect(r.reachable).toBe(true);
    expect(r.connections).toBe(3);
    expect(r.error).toBeNull();
  });

  it('flags an auth-proxy redirect (opaqueredirect) and points at the doc', async () => {
    mockFetch(() => ({ type: 'opaqueredirect', status: 0, ok: false, text: async () => '' }));
    const r = await service().poll();
    expect(r.reachable).toBe(false);
    expect(r.error).toMatch(/auth proxy/i);
    expect(r.error).toMatch(/setup-datum-api/);
  });

  it('flags an HTML login page returned with 200', async () => {
    mockFetch(() => ({
      type: 'basic',
      status: 200,
      ok: true,
      text: async () => '<!doctype html><html>login</html>',
    }));
    const r = await service().poll();
    expect(r.reachable).toBe(false);
    expect(r.error).toMatch(/HTML/i);
    expect(r.error).toMatch(/setup-datum-api/);
  });

  it('rewrites a bare "fetch failed" into a connection-refused hint with the URL', async () => {
    mockFetch(() => {
      throw new Error('fetch failed');
    });
    const r = await service().poll();
    expect(r.reachable).toBe(false);
    expect(r.error).toMatch(/connection refused/i);
    expect(r.error).toMatch(/http:\/\/umbrel:21000/);
    expect(r.error).toMatch(/setup-datum-api/);
  });
});

describe('DATUM status page fallback', () => {
  const url = 'http://datum.test:7152';
  const missing = () => new Response(null, { status: 404 });
  const table = (rows: string[][]) =>
    '<table>' +
    rows
      .map(([label, value]) => `<tr><td class="label">${label}:</td><td>${value}</td></tr>`)
      .join('') +
    '</table>';

  function mockGateway(...responses: Response[]) {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      const next = responses.shift();
      if (!next) throw new Error('Unexpected gateway request');
      return next;
    });
    vi.stubGlobal('fetch', fetch);
    return fetch;
  }

  it('reads the configured status page on 404 with the same deadline and redirect policy', async () => {
    const cancelled = vi.fn();
    const first = new Response(new ReadableStream({ cancel: cancelled }), { status: 404 });
    const fetch = mockGateway(
      first,
      new Response(
        table([
          ['Total Connections', '12'],
          ['Total Work Subscriptions', '7'],
          ['Estimated Hashrate', '1250 Th/sec'],
        ]),
      ),
    );
    const service = new DatumService({ apiUrl: `${url}/gateway/`, now: () => 42 });
    expect(await service.poll()).toEqual({
      reachable: true,
      connections: 7,
      hashrate_ph: 1.25,
      checked_at: 42,
      error: null,
    });
    expect(cancelled).toHaveBeenCalledOnce();
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      `${url}/gateway/umbrel-api`,
      `${url}/gateway/`,
    ]);
    const options = fetch.mock.calls.map(([, init]) => init);
    expect(options[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(options[1]?.signal).toBe(options[0]?.signal);
    expect(options.map((init) => init?.redirect)).toEqual(['manual', 'manual']);
    expect(service.snapshot()).toEqual({ last_ok_at: 42, consecutive_failures: 0 });
  });

  it.each([
    [
      [
        ['Total Connections', '12'],
        ['Total Work Subscriptions', '0'],
      ],
      0,
      null,
    ],
    [
      [
        ['Total Connections', '0'],
        ['Estimated Hashrate', 'N/A'],
        ['Other', '99 Th/sec'],
      ],
      0,
      null,
    ],
    [[['Estimated Hashrate', '0 Gh/s']], null, 0],
    [[['Estimated Hashrate', '750&nbsp;Gh/sec']], null, 0.00075],
    [[['Estimated Hashrate', '2.5 PH/s']], null, 2.5],
    [[['Estimated Hashrate', '1 Eh/sec']], null, 1000],
  ] as [string[][], number | null, number | null][])(
    'reads available metrics from %j',
    async (rows, connections, hashrate_ph) => {
      mockGateway(missing(), new Response(table(rows)));
      expect(await new DatumService({ apiUrl: url }).poll()).toMatchObject({
        reachable: true,
        connections,
        hashrate_ph,
      });
    },
  );

  it('aborts the dashboard request when the original poll deadline expires', async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockImplementationOnce(async () => {
          await new Promise((resolve) => setTimeout(resolve, 60));
          return missing();
        })
        .mockImplementationOnce(
          (_url, init) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => reject(new Error('deadline expired')), {
                once: true,
              });
            }),
        );
      vi.stubGlobal('fetch', fetch);
      const datum = new DatumService({ apiUrl: url, timeoutMs: 100 });
      const result = datum.poll();
      await vi.advanceTimersByTimeAsync(100);
      expect(await result).toMatchObject({ reachable: false, error: 'deadline expired' });
      expect(datum.snapshot()).toEqual({ last_ok_at: null, consecutive_failures: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([302, 401, 403, 500])('does not try the dashboard on initial HTTP %i', async (status) => {
    const fetch = mockGateway(new Response(null, { status }));
    expect((await service().poll()).reachable).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    new Response('<html>Sign in</html>'),
    new Response(null, { status: 302 }),
    new Response(null, { status: 503 }),
  ])('counts a failed fallback once and preserves the last successful poll', async (response) => {
    let now = 41;
    const datum = new DatumService({ apiUrl: url, now: () => ++now });
    const json = () => Response.json({ items: [{ title: 'Connections', text: '2' }] });
    const fetch = mockGateway(json(), missing(), response, json());
    expect((await datum.poll()).connections).toBe(2);
    expect(await datum.poll()).toMatchObject({
      checked_at: 43,
      reachable: false,
      connections: null,
      hashrate_ph: null,
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(datum.snapshot()).toEqual({ last_ok_at: 42, consecutive_failures: 1 });
    expect((await datum.poll()).reachable).toBe(true);
    expect(datum.snapshot()).toEqual({ last_ok_at: 44, consecutive_failures: 0 });
  });
});
