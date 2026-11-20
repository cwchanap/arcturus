# HPA-917 — Astro 7 / Cloudflare 14: implementation plan

**Linear:** https://linear.app/cwchanap/issue/HPA-917/maintenance-coordinate-ignored-astro-cloudflare-and-tooling-majors  
**Design:** [2026-11-19-hpa-917-astro7-cloudflare14-design.md](../specs/2026-11-19-hpa-917-astro7-cloudflare14-design.md)  
**Baseline:** `main` `d0e5a55a1ec2c692707aac3aa9196610412de9a7`  
**PR discipline:** **ONE PR for HPA-917**, beginning as documentation-only. Add implementation, regression fixes, evidence and review responses to this same draft PR; do not create a second implementation PR.

Astro 6 / adapter 13 / Vitest 5 is today's working baseline ([merged #86](https://github.com/cwchanap/arcturus/pull/86)). MDX was already removed, and the historical `assetsInclude` failure predates that compatible stack. Only the paired Astro 7 / adapter 14 upgrade is the required code change. TypeScript 7 is a documented hold; Vitest major is gated on tests. KISS: no refactor or new infrastructure.

## 1. Capture baseline and reproducibility

- [ ] Recheck latest `main` and the Linear issue before code changes; rebase this same PR if needed, and ensure no competing upgrade PR is active.
- [ ] Capture the current `package.json`, `bun.lock` and `.github/dependabot.yml` state. Verify the source Worker entry (`src/worker.ts`), `astro.config.mjs`, `src/middleware.ts`, `wrangler.toml`, `vitest.config.ts` and CI workflows. Confirm `@astrojs/mdx` is absent; do not add it back.
- [ ] Use the repository's supported Node runtime and Bun, install with `bun install --frozen-lockfile`, and record baseline results for `bunx astro check`, `bun run test:unit`, `bun run test:integration` and `bun run build`. Record known preexisting failures separately, with log links/commands; do not label a regression as preexisting without a baseline run.
- [ ] Through **browser MCP**, capture baseline lobby/Poker screenshots at **1280×800** and **375×812** using `main`. These are the visual comparison source because HPA-917 has no Linear mockup.

## 2. Make one coordinated dependency change

- [ ] Upgrade **`astro` to 7.x** and **`@astrojs/cloudflare` to 14.x** together using Bun; choose compatible available patch releases and commit the updated `package.json` and `bun.lock`. Re-run frozen install. Avoid a separate intermediate Astro-only or adapter-only PR.
- [ ] Keep MDX removed and TypeScript at 6.x. Keep Vitest initially at 5.x until the new integration suite is exercised. Do not change unrelated runtime dependencies simply for freshness.
- [ ] Verify active compatibility with Astro 7's Vite 8, `@tailwindcss/vite`, `@astrojs/check`, and existing Node/Bun setup. If a specific peer needs a version adjustment, keep it narrowly within this PR and explain the failed gate it addresses.
- [ ] Check Astro 7's compiler/whitespace migration against this repository. Look for invalid/unclosed Astro markup, `src/fetch.ts` reserved-file collisions, moved configuration, and changed text spacing. Correct only observed failures. Do **not** add a general compiler-compatibility layer or change `compressHTML` globally without a demonstrated need.

## 3. Preserve Cloudflare Worker, bindings and behavior

- [ ] Run build/typecheck and diagnose adapter 14 errors using the existing `astro.config.mjs`, `src/worker.ts` and `wrangler.toml`. Preserve `fetch` routing through the adapter, `MultiplayerPokerRoom` export, `scheduled()` jobs, D1/KV/DO/assets bindings, and auth secrets contract.
- [ ] Preserve `src/middleware.ts`'s `cloudflare:workers` → `Astro.locals.env` seam; update it only if the new adapter genuinely requires a change. Do not resurrect `Astro.locals.runtime`, `platformProxy`, or pre-Astro-6 adapter configuration.
- [ ] Verify `bun run build` plus `bunx wrangler deploy --dry-run` show the correct Worker entry/bindings, and `bun run preview` boots with the configured test bindings. Use a non-production preview; do not deploy to production merely to validate this ticket.
- [ ] If any existing frontend markup actually changes because of Astro 7's Rust compiler/JSX whitespace default, add the smallest component fix and corresponding focused regression assertion. No style overhaul.

## 4. Decide the Vitest and TypeScript holds from evidence

