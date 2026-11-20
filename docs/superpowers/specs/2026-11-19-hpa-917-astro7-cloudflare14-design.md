# HPA-917 — Coordinated Astro 7 / Cloudflare 14 upgrade: design

**Linear:** https://linear.app/cwchanap/issue/HPA-917/maintenance-coordinate-ignored-astro-cloudflare-and-tooling-majors  
**Tracking:** https://linear.app/cwchanap/issue/HPA-913/tracking-dependabot-major-upgrade-plan-by-project  
**Implementation plan and sole acceptance checklist:** [2026-11-19-hpa-917-astro7-cloudflare14.md](../plans/2026-11-19-hpa-917-astro7-cloudflare14.md)  
**Baseline:** `main` at `d0e5a55a1ec2c692707aac3aa9196610412de9a7`. This PR (#92) remains **planning only** until implementation and test evidence are committed **to this same PR**.

## Goal and decisions

Upgrade Astro + Cloudflare SSR together with the smallest viable change; preserve every game's current behavior and the source Worker entry. Keep scope to one PR with no compatibility framework, database schema migration, game logic rewrite, art or SFX.

| Dependency | Current `main` | Decision |
| --- | --- | --- |
| Astro | `^6.4.8` | Coordinated upgrade to a compatible **7.x** patch |
| `@astrojs/cloudflare` | `^13.7.0` | Coordinated upgrade to compatible **14.x** |
| `@astrojs/mdx` | Removed in [merged #86](https://github.com/cwchanap/arcturus/pull/86) | Keep removed, no unused integration |
| Vitest | `^5.1.0` | Keep 5; validate its Vite 8-compatible peer range with real integration tests |
| TypeScript | `6` | Keep 6; `@astrojs/check` / `typescript-eslint` peers currently exclude 7 |
| Dependabot | Vitest major ignore | Refresh rationale for Astro 7/Vite 8, add TS major ignore with peer-support gate |

Do not revive historical Dependabot PRs [#72](https://github.com/cwchanap/arcturus/pull/72), [#73](https://github.com/cwchanap/arcturus/pull/73), [#74](https://github.com/cwchanap/arcturus/pull/74), [#77](https://github.com/cwchanap/arcturus/pull/77). The prior `assetsInclude` mismatch was an older Astro/Vite combination, not a proven Vitest 5/Vite 8 failure.

## Runtime boundaries

**Node:** Astro 7.4.x requires Node ≥22.23.4. Pin **Node 24** in `.node-version` and run `actions/setup-node@v6` with `node-version-file` in every job of `.github/workflows/lint.yml`, `test.yml` and `e2e.yml` (including the new built-Worker job). Configure Node before Bun setup. Continue to use Bun for dependency installation and the repository's current scripts; no extra lockfile.

**Cloudflare:** keep `wrangler.toml` `main = "./src/worker.ts"`, `fetch()` via `@astrojs/cloudflare/handler`, `MultiplayerPokerRoom` Durable Object export, `scheduled()` cleanup jobs, D1 (`DB`), KV (`SESSION`), assets and auth bindings. Preserve `src/middleware.ts`'s `cloudflare:workers` → `Astro.locals.env` seam. Correct only actual adapter migration errors. Update obsolete Astro 6/adapter 13 comments in `src/worker.ts`, `wrangler.toml`, `src/middleware.ts` and `src/env.d.ts` even if no behavior change is needed.

**Compiler/Vite 8:** check `@tailwindcss/vite`, `experimental_AstroContainer` integration assertions, HTML whitespace, Astro markup validity and localized game pages. Repair specific failures; no blanket `compressHTML` change or compatibility shim.

## Regression strategy: automate the built Worker

Today, `bun run test:e2e:ci` exercises `astro dev`. In contrast, `playwright.config.mp.ts` builds with `PUBLIC_E2E=1 bun run build` and starts `wrangler dev`, exercising the **real built Worker and DO WebSocket**. Keep its existing `test:e2e:mp` script for focused multiplayer checks and add a separate narrowly scoped `test:e2e:worker` script which runs these three specs against the built Worker:

- `e2e/multiplayer-poker.spec.ts` — two authenticated users create/join a private room over WebSocket and complete a hand;
- `e2e/public-single-player-games.spec.ts` — guest routes and completed guest rounds (no wallet settlement);
- `e2e/authed-user-preservation.spec.ts` — authenticated casual Blackjack settlement and UI balance; **extend the existing test with a reload and assert the settled D1-backed balance persists**.

Use an **explicit spec list** with `MP_E2E=1`, never a blanket `MP_E2E=1 bunx playwright test --config playwright.config.mp.ts`: production builds return 404 for DEV-only `DELETE /api/missions/progress` (`src/pages/api/missions/progress.ts`), which `e2e/missions.spec.ts` relies upon.

Add a second `.github/workflows/e2e.yml` job for the built-Worker script, with the **same draft-PR guard** as the existing job, Node 24 and current D1 / `.dev.vars` setup. Give uploaded artifacts **distinct names** `playwright-report-mp` and `test-results-mp` (the existing job uses `playwright-report` / `test-results`). This keeps adapter regressions reproducible for later Dependabot updates.

## Acceptance approach

1. **Automated checks:** frozen Bun install, `astro check`, lint, format, unit tests, Vitest integration, build, Wrangler dry-run, `test:e2e:ci` and `test:e2e:worker`. Only this scoped Worker suite is required; do not claim the full suite works under production mode without running it. Existing `src/server/cleanup.test.ts` covers scheduled jobs unless `scheduled()` changes.
2. **End-to-end via MCP:** MCP drives/inspects the **actual built Worker** and validates the same real guest, authenticated D1-write-and-reload, and two-player WebSocket paths; reuse and invoke the existing/extended Playwright journeys through MCP rather than writing an independent, unrepeatable interaction script. Keep MCP observations/links as acceptance evidence, with the automated suite as the regression owner.
3. **Visual via browser MCP:** no Linear UI mockup exists. Screenshot the lobby `/` and Poker `/games/poker` at **1280×800 and 375×812**, comparing to baseline UI and checking localized whitespace, layout, cards/chips, images and overflow. These are *spot checks*, not a substitute for the broader Playwright tests. One browser platform suffices.
4. **CI and deployment:** all test workflows currently skip draft PRs. Collect actual command results during implementation and GitHub Actions once the PR is ready. A local production-built Worker + `wrangler deploy --dry-run` is sufficient: this repository has no non-production Cloudflare `[env.*]` deployment. Do not deploy to production merely to test.

If the paired Astro/adapter upgrade cannot satisfy these checks without unrelated changes, keep PR #92 draft and document the blocking failure. The **single, actionable acceptance checklist** is in the linked plan; do not duplicate it here.