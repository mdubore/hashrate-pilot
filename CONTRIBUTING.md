# Contributing

Hashrate Pilot continues Remco Douma’s Hashrate Autopilot. Open bug reports and pull requests in this repository. For larger changes, start a discussion about the operator workflow and how the change will be tested. [Issues](https://github.com/mdubore/hashrate-pilot/issues) · [Discussions](https://github.com/mdubore/hashrate-pilot/discussions)

## Contributions

- Bug fixes with a clear repro and a focused diff.
- Translations into a locale that doesn't exist yet (Czech, German, French, etc.) following the term policy in
  [`packages/dashboard/src/lib/i18n.ts`](packages/dashboard/src/lib/i18n.ts). See the existing `nl` and `es` `.po` files in
  `packages/dashboard/src/locales/` for the pattern.
- Improvements to the Umbrel / Docker / bare-metal install paths, documentation, and dev experience.
- Tests for existing untested behaviour.

## Review considerations

Changes involving payout addresses, fees, withdrawals or bid handling need a clear rationale and tests with simulated accounts. For changes to the controller, identify the operator-visible effect and how existing installations behave after an upgrade.

## Dev setup

```bash
# Prerequisites: Node 22.22.2+ on the 22.x line, pnpm 10.33.0
git clone https://github.com/mdubore/hashrate-pilot.git
cd hashrate-pilot
pnpm install --frozen-lockfile
pnpm build

# Daemon (live-reload via tsx)
pnpm daemon

# Dashboard (Vite dev server, proxies API to localhost:3000)
pnpm --filter @hashrate-autopilot/dashboard dev
```

Useful commands:

- `pnpm test` - run all tests across workspaces
- `pnpm typecheck` - all packages
- `pnpm build` - all packages (also runs `lingui:compile` for the
  dashboard)
- `pnpm --filter @hashrate-autopilot/dashboard run lingui:extract`
    - re-extract translation strings from source after edits

`docs/spec.md` is the project's design document - read the relevant section before changing how the controller 
behaves. `docs/research.md` captures empirical findings about the Braiins marketplace that we learned the hard way 
(e.g. that it's pay-your-bid, not CLOB - this matters for any pricing change).

## Commit and PR style

- Match the existing commit style (look at recent `git log`). Imperative subject, body explains the "why", focused 
  diffs.
- One logical change per commit when reasonable.
- For PRs: describe what changes, why, and how you tested. Link the issue if it has one.

## License and DCO

Contributions use the project's MIT license. Preserve the original copyright notice when redistributing the software. [License](LICENSE)