- [ ] Run `bun run test:unit` and `bun run test:integration` on the paired upgrade, including the real `vitest.config.ts` → `getViteConfig()` path. If an `assetsInclude`/Vite 8 load-time error appears, capture exact reproduction and address the smallest compatible test-tool peer change in this **same PR**; never silently skip integration tests.
- [ ] If **Vitest 5 passes**, retain it and the semver-major Dependabot ignore, but rewrite its stale Astro 6/Vite 7 comment to specify the current tested Vite 8 baseline and the exact gate for a future Vitest major. If a newer Vitest major is genuinely needed, bump only the necessary test dependencies and **remove the ignore only once integration tests pass**.
- [ ] Keep TypeScript 7 deferred; record the actual upgrade gate: compatible `@astrojs/check` and `typescript-eslint` peers, clean `bunx astro check`, clean ESLint and passing tests with TS 7. Do not fold speculative TS 7 migration into the Astro/adapter upgrade.
- [ ] Record the already-completed MDX removal as a retain/remove decision (merged #86). Keep closed Dependabot PRs #72/#73/#74/#77 closed; no bulk unignore or security-alert dismissals.
- [ ] If Astro 7 / adapter 14 cannot meet required checks without disproportionate unrelated changes, leave this PR draft with the documented blocker; do not merge a failing half-upgrade.

## 5. Automated suite, end-to-end via MCP and screenshots

- [ ] On the **implementation commit SHA**, run and capture exit status/logs for:
  
      bun install --frozen-lockfile
      bunx astro check
      bun run lint
      bun run format:check
      bun run test:unit
      bun run test:integration
      bun run build
      bunx wrangler deploy --dry-run
      bun run test:e2e:ci

  The E2E job uses the established local D1/test auth bootstrap setup. Follow the repo's `CLAUDE.md` notes for `.dev.vars`; do not change production auth behavior. If a test is flaky, show a justified repeat and preserve the first failure log.
- [ ] **Browser/Playwright MCP is the end-to-end acceptance owner**. Against a real running Worker preview on one Chromium platform, drive guest routing/one guest round, sign-in through existing test bootstrap, authenticated page/one game round, wallet balance update and its persistence after navigation/reload. Assert actual page and API outcomes, not just mocked service tests.
- [ ] Exercise one existing private multiplayer Poker create/join exchange against the Durable Object via the real Worker/WebSocket path; reuse `e2e/multiplayer-poker.spec.ts` where appropriate. Check static assets and representative API endpoints. If Worker scheduler/entry wiring changed, also use a terminal/Worker MCP to invoke the existing local scheduled handler through `wrangler dev --test-scheduled` and verify the real D1-facing effect; never fire it on production data.
- [ ] Smoke the built Cloudflare preview, and, when an existing non-production Cloudflare preview deployment is accessible, verify the same request path there. Record which environment was actually used and any unverified deployment gate instead of treating a local build as proof of a remote deployment.
- [ ] **Visual screenshot comparison via browser MCP**: on the upgraded app capture `/` and `/games/poker` at **1280×800** and **375×812**. Compare with the `main` screenshots: inspect header controls, localization whitespace (Astro 7 `compressHTML` behavior), table alignment, chips/cards, static asset loads and horizontal overflow. Record screenshot links and observed diffs; fix only actual regressions. There is **no UI mockup**, and no human acceptance requirement.
- [ ] Single-browser/platform acceptance is enough (no platform-specific implementation). Full Playwright and MCP browser checks are complementary; one cannot substitute for the other.

## 6. Finalize the same PR and update tracking

- [ ] Document exact before/after dependency versions, all relevant source/config changes, **the implementation commit SHA**, command outcomes, Browser/Worker MCP end-to-end evidence, screenshots and their comparison findings in this PR.
- [ ] Add a succinct decisions table: **Astro 7 + adapter 14 validated or blocked**, **MDX removed**, **Vitest hold retained or removed with test proof**, **TypeScript 7 deferred with peer/checker gate**. Update HPA-917 so it is no longer based on the pre-#86 baseline, and link this PR under HPA-913.
- [ ] Check diff remains narrow: `package.json`/`bun.lock`, genuinely needed config/source/compiler fixes, `.github/dependabot.yml` if its comment/hold changes, focused tests, and planning/evidence docs. No game rewrite, new packages without a demonstrated peer need, migration, security-alert dismissal, or additional PR.
- [ ] PR remains **draft** until implemented and verified. GitHub Actions currently skip draft PRs (`lint.yml`, `test.yml`, `e2e.yml`); after implementation, get green required CI on a ready-for-review PR or explicitly trigger equivalent checks. Do not mark any unchecked box complete merely because this planning draft exists.

## End-to-end acceptance criteria (all automated / evidence-backed)

- [ ] **Dependency gate:** Astro 7.x + adapter 14.x resolve together, frozen Bun install works, no unused MDX added, TypeScript remains deliberately held pending peer support; Vitest decision accurately documented and tested.
- [ ] **Runtime gate:** Worker `fetch`, Cloudflare env, D1, KV, assets, Durable Object and scheduled route bindings survive build/preview; Wrangler dry-run confirms required exports/bindings.
- [ ] **Quality gate:** `astro check`, ESLint, Prettier, Bun unit tests, Vitest integration, production build, and existing Chromium Playwright suite succeed for the implementation SHA. No Vite 8 / `assetsInclude` load-time failure or skipped suite.
- [ ] **MCP E2E gate:** real Worker request journey verifies auth, a guest and authenticated game, D1 wallet write + reload, and private-room WebSocket path; scheduler smoke if entry/scheduled logic was modified. Save logs/links.
- [ ] **Visual gate:** browser-MCP side-by-side screenshots of lobby and Poker on desktop **1280×800** and mobile **375×812** show no broken navigation, missing localized spaces, unexpected reflow, clipped cards/chips or missing image assets. No human sign-off.
- [ ] **Traceability gate:** implementation evidence is tied to the exact commit SHA, Vitest/TypeScript/MDX decisions are linked in HPA-917 and this **single PR**, and any inaccessible Cloudflare preview gate is explicitly unresolved rather than falsely passed.

**Current status:** documentation-only plan. All implementation and acceptance checkboxes are intentionally unchecked.