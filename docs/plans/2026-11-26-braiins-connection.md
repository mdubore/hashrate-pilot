# Braiins connection presentation implementation plan

Implement the [approved dashboard design](2026-11-26-braiins-connection-design.md) on `feat/braiins-hashpower-v2`. The application uses a React and Lingui dashboard, Fastify routes, a typed Braiins client and SQLite state. Start from the dual API implementation at `6a311f76`. Use the existing migration guard and credential storage. For a later implementation session, follow the executing-plans workflow.

## 1. Verify a candidate v2 key during setup

- [ ] In `packages/braiins-client/src/v2-client.test.ts`, cover a single account with a display name, an omitted name and an unexpected account. Extend account discovery in `src/v2-transport.ts` and `src/v2-client.ts` within the same package. Preserve the existing `getAccountId()` contract and expose the optional display name alongside the verified ID.
- [ ] In `packages/daemon/src/setup-mode.test.ts`, exercise a proposed setup-only `POST /api/setup/braiins/verify` using a synthetic candidate key. Expect only the account ID and optional display name on success. Check invalid credentials and temporary outages separately. Assert the outbound method is GET, the key stays out of the response and storage, and setup remains incomplete.
- [ ] Implement the handler in `packages/daemon/src/setup-mode.ts` using the setup server's existing request protections and the fixed Braiins endpoint. Preserve final server-side credential and history validation on `POST /api/setup`. Run the client and setup tests first against the old implementation, then against the new handler.

## 2. Present credentials in first setup

- [ ] Update `packages/dashboard/src/lib/api.ts` and `packages/dashboard/src/pages/Setup.tsx`. Show the v2 form first. Make the legacy disclosure keyboard accessible and reversible. Retain the credential-specific review screen and masked values.
- [ ] Test both submit payloads. With a mocked delayed verification response, edit the key or switch to v1 before the reply arrives. Confirm that the old reply cannot mark the new selection verified. A temporary outage should offer a retry. A successful read should report account access only.

## 3. Show migration progress and rotation in Config

- [ ] Drive the connection summary in `packages/dashboard/src/pages/Config.tsx` from the active and saved versions in `GET /api/security/state`. Exercise the four states in the design table, including the period after saving and before restart. Use the existing authenticated save action and refresh the state after success.
- [ ] Keep same-account rotation and the pending-placement recovery form accessible on v2. Cover a mismatched key, an in-flight legacy command, externally managed credentials and a successful migration with owned bids. Reuse `packages/daemon/src/http/routes/security.test.ts` and `packages/daemon/src/config/braiins-migration-guard.test.ts` for server assertions.

## 4. Verify and document

- [ ] Update the setup and migration text in `README.md` and `docs/configuration.md`. Extract Lingui messages and review the English, Dutch and Spanish catalogs.
- [ ] Run the commands below from the application root. Expect the focused tests, build, typecheck and full suite to pass. Smoke-test both setup paths and migration status in a browser using a mocked exchange. Confirm zero marketplace writes during verification and DRY-RUN.

```sh
pnpm exec vitest run packages/braiins-client packages/daemon/src/setup-mode.test.ts packages/daemon/src/http/routes/security.test.ts packages/daemon/src/config/braiins-migration-guard.test.ts
pnpm --filter @hashrate-autopilot/dashboard run lingui:extract
pnpm build
pnpm typecheck
pnpm test --maxWorkers=2 --testTimeout=60000 --hookTimeout=60000
```
