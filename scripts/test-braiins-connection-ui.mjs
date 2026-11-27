// Run with `node scripts/test-braiins-connection-ui.mjs` after `pnpm build`.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname } from 'node:path';
import { after, before, test } from 'node:test';
import { URL } from 'node:url';
import { chromium } from 'playwright';
import { APP_CONFIG_DEFAULTS } from '../packages/daemon/dist/config/schema.js';

const dist = new URL('../packages/dashboard/dist/', import.meta.url);
const contentTypes = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};
const server = createServer(async (request, response) => {
  const { pathname } = new URL(request.url, 'http://localhost');
  const file = ['/', '/setup', '/config'].includes(pathname) ? 'index.html' : pathname.slice(1);
  try {
    if (request.method !== 'GET' || !/^[\w./-]+$/.test(file) || file.includes('..'))
      throw new Error();
    const body = await readFile(new URL('./' + file, dist));
    response
      .writeHead(200, { 'Content-Type': contentTypes[extname(file)] ?? 'application/octet-stream' })
      .end(body);
  } catch {
    response.writeHead(404).end();
  }
});
let origin;
let browser;
before(async () => {
  await readFile(new URL('index.html', dist));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});
after(async () => {
  try {
    await browser?.close();
  } finally {
    if (server.listening) await new Promise((done) => server.close(done));
  }
});

const password = 'synthetic-dashboard-password';
const address = 'bc1qux2aehp5ny89l9spguf052x84zm8h9uyfqvgdg';
const config = {
  ...APP_CONFIG_DEFAULTS,
  destination_pool_url: '',
  destination_pool_worker_name: `${address}.test`,
  btc_payout_address: address,
  payout_source: 'none',
  bitcoind_rpc_url: '',
  bitcoind_rpc_user: '',
  bitcoind_rpc_password: '',
  electrs_host: null,
  electrs_port: null,
};
const setupInfo = {
  defaults: config,
  has_existing_config: false,
  has_existing_secrets: false,
  current_config: null,
  detected_bitcoind: { url: null, user: null, password: null },
};

// Each case has fresh browser storage and its own API. A new API call must be
// explicitly mocked, including background queries mounted by the real Status page.
async function visit(t, path, handlers, { clock = false } = {}) {
  const context = await browser.newContext({ locale: 'en-US', serviceWorkers: 'block' });
  const errors = [];
  t.after(async () => {
    await context.close();
    assert.deepEqual(errors, []);
  });
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    // The built index includes an optional third-party icon kit. Block this
    // known script locally and fail the case on every other off-origin request.
    if (
      request.resourceType() === 'script' &&
      request.url() === 'https://kit.fontawesome.com/090ca49637.js'
    ) {
      return route.abort();
    }
    if (url.origin === origin) {
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const handler = handlers[`${request.method()} ${url.pathname}`];
      if (handler) return handler(route);
    }
    errors.push(`Unexpected ${request.method()} ${url.origin}${url.pathname}`);
    await route.abort();
  });
  await context.routeWebSocket('**/*', (ws) => {
    errors.push(`Unexpected websocket ${new URL(ws.url()).pathname}`);
    ws.close();
  });
  if (path !== '/setup') {
    await context.addInitScript(
      (pw) => globalThis.sessionStorage.setItem('hashrate-autopilot.dashboardPassword', pw),
      password,
    );
  }
  const page = await context.newPage();
  if (clock) await page.clock.install();
  page.setDefaultTimeout(10_000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin + path);
  return page;
}
const json = (value) => (route) => route.fulfill({ json: value });
// The shell asks for these operational resources even during onboarding.
const needsSetup = (route) =>
  route.fulfill({ status: 412, json: { error: 'needs_setup', needs_setup: true } });
const setup = {
  'GET /api/config': needsSetup,
  'GET /api/btc-price': needsSetup,
  'GET /api/health': json({ mode: 'NEEDS_SETUP' }),
  'GET /api/setup-info': json(setupInfo),
};
const button = (page, name) => page.getByRole('button', { name, exact: true });

