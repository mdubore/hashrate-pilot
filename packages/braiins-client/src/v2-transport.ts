import type { AccountInfo, BraiinsClientConfig } from './client.js';
import {
  BraiinsAccountSelectionError,
  BraiinsApiError,
  BraiinsAuthMissingError,
  BraiinsNetworkError,
} from './errors.js';
import type { components } from './generated/v2.js';

type Accounts = components['schemas']['braiins.hashpower.trading.v2.ListAccountsResponse'];
type Query = Record<string, boolean | number | string>;

export interface V2Transport {
  get<T>(path: string, query?: Query): Promise<T>;
  write<T>(method: 'POST' | 'PATCH', path: string, body: object, deadlineMs?: number): Promise<T>;
  accountInfo(): Promise<AccountInfo>;
  accountId(): Promise<string>;
  accountPath(suffix: string, spot?: boolean): Promise<string>;
}

const publicPaths = new Set(['/spot/stats', '/spot/orderbook', '/spot/settings']);
const origin = 'https://hashpower.braiins.com/v2';

function errorReason(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || !('details' in body) || !Array.isArray(body.details))
    return;
  for (const detail of body.details) {
    if (
      detail?.['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo' &&
      typeof detail.reason === 'string' &&
      /^[A-Z0-9_]+$/.test(detail.reason)
    )
      return detail.reason;
  }
  return undefined;
}

export function createV2Transport(config: BraiinsClientConfig): V2Transport {
  const base = (config.baseUrl ?? origin).replace(/\/$/, '');
  const fetchImpl = config.fetch ?? fetch;
  const sleep = config.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let account: Promise<AccountInfo> | undefined;

  async function request<T>(
    method: string,
    path: string,
    query?: Query,
    body?: object,
    deadlineMs?: number,
  ): Promise<T> {
    const url = new URL(base + path);
    for (const [key, value] of Object.entries(query ?? {}))
      url.searchParams.set(key, String(value));
    const headers = new Headers({ accept: 'application/json' });
    if (!publicPaths.has(path)) {
      if (!config.apiKey) throw new BraiinsAuthMissingError('READ_ONLY');
      headers.set('Authorization', 'Bearer ' + config.apiKey);
    }
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload !== undefined) headers.set('Content-Type', 'application/json');
    const endpoint = method + ' ' + path;
    const deadline =
      method === 'GET' ? Infinity : Math.min(deadlineMs ?? Infinity, Date.now() + 60_000);
    let previousFailure: Error | undefined;
    let uncertainWrite = false;
    for (let attempt = 1; ; attempt++) {
      if (Date.now() >= deadline) {
        throw (
          previousFailure ??
          new BraiinsNetworkError(endpoint, 'The journal replay window has expired.')
        );
      }
      let wait = Math.min(200 * 2 ** (attempt - 1), 2000);
      try {
        const response = await fetchImpl(url, {
          method,
          headers,
          redirect: 'error',
          signal: AbortSignal.timeout(10_000),
          ...(payload === undefined ? {} : { body: payload }),
        });
        if (response.ok) return (await response.json()) as T;
        const raw = await response.text();
        let errorBody: unknown;
        try {
          errorBody = JSON.parse(raw);
        } catch {
          /* gateways may return plain text */
        }
        const reason = errorReason(errorBody);
        const hint =
          reason === 'INSUFFICIENT_PERMISSION'
            ? 'Trading requires a key with Hashpower Admin access.'
            : response.status === 401
              ? 'Check the Braiins ID API key and its expiry.'
              : reason;
        const resetSeconds = Number(response.headers.get('X-RateLimit-Reset'));
        if (response.status === 429 && Number.isFinite(resetSeconds))
          wait = Math.max(wait, resetSeconds * 1000);
        throw new BraiinsApiError({
          status: response.status,
          endpoint,
          reason,
          retryAt: response.status === 429 ? Date.now() + wait : undefined,
          grpcMessage: hint,
          body: errorBody,
        });
      } catch (err) {
        const failure =
          err instanceof BraiinsApiError ? err : new BraiinsNetworkError(endpoint, err);
        const transient =
          !(failure instanceof BraiinsApiError) || failure.status === 429 || failure.status >= 500;
        // A refusal cannot resolve an earlier write whose reply was lost.
        previousFailure =
          uncertainWrite &&
          failure instanceof BraiinsApiError &&
          (!failure.reason || [401, 403, 409, 429].includes(failure.status))
            ? new BraiinsNetworkError(endpoint, failure)
            : failure;
        if (!transient || attempt >= (config.maxRetries ?? 3) || Date.now() + wait >= deadline)
          throw previousFailure;
        if (method !== 'GET' && (!(failure instanceof BraiinsApiError) || failure.status >= 500)) {
          uncertainWrite = true;
        }
      }
      await sleep(wait);
    }
  }

  async function discover(): Promise<AccountInfo> {
    const result = await request<Accounts>('GET', '/accounts');
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new BraiinsNetworkError('GET /accounts', 'Invalid account response');
    }
    const { accounts = [], next_page_token: next } = result;
    if (
      !Array.isArray(accounts) ||
      (next !== undefined && typeof next !== 'string') ||
      accounts.some(
        (a) =>
          !a ||
          typeof a !== 'object' ||
          Array.isArray(a) ||
          (a.account_id !== undefined && typeof a.account_id !== 'string') ||
          (a.display_name !== undefined && typeof a.display_name !== 'string'),
      )
    ) {
      throw new BraiinsNetworkError('GET /accounts', 'Invalid account list');
    }
    const selected =
      config.accountId !== undefined
        ? accounts.find((a) => a.account_id === config.accountId)
        : accounts.length === 1 && !next
          ? accounts[0]
          : undefined;
    const id = selected?.account_id;
    if (!id?.trim() || id === '.' || id === '..') throw new BraiinsAccountSelectionError();
    const name = selected?.display_name?.trim();
    return Object.freeze({ account_id: id, ...(name && { display_name: name }) });
  }
  function accountInfo(): Promise<AccountInfo> {
    // Share discovery between concurrent pollers. A transient discovery failure is recoverable.
    return (account ??= discover().catch((err) => {
      account = undefined;
      throw err;
    }));
  }
  const accountId = async () => (await accountInfo()).account_id;
  return {
    get: (path, query) => request('GET', path, query),
    write: (method, path, body, deadlineMs) => request(method, path, undefined, body, deadlineMs),
    accountInfo,
    accountId,
    accountPath: async (suffix, spot = false) =>
      (spot ? '/spot' : '') + '/accounts/' + encodeURIComponent(await accountId()) + suffix,
  };
}
