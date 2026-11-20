# HPA-917 — Astro 7 / Cloudflare 14: implementation plan

**Linear:** https://linear.app/cwchanap/issue/HPA-917/maintenance-coordinate-ignored-astro-cloudflare-and-tooling-majors  
**Design:** [2026-11-19-hpa-917-astro7-cloudflare14-design.md](../specs/2026-11-19-hpa-917-astro7-cloudflare14-design.md)  
**Baseline:** `main` at `d0e5a55a1ec2c692707aac3aa9196610412de9a7`; [PR #86](https://github.com/cwchanap/arcturus/pull/86) already did Astro 6 / Cloudflare 13 / MDX removal / Vitest 5.  
**One PR:** **#92 only**. It begins documentation-only; commit subsequent implementation, tests, evidence and review fixes to this same PR. Do not open another PR for HPA-917.

This plan incorporates the [2026-11-19 design review](https://github.com/cwchanap/arcturus/pull/92#pullrequestreview-5987451203): pin Node, reuse built-Worker tests, add the missing CI gate, keep Vitest 5 and TS 6, reduce redundant process. MCP E2E and screenshots remain required acceptance checks.

## 1. Establish runtime and baseline

- [ ] Add **`.node-version` containing `24`**. Add `actions/setup-node@v6` with `node-version-file: .node-version` to **each job** in `.github/workflows/lint.yml` (lint + build), `test.yml`, and `e2e.yml`, before Bun setup. Check `node --version` locally and in CI. Astro 7.4.x requires Node ≥22.23.4, so Node 22.22.0 is insufficient.
- [ ] Link the existing CI results on baseline commit `d0e5a55`. Capture any actual existing failures, rather than rerunning every baseline test. Confirm `package.json`, `bun.lock`, `astro.config.mjs`, `src/worker.ts`, `wrangler.toml`, `src/middleware.ts` and `vitest.config.ts` still match the design. `@astrojs/mdx` must remain absent.
- [ ] Capture the before-upgrade screenshots of lobby and Poker on `main` (or use verifiable existing baseline screenshots), at **1280×800** and **375×812**. There is no Linear mockup.

## 2. One coordinated dependency upgrade

- [ ] Upgrade `astro` to a current compatible **7.x** patch and `@astrojs/cloudflare` to compatible **14.x** together, committing `package.json` and `bun.lock` in this PR. Version examples verified in review: Astro 7.4.13 / adapter 14.4.9; recheck compatibility when performing the upgrade. Run `bun install --frozen-lockfile` and typecheck/build early.
- [ ] Keep `vitest` **5.x**, TypeScript **6.x**, and MDX removed. Vitest 5 accepts Vite 8 as a peer, and `@tailwindcss/vite` supports Vite 8; do not manufacture a new major-version branch. If a real peer-resolution failure arises, make only the minimal measured change.
- [ ] Fix only actual Astro 7 compiler, JSX/HTML whitespace, CSS or Vite 8 failures. Check `experimental_AstroContainer` rendering assertions in `integration/*.test.ts`. Do not apply a blanket `compressHTML` change or introduce a compatibility subsystem.
- [ ] Preserve the existing Cloudflare handler/`src/worker.ts` `fetch()`, `scheduled()`, `MultiplayerPokerRoom`, D1/KV/assets/DO bindings, and middleware `cloudflare:workers` → `Astro.locals.env` seam. Verify `bun run build` and `bunx wrangler deploy --dry-run`.
- [ ] Update stale pre-upgrade version comments in `src/worker.ts`, `wrangler.toml`, `src/middleware.ts` and `src/env.d.ts` alongside real code/config edits, without changing their runtime behavior solely to update prose.

## 3. Make dependency decisions once, in Dependabot config

- [ ] Retain the **Vitest semver-major ignore**, but replace the obsolete "Astro 6 / Vite 7" explanation in `.github/dependabot.yml` with "Astro 7 / Vite 8, Vitest 5 validated by the integration suite." If the suite fails, fix the concrete failure first; don't invent a speculative Vitest 6 upgrade.
- [ ] Add a targeted **TypeScript semver-major ignore** beside it, with the removal gate in the comment: both `@astrojs/check` and `typescript-eslint` must publish TS 7-compatible peers, then `astro check`, ESLint and tests must pass. Keep TS 6 until then.
- [ ] Retain the prior `@astrojs/mdx` removal and leave closed Dependabot PRs #72/#73/#74/#77 closed; no mass ignores or alert dismissals.

## 4. Automate the *built Worker* regression path

- [ ] Add a focused second job to `.github/workflows/e2e.yml` that installs with frozen Bun, sets up Node 24, installs Chromium, prepares test D1 and `.dev.vars` using the current E2E setup, then runs **`bun run test:e2e:mp`**. Follow the existing job steps; do not create a new test framework or deploy target.
- [ ] The script uses `PUBLIC_E2E=1 bun run build && wrangler dev` through `playwright.config.mp.ts`, testing **built Astro/adapter output** (not only `astro dev`). `e2e/multiplayer-poker.spec.ts` verifies two authenticated players create/join a room and play over the DO WebSocket.
- [ ] Keep existing `bun run test:e2e:ci` on the Astro-dev path. An optional follow-up diagnostic can run other compatible specs with `MP_E2E=1 bunx playwright test --config playwright.config.mp.ts`; **do not claim full built-Worker suite coverage without executing it**. The new dedicated job is the narrow long-term regression gate.

## 5. Run tests, MCP E2E and visual checks

- [ ] Run the existing checks on the *implemented* branch, record actual outcome and link CI run:

  ```sh
  node --version                 # Node 24
  bun install --frozen-lockfile
  bunx astro check
  bun run lint
  bun run format:check
  bun run test:unit
  bun run test:integration
  bun run build
  bunx wrangler deploy --dry-run
  bun run test:e2e:ci            # astro dev + D1
  bun run test:e2e:mp            # built Worker + auth + DO/WebSocket
  ```

- [ ] **End-to-end acceptance via Browser/Playwright MCP (not merely mocks or unit tests):** start the *built* Worker using the existing local Wrangler/Playwright setup on one Chromium platform; drive (1) guest route + playable round, (2) signed-in game round with a D1-backed wallet balance update that persists after reload/navigation, and (3) a private Poker room create/join and WebSocket exchange. Reuse existing E2E auth/bootstrap and MP test fixtures; no separate general-purpose harness. Record actual observations/links. The CI MP job verifies the DO seam independently.
- [ ] If `src/worker.ts`'s scheduled handler changes, use a terminal/Worker MCP with the existing `wrangler dev --test-scheduled` recipe on local D1 and assert the job effect; otherwise the current `src/server/cleanup.test.ts` is enough.
- [ ] **Visual acceptance via browser MCP**, no mockup: screenshot the upgraded lobby `/` and Poker `/games/poker` at **1280×800** and **375×812**, and compare to `main` baseline. Inspect navigation, typography/localized whitespace, cards/chips, images and overflow. Treat these two routes as **spot checks**, with the existing Playwright suite providing broader game-page regression evidence. One platform is sufficient; no human approval criterion.
- [ ] No non-production Cloudflare `[env.*]` deployment is configured. Use the local production-built Worker + Wrangler dry-run; don't demand a new preview environment or mark remote deployment as tested. Never deploy to production to validate.

## 6. Finish the same PR

- [ ] Keep a small decisions table in **PR #92**: Astro/adapter validated or blocked; MDX remains removed; Vitest 5 retained (actual integration result); TypeScript 7 deferred (Dependabot peer gate). Link required CI/MCP screenshot evidence in the PR without duplicate tracking files or a separate traceability checklist.
- [ ] Keep the diff limited to `.node-version`, the three workflow files, `package.json` / `bun.lock`, the Dependabot ignore rationale and TypeScript major rule, stale source comments, necessary Astro 7/adapter 14 fixes and focused tests. No unrelated refactor, new art, or second PR.
- [ ] Keep PR draft if any required gate fails. CI currently skips draft PRs, so run direct tests while drafting and obtain GitHub Actions results once ready-for-review; do not claim the planning commit validated the upgrade.

## End-to-end acceptance criteria

- [ ] **Dependencies and toolchain:** Node 24 pinned locally/CI; a compatible Astro 7 + Cloudflare adapter 14 pair installs reproducibly from `bun.lock`; MDX absent, Vitest 5 retained and TypeScript 7 explicitly held in Dependabot; `astro check`, lint, format, unit and integration tests pass.
- [ ] **Built-Worker backend E2E:** production build and Wrangler dry-run pass, correct D1/KV/DO/asset and Worker entry bindings preserved; existing `test:e2e:mp` passes against the built Worker both locally and through the new GitHub Actions job. Scheduler tested via MCP if its wiring changed.
- [ ] **Browser-MCP end-to-end:** on one Chromium platform against the built Worker, guest round, authenticated D1 wallet settlement with reload persistence, and two-player private-room WebSocket journey succeed with recorded test evidence.
- [ ] **Broad regression:** existing `test:e2e:ci` Playwright suite passes without compiler-generated text/DOM regressions; relevant integration snapshots/assertions pass under Astro 7/Vite 8.
- [ ] **Visual screenshot check:** browser-MCP compares lobby and Poker screenshots with the existing `main` UI at 1280×800 and 375×812; no missing localized spaces, blocked controls, visible overflow, missing chips/cards/images or unexplained layout changes. Screenshots supplement the broad E2E suite and do not alone imply all routes are checked.
- [ ] **Single-PR delivery:** all implementation and test fixes remain in PR #92; a four-row PR decision summary accurately reports what actually passed or remains blocked. No human sign-off.

**Status:** documentation-only revision in response to design review. All implementation/acceptance checkboxes remain unchecked.