# Braiins connection presentation implementation plan

On `feat/braiins-hashpower-v2`, deliver the [approved setup and migration screens](2026-11-26-braiins-connection-design.md) on top of `6a311f76`. Keep the existing v1 and v2 clients, SQLite account binding, bid journal, and LIVE control. The changes belong in the upstream application. Work through the following tasks with mocked Braiins responses.

## 1. Offer a read-only connection check during setup

**Contract.** The setup server accepts `POST /api/setup/braiins/verify` with JSON `{"api_key":"<candidate>"}`. A successful response is `200 {"account_id":"acct-1","display_name":"Acme Mining"}`. Omit a missing or blank display name. The dashboard then uses the ID. **Verify connection** is optional. **Next** keeps its existing form validation. Final v2 submission always checks the submitted key and local account history again before saving.

| Result | HTTP response | Dashboard action |
| --- | --- | --- |
| Missing or malformed input | 400 · `invalid_input` | Focus the key field. |
| Braiins denies the key (401/403) | 422 · `credential_rejected` | Prompt for a key with Hashpower read access. |
| No unambiguous usable account | 422 · `account_unavailable` | Ask the operator to check the selected Braiins account. |
| Timeout, throttling, upstream failure or unreadable upstream reply | 503 · `temporarily_unavailable` | Offer **Retry** and retain the input. |

- [ ] In `packages/braiins-client/src/{client,v2-client,v2-transport}.ts`, expose optional `getAccountInfo(): Promise<{ account_id: string; display_name?: string }>` on the shared client. Derive `getAccountId()` from the same per-client discovery promise. Preserve expected-ID matching and retry after failure. In `src/v2-client.test.ts` in that package, cover a missing name, a wrong expected ID, zero/multiple candidate accounts, and concurrent calls sharing one GET. A suitably typed account-selection error distinguishes an unusable account from a transport failure.
- [ ] Add the route and tests to `packages/daemon/src/setup-mode{,.test}.ts`. Parse a strict body with a nonempty trimmed key. Use a fresh candidate client, its fixed v2 origin and one `GET /v2/accounts` per button press (`maxRetries: 1`). Use the existing same-origin setup policy. Return only the documented fields or `{"error":"<code>"}`. Keep the key out of URLs, logs, replies and storage. The preview does not write config, bind an account or fire setup completion.
- [ ] Test preview success followed by a revoked key at final submission, and by a key whose account conflicts with saved history. The final `POST /api/setup` must reject both, preserve the previous database contents and leave setup available. Also submit successfully with no preview. Keep legacy final submission compatible.

## 2. Render the selected credential in the wizard

- [ ] In `packages/dashboard/src/lib/api.ts`, add a typed preview method that parses the documented status and error code. Keep existing public POST callers' behavior. A network error gets the retry message. In `packages/dashboard/src/pages/Setup.tsx`, use the labels and Viewer/Admin guidance from the design. Submit only the selected credentials and mask them on the review screen.
- [ ] Make the legacy disclosure a keyboard-operable button with an accessible name and expanded state. Keep **Verify connection** a non-submit button and announce its pending, success and error messages. Editing the key, changing protocol or leaving the step invalidates an in-flight result. Apply a response only if it belongs to the latest request for the current input, including switching away and back. On success show **Account read access verified**. Trading is enabled separately in the existing run-mode control.

## 3. Report the running connection and where to change it

Extend authenticated `GET /api/security/state` in `packages/daemon/src/http/routes/security.ts` and its dashboard type in `packages/dashboard/src/lib/api.ts`. Preserve the current fields. Add `braiins_env_override_names: string[]` and `braiins_needs_live_confirmation: boolean`. Use the existing binding's flag when v2 is active. Read it on each state request, including on SOPS and environment installations. This flag can also be set after a permission denial or recovery, so the prompt must make sense outside a migration. A database schema change is unnecessary.

- [ ] In `packages/daemon/src/config/env-overrides.ts`, derive the names from the existing Braiins entries in `SECRETS_ENV`. Have `hasBraiinsCredentialOverrides` delegate to the same enumeration. Preserve its existing meaning for defined values. Return names only. Reuse `secret_source` for the underlying store and `braiins_editable` for whether the dashboard can save Braiins credentials. Preserve password editing and pending-placement recovery under their existing conditions.
- [ ] Implement the following display rules in `packages/dashboard/src/pages/Config.tsx`. Credential management and the LIVE-confirmation prompt are independent. The active version describes the running daemon. A same-version key rotation gets the existing saved-for-restart acknowledgement.

| Fixture | Display and action |
| --- | --- |
| Editable DB, active/saved v1 | Show active v1, token rotation, and **Migrate to Braiins ID**. Before saving, explain the one-way binding, request the expected account ID, candidate key and dashboard password, and direct the operator to DRY-RUN. |
| Editable DB, active v1 / saved v2 | **v1 is active. Restart to activate v2.** Hold bid changes. Suppress duplicate migration forms. An attempted LIVE transition returns 409 until restart. |
| Active v2 and confirmation required | **Review your balance and owned bids before enabling LIVE.** Point to Status and its existing run-mode control. Keep this prompt across restarts. Show **Rotate API key** alongside it whenever credentials are editable, including after a permission denial. |
| Active v2 and confirmation cleared | Show v2 and **Rotate API key** when editable. Retain the existing same-account check. |
| Pure env or SOPS | Show active version and directions for that source. Omit Braiins credential editors. Continue to show any v2 confirmation or recovery prompt. |
| DB or SOPS plus Braiins environment overrides | Name the overridden variables and the underlying store for the other fields. Suppress the DB migration-pending banner even if stored and active versions differ. Omit Braiins editors. An unrelated config override keeps ordinary DB editing available. |

