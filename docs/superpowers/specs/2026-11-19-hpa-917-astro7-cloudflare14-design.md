# HPA-917 — Coordinated Astro 7 / Cloudflare 14 upgrade: design

**Linear:** https://linear.app/cwchanap/issue/HPA-917/maintenance-coordinate-ignored-astro-cloudflare-and-tooling-majors  
**Tracking:** https://linear.app/cwchanap/issue/HPA-913/tracking-dependabot-major-upgrade-plan-by-project  
**Plan and single acceptance checklist:** [2026-11-19-hpa-917-astro7-cloudflare14.md](../plans/2026-11-19-hpa-917-astro7-cloudflare14.md)  
**Baseline:** `main` `d0e5a55a1ec2c692707aac3aa9196610412de9a7`. This is a **docs-only draft**; implementation and evidence will be added to the **same PR #92**.

## Objective

Upgrade the Cloudflare-hosted Astro SSR app to a compatible **Astro 7 + `@astrojs/cloudflare` 14** pair, retaining existing game, authentication, persistence, Worker, and visual behavior. Prefer the smallest set of dependency/configuration changes that pass the existing tests. Do not introduce a new hosting model, migration layer or broad refactor.

## Baseline and chosen dependency policy

| Dependency | `main` state | Decision |
| --- | --- | --- |
| `astro` | `^6.4.8` | Upgrade to a compatible 7.x patch alongside adapter 14 |
| `@astrojs/cloudflare` | `^13.7.0` | Upgrade to compatible 14.x **in the same PR** |
| `@astrojs/mdx` | Already absent | **Keep removed** (done in [#86](https://github.com/cwchanap/arcturus/pull/86)); no unused integration |
| `vitest` | `^5.1.0` | **Keep v5**; its Vite 8 peer range is compatible; run the actual integration tests to confirm compiled HTML and page assertions |
| `typescript` | `6` | **Keep v6**; published `@astrojs/check`/`typescript-eslint` peer ranges do not yet justify TS 7 |
| Dependabot | Vitest major ignore with outdated Astro 6/Vite 7 comment | Update the Vitest rationale and add a narrow TypeScript semver-major ignore with a peer-support unignore gate; do not bulk unignore |

[PR #86](https://github.com/cwchanap/arcturus/pull/86) already migrated Astro 5 → 6 / adapter 12 → 13, removed MDX, and validated Vitest 5. The historical `assetsInclude` error from [#69](https://github.com/cwchanap/arcturus/pull/69) does not establish a current Vitest 5/Vite 8 incompatibility. Leave historical Dependabot PRs [#72](https://github.com/cwchanap/arcturus/pull/72), [#73](https://github.com/cwchanap/arcturus/pull/73), [#74](https://github.com/cwchanap/arcturus/pull/74) and [#77](https://github.com/cwchanap/arcturus/pull/77) closed.

## Compatibility boundaries

**Node runtime is a prerequisite, not an afterthought.** Astro 7.4.13 requires Node ≥22.23.4; use a single **Node 24** baseline via a repository `.node-version` file and `actions/setup-node` with `node-version-file: .node-version` in **every job** of the three workflows (`lint.yml`, `test.yml`, `e2e.yml`). Configure Node before Bun/install/commands. The development machine must also use Node 24; Bun remains the package manager. Avoid a second package-manager lockfile.

**Keep the existing Worker entry.** `wrangler.toml` uses `main = "./src/worker.ts"`. Its `fetch()` delegates through `@astrojs/cloudflare/handler`, `scheduled()` handles retention/Blackjack expiration, and it exports `MultiplayerPokerRoom`. Keep those exports and D1 (`DB`), session KV (`SESSION`), assets, DO, auth and scheduled bindings. `src/middleware.ts` imports `env` from `cloudflare:workers` and exposes it via `Astro.locals.env`. Change only if the new adapter requires it. The adapter's existing handler export remains the intended seam.

**Fix observed compiler changes only.** Astro 7's Vite 8 / Rust compiler and HTML whitespace changes might affect `.astro` markup and integration snapshots. Preserve Tailwind styling, localized text spacing and game UI. Do not globally change `compressHTML` or build compatibility shims to hide regressions. During implementation, also update now-stale Astro 6/v13 comments in `src/worker.ts`, `wrangler.toml`, `src/middleware.ts` and `src/env.d.ts`.

**Dependabot gates:** retain Vitest 5 and its semver-major ignore (update comment to mention verified Astro 7/Vite 8), unless a concrete test failure proves a change is needed. Add a targeted TypeScript semver-major ignore; revisit when **both** `@astrojs/check` and `typescript-eslint` support TS 7, then run checker, lint and tests. Do not pair an unrelated TypeScript or Vitest-major migration with this ticket.

## Verification approach

- **Two existing environments:** `bun run test:e2e:ci` uses Astro dev + local D1; `bun run test:e2e:mp` uses the **production-built Worker via `wrangler dev`**, with real two-user auth + Durable Object WebSockets. The second path is the important missing adapter-regression gate. Add it as a job in `.github/workflows/e2e.yml` so future adapter updates get it too.
- **Built-Worker acceptance via MCP:** additionally use Browser/Playwright MCP against the actual built Worker to check a guest flow, authenticated wallet/D1 write and persistence after reload, plus the multiplayer path (reuse the existing setup rather than invent a new harness). This is the required end-to-end acceptance; CI tests complement rather than replace it. If `scheduled()` wiring changes, use the existing `wrangler dev --test-scheduled` recipe in a local MCP/terminal session; otherwise the existing `src/server/cleanup.test.ts` covers the job.
- **Visual via browser MCP:** no Linear UI mockup exists. Compare screenshots of lobby `/` and Poker `/games/poker` on `main` vs upgraded Worker, at **1280×800** and **375×812**, checking layout, localized whitespace, cards/chips, image loading and mobile overflow. This is a deliberate *visual spot check*, not proof that every Astro page is identical; the broader Playwright suite covers remaining routes.
- **CI and dry-run:** `astro check`, lint, formatting, unit and Vitest integration tests, build, `wrangler deploy --dry-run`, dev E2E and built-Worker MP E2E. `.github/workflows/*` skip draft PRs, so collect actual results on the implementation and obtain CI when ready. Link the existing `main` CI as baseline rather than duplicating its entire run.
- **No cloud deployment requirement:** this repo does not define a non-production Cloudflare `[env.*]` deployment; local built-Worker `wrangler dev` + dry-run suffice. Never deploy to production merely to test this change.

## Out of scope

No game rules, persistence schema, OAuth flow, new artwork/SFX, security-alert dismissals, broad tooling major upgrades, new preview infrastructure, or generic compatibility architecture. If the paired upgrade fails a required gate and cannot be fixed narrowly, leave **PR #92** draft and document the blocker.

**Acceptance criteria live only in the linked implementation plan** to avoid duplicated checklists that drift.