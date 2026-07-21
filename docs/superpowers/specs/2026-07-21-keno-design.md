# Keno Game Design

Linear: [HPA-201 — Game: Keno](https://linear.app/cwchanap/issue/HPA-201/game-keno)

## Goal

Add a playable 80-number Keno game at `/games/keno` that fits Arcturus's free-to-play
virtual-chip casino model: a fast, casual number-draw game with manual selection, Quick Pick,
a versioned configuration-driven paytable, and exact-once single-draw settlement. Consistent
with the existing client-authoritative single-player game architecture (slots, blackjack,
baccarat, craps).

## Resolved Design Decisions

| Decision | Choice |
|----------|--------|
| Settlement architecture | **Client-authoritative (slots/craps receipt pattern)** — RNG + payout run client-side, synced via `POST /api/chips/update` + `chip_sync_receipt`. Supports guest + authenticated. |
| Authoritative random source | Default RNG = unbiased uniform ints from `crypto.getRandomValues` (Fisher–Yates partial shuffle over 1–80), injectable `Rng = () => number` for tests. Stronger than `Math.random` (which `ReelManager` defaults to) and matches the issue's "authoritative random source" language; unbiased — no `byte % 80` modulo skew. |
| Chip-sync transport | **Direct single-round fetch (blackjack pattern), NOT `ChipSyncCoordinator`.** The slots coordinator hardcodes `gameType:'slots'`, coalesces multiple rounds, and generates its own server `syncId` that differs from the game round's `syncId`. Keno is single-draw (one round = one sync), so it uses a direct `fetch('/api/chips/update')` with the game round's `syncId` as the receipt key. See Settlement Flow. |
| Paytable philosophy | **Realistic standard** published-style paytable, RTP-aligned with common Vegas/IGT tables |
| Number pool | 80 numbers (1–80), player picks 1–10, house draws 20 |
| Multi-draw | **Deferred.** Single-draw only for this spec. The UI shows a number-of-draws control with 5/10 disabled ("Coming soon"); multi-draw batch settlement is a future spec that extends this one. |
| Bet limits | min 1, max 5 chips per draw (sized so the top prize fits under the per-game win cap with 2× headroom) |
| Server persistence | **No new D1 table, no migration.** Reuses `chip_sync_receipt` (PK `userId+syncId`) for exact-once settlement. |
| Paytable versioning | `PAYTABLE_VERSION` constant stamped into each client-side `DrawResult`; not stored server-side for MVP (server trusts the capped delta, consistent with the documented client-authoritative security model) |
| Guest mode | Yes — `createPublicGameSession` + `persistGuestBankroll('keno', ...)` (slots pattern) |
| Settings storage | `arcturus:keno:settings:<clientUserId>` — namespaced-per-user key from `slots/GameSettingsManager.ts` (NOT baccarat's global `'baccarat-settings'` key) |
| LLM module | None (Keno is pure chance; no strategy hint module) |

## Architecture

Keno follows the established modular game pattern under `src/lib/{game}/`, mirroring slots,
baccarat, blackjack, and craps.

### New files

```
src/pages/games/keno.astro                # Page: guest preamble, #keno-root, UI shell, <script> init
src/lib/keno/
├── types.ts                  # KenoTicket, DrawResult, KenoSettings, KenoGameState, KenoErrorCode, KenoGameEvents
├── constants.ts              # MIN_SPOTS, MAX_SPOTS, KENO_POOL, KENO_DRAW_SIZE, MIN_BET, MAX_BET, MAX_HISTORY, PAYTABLE, PAYTABLE_VERSION, BET_INCREMENTS, DEFAULT_SETTINGS
├── DrawManager.ts            # draw(rng?) → 20 distinct numbers from 1–80 (default: crypto.getRandomValues Fisher–Yates; injectable Rng for tests)
├── selection.ts              # Pure: validateSelection, quickPick(count, rng?), countHits
├── payoutCalculator.ts       # Pure: evaluateDraw(picks, drawn, bet) → {hits, hitCount, multiplier, payout}
├── KenoGame.ts               # State holder: balance, bet, ticket, history, event callbacks; draw(syncId)
├── KenoUIRenderer.ts         # DOM: 80-number grid, selection/drawn/hit highlight, draw animation, paytable panel, history, balance/bet
├── GameSettingsManager.ts    # localStorage 'arcturus:keno:settings:<clientUserId>' (animation speed, sound — slots namespaced pattern)
├── kenoClient.ts             # initKenoClient(): wire DOM + game + direct single-round chip sync + guest bankroll; owns drawInFlight lock
├── index.ts                  # Barrel exports
└── *.test.ts                 # One per pure module (DrawManager, selection, payoutCalculator, KenoGame)
```

### Integration touchpoints (existing files)

- `src/pages/api/chips/update.ts` — add `keno` to `GAME_LIMITS`:
  ```ts
  keno: {
      // Top prize: 10-spot catch-10 (50,000×) at MAX_BET=5 = 250,000.
      // 2× headroom under the cap covers the documented client-authoritative
      // security limitation (same mitigation philosophy as slots/craps).
      maxWin: 500000,
      // Single-draw loss = wager (5). 100× headroom matches slots and bounds
      // the abuse surface for coalesced sync retries.
      maxLoss: 10000,
  },
  ```
  Keno is **not** added to `BATCHED_GAME_TYPES` or `BIGGEST_WIN_BATCHED_GAME_TYPES` — it is
  single-draw, one round per sync, like blackjack/baccarat.
- `src/lib/game-stats/constants.ts` — extend the three mirrors of the game-type union. `GameType` in `src/lib/game-stats/types.ts` is derived as `(typeof GAME_TYPES)[number]`, so this single edit flows through automatically to `achievements/` and `game-stats/` (no other hardcoded unions to chase):
  ```ts
  export const GAME_TYPES = ['blackjack', 'baccarat', 'craps', 'poker', 'slots', 'roulette', 'keno'] as const;
  export const GAME_TYPE_LABELS = { ..., keno: 'Keno' };
  export const GAME_TYPE_ICONS = { ..., keno: '\u{1F3B1}' }; // 🎱 numbered-ball glyph (distinct from slots' 🎰)
  ```
- `src/db/schema.ts` — update the inline comment on `gameStats.gameType` (line 119) so the
  documented allowed-values list stays in sync:
  ```ts
  gameType: text('gameType').notNull(), // 'poker' | 'blackjack' | 'baccarat' | 'craps' | 'slots' | 'roulette' | 'keno'
  ```
- `src/lib/chips-update-api.test.ts` — add coverage parallel to the existing slots tests
  (around line 818/846): accept a `keno` delta within `GAME_LIMITS.keno`, reject a `keno` win
  over `maxWin`, reject a `keno` loss over `maxLoss`.
- `src/pages/index.astro` — add a Keno entry to the `games` array:
  ```ts
  { name: 'Keno', emblem: 'spark' as const, players: 0, minBet: 1, href: '/games/keno' },
  ```
  (`emblem: 'spark'` is a valid `GameCard` emblem (`'cards' | 'dice' | 'wheel' | 'spark'`).
  It duplicates the Slots emblem — intentional for now since no Keno-specific emblem exists;
  revisit if a dedicated `DecoIcon` variant is added. `featured: false` since this is a casual
  side game, not a flagship title.)

## Settlement Flow (single draw)

The client owns one authoritative `syncId` per draw. **The game round's `syncId` IS the
chip-receipt `syncId`** (unlike slots, where the coordinator generates a separate server
`syncId`). This is the blackjack pattern (`src/lib/blackjack/blackjackClient.ts`), not the
slots `ChipSyncCoordinator` pattern.

1. Player commits a ticket (1–10 picks + wager) and taps **Draw**.
2. **`kenoClient` generates one `syncId` at commit** and sets a module-level `drawInFlight`
   flag (mirrors `spinInFlight` in `slotsClient.ts`). While set: the Draw button is disabled,
   pick/bet changes are ignored, and a second click is a no-op. The flag clears in a `finally`
   after both the animation completes AND the chip sync is kicked off (not awaiting sync
   completion — sync runs in the background). This prevents a double-click during the ~1.5s
   reveal from settling twice.
3. `KenoGame.draw(syncId)`:
   - Validates `syncId` (reject `INVALID_SYNC_ID`).
   - Returns cached `DrawResult` if `syncId` already exists in history (idempotent replay —
     matches `SlotsGame.spin`).
   - Validates wager and selection. **Error routing matches `SlotsGame`:** programmatic
     setters (`setBet`, `setSelection`) throw via `buildError` (no toast — caller bugs), while
     `draw()` throws via `fail` (toast + throw). See Error Handling.
   - Debits wager from balance, emits `onBalanceUpdate`.
   - Calls `DrawManager.draw()` → 20 distinct numbers in 1–80 (crypto RNG by default).
   - Computes hits via `selection.countHits`, payout via `payoutCalculator.evaluateDraw`.
   - Credits payout to balance, appends `DrawResult` to history (capped at `MAX_HISTORY=20`,
     FIFO like slots), emits `onRoundComplete` + `onBalanceUpdate`.
4. **`kenoClient` performs a direct single-round chip sync** (authenticated only). It tracks
   `serverSyncedBalance` (initialized from `createPublicGameSession` balance, then from each
   successful response). For each completed draw:
   ```ts
   const deltaForRequest = game.getBalance() - serverSyncedBalance;
   const response = await fetch('/api/chips/update', {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({
       delta: deltaForRequest,
       previousBalance: serverSyncedBalance,
       gameType: 'keno',
       syncId,                                  // the game round's syncId = receipt key
       outcome: deltaForRequest > 0 ? 'win' : deltaForRequest < 0 ? 'loss' : 'push',
       handCount: 1,
       biggestWinCandidate: deltaForRequest > 0 ? deltaForRequest : undefined,
     }),
   });
   ```
   - **On 200:** adopt `response.balance` as the new `serverSyncedBalance`; `game.setBalance(...)`
     to correct any drift.
   - **On 409 `BALANCE_MISMATCH` / `MP_ESCROW_ACTIVE` (with `currentBalance`):** adopt the
     server's `currentBalance` as both `serverSyncedBalance` and `game.setBalance(...)`; the
     just-played draw's local delta is effectively rolled into the authoritative balance.
     Surface a toast.
   - **On 409 `SYNC_ID_REUSE_MISMATCH`:** the server already has this `syncId` for a different
     payload — a real bug; surface the error and refetch balance.
   - **On 429 `RATE_LIMITED`:** respect `Retry-After`; re-queue the same `{syncId, delta,
     previousBalance}` payload after the backoff. Because the server keys on `syncId`, a
     late-arriving retry after the draw already settled is a no-op replay (returns cached).
   - **On network failure (after retries):** give up — set `serverSyncedBalance = game.getBalance()`
     so subsequent draws sync against the locally-accepted balance (best-effort; the player's
     local balance is authoritative in guest mode and best-effort in auth mode, same tradeoff
     as blackjack).
5. Server applies the delta under optimistic lock, writes `chip_sync_receipt` (PK `userId+syncId`)
   → exact-once. On replay (same `syncId`), server returns the cached result and the client
   adopts it — identical to blackjack/baccarat/roulette's receipt-replay branch.
6. Guest mode (`shouldSyncAccountChips === false`): no fetch. Balance persists in `localStorage`
   via `persistGuestBankroll('keno', clientUserId, balance)`; `serverSyncedBalance` tracks the
   guest bankroll locally.

## Paytable

Realistic standard published-style paytable. Multiplier is per 1-unit bet; chip payout =
`multiplier × bet`. Configurable in `constants.ts`; stamped with
`PAYTABLE_VERSION = '2026-07-standard-v1'`.

| Spots | Catch → multiplier |
|-------|--------------------|
| 1 | 1→3 |
| 2 | 2→12 |
| 3 | 3→45 · 2→2 |
| 4 | 4→130 · 3→5 · 2→1 |
| 5 | 5→500 · 4→20 · 3→2 |
| 6 | 6→1500 · 5→50 · 4→7 · 3→1 |
| 7 | 7→5000 · 6→150 · 5→15 · 4→2 · 3→1 |
| 8 | 8→15000 · 7→400 · 6→50 · 5→10 · 4→2 |
| 9 | 9→25000 · 8→2000 · 7→200 · 6→30 · 5→8 · 4→2 |
| 10 | 10→50000 · 9→5000 · 8→1000 · 7→100 · 6→20 · 5→5 · 0→5 |

Notes:
- The catch-0 → 5× on the 10-spot is the classic Keno "no-catch bonus." **Important UX
  consequence:** a 10-spot ticket with 0 hits is still a *win* (payout = 5 × bet > bet for
  bet < 5, push at bet = 5). Status copy and outcome classification must NOT assume
  `hitCount > 0` ⟹ win or `hitCount === 0` ⟹ loss. Compute outcome from `netDelta` (see
  Settlement Flow), not from `hitCount`.
- `MAX_BET=5` keeps the top prize (10-spot catch-10) at 250,000 chips — 2× headroom under
  `GAME_LIMITS.keno.maxWin=500000`.
- All other prizes at `MAX_BET=5` fit trivially under the cap (next-highest: 9-spot catch-9
  = 125,000).
- Within each spot count, paying tiers are monotonic (more catches ≥ fewer catches).
- With this table, `push` only occurs when `multiplier × bet === bet` (i.e. multiplier === 1,
  e.g. 4-spot catch-2 at bet 1, or 10-spot catch-0 at bet 5). All non-paying tiers
  (multiplier 0) are pure losses. Unit-test these edge outcome labels since the UI surfaces them.

The UI shows the exact paytable for the currently-selected spot count, re-rendering when the
spot count changes (picks added/removed). **Acceptance criterion:** the Paytable control is
enabled whenever the current spot count is in [1, 10] — including before the first draw — so
the player can always see the applicable paytable before committing a wager (per HPA-201).

## Data Model

Client-authoritative — no server schema change.

- `DrawResult` (client history record):
  ```ts
  {
    syncId: string;
    picks: number[];        // sorted ascending, length 1–10
    drawn: number[];        // 20 sorted, the authoritative draw
    hits: number[];         // subset of picks that appeared in drawn
    hitCount: number;
    spots: number;          // picks.length (1–10)
    bet: number;
    multiplier: number;     // from PAYTABLE[spots][hitCount] (0 if no payout tier)
    payout: number;         // multiplier × bet
    netDelta: number;       // payout - bet
    paytableVersion: string;
    timestamp: number;
  }
  ```
- History: bounded ring buffer, `MAX_HISTORY=20`, FIFO eviction (matches `SlotsGame`).
- Server-side: `chip_sync_receipt` row per draw with `gameType='keno'`, `delta`, `outcome`,
  `handCount=1`, `biggestWinCandidate`. No paytable-version column for MVP (see Resolved
  Design Decisions).

## UI / UX

Page: `/games/keno`, rendered in `CasinoLayout`. `createPublicGameSession(user)` provides the
guest/authenticated preamble (balance label, `clientUserId`, `guestModeValue`), identical to
`slots.astro`.

Layout (follows the deco felt-table + sidebar pattern of other games):

- **Header:** back-to-games link, title, balance pill.
- **Felt table:**
  - 80-number grid (8 columns × 10 rows) of tappable cells. Cell states:
    empty (muted), selected (brass highlight + pick-order badge), drawn (pulse animation),
    hit (bright brass + glow — reuses `.symbol-cell.win` animation language from slots).
  - Status line: phase text ("Pick 1–10 numbers" / "Drawing…" / "Round complete") plus
    last-result summary ("5 of 7 hits — won 350").
- **Controls panel:**
  - Spot-count display (current `picks.length` / 10).
  - Bet chips: `BET_INCREMENTS = [1, 2, 3, 5]` (selected style reuses `.bet-chip.selected`).
  - Buttons: **Quick Pick** (random valid ticket of current spot count, or **8 if none
    selected** — 8 is the common casino middle-ground default, balancing hit frequency and
    payout potential), **Clear** (deselect all), **Repeat Ticket** (re-apply last ticket's
    picks), **Draw** (disabled until 1–10 picks selected and balance ≥ bet, AND disabled
    while `drawInFlight` is set — see Settlement Flow).
  - Number-of-draws control: rendered as `[1 | 5 | 10]` with `1` selected; `5` and `10`
    disabled with a "Coming soon" tooltip (forward-compat UI; multi-draw is deferred).
- **Sidebar:**
  - Recent-tickets list (picks summary, hits, net delta) — bounded to `MAX_HISTORY`.
  - **Paytable** button → modal showing the exact paytable for the currently-selected spot
    count (re-renders when spot count changes).
  - **Settings** button → modal (animation speed: slow/normal/fast; sound on/off).
- **Achievement toast:** reused from layout.

Draw animation: the 20 drawn numbers reveal sequentially over ~1.5s (paced by
`GameSettingsManager.getAnimationDelay()`); hits flip to the bright state after all 20
reveal. Sound setting governs any audio cues.

## Error Handling

`KenoErrorCode` (mirrors `SlotsErrorCode`):

| Code | Cause | Thrown by |
|------|-------|-----------|
| `BET_BELOW_MIN` | wager < `MIN_BET` | `setBet` |
| `BET_ABOVE_MAX` | wager > `MAX_BET` | `setBet` |
| `INVALID_BET` | non-finite / non-integer wager | `setBet` |
| `INVALID_SELECTION` | <1 or >10 picks, duplicates, out-of-range (non 1–80), non-integers | `setSelection` |
| `INSUFFICIENT_BALANCE` | wager > balance | `draw` |
| `INVALID_SYNC_ID` | missing/empty `syncId` | `draw` |

**Two-path error routing, matching `SlotsGame` exactly:**

- **Programmatic setters** (`setBet`, `setSelection`) throw via `buildError(code, msg)` —
  plain `Error` with a `code` property, **no toast**. These are caller bugs (the UI clamps
  before calling); emitting `onError` here would leak a toast even when the caller swallows
  the throw. Mirrors `SlotsGame.setBet`.
- **`draw(syncId)`** throws via `fail(code, msg)` — emits `onError` (toast) THEN throws.
  `INSUFFICIENT_BALANCE` and `INVALID_SYNC_ID` are runtime conditions the player should see,
  not caller bugs. Mirrors `SlotsGame.spin` / `SlotsGame.fail`.

Selection validation (`selection.validateSelection`) rejects: fewer than 1 or more than 10
picks, duplicate numbers, numbers outside 1–80, non-integers. `quickPick` is guaranteed to
return a valid ticket (correct count, unique, in-range).

**Chip-sync failures** are NOT `KenoErrorCode`s — they surface as HTTP responses handled in
`kenoClient` (see Settlement Flow): 200 adopts balance; 409 adopts `currentBalance` or
surfaces `SYNC_ID_REUSE_MISMATCH`; 429 retries with backoff; network failure gives up and
re-syncs against the local balance on the next draw. No `ChipSyncCoordinator` involvement.

## Testing

### Unit tests (Bun)

- `DrawManager.test.ts` — `draw()` returns exactly 20 numbers; all in range 1–80; all
  distinct; injectable `Rng` is deterministic for a seeded sequence.
- `selection.test.ts` — `validateSelection` accepts all valid 1–10 pick sets and rejects
  every malformed input (empty, >10, duplicates, out-of-range, non-integers, non-array);
  `quickPick(n)` produces `n` unique in-range numbers; `countHits` is correct for known
  inputs.
- `payoutCalculator.test.ts` — every spot-count × hit-count branch in `PAYTABLE` is covered
  (including the catch-0 bonus on the 10-spot), payout scales linearly with bet, monotonic
  within each spot count, no payout for non-paying tiers. **Plus outcome-label cases:** the
  10-spot-catch-0 case (0 hits, `netDelta > 0` → classified `'win'`), the multiplier===1
  push cases (e.g. 4-spot catch-2 at bet 1, 10-spot catch-0 at bet 5), and a pure-loss
  case (multiplier 0). The UI surfaces these labels, so they must be correct.
- `KenoGame.test.ts` — balance debit/credit, `syncId` replay returns cached `DrawResult`,
  history cap eviction at `MAX_HISTORY`, `setBet`/`setSelection` throw via `buildError`
  (no `onError` emission), `draw` throws via `fail` (`onError` emitted then throw), every
  `KenoErrorCode` is thrown in the right condition, `canDraw` gating.

### E2E tests (Playwright — `e2e/keno.spec.ts`)

Reuses `e2e/.auth/user.json` global setup. Coverage:

1. Manual selection: tap N numbers, assert spot count, place bet, trigger draw, assert a
   valid 20-number draw result and payout display.
2. Quick Pick flow: produces a valid ticket, draw resolves.
3. Repeat Ticket: after a draw, re-applies the prior ticket's picks.
4. Paytable modal: opens, shows the table matching the currently-selected spot count,
   updates when the spot count changes.
5. Controlled draw: assert on draw validity (20 unique numbers in 1–80) and payout-form
   correctness (payout matches `PAYTABLE[spots][hitCount] × bet`) rather than injecting a
   seeded RNG across the page boundary — matches how the existing game E2E suites handle
   randomness without flakiness.

## Acceptance Criteria Mapping

All MVP criteria from the issue are covered. Multi-draw criteria are explicitly deferred.

| Issue criterion | Coverage |
|-----------------|----------|
| Select 1–10 unique numbers manually or via Quick Pick | UI + `selection.ts` |
| Reject invalid/duplicate/out-of-range/over-limit selections | `selection.validateSelection` + unit tests |
| Every draw = 20 unique valid numbers | `DrawManager` + unit tests |
| Match counting + every payout branch has unit coverage | `selection.countHits` + `payoutCalculator` full-branch tests |
| UI shows the exact paytable for the chosen spot count | Paytable modal, re-renders on spot-count change |
| Wagers cannot exceed available balance | `INSUFFICIENT_BALANCE` check in `KenoGame.draw` |
| Single-draw settlement updates chips and stats exactly once | `chip_sync_receipt` PK `userId+syncId`, receipt-replay branch |
| Guest and authenticated modes | `createPublicGameSession` + guest bankroll persistence |
| Playwright coverage for manual select, Quick Pick, controlled draw, payout, repeat-ticket | `e2e/keno.spec.ts` |
| Multi-draw resume / no duplicate draws | **Deferred** — future spec; UI shows 5/10 as "Coming soon" |

## Out of Scope (deferred)

- **Multi-draw batches (5/10 draws):** gated on idempotent batch settlement per the issue.
  Will be a separate spec that extends this one; forward-compat is limited to the
  number-of-draws control being present-but-disabled.
- **Server-side draw authority / `keno_round` table:** the issue's "authoritative random
  source" language is satisfied for play-money by client-side `crypto.getRandomValues`
  (consistent with slots/craps). A future server-authoritative migration (roulette-style)
  is possible if ranked/seasonal Keno becomes a priority.
- **Server-side paytable-version audit column:** not needed for MVP; version is recorded in
  the client `DrawResult`.
- **LLM strategy/hint module:** Keno is pure chance; no strategy hint.

## References

- Issue references:
  - [`src/lib/slots/ReelManager.ts`](../../src/lib/slots/ReelManager.ts) — injectable RNG pattern (`DrawManager` mirrors this).
  - [`src/lib/public-game-session.ts`](../../src/lib/public-game-session.ts) — guest/authenticated session pattern.
  - [`src/pages/api/chips/update.ts`](../../src/pages/api/chips/update.ts) — `GAME_LIMITS` + `chip_sync_receipt` exact-once settlement.
  - [`src/lib/game-stats/`](../../src/lib/game-stats/) — game-type registration.
- Pattern references: `src/lib/slots/` (settlement + history cap), `src/lib/baccarat/GameSettingsManager.ts`
  (localStorage settings), `src/pages/games/slots.astro` (page shell + guest preamble).
- Parent: [HPA-168 — Roadmap: Arcturus engagement and multiplayer features](https://linear.app/cwchanap/issue/HPA-168/roadmap-arcturus-engagement-and-multiplayer-features).