test('Setup opens with the v2 key and a keyboard-operable legacy disclosure', async (t) => {
  const page = await visit(t, '/setup', setup);
  await button(page, 'Next →').waitFor();
  const legacy = button(page, 'Use an existing legacy token (v1)');
  assert.equal(await legacy.isVisible(), true, 'the wizard offers the legacy disclosure');
  assert.equal(await legacy.getAttribute('aria-expanded'), 'false');
  assert.equal(await verify(page).getAttribute('type'), 'button');
  assert.equal(await next(page).isEnabled(), false);
  await page.getByText(/Viewer can monitor an account/).waitFor();
  await page.getByText(/Admin can also place, change and cancel bids/).waitFor();
  await legacy.press('Enter');
  const back = button(page, 'Use a Braiins ID API key (v2)');
  assert.equal(await back.getAttribute('aria-expanded'), 'true');
  await back.press('Space');
  assert.equal(await legacy.getAttribute('aria-expanded'), 'false');
});

function input(page, label) {
  return page.getByLabel(label, { exact: true });
}
const keyInput = (page) => input(page, 'Braiins ID API key (v2)');
const ownerInput = (page) => input(page, 'Owner token');
const readerInput = (page) => input(page, 'Read-only token (optional)');
const verify = (page) => button(page, 'Verify connection');
const previewPath = '/api/setup/braiins/verify';
const next = (page) => button(page, 'Next →');

async function fillPassword(page) {
  await input(page, 'Password').fill(password);
  await input(page, 'Confirm password').fill(password);
}

for (const version of ['v1', 'v2']) {
  test(`Setup masks and submits only the selected ${version} credentials without a preview`, async (t) => {
    const page = await visit(t, '/setup', { ...setup, 'POST /api/setup': json({ ok: true }) });
    const key = 'synthetic-v2-paste';
    const owner = 'synthetic-owner-paste';
    const reader = 'synthetic-reader-paste';
    await keyInput(page).fill(` ${key} `);
    assert.equal(await keyInput(page).getAttribute('type'), 'password');
    await button(page, 'Use an existing legacy token (v1)').press('Enter');
    await ownerInput(page).fill(` ${owner} `);
    await readerInput(page).fill(` ${reader} `);
    assert.equal(await ownerInput(page).getAttribute('type'), 'password');
    assert.equal(await readerInput(page).getAttribute('type'), 'password');
    if (version === 'v2') {
      await button(page, 'Use a Braiins ID API key (v2)').press('Space');
      await keyInput(page).fill(` ${key} `);
    }
    await fillPassword(page);
    await next(page).click();
    await page.getByRole('heading', { name: 'Hashrate targets' }).waitFor();
    await next(page).click();
    const submit = button(page, 'Complete setup');
    await submit.waitFor();
    const review = await page.locator('body').innerText();
    for (const secret of [key, owner, reader, password]) assert.ok(!review.includes(secret));
    assert.match(review, /DRY-RUN/);
    const labels =
      version === 'v1' ? ['Owner token', 'Read-only token'] : ['Braiins ID API key (v2)'];
    for (const label of [...labels, 'Dashboard password']) {
      const row = page.getByText(label, { exact: true }).locator('..');
      assert.match((await row.innerText()).slice(label.length).trim(), /^•+$/);
    }
    const hiddenLabel = version === 'v1' ? 'Braiins ID API key (v2)' : 'Owner token';
    assert.equal(await page.getByText(hiddenLabel, { exact: true }).isVisible(), false);
    const sent = page.waitForRequest(
      (req) => req.method() === 'POST' && new URL(req.url()).pathname === '/api/setup',
    );
    await submit.click();
    const credentials =
      version === 'v1'
        ? { braiins_owner_token: owner, braiins_read_only_token: reader }
        : { braiins_api_version: 'v2', braiins_api_key: key };
    assert.deepEqual((await sent).postDataJSON(), {
      config,
      secrets: { ...credentials, dashboard_password: password },
    });
  });
}

