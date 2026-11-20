# HPA-917 — Astro 7 and Cloudflare adapter 14: design specification

**Linear:** https://linear.app/cwchanap/issue/HPA-917/maintenance-coordinate-ignored-astro-cloudflare-and-tooling-majors  
**Tracking parent:** https://linear.app/cwchanap/issue/HPA-913/tracking-dependabot-major-upgrade-plan-by-project  
**Implementation plan:** [2026-11-19-hpa-917-astro7-cloudflare14.md](../plans/2026-11-19-hpa-917-astro7-cloudflare14.md)  
**Baseline reviewed:** `main` at `d0e5a55a1ec2c692707aac3aa9196610412de9a7` (2026-11-19).  
**Delivery:** One PR for HPA-917. This draft starts as **planning documents only**; put subsequent implementation, tests, validation evidence and review fixes in this same PR.

## Goal

Upgrade the already-working Astro/Cloudflare SSR stack **as one compatible pair**, preserve play-money game behavior and Worker bindings, and close or accurately gate the historical major-dependency decisions. This is maintenance, not a feature rewrite. Prefer changes to existing files, no new abstraction, migration, infrastructure or broad refactor.

## Verified starting point and stale-ticket corrections

| Area | Current repository / evidence | Decision |
| --- | --- | --- |
| Astro | `package.json`: `astro: ^6.4.8` | Target compatible Astro **7.x** in this PR |
| Cloudflare integration | `@astrojs/cloudflare: ^13.7.0` | Target compatible adapter **14.x** in the *same* PR |
| MDX | `@astrojs/mdx` is absent; no MDX integration in `astro.config.mjs` | **Retain removal**; do not resurrect `@astrojs/mdx@8` |
| Vitest | `vitest: ^5.1.0`, `vitest.config.ts` uses `getViteConfig()` | First test existing Vitest with Astro 7 / Vite 8; decide explicitly whether an in-PR Vitest bump is necessary |
| TypeScript | `typescript: 6` and `typescript-eslint: ^8.72.1` | Keep TypeScript 7 **deferred** until `astro check` / ESLint / peer support is demonstrably compatible |
| Dependabot | `.github/dependabot.yml` ignores Vitest semver-major; comment still describes an Astro 6 / Vite 7 baseline | Update comment and ignore **only based on measured integration evidence**, not a bulk unignore |

