# HPA-917 — Astro 7 / Cloudflare 14: implementation plan

**Linear:** https://linear.app/cwchanap/issue/HPA-917/maintenance-coordinate-ignored-astro-cloudflare-and-tooling-majors  
**Design:** [2026-11-19-hpa-917-astro7-cloudflare14-design.md](../specs/2026-11-19-hpa-917-astro7-cloudflare14-design.md)  
**Baseline:** `main` at `d0e5a55a1ec2c692707aac3aa9196610412de9a7` ([merged PR #86](https://github.com/cwchanap/arcturus/pull/86) already did Astro 6 / adapter 13 / MDX removal / Vitest 5).  
**PR discipline:** **PR #92 only** for design, code, tests and review fixes. The same PR now also carries the implementation; GitHub Actions evidence remains pending while it is a draft.

This plan incorporates [design review #1](https://github.com/cwchanap/arcturus/pull/92#pullrequestreview-5987451203) and [review #2](https://github.com/cwchanap/arcturus/pull/92#pullrequestreview-5987928153): Node 24 pin, explicit built-Worker D1/DO coverage, no artifact collisions, no all-spec production-mode run. Reuse automated tests for repeatability; MCP drives the real end-to-end acceptance, and screenshot checks remain required because the ticket has no UI mockup.

## 1. Pin Node and establish baseline

- [x] Add `.node-version` containing `24`. Add `actions/setup-node@v6` (with `node-version-file: .node-version`) **before Bun** in every job of `.github/workflows/lint.yml` (lint/build), `test.yml` and `e2e.yml` (both jobs). Verify `node --version` locally (`v24.22.3` observed) and in CI (run pending — workflows skip draft PRs); Astro 7.4.x requires Node ≥22.23.4.
- [x] Link baseline `main` GitHub Actions results rather than duplicating every existing test. Verify `package.json`, `bun.lock`, `astro.config.mjs`, `src/worker.ts`, `wrangler.toml`, `src/middleware.ts`, `vitest.config.ts` and `.github/dependabot.yml` against the code being upgraded. Keep `@astrojs/mdx` absent.
- [x] Capture baseline `main` lobby `/` and Poker `/games/poker` screenshots at desktop **1280×800** and mobile **375×812** (or link existing evidence of those precise views). These are for the mandatory comparison after upgrading; no Linear mockup exists.

## 2. Upgrade Astro + adapter as one compatible pair

- [x] Upgrade `astro` to a compatible **7.x** patch and `@astrojs/cloudflare` to compatible **14.x** together in `package.json`, then update `bun.lock` with Bun. Example review-era versions: Astro 7.4.13 / Cloudflare 14.4.9; recheck current peer compatibility. `bun install --frozen-lockfile` must succeed.
- [x] Keep Vitest **5.x**, TypeScript **6.x** and MDX removed. Vitest 5 and `@tailwindcss/vite` already declare Vite 8 support; make a dependency tweak only if a measured peer/test failure requires it.
- [x] Run `bunx astro check`, `bun run test:integration` and `bun run build` early. Fix only actual Astro 7 Rust compiler, Vite 8, HTML whitespace, CSS or `experimental_AstroContainer` assertion regressions; do not globally change `compressHTML` or add a compatibility shim.
- [x] Keep `src/worker.ts`'s `@astrojs/cloudflare/handler` `fetch`, `scheduled()` and `MultiplayerPokerRoom` export; preserve `src/middleware.ts`'s `cloudflare:workers` → `Astro.locals.env` seam, D1, KV, DO, static assets, auth and cron bindings. Verify with `bun run build` and `bunx wrangler deploy --dry-run`.
- [x] Update stale Astro 6/adapter 13 prose in `src/worker.ts`, `wrangler.toml`, `src/middleware.ts` and `src/env.d.ts` even if those files otherwise need no functional changes.

## 3. Keep major-version holds simple

- [x] Update the Vitest ignore explanation in `.github/dependabot.yml` for the tested **Astro 7/Vite 8 + Vitest 5** baseline, retaining its semver-major ignore.
- [x] Add a **TypeScript semver-major** ignore beside Vitest's. State its removal gate in the comment: `@astrojs/check` and `typescript-eslint` must both support TS 7, then typecheck/lint/tests must pass. Don't upgrade TS as part of this PR.
- [x] Keep `@astrojs/mdx` removed (PR #86); do not reopen old Dependabot PRs #72/#73/#74/#77, bulk-unignore packages, or dismiss security alerts.

## 4. Add repeatable production-built Worker coverage

- [x] Extend the existing signed-in **Casual Blackjack** test in `e2e/authed-user-preservation.spec.ts`: after the successful `POST /api/wallet/settle` response and the visible settled-balance assertion, **reload the same authenticated page**, then assert `#player-balance` still equals the *server-returned settled balance*. Ensure the reload is not masked by an optimistic client-only update. Keep its existing isolated user and no-ranked-run assertions.
- [x] Add a separate, explicitly scoped `package.json` script `test:e2e:worker`. It applies local migrations and runs three existing specs under `playwright.config.mp.ts` with `MP_E2E=1`:

  ```sh
  bun run db:migrate:local &&
  MP_E2E=1 bunx playwright test \
    e2e/multiplayer-poker.spec.ts \
    e2e/public-single-player-games.spec.ts \
    e2e/authed-user-preservation.spec.ts \
    --config playwright.config.mp.ts
  ```

  Playwright's MP config starts `PUBLIC_E2E=1 bun run build && wrangler dev`, exercising the **built Worker** with real authentication/D1 and Durable Object WebSockets. Keep the existing narrow `test:e2e:mp` script for standalone MP diagnosis.
- [x] **Do not run the whole Playwright test directory under the MP/production-build config.** `e2e/missions.spec.ts` calls `DELETE /api/missions/progress`; that endpoint returns 404 when `import.meta.env.DEV` is false. Always pass these explicit spec paths (also for diagnostics) unless a particular additional spec is separately proven compatible.
- [x] Add a second job to `.github/workflows/e2e.yml` using the existing E2E bootstrap steps: Node 24, Bun frozen install, Chromium, local D1, `.dev.vars` and `E2E_AUTH_BOOTSTRAP_SECRET`. Run **`bun run test:e2e:worker`**, with the same draft-PR `if:` guard as the existing job and appropriately sized timeout.
- [x] **Avoid CI artifact collisions:** the new job must upload `playwright-report-mp` and `test-results-mp`; leave the original job's `playwright-report` and `test-results` names unchanged. Both jobs should archive test failures (`if: always()`).

## 5. Validation and MCP acceptance

- [x] On the implemented branch, run the existing checks and keep actual evidence/CI links (no claimed pass before execution; local evidence recorded — CI links pending while the PR is a draft):

  ```sh
  node --version                    # Node 24
  bun install --frozen-lockfile
  bunx astro check
  bun run lint
  bun run format:check
  bun run test:unit
  bun run test:integration
  bun run build
  bunx wrangler deploy --dry-run
  bun run test:e2e:ci               # astro dev + local D1
  bun run test:e2e:worker           # explicit specs, built Worker + D1 + DO
  ```

- [x] **MCP end-to-end acceptance:** via a real Browser/Playwright MCP on one Chromium platform, run/observe the *built-Worker* guest Blackjack round (no wallet settlement), signed-in Casual Blackjack settlement **and reload-persistent D1 balance**, and private Poker create/join/WebSocket round. Drive the existing `test:e2e:worker` specs through MCP where supported rather than scripting redundant one-off journeys. Record observable test results and relevant evidence. The CI job supplies the repeatable regression safety net; MCP remains the acceptance owner.
- [x] If `scheduled()` entry wiring changes, exercise the existing local `wrangler dev --test-scheduled` path through a Worker/terminal MCP against **local** D1; otherwise `src/server/cleanup.test.ts` suffices. Never test scheduled mutations against production data.
- [x] **Browser-MCP screenshot acceptance (no UI mockup):** capture upgraded lobby `/` and Poker `/games/poker` at **1280×800** and **375×812**, compare to the baseline screenshots and inspect localized whitespace, navigation, visual hierarchy, chips/cards, images and horizontal overflow. This is a *spot-check*; the full `test:e2e:ci` suite covers other routes. One browser platform is enough. No human approval criterion.
- [x] Use local **production-built Worker + Wrangler dry-run**; no `[env.*]` non-production Cloudflare target exists in this repository. Do not create a deployment environment or deploy to production just for this validation.

## 6. Finish in PR #92

- [ ] Keep a short four-row decision summary in the PR description: paired Astro/adapter upgrade validated or blocked; MDX removed; Vitest 5 retained after integration testing; TypeScript 7 deferred behind published peer gate. Include links to CI and MCP screenshot evidence, not a separate evidence framework.
- [x] Keep the final diff focused on `.node-version`, the existing workflow files, `package.json`/`bun.lock`, Dependabot config, the single E2E test improvement, small observed migration fixes, stale version comments and these two docs. All changes stay in **PR #92**, never multiple PRs for one ticket.
- [ ] Keep the PR draft while GitHub Actions checks remain unrun — workflows skip draft PRs, so the direct local checks above were run and recorded during implementation; obtain actual GitHub Actions results when ready for review.

## End-to-end acceptance criteria

- [x] **Dependency/toolchain:** Node 24 used in local checks and pinned in every CI job (Actions runs pending while the PR is a draft); Astro 7/Cloudflare 14 peer-compatible frozen install passes; Vitest 5 / TS 6 / MDX removal and Dependabot holds documented; `astro check`, lint, format, unit and integration tests green.
- [x] **Built Worker + backend E2E:** build and Wrangler dry-run preserve fetch, scheduled, D1/KV/assets/DO bindings; the dedicated `test:e2e:worker` job runs **exactly the three selected specs** against the built Worker, including guest play, private-room WebSocket and the **new authenticated wallet balance reload persistence** assertion. Artifacts have unique names and the draft guard is present.
- [x] **General Playwright E2E:** `bun run test:e2e:ci` passes in its dev-server configuration; no compiler/whitespace regressions in tested game routes. Development-only mission endpoints are not mistakenly run against the production-built Worker.
- [x] **MCP E2E:** MCP executes/inspects real built-Worker guest, authenticated D1 write/reload, and multiplayer WebSocket journeys on one platform with recorded outcomes, using the repeatable tests rather than a duplicate manual harness.
- [x] **Visual:** browser MCP screenshot comparison of lobby and Poker at **1280×800** and **375×812** shows no meaningful new text spacing, layout, clipped controls, missing chips/cards/assets or unexpected overflow. No mockup available, no human sign-off; screenshot checks complement broad automated coverage.
- [ ] **Single-PR closeout:** all fixes and evidence live in PR #92; its decision summary accurately represents test outcomes and any remaining blocker.

**Status (post-implementation):** the checklist was planning-only when first drafted; implementation and local acceptance have since been executed on this branch and recorded under `.superpowers/sdd/2026-11-19-hpa-917-astro7-cloudflare14/` — Node 24 locally, frozen install, `astro check`, lint, format, 3161 unit + 4 integration tests, build, Wrangler dry-run, dev E2E 172 passed (1 intentional MP skip), built-Worker E2E 19 passed, MCP trace inspection 3/3 and local baseline-vs-upgraded screenshot comparisons. Still pending: GitHub Actions results (workflows skip draft PRs), publishing screenshot/trace evidence, and the PR-description decision summary — see the remaining unchecked boxes.