test('Setup verifies account read access and retries a temporary failure with the same key', async (t) => {
  const requests = [];
  const replies = [
    { status: 200, json: { account_id: 'acct-named', display_name: 'Acme Mining' } },
    { status: 503, json: { error: 'temporarily_unavailable' } },
    { status: 200, json: { account_id: 'acct-unnamed' } },
  ];
  const page = await visit(t, '/setup', {
    ...setup,
    [`POST ${previewPath}`]: (route) => {
      requests.push(route.request().postDataJSON());
      return route.fulfill(replies.shift());
    },
  });
  await keyInput(page).fill(' first-key ');
  await verify(page).click();
  const named = page.getByText(/Connected to Acme Mining\. Account read access verified\./);
  await named.waitFor();
  await keyInput(page).fill(' next-key ');
  assert.equal(await named.isVisible(), false);
  await verify(page).click();
  const retry = button(page, 'Retry');
  await retry.waitFor();
  assert.equal(await keyInput(page).inputValue(), ' next-key ');
  await retry.click();
  await page.getByText(/Connected to acct-unnamed\. Account read access verified\./).waitFor();
  assert.deepEqual(requests, [
    { api_key: 'first-key' },
    { api_key: 'next-key' },
    { api_key: 'next-key' },
  ]);
});

for (const action of ['edit the key', 'switch to v1 and back', 'leave the step and return']) {
  test(`Setup ignores a delayed preview after operators ${action}`, async (t) => {
    let heldRoute;
    const page = await visit(t, '/setup', {
      ...setup,
      [`POST ${previewPath}`]: (route) => {
        if (route.request().postDataJSON().api_key === 'replacement-key') {
          return route.fulfill({ json: { account_id: 'replacement-account' } });
        }
        heldRoute = route;
      },
    });
    await keyInput(page).fill('previous-key');
    await fillPassword(page);
    const received = page.waitForRequest((req) => new URL(req.url()).pathname === previewPath);
    await verify(page).click();
    await received;
    await page
      .getByRole('status')
      .filter({ hasText: /Checking account read access/ })
      .waitFor();
    if (action === 'edit the key') {
      await keyInput(page).fill('replacement-key');
      await verify(page).click();
      await page
        .getByRole('status')
        .filter({ hasText: /Connected to replacement-account/ })
        .waitFor();
    } else if (action === 'switch to v1 and back') {
      await button(page, 'Use an existing legacy token (v1)').press('Enter');
      await button(page, 'Use a Braiins ID API key (v2)').press('Space');
    } else {
      await next(page).click();
      await button(page, '← Back').click();
    }
    await keyInput(page).waitFor();
    const response = page.waitForResponse((res) => new URL(res.url()).pathname === previewPath);
    await heldRoute.fulfill({ json: { account_id: 'stale-account' } });
    await (await response).finished();
    // Commit any React update triggered by consuming the late JSON before checking the DOM.
    await page.evaluate(
      () =>
        new Promise((done) =>
          globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(done)),
        ),
    );
    const message = await page.getByRole('status').textContent();
    if (action === 'edit the key') assert.match(message, /Connected to replacement-account/);
    else assert.equal(message, '');
    assert.doesNotMatch(message, /stale-account/);
  });
}

test('Setup explains rejected and unavailable accounts, focuses invalid input, and handles a network outage', async (t) => {
  const responses = [
    { status: 400, json: { error: 'invalid_input' } },
    { status: 422, json: { error: 'credential_rejected' } },
    { status: 422, json: { error: 'account_unavailable' } },
  ];
  const page = await visit(t, '/setup', {
    ...setup,
    [`POST ${previewPath}`]: (route) => {
      const response = responses.shift();
      return response ? route.fulfill(response) : route.abort('failed');
    },
  });
  const message = page.getByRole('status');
  await verify(page).click();
  await message.filter({ hasText: 'Enter a Braiins ID API key.' }).waitFor();
  assert.ok(await keyInput(page).evaluate((field) => field === field.ownerDocument.activeElement));
  await keyInput(page).fill('rejected-key');
  await verify(page).click();
  await message.filter({ hasText: /Hashpower read access/ }).waitFor();
  await keyInput(page).fill('unavailable-account-key');
  await verify(page).click();
  await message.filter({ hasText: /Check the selected account/ }).waitFor();
  await verify(page).click();
  await button(page, 'Retry').waitFor();
  assert.equal(await keyInput(page).inputValue(), 'unavailable-account-key');
});

const reviewText = 'Review your balance and owned bids before enabling LIVE.';
const pendingText = 'v1 is active. Restart to activate v2.';
const v1Text = 'Connected using a legacy token (v1)';
const v2Text = 'Connected using Braiins ID (v2)';
const rotate = 'Rotate API key';
const migrate = 'Migrate to Braiins ID';

