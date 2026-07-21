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
| Settlement architecture | **Client-authoritative (slots pattern)** — RNG + payout run client-side, synced via `POST /api/chips/update` + `chip_sync_receipt`. Supports guest + authenticated. |
| Authoritative random source | `crypto.getRandomValues`-backed RNG in `DrawManager` (injectable `Rng = () => number` for tests, the `ReelManager.ts` pattern referenced in the issue) |
| Paytable philosophy | **Realistic standard** published-style paytable, RTP-aligned with common Vegas/IGT tables |
| Number pool | 80 numbers (1–80), player picks 1–10, house draws 20 |
| Multi-draw | **Deferred.** Single-draw only for this spec. The UI shows a number-of-draws control with 5/10 disabled ("Coming soon"); multi-draw batch settlement is a future spec that extends this one. |
| Bet limits | min 1, max 5 chips per draw (sized so the top prize fits under the per-game win cap with 2× headroom) |
| Server persistence | **No new D1 table, no migration.** Reuses `chip_sync_receipt` (PK `userId+syncId`) for exact-once settlement, identical to slots/craps. |
| Paytable versioning | `PAYTABLE_VERSION` constant stamped into each client-side `DrawResult`; not stored server-side for MVP (server trusts the capped delta, consistent with the documented client-authoritative security model) |
| Guest mode | Yes — `createPublicGameSession` + `persistGuestBankroll('keno', ...)` (slots pattern) |
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
├── DrawManager.ts            # draw(rng?) → 20 distinct numbers from 1–80 (injectable RNG, ReelManager pattern)
├── selection.ts              # Pure: validateSelection, quickPick(count, rng?), countHits
├── payoutCalculator.ts       # Pure: evaluateDraw(picks, drawn, bet) → {hits, hitCount, multiplier, payout}
├── KenoGame.ts               # State holder: balance, bet, ticket, history, event callbacks; draw(syncId)
├── KenoUIRenderer.ts         # DOM: 80-number grid, selection/drawn/hit highlight, draw animation, paytable panel, history, balance/bet
├── GameSettingsManager.ts    # localStorage 'arcturus:keno:settings:<clientUserId>' (animation speed, sound — baccarat pattern)
├── kenoClient.ts             # initKenoClient(): wire DOM + game + chip sync + guest bankroll (the <script> entrypoint)
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
- `src/lib/game-stats/constants.ts` — extend the three mirrors of the game-type union:
  ```ts
  export const GAME_TYPES = ['blackjack', 'baccarat', 'craps', 'poker', 'slots', 'roulette', 'keno'] as const;
  export const GAME_TYPE_LABELS = { ..., keno: 'Keno' };
  export const GAME_TYPE_ICONS = { ..., keno: '\u{1F3B1}' }; // 🎱 numbered-ball glyph (distinct from slots' 🎰)
  ```
- `src/pages/index.astro` — add a Keno entry to the `games` array:
  ```ts
  { name: 'Keno', emblem: 'spark' as const, players: 0, minBet: 1, href: '/games/keno' },
  ```
  (`emblem: 'spark'` reuses an existing `DecoIcon` variant; `featured: false` since this is a
  casual side game, not a flagship title. Adjust at impl if a more fitting `emblem` exists.)

## Settlement Flow (single draw)

1. Player commits a ticket (1–10 picks + wager) and taps **Draw**.
2. `KenoGame.draw(syncId)`:
   - Validates `syncId` (reject `INVALID_SYNC_ID`).
   - Returns cached `DrawResult` if `syncId` already exists in history (idempotent replay —
     matches `SlotsGame.spin`).
   - Validates wager (`BET_BELOW_MIN` / `BET_ABOVE_MAX` / `INSUFFICIENT_BALANCE`).
   - Validates selection via `selection.validateSelection` (`INVALID_SELECTION` for count
     <1 or >10, duplicates, out-of-range, non-integers).
   - Debits wager from balance, emits `onBalanceUpdate`.
   - Calls `DrawManager.draw()` → 20 distinct numbers in 1–80.
   - Computes hits via `selection.countHits`, payout via `payoutCalculator.evaluateDraw`.
   - Credits payout to balance, appends `DrawResult` to history (capped at `MAX_HISTORY=20`,
     FIFO like slots), emits `onRoundComplete` + `onBalanceUpdate`.
3. `kenoClient.ts` calls the existing chip-sync path → `POST /api/chips/update` with:
   ```ts
   {
     delta: payout - bet,
     gameType: 'keno',
     syncId,
     previousBalance,
     outcome: payout > bet ? 'win' : payout < bet ? 'loss' : 'push',
     handCount: 1,
     biggestWinCandidate: payout > bet ? payout - bet : undefined,
   }
   ```
4. Server applies the delta under optimistic lock, writes `chip_sync_receipt` (PK `userId+syncId`)
   → exact-once. On replay (same `syncId`), server returns the cached result and the client
   adopts it — identical to slots/craps/roulette's receipt-replay branch.
5. Guest mode (`shouldSyncAccountChips === false`): balance persists in `localStorage` via
   `persistGuestBankroll('keno', clientUserId, balance)`; no API call is made.

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
- The catch-0 → 5× on the 10-spot is the classic Keno "no-catch bonus."
- `MAX_BET=5` keeps the top prize (10-spot catch-10) at 250,000 chips — 2× headroom under
  `GAME_LIMITS.keno.maxWin=500000`.
- All other prizes at `MAX_BET=5` fit trivially under the cap (next-highest: 9-spot catch-9
  = 125,000).
- Within each spot count, paying tiers are monotonic (more catches ≥ fewer catches).

The UI shows the exact paytable for the currently-selected spot count, re-rendering when the
spot count changes (picks added/removed).

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
  - Buttons: **Quick Pick** (random valid ticket of current spot count, or 8 if none),
    **Clear** (deselect all), **Repeat Ticket** (re-apply last ticket's picks), **Draw**
    (disabled until 1–10 picks selected and balance ≥ bet).
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

| Code | Cause |
|------|-------|
| `BET_BELOW_MIN` | wager < `MIN_BET` |
| `BET_ABOVE_MAX` | wager > `MAX_BET` |
| `INSUFFICIENT_BALANCE` | wager > balance |
| `INVALID_BET` | non-finite / non-integer wager |
| `INVALID_SELECTION` | <1 or >10 picks, duplicates, out-of-range (non 1–80), non-integers |
| `INVALID_SYNC_ID` | missing/empty `syncId` |

`KenoGame.fail(code, msg)` emits `onError` (toast) then throws — same separation as
`SlotsGame.fail`, so caller-side `try/catch` swallowing does not leak the toast.

Selection validation (`selection.validateSelection`) rejects: fewer than 1 or more than 10
picks, duplicate numbers, numbers outside 1–80, non-integers. `quickPick` is guaranteed to
return a valid ticket (correct count, unique, in-range).

Chip-sync failures (rate limit, network, balance mismatch): handled by the existing
`ChipSyncCoordinator` — on 429 give-up the delta is reverted to `serverSyncedBalance`; on
network give-up same. No Keno-specific sync logic.

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
  within each spot count, no payout for non-paying tiers.
- `KenoGame.test.ts` — balance debit/credit, `syncId` replay returns cached `DrawResult`,
  history cap eviction at `MAX_HISTORY`, every `KenoErrorCode` is thrown in the right
  condition, `canDraw` gating.

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