Merged [PR #86](https://github.com/cwchanap/arcturus/pull/86) already advanced Astro 5 → 6, adapter 12 → 13, removed unused MDX, and validated Vitest 5 with Vite 7. Earlier `assetsInclude` failure in [PR #69](https://github.com/cwchanap/arcturus/pull/69) referred to a *different* Astro/Vite combination and is not a current proven failure. Original Dependabot [#72](https://github.com/cwchanap/arcturus/pull/72), [#73](https://github.com/cwchanap/arcturus/pull/73), [#74](https://github.com/cwchanap/arcturus/pull/74) and [#77](https://github.com/cwchanap/arcturus/pull/77) were closed unmerged; **do not merge, rebase, or resurrect those old PRs**.

## Architecture and behavior to preserve

- **Worker entry:** `wrangler.toml` uses `main = "./src/worker.ts"`. `src/worker.ts` forwards `fetch()` through `@astrojs/cloudflare/handler`, exports the `MultiplayerPokerRoom` Durable Object, and runs scheduled retention/Blackjack expiration jobs. Adapt this seam only if adapter 14 requires it; do not replace it with a new hosting model.
- **Cloudflare access:** `src/middleware.ts` imports `env` from `cloudflare:workers` and sets `Astro.locals.env` for routes. Maintain D1 (`DB`), session KV (`SESSION`), Durable Object, static assets, test bootstrap and auth bindings.
- **Frontend:** preserve the existing Astro page routes, styles, locales and games. No intentional gameplay, wallet, API contract, database/schema, deployment secret, or UX change.
- **Toolchain:** Astro 7 moves from Vite 7 to **Vite 8**; its Rust compiler is stricter about invalid HTML, and its default HTML whitespace handling changes. Check the existing `@tailwindcss/vite` integration and resulting CSS. Fix concrete compiler/spacing differences locally rather than introducing blanket compatibility shims.
- **Runtime:** honor current Astro 7 / adapter 14 Node and peer requirements in local/CI workflows. Bun remains the package manager; do not add an unneeded direct Vite dependency or dual package-manager lockfiles.

References: [Astro 7 upgrade guide](https://docs.astro.build/en/guides/upgrade-to/v7/), [Cloudflare Astro guide](https://developers.cloudflare.com/workers/framework-guides/web-apps/astro/), [Astro Cloudflare adapter](https://docs.astro.build/en/guides/integrations-guide/cloudflare/).

## Decision gates

1. **Astro + adapter:** update the two package majors together (and `bun.lock`), using current peer-compatible patch releases when implementation starts. Run install/check/build before making unrelated source edits. Resolve concrete Astro 7 migration failures with minimal changes to existing config/components. If the coordinated pair cannot pass core checks, **do not merge** a partially working upgrade; document the exact blocker and retain the current compatible pair.
2. **Vitest:** run `bun run test:integration` against the new Vite 8 graph. If Vitest 5 is green, keep it and record the test SHA; the Vitest-major ignore stays with a corrected rationale until a newer major has its own passing verification. If it fails due to the known `assetsInclude` class or another peer mismatch, evaluate the smallest compatible Vitest update within **this PR**. Remove its ignore only if the new major genuinely passes. If the fix is disproportionate, record an explicit hold and do not claim the overall Astro upgrade validated.
3. **MDX:** record a **remove/retain** decision (already removed by #86); no MDX dependency or unused source integration added.
4. **TypeScript 7:** **defer** unless independent checker, linter and peer compatibility has been established. Do not couple it to the Astro jump; include a concrete future gate (clean `astro check`, ESLint, relevant typecheck and test suites on TS 7) in the ticket/PR. No unconditional unignore or security-alert dismissals.

## Verification strategy

- **Static and automated:** frozen Bun install; `bunx astro check`; `bun run lint`; `bun run format:check`; `bun run test:unit`; `bun run test:integration`; `bun run build`; `bunx wrangler deploy --dry-run`; full existing Playwright suite on Chromium. Record commands, results and **upgrade commit SHA**, not estimates.
- **Worker/SSR end-to-end via MCP:** in a real running Worker preview, drive anonymous and authenticated requests using Browser/Playwright MCP; verify page routing, auth session, guest play, authenticated wallet round settlement and persisted D1 balance. Also exercise an existing private poker room creation/join WebSocket journey to verify the Durable Object export. If `src/worker.ts` scheduled wiring changes, invoke the existing scheduled smoke path through a terminal/Worker MCP and verify the job; retain existing tests otherwise.
- **Visual via browser MCP:** **no Linear mockup exists**. Capture comparable baseline/after screenshots of the lobby `/` and Poker `/games/poker` (or its current route) at **1280×800 and 375×812**, and check header/menu alignment, textual spacing in all visible localized labels, cards, chips and image loading. A single Chromium platform is enough; test both viewport sizes because Astro 7 changes the compiler and whitespace handling. Do not introduce art tasks.
- **Cloudflare preview:** verify `bun run preview` against the built Worker, and use an existing non-production Cloudflare preview deployment when available for equivalent smoke checks. No new preview infrastructure is in scope. If required preview access is absent, report an unverified deployment gate rather than marking it passed.
- **CI caveat:** current `.github/workflows/test.yml`, `lint.yml` and `e2e.yml` skip draft pull requests. A docs-only draft cannot be described as green CI. Run direct checks during implementation, then obtain required CI results when PR is ready.

## Out of scope

No generic migration layer, new deployment pipeline, authentication rewrite, serverless architecture changes, game logic changes, TypeScript 7 adoption by default, new MDX integration, blanket Dependabot unignore, security alert dismissals, artwork or SFX. Existing application behavior is the contract; no backward-compatibility machinery is needed.

## End-to-end acceptance (on the implemented commit)

- [ ] Coordinated Astro **7.x** / Cloudflare adapter **14.x** and reproducible `bun.lock` install pass; existing Worker fetch/scheduled/DO exports and bindings remain correct.
- [ ] `astro check`, ESLint, formatting, Bun unit tests, Vitest integration suite, build, Wrangler dry-run and existing Playwright tests pass on the upgrade commit; no `assetsInclude` or Vite 8 incompatibility remains.
- [ ] MCP-driven end-to-end acceptance on a real Worker preview covers guest and signed-in route loads, auth, D1-backed wallet settlement/persistence and a multiplayer WebSocket/DO path; record actual evidence.
- [ ] Browser-MCP screenshot comparison (no mockup) passes on lobby and Poker at desktop **1280×800** and mobile **375×812**, with no meaningful missing spaces, layout shifts or lost assets.
- [ ] MDX stays removed; Vitest/Dependabot major hold gets a tested decision; TypeScript 7 gets an explicit deferred peer/checker gate; exact evidence/commit refs linked from this one PR and Linear issue.

**Status:** planning only. None of the implementation checks above have been run as part of this draft.