function installation(overrides = {}) {
  const security = {
    secret_source: 'db',
    editable: true,
    braiins_editable: true,
    braiins_active_api_version: 'v2',
    braiins_api_version: 'v2',
    braiins_account_id: 'acct-1',
    braiins_env_override_names: [],
    braiins_needs_live_confirmation: false,
    ...overrides,
  };
  const status = {
    run_mode: 'DRY_RUN',
    action_mode: 'NORMAL',
    tick_at: null,
    next_tick_at: null,
    last_api_ok_at: null,
    tick_interval_ms: 60_000,
    next_action: {
      descriptor: null,
      summary: 'Waiting for first tick',
      detail: null,
      eta_ms: null,
      event_started_ms: null,
      event_kind: null,
      last_executed: null,
    },
    balances: [],
    market: null,
    pool: {
      reachable: false,
      last_ok_at: null,
      consecutive_failures: 0,
      error: null,
      latency_ms: null,
    },
    datum: null,
    bids: [],
    actual_hashrate_ph: 0,
    avg_delivered_ph_3h: null,
    actual_spend_per_day_sat_3h: null,
    live_effective_sat_per_ph_day: null,
    below_floor_since: null,
    last_proposals: [],
    config_summary: {
      target_hashrate_ph: 1,
      minimum_floor_hashrate_ph: 0.5,
      max_bid_sat_per_ph_day: 49000,
      max_overpay_vs_hashprice_sat_per_ph_day: null,
      effective_cap_sat_per_ph_day: 49000,
      binding_cap: 'fixed',
      bid_budget_sat: 10000,
      pool_url: '',
      effective_target_hashrate_ph: 1,
      cheap_mode_active: false,
    },
    cheap_status: null,
    chain_tip: null,
  };
  const pending = { pending: null };
  const handlers = {
    'GET /api/health': json({ mode: 'OPERATIONAL' }),
    'GET /api/config': json({ config }),
    'GET /api/status': json(status),
    'GET /api/security/state': json(security),
    'GET /api/braiins/pending-mutation': json(pending),
    'GET /api/alerts': json({ alerts: [], unacknowledged_high_severity_count: 0 }),
    'GET /api/build': json({ version: '0.0.0', build: 0, hash: 'fixture' }),
    'GET /api/ddns': json({ ddns: {} }),
    'GET /api/btc-price': json({ usd_per_btc: null }),
    'GET /api/metrics': json({ points: [], range: null }),
    'GET /api/bid-events': json({ events: [] }),
    'GET /api/alert-spans': json({ spans: [] }),
    'GET /api/ip-changes': json({ events: [] }),
    'GET /api/system-events': json({ events: [] }),
    'GET /api/solo-miners': json({ devices: [], snapshot: { enabled: false, entries: [] } }),
    'GET /api/stale-urls': json({
      stale: [],
      current_destination_pool_url: '',
      current_host_port: null,
      checked_at: 0,
    }),
    'GET /api/payout-ledger': json({ payouts: [] }),
    'GET /api/deposits': json({ deposits: [] }),
    'GET /api/stats': json({ tick_count: 0 }),
  };
  // The connection control also works when these optional monitoring panels are offline.
  for (const name of ['finance', 'finance/range', 'ocean']) {
    handlers[`GET /api/${name}`] = (route) =>
      route.fulfill({ status: 503, json: { error: 'offline' } });
  }
  return { security, status, pending, handlers };
}

async function openSecurity(page) {
  await button(page, 'Pool & Payout').click();
  const section = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Security & credentials', exact: true }) });
  await section.waitFor();
  return section;
}
const waitForApi = (page, path, method = 'GET') =>
  page.waitForResponse(
    (res) => res.request().method() === method && new URL(res.url()).pathname === path,
  );