- [ ] Use the same effective-management rule for the pending-migration check in `packages/daemon/src/http/routes/run-mode.ts` and the UI. A stale shadowed DB version must not block an externally managed v1 install. Keep the actual pending DB migration guard and the v2 account verification on LIVE. In `packages/dashboard/src/pages/Status.tsx`, refresh both status and security state after a successful explicit mode change. Retain the existing security-state refresh after saving a key. In `packages/dashboard/src/components/BraiinsPendingPlacement.tsx`, invalidate security state as well as the pending-mutation query after recovery succeeds. Recording confirmed non-placement while PAUSED sets the review flag. Reading the refreshed server state also handles adoption of a matching bid, which does not set that flag.
- [ ] In `packages/daemon/src/config/{env-overrides,secret-sources}.test.ts` and `packages/daemon/src/http/routes/security.test.ts`, cover all table rows. Include SOPS with only the key overridden, DB with only an account/version override and DB with an unrelated setting. Assert that the state response contains no credential values and a rejected candidate leaves the current credentials usable.

## 4. Exercise save, restart and explicit LIVE

- [ ] Add `packages/daemon/src/http/routes/braiins-migration.integration.test.ts`. Use the real repos, a temporary SQLite file, Fastify injection, and synthetic outbound fetch, following `packages/daemon/src/services/braiins-v2.integration.test.ts`. Keep a request ledger at the Braiins transport. Fail on any unexpected operation. Exercise setup verification, migration reads, and DRY-RUN with **zero outbound bid mutations**. Register the run-mode and security routes against the same runtime and repository.
- [ ] Seed a v1 DB with an owned active bid and synthetic account history. Refuse switching during LIVE or an in-flight v1 write. Switch to DRY-RUN, verify matching v2 history, save, assert active v1 / saved v2, and check the premature LIVE request returns 409. In the temporary DB set `boot_mode=ALWAYS_LIVE` before closing it.
- [ ] Reopen the DB with the saved v2 key and run production account preparation and boot-mode selection. Move the existing mode decision and runtime update into an import-safe function in a new `packages/daemon/src/config/boot-mode.ts`. Both `packages/daemon/src/main.ts` and the fixture call it. Import the helper directly in tests because importing `main.ts` starts the daemon. Assert that the persisted runtime mode is DRY-RUN **despite ALWAYS_LIVE**, and that the API reports confirmation required. Repeat the restart. A control with the same boot preference and the confirmation flag cleared must select LIVE. Never start a controller scheduler in this fixture.
- [ ] While DRY-RUN and awaiting confirmation, pass a valid synthetic edit of the owned active bid into the real `V2BidMutations.run()`. Require a LIVE-mode rejection and zero outbound mutations. For the mismatched-account case, create a fresh client and route instance against the same bound DB. Give that client a synthetic key whose first account response contains only a different account ID. Assert an outbound account lookup, HTTP 409 and an intact flag. The original client caches successful discovery and cannot exercise this case by changing its mock response alone. Back on the matching route, explicit LIVE clears the flag. Use the existing `config/braiins-credentials.test.ts` and `config/braiins-migration-guard.test.ts` for historical-bid, deposit, failed-save and in-flight coverage.
- [ ] Add `scripts/test-braiins-connection-ui.mjs` using the root Playwright dependency and Node assertions. Have the script start the built SPA on an ephemeral loopback port, mock same-origin API calls, reject unexpected external requests, and close the server and browser in teardown. Visit real setup and Config pages. Assert keyboard switching, masked review and exact v1/v2 submissions, optional Verify, name/ID fallback, retry after a temporary failure, and a delayed old reply after editing or switching. Cover editable v1 → saved v2 → restarted DRY-RUN → confirmed v2, plus mixed-source instructions. For an editable v2 account requiring review after a permission denial, assert that both **Rotate API key** and the review prompt are visible. In a separate PAUSED case, complete confirmed non-placement and verify the prompt appears on the current Config page without a reload. Adoption of a matching bid must reflect the actual server flag. This browser fixture checks what the operator can see and submit. The daemon test above counts exchange requests.

## 5. Run from a clean checkout

Use Node 22.22.2 or newer on the 22.x line and pnpm 10.33.0, matching the lockfile's Inquirer engine requirement and the root package-manager pin. Install SOPS and age for the encrypted-secret round trips. From the application root, build the daemon's workspace dependencies before focused daemon tests. Repeat that dependency build after editing the shared client so the daemon imports the current `dist`.

```sh
pnpm install --frozen-lockfile
pnpm --filter '@hashrate-autopilot/daemon^...' run build
pnpm exec vitest run --testTimeout=60000 --hookTimeout=60000 packages/braiins-client packages/daemon/src/setup-mode.test.ts packages/daemon/src/config/{env-overrides,secret-sources,braiins-credentials,braiins-migration-guard}.test.ts packages/daemon/src/http/routes/{security.test,braiins-migration.integration.test}.ts
pnpm --filter @hashrate-autopilot/dashboard run lingui:extract
pnpm build
pnpm typecheck
pnpm exec playwright install chromium
node scripts/test-braiins-connection-ui.mjs
pnpm test --maxWorkers=2 --testTimeout=60000 --hookTimeout=60000
```

For each behavior change, reproduce the missing behavior with its targeted test, implement it, then rerun the test. Update `README.md`, `docs/configuration.md`, and English, Dutch and Spanish catalogs. Follow the repository's changelog and build-number convention for the implementation commit. Completion requires passing focused and full tests, typecheck, production build and browser assertions. Record the commands, results and any skipped checks in the PR.
