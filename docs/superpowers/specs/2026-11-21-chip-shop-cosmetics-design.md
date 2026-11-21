# HPA-731 — Chip shop and poker cosmetics: design specification

**Linear:** https://linear.app/cwchanap/issue/HPA-731/chip-shop-buy-and-equip-poker-table-cosmetics  
**Implementation plan:** [2026-11-21-chip-shop-cosmetics.md](../plans/2026-11-21-chip-shop-cosmetics.md)  
**Assets prerequisite:** [HPA-730 / merged PR #95](https://github.com/cwchanap/arcturus/pull/95)  
**Baseline:** `main` at `8e03a5ed68212d3d33c7060db24a7498a30ec07c` (2026-11-21).  
**Delivery:** One PR for HPA-731. The draft initially contains only these planning documents; add the implementation, migration, tests, and acceptance evidence to this **same** PR.

## Goal and scope

Give authenticated players a small, usable play-money chip sink: purchase one of six existing cosmetics once, equip one card back and one felt independently, and see the result on Poker cash and solo Sit & Go after reload. The existing card back and felt remain free defaults. Styling is presentation-only: chips are not currency, and purchases do not register as game rounds, wallet settlements, missions, achievements or statistics. **The leaderboard intentionally ranks by current chip balance**, so spending chips on cosmetics can lower a player's leaderboard position; no special leaderboard adjustment is added.

No new art/SFX, dependency, generic storefront/payment abstraction, product database table, inventory sync system, multiplayer room customization, historical data compatibility, or change to the actual Poker card faces. Keep the implementation in the existing Astro + D1 modular monolith.

### Codebase facts verified on main

- All six HPA-730 WebPs are already under `public/images/shop/`. The free originals are `public/images/poker/card-back.webp` and `public/images/poker/felt.webp`.
- `src/pages/games/poker.astro` owns **both** `/games/poker` (cash) and `/games/poker?mode=sng` (solo tournament). The page builds a common `#poker-root`; `src/styles/poker.css` paints `.poker-frame` with felt and `.poker-room .card-back-deco` with the card back.
- `src/layouts/AppLayout.astro` has the shared header/balance. `src/components/UserNav.astro` links to `/profile`. Prefer a shop entry on `/profile` to avoid overflowing the existing phone header.
- `src/db/schema.ts` is the Drizzle schema source, but recent numbered SQL migrations are **hand-written**: `.gitignore` excludes `drizzle/meta/*`, and existing snapshots do not cover later migrations. Add `drizzle/0021_user_cosmetic.sql` manually (matching `schema.ts`) and apply it through `bun run db:migrate:local`; **do not run `bun run db:generate` for this change**. `src/lib/missions/claim.ts` already establishes the D1 transactional `batch` + `changes()` cascade convention.
- Playwright has `e2e/isolated-page.ts` for an authenticated user with isolated wallet state. No Linear UI mockup is attached; acceptance will therefore use actual browser-MCP screenshots.

## Catalog and purchase rules

One compile-time registry `src/lib/shop/catalog.ts` owns validated items with at least `{ id, kind: 'card-back' | 'felt', price, image }`. Define `SHOP_ITEM_IDS` as an eight-ID `as const` tuple, `type ShopItemId = (typeof SHOP_ITEM_IDS)[number]`, and an exhaustive `Record<ShopItemId, ShopItem>` catalog, mirroring `src/lib/missions/types.ts`. Provide `getShopItem(id: string)` / a runtime parser at the untrusted API boundary and kind/default helpers. The four locale name dictionaries in `src/lib/i18n/messages/shop.ts` must be keyed exhaustively by `ShopItemId` (using the existing typed `defineMessages` conventions), so adding an item without its names fails typecheck. Prices come **only from the server catalog**, never a request body.

| Item ID | Kind | Price (chips) | Image path |
| --- | --- | ---: | --- |
| `card-back-default` | card-back | 0 | `/images/poker/card-back.webp` |
| `card-back-sapphire` | card-back | 5,000 | `/images/shop/card-back-sapphire.webp` |
| `card-back-crimson` | card-back | 15,000 | `/images/shop/card-back-crimson.webp` |
| `card-back-jade` | card-back | 40,000 | `/images/shop/card-back-jade.webp` |
| `felt-default` | felt | 0 | `/images/poker/felt.webp` |
| `felt-sapphire` | felt | 5,000 | `/images/shop/felt-sapphire.webp` |
| `felt-crimson` | felt | 15,000 | `/images/shop/felt-crimson.webp` |
| `felt-jade` | felt | 40,000 | `/images/shop/felt-jade.webp` |

Defaults are **implicitly owned**, cannot be purchased and need no database rows. Both defaults are equipped when no purchased row for the corresponding kind has `equipped = true`. A user may buy a theme's card back without buying its felt. Nothing enforces matched pairs.

## Persistence

Add exactly one Drizzle table in `src/db/schema.ts`, mirrored by a **hand-written** `drizzle/0021_user_cosmetic.sql` migration. Follow the SQL style of `drizzle/0018_blackjack_run.sql`; leave the `0019` numbering gap alone. Do not generate fresh snapshots or recreate existing tables:

```ts
export const userCosmetic = sqliteTable(
  'user_cosmetic',
  {
    userId: text('userId').notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    itemId: text('itemId').notNull(),
    purchasedAt: integer('purchasedAt').notNull(), // unix seconds
    equipped: integer('equipped', { mode: 'boolean' }).notNull().default(false),
  },
  (table) => [primaryKey({ columns: [table.userId, table.itemId] })],
);
```

Keep the ownership/selection set small. No extra index is needed: every read/write is by `userId`, the leading PK field; no `kind` column or foreign key to a catalog table is needed. Do not persist default rows. Read a user's rows and interpret `equipped` against the static registry to find each effective item; an absent, unknown or unequipped row falls back to that kind's default.

## Server-side behavior

Keep HTTP routes thin over `src/lib/shop/`, with the authenticated session's user ID and the D1 binding taken from Astro locals. Missing session = 401 for APIs; invalid/unknown catalog input = 400; missing DB binding = `500 DATABASE_UNAVAILABLE` per `src/pages/api/missions/claim.ts`. Errors use stable machine-readable codes and localized UI messages.

### Purchase: `POST /api/shop/purchase`

Input: `{ itemId: string }`. Only nondefault catalog items are purchasable. The service must not use the middleware's potentially stale chip balance for eligibility or subtract from a cached balance. Use the same two-statement **D1 batch** transaction pattern as `src/lib/missions/claim.ts`:

```sql
INSERT INTO user_cosmetic (userId, itemId, purchasedAt, equipped)
SELECT ?, ?, ?, 0 FROM user
WHERE id = ? AND chipBalance >= ?
ON CONFLICT(userId, itemId) DO NOTHING;

UPDATE user SET chipBalance = chipBalance - ?
WHERE id = ? AND changes() = 1
RETURNING chipBalance;
```

Bind catalog price in the `WHERE` and debit, and seconds for `purchasedAt`. The first statement must be **immediately before** the debit so `changes()` means the ownership insert; no extra statement between them. In D1 `batch()` both statements commit together or roll back on error. The PK rejects duplicate acquisitions; the conditional insert rejects insufficient balance; the debit only runs for a successful new ownership insert.

Interpret the insert's `meta.changes`; on success use the **post-debit `chipBalance` returned by the second batch statement** (`RETURNING`), not `oldBalance - price` or a stale middleware value. If the insert changed 0 rows, check ownership to distinguish `ALREADY_OWNED` from `INSUFFICIENT_CHIPS`, and reuse `readWalletBalance(d1, userId)` from `src/lib/wallet/repository.ts` when the current balance is needed on failure (or for initial SSR). Do not debit on failure. On success return `{ status: 'purchased', balance, itemId }`. Appropriate HTTP statuses: 200 success, 409 already owned, 400 insufficient/invalid. A missing user (`readWalletBalance` returns null) should report an error, never appear as insufficient balance. Test the returned balance from the actual D1 batch.

### Equip: `POST /api/shop/equip`

Input: `{ kind: 'card-back' | 'felt', itemId: string }`. Require matching catalog kind. Purchased items require a matching ownership row; defaults are available to every authenticated user.

- **Paid item:** validate ownership, then a **single atomic UPDATE** over that user's owned IDs of that kind: `equipped = CASE WHEN itemId = :target THEN 1 ELSE 0 END`. Use bound catalog IDs and, if convenient, an `EXISTS` ownership predicate in the same SQL to ensure an unowned request cannot clear the current selection. This sets the target and clears any other selection of that kind together.
- **Default item:** clear `equipped` on all owned items of that kind with one UPDATE. The default is effective by fallback, with no inserted default row.
- Never alter the other kind. Resolve the resulting item IDs from the registry and return them. An unowned paid target responds `NOT_OWNED` (403/400), leaving the previous selection intact.

No separate clear-then-set commands, extra transaction framework, or new schema uniqueness for a denormalized kind.

## UI and Poker integration

**Shop route `src/pages/shop.astro`:** Require login (redirect to `/signin`); if D1 is absent show service unavailable rather than a fake shop. SSR renders the authoritative DB balance, owned IDs and equipped IDs. Reuse `CasinoLayout` and existing Art Deco gold/dark-green components. Two responsive sections (Card Backs / Table Felts) show four image-led tiles each, including free default. Each tile shows a scaled preview, localized name, price, ownership/selection state, and an accessible Buy / Equip / Equipped action. A pending request disables repeat action, displays localized errors and updates the shown balance/selected state from the API result. After purchasing, also update all `[data-chip-balance]` elements in the existing shared header with localized `formatChips` output (matching `src/lib/wallet/public-game-settlement.ts`), so the header never keeps the pre-purchase amount. Do not add a client framework or persist state in browser storage.

Suggested visual hierarchy (conceptual, not a supplied Linear mockup):

```text
CHIP SHOP                                      Balance: 10,000 chips
Card Backs    [Default • Equipped] [Sapphire • Buy 5,000] [Crimson • Buy 15,000] [Jade • Buy 40,000]
Table Felts   [Default • Equipped] [Sapphire • Buy 5,000] [Crimson • Buy 15,000] [Jade • Buy 40,000]
                               [Back to Poker]
```

At phone widths (test `375×812`), make tiles wrap into a one- or two-column layout with legible pricing/buttons; no horizontal overflow. Use the already shipped WebPs as previews, not new thumbnails. Add an authenticated shop link near the profile action area in `src/pages/profile.astro`, with existing styles; avoid crowding the mobile shared header. Add `en`, `zh-Hant`, `zh-Hans` and `ja` copy in `src/lib/i18n/messages/shop.ts` with an exhaustive `ShopItemId` key set for names.

**Poker SSR:** In `src/pages/games/poker.astro` read effective cosmetic selections for the authenticated user via the shop helper, otherwise defaults for guests / missing optional cosmetic data. Set only two CSS custom properties on `#poker-root` using server-selected, catalog-controlled image paths:

- `--poker-felt-image`: consumed by the existing background on `.poker-frame`;
- `--poker-card-back-image`: consumed by the existing background on `.poker-room .card-back-deco`.

In `src/styles/poker.css` use `var(--poker-felt-image, url('/images/poker/felt.webp'))` and `var(--poker-card-back-image, url('/images/poker/card-back.webp'))` in the existing background layers. Preserve gradients, framing, face-up card art and contrast. Because both cash Poker and solo Sit & Go share the page and styles, they automatically receive the same selection. Do not customize private multiplayer Poker or other games.

## Accessibility, errors and constraints

- Buttons have explicit accessible names; equipped state is visible as text (not color alone). Image alt text describes the cosmetic; decorative duplicate layers have empty alt. Keep focus states and error messages readable.
- DB-side source of truth protects against forged prices, double purchases and negative balance. Only catalog-known image URLs can enter inline CSS; never accept arbitrary image URL from API input.
- Page reload and signing in again must preserve purchases/selections. Two kinds select independently; defaults must be reversible without any extra purchases.
- No new security infrastructure, historical migration compatibility or speculative recovery system is warranted for this hobby app.

## Automated acceptance (implementation PR)

There is **no Linear UI mockup**; use screenshot-based verification of the actual rendered page and poker table, not a human sign-off. **Browser MCP** is the end-to-end acceptance owner on one Chromium/browser platform, with desktop `1280×800` and mobile `375×812` emulation.

1. **Automated functional regression:** Bun catalog/validation tests, Miniflare/D1 tests for `batch()` / `changes()` and `RETURNING`, and `e2e/shop.spec.ts` using `createIsolatedPage` prove the full 10,000-chip path: buy Sapphire card back → 5,000; reject repeat/Jade without debit; buy Sapphire felt → 0; equip both; reload; restore defaults; check second-user isolation and unauthenticated API rejection. Prefer `createPostHandler` injection as in `src/pages/api/wallet/settle.ts` / `src/lib/wallet/settle-api.test.ts` for focused route tests.
2. **Browser-MCP end-to-end happy path:** In the running, migrated app, sign in as a disposable test user, open the shop, purchase/equip the two affordable Sapphire items and navigate from shop to cash Poker and solo Sit & Go. This establishes an actual connected UI/API/backend journey; do **not** repeat the duplicate/insufficient/concurrency/second-user rejection matrix already covered by Playwright and D1 tests.
3. **Browser-MCP visual checks:** With 0 chips after those two purchases, cash Poker cannot deal. Screenshot **cash Poker felt/table** and verify the selected card-back URL using `getComputedStyle` on the hidden `.card-back-deco`. Sit & Go uses its independent tournament stack, so start a hand and screenshot a **visible** Sapphire card back and felt there. Inspect shop and both Poker modes at `1280×800` desktop and `375×812` mobile: readability, contrast under cards/chips/seats, tile pricing/buttons, focus and horizontal overflow. Check restoring free defaults through the UI; record actual screenshots and outcomes in the same PR.
4. **Build and release checks:** Run and record actual `bun run db:migrate:local`, `bun run test`, `bun run lint`, `bun run format:check`, `bunx astro check`, `bun run build`, targeted Playwright and browser-MCP results after implementation. Browser MCP remains the E2E acceptance owner; Playwright supplies the comprehensive functional regression, not a duplicate manual journey. No human sign-off counts as acceptance.

Keep one task → one PR; the initial documents-only draft must not claim these tests have run.
