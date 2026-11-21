# HPA-917 — local acceptance record (Astro 7 / @astrojs/cloudflare 14)

**Date:** 2026-11-19 · **Plan:** [2026-11-19-hpa-917-astro7-cloudflare14.md](../../plans/2026-11-19-hpa-917-astro7-cloudflare14.md) · **PR:** [#92](https://github.com/cwchanap/arcturus/pull/92)

Evidence for the checked boxes in the plan, moved out of the gitignored `.superpowers/sdd/` working directory so reviewers can reach it. GitHub Actions results were still pending when this record was written (workflows skip draft PRs); CI links belong in the PR description.

## Environment

- Node `v24.22.3` via `mise exec node@24` (this shell defaults to Node 26 via mise `latest`; `.node-version` = `24` is what `actions/setup-node` reads in CI). `engines.node >=22.23.4` in `package.json` declares Astro 7.4's floor.
- Bun, frozen lockfile (`final-install.log`), local D1 migrations applied (`local-migrations.log`), gitignored `.dev.vars` with local-only E2E bootstrap values.

## Local gate results

| Check | Result | Log |
| --- | --- | --- |
| `bunx astro check` | 0 errors / 0 warnings (103 hints, 522 files) | [final-astro-check.log](./final-astro-check.log) |
| `bun run lint` | clean | [final-lint.log](./final-lint.log) |
| `bun run format:check` | clean | [final-format.log](./final-format.log) |
| `bun test src/` | 3161 pass / 0 fail (180 files) | [final-unit.log](./final-unit.log) |
| `bun run test:integration` | 4 passed (2 files) | [final-integration.log](./final-integration.log) |
| `bun run build` | complete | [final-build.log](./final-build.log) |
| `bunx wrangler deploy --dry-run` | `fetch`, `scheduled`, `MultiplayerPokerRoom`, D1/KV/DO/ASSETS bindings intact | [final-dry-run.log](./final-dry-run.log) |
| `bun run test:e2e:ci` (astro dev) | 172 passed, 1 intentional MP skip | [final-e2e-dev.log](./final-e2e-dev.log), [last-run](./test-results-dev.last-run.json) |
| `bun run test:e2e:worker` (built Worker) | 19 passed — the three selected specs only | [final-e2e-worker.log](./final-e2e-worker.log), [last-run](./test-results-worker.last-run.json) |

Baseline suite output from `main` before the upgrade: [baseline-tests.log](./baseline-tests.log).

## MCP acceptance (built Worker, Playwright)

Playwright traces from the MCP-driven runs, one per journey ([`.last-run.json`](./test-results-mcp/.last-run.json): `status: passed`). Session-cookie and `x-e2e-auth-bootstrap-secret` header values in the authenticated traces are redacted — they are local-only test credentials.

- [guest Blackjack round without wallet settlement](./test-results-mcp/public-single-player-games-224e3-d-without-wallet-settlement-chromium/trace.zip)
- [signed-in Casual Blackjack settle + reload-persistent D1 balance](./test-results-mcp/authed-user-preservation-a-f4f2b-rmally-without-run-requests-chromium/trace.zip)
- [private Poker create/join WebSocket heads-up hand](./test-results-mcp/multiplayer-poker-Multipla-9a967-a-local-stack-heads-up-hand-chromium/trace.zip)

Open a trace with `bunx playwright show-trace <file>`.

## Screenshot comparison (baseline `main` vs upgraded)

Lobby `/` and Poker `/games/poker` at 1280×800 (desktop) and 375×812 (mobile):

| View | Baseline | Upgraded |
| --- | --- | --- |
| Lobby desktop | [baseline-lobby-desktop.png](./baseline-lobby-desktop.png) | [upgraded-lobby-desktop.png](./upgraded-lobby-desktop.png) |
| Lobby mobile | [baseline-lobby-mobile.png](./baseline-lobby-mobile.png) | [upgraded-lobby-mobile.png](./upgraded-lobby-mobile.png) |
| Poker desktop | [baseline-poker-desktop.png](./baseline-poker-desktop.png) | [upgraded-poker-desktop.png](./upgraded-poker-desktop.png) |
| Poker mobile | [baseline-poker-mobile.png](./baseline-poker-mobile.png) | [upgraded-poker-mobile.png](./upgraded-poker-mobile.png) (reloaded: [upgraded-poker-mobile-reloaded.png](./upgraded-poker-mobile-reloaded.png)) |

Visual spot-check finding: no meaningful new text spacing, layout shift, clipped controls, or missing assets between baseline and upgraded captures.
