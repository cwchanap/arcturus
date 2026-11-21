# HPA-731 — Chip shop and poker cosmetics: implementation plan

**Linear:** https://linear.app/cwchanap/issue/HPA-731/chip-shop-buy-and-equip-poker-table-cosmetics  
**Design:** [2026-11-21-chip-shop-cosmetics-design.md](../specs/2026-11-21-chip-shop-cosmetics-design.md)  
**Dependencies:** HPA-730 art assets already merged as [PR #95](https://github.com/cwchanap/arcturus/pull/95) into `main` (baseline `8e03a5e`).  
**PR discipline:** **Exactly one PR for this ticket.** This is a planning-only draft; commit implementation, tests, fixes and browser-MCP evidence to **this branch/PR**, not a separate implementation PR.

Keep this a small Astro/D1 feature. No new assets, packages, generic commerce layer, inventory database, currency system, old-schema compatibility, route refactor, or new game framework.

## 1. Catalog and schema

- [ ] Create `src/lib/shop/catalog.ts` with the eight fixed items from the design spec: 2 free defaults, 6 HPA-730 assets, kinds `card-back` / `felt`, price 5k/15k/40k per Sapphire/Crimson/Jade item. Provide only a small typed lookup/grouping API and effective-default helpers. The catalog is the **sole price/image authority**.
- [ ] Add the `userCosmetic` Drizzle table in `src/db/schema.ts` with `(userId, itemId)` PK, user cascade delete, `purchasedAt` unix seconds and boolean `equipped`. Defaults remain implicit; no rows for them, no second kind/index/catalog table.
- [ ] Run `bun run db:generate`. Commit the generated numbered D1 SQL migration and any generated metadata Drizzle produces; do not manually maintain a migration list or edit the Better Auth `user` table.
- [ ] Verify the migration applies with `bun run db:migrate:local` on a clean/local test DB.

## 2. Minimal shop service and transactional correctness

- [ ] Add focused `src/lib/shop/` functions for: reading owned/equipped state, purchasing a catalog item and equipping an owned/default item. Use `D1Database` directly where the two-statement `batch()` matters; do not wrap the entire wallet module or add a generalized repository hierarchy.
- [ ] Implement purchase with a single bound `INSERT ... SELECT FROM user WHERE chipBalance >= price ON CONFLICT DO NOTHING` followed **immediately** by `UPDATE user SET chipBalance = chipBalance - price WHERE id = userId AND changes() = 1` inside `d1.batch([...])`, as established by `src/lib/missions/claim.ts`. Read fresh balance after the batch. Distinguish successful insert from duplicate ownership and insufficient balance. Duplicate/insufficient requests never debit.
- [ ] Equip an owned item by updating all purchased items **of that kind** in one SQL statement using `CASE WHEN itemId = target THEN 1 ELSE 0 END`; check ownership and preserve the prior selection on invalid/unowned requests. Equipping a free default clears equipped flags for that kind only. Do not clear the other kind; defaults are inferred when none is equipped.
- [ ] Keep server catalog validation strict: unknown item/kind, mismatched kind, unowned paid item, default purchase and invalid JSON cannot mutate DB. No achievement, wallet settlement, game stats, or mission hooks for a purchase.
- [ ] Add thin authenticated endpoints `src/pages/api/shop/purchase.ts` and `src/pages/api/shop/equip.ts`. Map stable domain codes to 400/401/403/409/5xx as appropriate. Return new balance for a purchase and effective IDs for equip. No additional GET API: the shop page renders its initial state with Astro SSR.

**Concurrency invariant:** a double-click/two simultaneous POSTs buying the **same item** inserts at most one `user_cosmetic` row and subtracts its price once; two purchases of **different** items cannot overdraw the current user balance. Prove this at least in D1 integration tests, not just a mocked service.

## 3. Accessible shop UI and navigation

- [ ] Implement protected `src/pages/shop.astro` using `CasinoLayout`; use fresh D1 balance and catalog/ownership helpers in SSR. Missing session redirects to `/signin`, absent DB shows service unavailable. The page has two sections, **Card Backs** and **Table Felts**, with four tile previews each (default, Sapphire, Crimson, Jade), prices, owned/equipped text, and Buy/Equip/Equipped controls.
- [ ] Reuse `deco-panel`/`deco-btn` typography and colors; use shipped WebPs directly at small displayed sizes. On purchase/equip, keep the smallest possible client script: disable pending button, `fetch` existing API, update price/owned/selection/balance from response, show localized error on refusal. On reload, SSR must agree with the rendered state.
- [ ] Add the shop entry link near existing actions in `src/pages/profile.astro` instead of adding another item to the crowded shared mobile header. Link back to Poker from the shop for an obvious way to inspect the result.
- [ ] Add one focused `src/lib/i18n/messages/shop.ts` dictionary for `en`, `zh-Hant`, `zh-Hans` and `ja` using existing `defineMessages`/`createTranslator` and `formatChips` conventions. Buttons should announce the item's name/action; equipped state must not depend on color alone.
- [ ] Use responsive grid/tile sizing at `375×812` without horizontal scrolling or button overlap. Do not create images, animations, a new design-system layer or a separate mobile implementation.

## 4. Apply cosmetics through existing Poker SSR + CSS seams

- [ ] In `src/pages/games/poker.astro`, for authenticated users with D1, load effective felt and card-back paths via the shop registry and ownership rows. For guests, absent selections or a cosmetic read failure, retain the existing defaults.
- [ ] Set `--poker-felt-image` and `--poker-card-back-image` on the shared `#poker-root` using only known catalog image paths. Never render arbitrary request-supplied CSS/URLs.
- [ ] In `src/styles/poker.css`, replace only the image portions of the existing `.poker-frame` felt background and `.poker-room .card-back-deco` background with CSS `var(...)` plus the current asset URL as fallback. Preserve the overlays/gradients, border, sizing, card-face rendering and UI readability.
- [ ] Test **both** `/games/poker` and `/games/poker?mode=sng`; they share the SSR template. Leave private-room multiplayer Poker and other card games unchanged.

## 5. Automated regression tests

- [ ] `src/lib/shop/catalog.test.ts`: catalog contains eight unique IDs; six nondefault image URLs exist in known locations; prices/kinds/default ownership are correct; lookup rejects unknown IDs and does not accept a client-supplied price.
- [ ] Focused Bun + actual D1/Miniflare integration tests (following `src/lib/missions/claim.test.ts`): affordable purchase debits once; duplicate and unaffordable purchases debit zero; two concurrent attempts for same item result in exactly one successful debit; concurrent different-item purchases never overdraw; exact boundary balance succeeds; unknown/default IDs fail; equip validates ownership/kind, replaces within a kind, keeps other kind, restores default, and remains after a fresh service read. Assert `changes()` behavior with the **real D1 batch**, not only mocks.
- [ ] Thin API route tests for authentication, invalid JSON and DB unavailable/error responses; avoid a second custom HTTP service harness when current tests can reuse route handlers.
- [ ] Create `e2e/shop.spec.ts` using `createIsolatedPage` (never the shared auth user for wallet-mutating tests). With a new 10,000-chip user: buy Sapphire card back (5,000 remaining), reject repeat and Jade, buy Sapphire felt (0 remaining), equip both, refresh shop, inspect cash Poker and solo Sit & Go computed images, restore defaults, and verify both revert on reload. Add a separate isolated user to verify no inventory leakage; reject unauthenticated API attempts. Use bounded assertions and no arbitrary sleeps.
- [ ] Keep the E2E test deterministic: the two affordable 5,000-chip Sapphire items are sufficient for both kinds. Do not add a production debug balance endpoint, new seed system, RNG manipulation or manual test precondition.

## 6. End-to-end acceptance through browser MCP (required)

There is **no UI mockup on HPA-731**, so screenshot visual checks against the existing Art Deco styling are required. **Browser MCP** owns the real end-to-end acceptance, with a single Chromium platform and a phone emulation. The Playwright spec is a committed regression test, not a replacement for browser-MCP acceptance.

- [ ] Start the app with the local migrated D1 and existing E2E auth bootstrap (`.dev.vars` for Worker vars, `http://localhost:2000`). Through browser MCP, authenticate a disposable isolated user and exercise the **actual UI and API** in order: load shop, check 10k balance, buy Sapphire card back, verify 5k, attempt duplicate and expensive item with no debit, buy Sapphire felt, equip both, and reload.
- [ ] Navigate through the browser to `/games/poker` and `/games/poker?mode=sng`, checking computed CSS image URLs and the **visible painted results**. Equip free defaults via the shop and verify both original images after reload. Verify unauthenticated purchase rejects without mutation and a second user sees defaults.
- [ ] Capture and inspect browser-MCP screenshots at **1280×800 desktop** and **375×812 phone** for: shop with owned/unowned states, cash Poker with paid felt/back, and solo Sit & Go with paid felt/back. If a supplied mockup appears later, use it; currently compare against existing Art Deco layout. Check legible cards/chips/seat labels, felt contrast, card-back readability, no tile/button clipping, no horizontal overflow, accessible focus/labels and no hidden action at phone width.
- [ ] Record exact MCP run steps, screenshot file paths/links and visual findings in **this PR**. Do not call an unperformed screenshot check passed. **No human acceptance is required.**

## 7. Quality gate and single PR

- [ ] On the **implemented diff**, record actual results of `bun run db:migrate:local`, `bun run test`, `bun run lint`, `bun run format:check`, `bunx astro check`, `bun run build`, targeted `bunx playwright test e2e/shop.spec.ts` and browser-MCP acceptance. Confirm no Playwright auth/bootstrap configuration was incorrectly passed through `process.env` alone.
- [ ] Review the final diff for scope: one migration/table, small shop catalog/service/routes/SSR page, four-locale messages, profile link, two Poker CSS image variables and focused tests; reuse HPA-730 media without modifying it.
- [ ] Keep all commits and review fixes on this draft PR. Do not make a second PR for the implementation or ask for manual approval as acceptance. Convert to ready only when the implemented code and automated evidence genuinely pass.

## End-to-end acceptance criteria

- [ ] An authenticated user can purchase each affordable item once, with exactly one conditional transactional debit from the **current** D1 chip balance; repeated/parallel purchase and insufficient-funds requests cannot double-charge, grant free ownership or produce negative balance. DB integration and browser-MCP API/UI journey prove the backend behavior.
- [ ] Purchased items persist across reloads; one felt and one card back equip independently, unaffordable/unowned requests do not overwrite selection, and equipping defaults returns to the original artwork without inserting a default purchase.
- [ ] On a real Poker **cash** and **Sit & Go** page, browser MCP confirms the selected felt and back render in the existing table frame/card slots; guest pages and default profiles show old images. Other games and private multiplayer remain unaffected.
- [ ] Desktop and phone screenshots from browser MCP pass visual checks for tiles/buttons, contrast/readability, the shared Art Deco theme and no horizontal overflow. Automated Playwright uses one supported browser/platform; no native acceptance is required.
- [ ] Four existing locales display usable labels and chip prices, test coverage is green, migration/build/lint/type/format checks pass, and evidence is recorded in **the same HPA-731 PR**.

**Current state:** Plan only, no implementation or test executions claimed.