test('Config saves v2, reports the pending restart, and clears review after explicit LIVE in Status', async (t) => {
  const { security, status, handlers } = installation({
    braiins_active_api_version: 'v1',
    braiins_api_version: 'v1',
    braiins_account_id: null,
  });
  const rotations = [];
  handlers['POST /api/security/braiins-token'] = (route) => {
    rotations.push(route.request().postDataJSON());
    Object.assign(security, { braiins_api_version: 'v2', braiins_account_id: 'acct-1' });
    return route.fulfill({ json: { ok: true } });
  };
  const modes = [];
  handlers['POST /api/run-mode'] = (route) => {
    modes.push(route.request().postDataJSON());
    status.run_mode = 'LIVE';
    security.braiins_needs_live_confirmation = false;
    return route.fulfill({ json: { run_mode: 'LIVE' } });
  };
  const page = await visit(t, '/config', handlers, { clock: true });
  const originalDocument = await page.evaluateHandle(() => globalThis.document);
  let section = await openSecurity(page);
  await section.getByText(v1Text, { exact: true }).waitFor();
  await section.getByText('Rotate Braiins owner token', { exact: true }).waitFor();
  const form = section.getByRole('form', { name: migrate });
  await form.waitFor();
  assert.match(await form.innerText(), /DRY-RUN/i);
  assert.match(await form.innerText(), /first successful v2 startup permanently binds/i);
  await form.getByLabel('Braiins account ID').fill('acct-1');
  await form.getByPlaceholder('Current password').fill(password);
  await form.getByPlaceholder('New API key').fill('candidate-key');
  await button(form, 'Verify and save').click();
  await section.getByText(pendingText, { exact: false }).waitFor();
  assert.deepEqual(rotations, [
    { kind: 'v2', current_password: password, account_id: 'acct-1', token: 'candidate-key' },
  ]);
  assert.equal(await form.isVisible(), false);
  assert.match(await section.innerText(), /hold/i);

  Object.assign(security, {
    braiins_active_api_version: 'v2',
    braiins_needs_live_confirmation: true,
  });
  // The operator leaves Config open while the daemon restarts. Advance the
  // polling interval while preserving the document and its query cache.
  await page.clock.fastForward(30_000);
  await section.getByText(reviewText, { exact: false }).waitFor();
  await section.getByText(v2Text, { exact: true }).waitFor();
  assert.equal(await originalDocument.evaluate((doc) => doc === globalThis.document), true);
  assert.equal(await section.getByText(pendingText, { exact: true }).isVisible(), false);
  await section.getByRole('form', { name: rotate }).waitFor();
  await section.getByRole('link', { name: /Status/ }).click();
  await page.waitForURL(origin + '/');
  const dryRun = button(page, 'DRY RUN');
  await dryRun.waitFor();
  assert.equal(await dryRun.isDisabled(), true);
  await Promise.all([
    waitForApi(page, '/api/status'),
    waitForApi(page, '/api/security/state'),
    button(page, 'LIVE').click(),
  ]);
  assert.deepEqual(modes, [{ run_mode: 'LIVE' }]);
  // An in-app navigation preserves the React Query cache: only invalidation
  // by the explicit mode change should clear the just-cached review flag.
  await page.getByRole('link', { name: 'Config', exact: true }).click();
  section = await openSecurity(page);
  await section.getByRole('form', { name: rotate }).waitFor();
  await section.getByText(reviewText, { exact: false }).waitFor({ state: 'hidden' });
});

test('An editable v2 account can rotate a denied key while review is required', async (t) => {
  const { handlers, security } = installation();
  const rotations = [];
  handlers['POST /api/security/braiins-token'] = (route) => {
    rotations.push(route.request().postDataJSON());
    return route.fulfill({ json: { ok: true } });
  };
  const page = await visit(t, '/config', handlers, { clock: true });
  const section = await openSecurity(page);
  const form = section.getByRole('form', { name: rotate });
  await form.waitFor();
  const review = section.getByText(reviewText, { exact: false });
  assert.equal(await review.isVisible(), false);
  // A daemon-side permission denial also sets this flag on an established v2 account.
  security.braiins_needs_live_confirmation = true;
  await page.clock.fastForward(30_000);
  await review.waitFor();
  assert.equal(await form.isVisible(), true);
  assert.equal(await form.getByLabel('Braiins account ID').inputValue(), 'acct-1');
  await form.getByPlaceholder('Current password').fill(password);
  await form.getByPlaceholder('New API key').fill('replacement-key');
  await button(form, 'Save API key').click();
  await form.getByText(/saved.*restart/i).waitFor();
  assert.deepEqual(rotations, [
    { kind: 'v2', account_id: 'acct-1', current_password: password, token: 'replacement-key' },
  ]);
  assert.equal(await section.getByText(reviewText, { exact: false }).isVisible(), true);
});

