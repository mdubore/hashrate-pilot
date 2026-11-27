# Security policy

## Reporting a vulnerability

Report suspected vulnerabilities in Hashrate Pilot privately using GitHub. Include the affected build, the impact, and steps to reproduce with synthetic credentials. The report goes directly to the maintainers of this repository. [Report a vulnerability](https://github.com/mdubore/hashrate-pilot/security/advisories/new)

## What's in scope

- The autopilot daemon itself (`packages/daemon/**`)
- The dashboard (`packages/dashboard/**`) and the auth flow
- The application built from this repository, including its Dockerfile
- The setup wizard's secret-handling paths

## What's out of scope

- Vulnerabilities in upstream dependencies that aren't reachable in
  any default code path - report those directly to the dependency.
- Misconfiguration of an operator's own environment (publicly
  exposing the dashboard without a reverse proxy, weak passwords on
  the wizard step, etc.). The default Umbrel install routes through
  `app_proxy` and is fine; deliberately bypassing that is on you.
- The Braiins Hashpower API itself, the Ocean pool, or any other
  third-party service the autopilot consumes - report those to their
  respective vendors.
- Forks of this repository. If a fork has a vulnerability, contact
  the fork's maintainer.

## How secrets are protected

Your credentials (Braiins tokens, bitcoind RPC password, Telegram bot
token, DDNS credential) are AES-256-GCM encrypted at rest in the
database, and the dashboard password is stored as a one-way scrypt hash.
The encryption key comes from `BHA_SECRET_KEY` (on Umbrel that's the
device-derived `APP_SEED`, which lives outside the app's data folder) or
a generated key file next to the database. The config API is write-only
for credential fields, and the config-change audit log redacts them.

This protects the **data-at-rest** cases: a copied database, an
unencrypted backup, an exported support bundle. It does **not** protect
against someone who already controls the running machine - an unattended
daemon has to decrypt its own secrets on boot with no human present, so
the key is necessarily reachable by privileged processes on that host.
Env- and SOPS-sourced secrets are never written to disk in the clear;
DB-sourced secrets are the encrypted-at-rest path above. Full detail:
[`docs/security-secrets-at-rest.md`](docs/security-secrets-at-rest.md).

## Advisories inherited from Hashrate Autopilot

- **GHSA-wvpp-w528-9p8x** (high): credentials were stored in plaintext in
  the SQLite database, so a copied database or backup exposed them.
  Addressed in v1.17.0 by encrypting DB-stored secrets at rest and
  hashing the dashboard password; existing installs upgrade in place on
  the first start of that version.
- **GHSA-x8x9-3m72-9w8w** (medium): the config-change audit log wrote
  credential values in cleartext into Timeline system events, which were
  readable via the API, the UI, and the Excel export. Addressed in
  v1.17.0 by redacting credential fields at write time and scrubbing the
  previously-logged rows on upgrade.

Both were reported privately and are credited to their reporters in the
published advisories.

## Coordinated disclosure

If you'd like a CVE assigned, GitHub's vulnerability advisories can
do that as part of the private flow. Otherwise we'll just publish a
patch and a CHANGELOG note.

Thank you for taking the time to report responsibly.
