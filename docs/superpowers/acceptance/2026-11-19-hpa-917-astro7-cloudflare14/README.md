# HPA-917 — local acceptance record (Astro 7 / @astrojs/cloudflare 14)

**Date:** 2026-11-19 · **Plan:** [2026-11-19-hpa-917-astro7-cloudflare14.md](../../plans/2026-11-19-hpa-917-astro7-cloudflare14.md) · **PR:** [#92](https://github.com/cwchanap/arcturus/pull/92)

This record summarizes the local acceptance checks. Raw logs, Playwright traces and run metadata are no longer tracked; the comparison below retains a representative mobile pair. GitHub Actions results were still pending when this record was written (workflows skip draft PRs); CI links belong in the PR description.

## Environment

- Node `v24.22.3` via `mise exec node@24` (this shell defaults to Node 26 via mise `latest`; `.node-version` = `24` is what `actions/setup-node` reads in CI). `engines.node >=22.23.4` in `package.json` declares Astro 7.4's floor.
- Bun with a frozen lockfile, local D1 migrations applied, gitignored `.dev.vars` with local-only E2E bootstrap values.

## Local gate results

| Check | Result |
| --- | --- |
| `bunx astro check` | 0 errors / 0 warnings (103 hints, 522 files) |
| `bun run lint` | clean |
| `bun run format:check` | clean |
| `bun test src/` | 3161 pass / 0 fail (180 files) |
| `bun run test:integration` | 4 passed (2 files) |
| `bun run build` | complete |
| `bunx wrangler deploy --dry-run` | `fetch`, `scheduled`, `MultiplayerPokerRoom`, D1/KV/DO/ASSETS bindings intact |
| `bun run test:e2e:ci` (astro dev) | 172 passed, 1 intentional MP skip |
| `bun run test:e2e:worker` (built Worker) | 19 passed — the three selected specs only |

The baseline suite was run against `main` before the upgrade.

## MCP acceptance (built Worker, Playwright)

The recorded Playwright status was passed for all three MCP-driven journeys:

- Guest Blackjack round without wallet settlement.
- Signed-in Casual Blackjack settlement with D1 balance preserved after reload.
- Private Poker create/join over WebSocket and a heads-up hand.

The old record described redaction of local-only authentication values in the archived traces; this cleanup does not inspect or rewrite Git history. Keep raw authenticated traces and logs in restricted storage.

## Screenshot comparison (baseline `main` vs upgraded)

The original spot check covered Lobby `/` and Poker `/games/poker` at 1280×800 (desktop) and 375×812 (mobile). The Poker mobile comparison remains here:

| View | Baseline | Upgraded |
| --- | --- | --- |
| Poker mobile | [baseline-poker-mobile.png](./baseline-poker-mobile.png) | [upgraded-poker-mobile.png](./upgraded-poker-mobile.png) |

Visual spot-check finding: no meaningful new text spacing, layout shift, clipped controls, or missing assets between baseline and upgraded captures.