for (const [source, variables, active] of [
  ['env', ['BHA_BRAIINS_API_KEY'], 'v2'],
  ['sops', [], 'v2'],
  ['sops', ['BHA_BRAIINS_API_KEY'], 'v2'],
  ['db', ['BHA_BRAIINS_API_VERSION', 'BHA_BRAIINS_ACCOUNT_ID'], 'v1'],
]) {
  test(`Config identifies the ${source} store and ${variables.join(', ') || 'no environment overrides'}`, async (t) => {
    const { handlers } = installation({
      secret_source: source,
      editable: source === 'db',
      braiins_editable: false,
      braiins_active_api_version: active,
      braiins_env_override_names: variables,
      braiins_needs_live_confirmation: active === 'v2',
    });
    const page = await visit(t, '/config', handlers);
    const section = await openSecurity(page);
    await section.getByText(active === 'v1' ? v1Text : v2Text, { exact: true }).waitFor();
    const content = await section.innerText();
    assert.match(
      content,
      { db: /database/i, sops: /SOPS secrets file/i, env: /environment/i }[source],
    );
    for (const name of variables) assert.ok(content.includes(name));
    assert.equal(await section.getByText(pendingText, { exact: false }).isVisible(), false);
    assert.equal(
      await section.getByText(reviewText, { exact: false }).isVisible(),
      active === 'v2',
    );
    assert.equal(await section.getByRole('form', { name: migrate }).isVisible(), false);
    assert.equal(await section.getByRole('form', { name: rotate }).isVisible(), false);
    assert.equal(
      await section.getByText('Rotate Braiins owner token', { exact: true }).isVisible(),
      false,
    );
    assert.equal(await button(section, 'Change password').isVisible(), source === 'db');
  });
}

for (const found of [false, true]) {
  test(`Config refreshes the review flag in place after ${found ? 'adoption of a matching bid' : 'confirmed non-placement'}`, async (t) => {
    const { handlers, pending, security, status } = installation();
    status.run_mode = 'PAUSED';
    const requestId = 'pending-fixture';
    pending.pending = {
      request_id: requestId,
      needs_review: true,
      created_at: 1,
      command: { kind: 'place', body: { memo: 'synthetic-memo' } },
    };
    const requests = [];
    const path =
      '/api/braiins/pending-mutation/' + (found ? 'resolve-placement' : 'confirm-not-placed');
    handlers[`POST ${path}`] = (route) => {
      requests.push(route.request().postDataJSON());
      pending.pending = null;
      security.braiins_needs_live_confirmation = !found;
      return route.fulfill({ json: { ok: true } });
    };
    const page = await visit(t, '/config', handlers);
    const section = await openSecurity(page);
    await section.getByText('synthetic-memo').waitFor();
    assert.equal(await section.getByText(reviewText, { exact: false }).isVisible(), false);
    const initialUrl = page.url();
    const originalDocument = await page.evaluateHandle(() => globalThis.document);
    await section.getByLabel('Verification result').selectOption(found ? 'found' : 'absent');
    const evidence = found ? 'matching-bid-id' : 'support-confirmation';
    await section
      .getByLabel(found ? 'Braiins bid ID' : 'Braiins confirmation reference')
      .fill(evidence);
    const refreshed = waitForApi(page, '/api/security/state');
    await button(
      section,
      found ? 'Verify bid and restore tracking' : 'Record confirmed non-placement',
    ).click();
    await refreshed;
    await section.getByText('synthetic-memo').waitFor({ state: 'hidden' });
    assert.deepEqual(requests, [
      found
        ? { request_id: requestId, bid_id: evidence }
        : { request_id: requestId, confirmation_reference: evidence },
    ]);
    if (!found) await section.getByText(reviewText, { exact: false }).waitFor();
    assert.equal(await section.getByText(reviewText, { exact: false }).isVisible(), !found);
    assert.equal(await originalDocument.evaluate((doc) => doc === globalThis.document), true);
    assert.equal(page.url(), initialUrl);
  });
}
