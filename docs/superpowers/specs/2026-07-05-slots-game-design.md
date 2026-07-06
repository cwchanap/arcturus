# Slots Game Design

Linear: [HPA-124 — Requirement: Slot Machines game](https://linear.app/cwchanap/issue/HPA-124/requirement-slot-machines-game)

## Goal

Add a playable slot machine at `/games/slots` that fits Arcturus's free-to-play virtual-chip
casino model: quick, readable, fair, and consistent with the existing single-player game
architecture (blackjack, baccarat, craps).

## Resolved Design Decisions

| Decision | Choice |
|----------|--------|
| Reel layout | 5 reels × 3 rows |
| Paylines | 5 fixed paylines, single bet amount |
| Symbol set | Classic fruit machine (7 symbols) |
| Win rule | Left-to-right, 3/4/5 of a kind |
| Bet model | Bet = total per spin (min 1 chip) |
| Spin resolution | Client-resolved + server chip sync (matches existing games) |
| History | In-memory recent-spins ring buffer (no DB migration) |
| LLM module | None (slots is pure chance) |

## Architecture

Slots follows the established modular game pattern under `src/lib/{game}/`, mirroring baccarat
and blackjack.

### New files

```
src/pages/games/slots.astro              # Page: guest preamble, #slots-root, UI shell, <script> init
src/lib/slots/
├── types.ts                  # Symbol, ReelGrid, SpinResult, GamePhase, SlotSettings, SlotsGameState, SlotsGameEvents
├── constants.ts              # Symbols, weights, paylines, paytable, bet limits, DEFAULT_SETTINGS, MAX_HISTORY
├── ReelManager.ts            # Weighted RNG spin → 5×3 ReelGrid
├── payoutCalculator.ts       # Pure: evaluate grid against paylines → line wins + total payout
├── SlotsGame.ts              # State machine: idle/spinning/settled/error, balance, history, event callbacks
├── SlotsUIRenderer.ts        # DOM updates: reels, balance, buttons, win highlight, paytable panel
├── GameSettingsManager.ts    # localStorage 'arcturus:slots:settings:<clientUserId>'
├── balance-sync-state.ts     # Pending-stats + retry/backoff helpers (adapted from baccarat's)
├── slotsClient.ts            # initSlotsClient(): wire DOM + game + chip sync (the <script> entrypoint)
├── index.ts                  # Barrel exports
└── *.test.ts                 # One per pure module (ReelManager, payoutCalculator, SlotsGame, GameSettingsManager)
```

### Integration touchpoints (existing files)

- `src/pages/api/chips/update.ts` — add `slots` to `GAME_LIMITS`:
  `{ maxWin: 100000, maxLoss: 10000 }`.
- `src/lib/game-stats/constants.ts` — add `'slots'` to `GAME_TYPES`, `GAME_TYPE_LABELS`,
  `GAME_TYPE_ICONS` so stats/leaderboards include slots.
- `src/pages/index.astro` — add `featured: true` to the existing Slots entry (route already
  linked).

No DB migration. No new components — reuses `PokerChip.astro`, `.felt-table`, `.btn-gold`, and
the Art Deco design tokens.

### Deviation from other games

Every other game has an `llm{Game}Strategy.ts` module. Slots has none because it is pure chance
with no player decisions to advise on.

## Game Config

All tunable values live in `constants.ts` as the single source of truth. UI never hardcodes these.

### Symbols and weights

Highest to lowest. Weights are per reel (sum 100); the same weights apply to all 5 reels for the
MVP. The config is per-reel ready if reel strips should later differ.

| id | symbol | weight |
|----|--------|--------|
| seven | 7 | 3 |
| bell | Bell | 6 |
| bar | BAR | 9 |
| melon | Watermelon | 12 |
| grapes | Grapes | 18 |
| lemon | Lemon | 24 |
| cherry | Cherry | 28 |

### Paylines

Rows are indexed 0 (top), 1 (middle), 2 (bottom). Each payline is one row index per reel.

1. Middle: `[1,1,1,1,1]`
2. Top: `[0,0,0,0,0]`
3. Bottom: `[2,2,2,2,2]`
4. V: `[0,1,2,1,0]`
5. Λ: `[2,1,0,1,2]`

### Paytable

Per-line multiplier applied to the per-line bet, where per-line bet = `totalBet / NUM_PAYLINES`
(NUM_PAYLINES = 5). Every value is a multiple of 5 so payouts are always integer chips at any
integer bet: `payout = multiplier × totalBet / 5`.

| Symbol | 3-of-a-kind | 4-of-a-kind | 5-of-a-kind |
|--------|-------------|-------------|-------------|
| seven  | 60 | 300 | 1000 |
| bell   | 40 | 120 | 400 |
| bar    | 30 | 90 | 300 |
| melon  | 25 | 60 | 200 |
| grapes | 20 | 50 | 150 |
| lemon  | 10 | 30 | 100 |
| cherry | 10 | 30 | 80 |

### Win rule

Left-to-right consecutive matching from reel 0. A line wins when the first N reels (N ≥ 3) share
a symbol and reel N differs (or N = 5). All 5 paylines are evaluated independently each spin;
line wins sum.

### RTP and balance guardrails

Computed analytical RTP from the weights and paytable above is approximately 95%, appropriate
for a fun free-to-play economy. Two config-validation tests enforce this going forward:

- All paytable values are multiples of `NUM_PAYLINES` (5).
- A Monte-Carlo simulation (≥ 200k spins) asserts RTP stays within 92–98%.

### Bet limits

Minimum bet 1 chip. Bet increments `[1, 5, 10, 25, 50, 100]`. Hard cap 100 chips. At bet = 1 the
smallest win (cherry or lemon 3-of-a-kind) pays `(10 × 1 / 5) = 2` chips. The jackpot (seven
5-of-a-kind on one line at bet = 100) pays `1000 × 20 = 20,000` chips; across up to 5 lines that
is 100,000, matching `GAME_LIMITS.slots.maxWin`.

## Core Logic

### ReelManager

Weighted RNG producing a 5×3 grid. Each of the 15 cells is chosen independently via a
cumulative-weight lookup over the symbol weights. There is no deck or shoe — each spin is
independent, unlike the card games.

The RNG source is swappable. The default is `Math.random`, matching the trust model of the other
client-resolved games. Tests inject a seeded `mulberry32` PRNG for deterministic reels.

### payoutCalculator

Pure functions and the most heavily tested module.

- `evaluateLine(line, paytable)` — walks from index 0 while `line[i] === line[0]`; returns the
  longest match of count ≥ 3, else null.
- `evaluateGrid(grid, paylines, paytable, totalBet)` — evaluates all paylines and returns
  `{ lineWins, totalPayout }`, where
  `totalPayout = sum(lineWins.map(w => (w.multiplier × totalBet) / NUM_PAYLINES))`.

Integer math is guaranteed by the multiples-of-5 invariant; `Math.round` is applied defensively.
Insufficient-balance and duplicate-settlement protection do not live here — the calculator is
pure math on a supplied grid.

### SlotsGame

State machine with event callbacks (baccarat's event pattern).

```ts
type GamePhase = 'idle' | 'spinning' | 'settled' | 'error';

interface SlotsGameState {
  balance: number;
  phase: GamePhase;
  bet: number;
  grid: SymbolId[][];
  lastEvaluation: SpinEvaluation | null;
  history: SpinResult[];      // ring buffer, cap MAX_HISTORY = 20
  settings: SlotSettings;
  lastSyncId: string | null;
}
```

- `placeBet(amount)` — validates `amount ≥ MIN_BET`, `amount ≤ balance`, `amount ≤ MAX_BET`;
  throws on violation. Sets the active bet.
- `spin(syncId)` — **idempotency guard**: if `state.lastSyncId === syncId` and the phase is
  already `settled`, re-return the cached result without re-deducting or re-crediting. This is
  the refresh/retry-during-a-spin protection. Otherwise deduct the bet, set phase `spinning`,
  generate the grid via ReelManager, evaluate, credit the payout, push to history, and emit
  `onRoundComplete`.
- Balance never goes negative: `placeBet` rejects when `bet > balance`; payout only ever adds.

Events emitted: `onSpinStart`, `onReelsReady(grid)`, `onRoundComplete(result)`,
`onBalanceUpdate(balance)`, `onError`.

This game class is the client trust boundary. The server's `/api/chips/update` independently
enforces `maxWin`/`maxLoss` caps, `syncId` idempotency via the `chip_sync_receipt` table
(primary key `(userId, syncId)`), rate limits, and optimistic locking — so even though the client
picks the outcome, settlement is gated.

## Chip Sync

On `onRoundComplete`, `slotsClient.ts` computes
`delta = payout - bet` and
`outcome = payout > bet ? 'win' : payout === bet ? 'push' : 'loss'`, then (for authenticated
users only) POSTs to `/api/chips/update`:

```jsonc
{
  "delta": "<payout - bet>",
  "gameType": "slots",
  "outcome": "win" | "loss" | "push",
  "handCount": 1,
  "previousBalance": "<serverSyncedBalance>",
  "syncId": "<crypto.randomUUID()>"
}
```

This mirrors baccarat's proven flow, adapted via `balance-sync-state.ts`:

- **Guest mode:** no sync; `persistGuestBankroll('slots', clientUserId, balance)` writes to
  localStorage. Only authenticated users hit the server.
- **Concurrency:** an `isSyncInProgress` flag prevents overlapping requests.
- **Rate-limit retry:** on HTTP 429, read `Retry-After`, schedule up to 3 retries, and release
  the lock first.
- **Follow-up sync:** if another spin settles while a sync is in flight, queue a follow-up with
  exponential backoff (max 3 attempts).
- **Error recovery:** on `BALANCE_MISMATCH` or any error carrying `currentBalance`, rebase via
  `game.setBalance(serverBalance)`; on network error, revert to `serverSyncedBalance`.

### Duplicate-settlement protection

The `syncId` is generated per spin and passed into `game.spin(syncId)` so both the client guard
and the server `chip_sync_receipt` table protect against duplicate settlement. A page refresh
mid-spin leaves no phantom deduction client-side (the bet is only deducted synchronously inside
`spin()`), and the server only ever credits a settled spin's delta once because of the `syncId`
plus the receipt primary key.

## History

In-memory ring buffer, `MAX_HISTORY = 20`, stored in `SlotsGameState.history`:

```ts
interface SpinResult {
  bet: number;
  grid: SymbolId[][];
  payout: number;
  netDelta: number;
  timestamp: number;
  syncId: string;
  lineWins: LineWin[];
}
```

Rendered as a compact recent-spins strip (bet → net, color-coded). Lost on refresh, which is
acceptable for the MVP. The `SpinResult` shape is intentionally DB-ready — it carries every field
the issue lists (bet, result symbols, payout, net delta, timestamp; game type is implicit) so a
future `game_round` table can consume it without changes.

### Stats integration

Because `'slots'` is added to `GAME_TYPES`, each successful sync automatically updates the
`game_stats` aggregates (wins, losses, hands played, biggest win, net profit) and the
leaderboards. No extra code is required; the sync endpoint already does this.

## UI/UX

### Page (`slots.astro`)

Guest-mode preamble matching craps/baccarat (`createPublicGameSession`), `<CasinoLayout>`, a
single `#slots-root` carrying `data-user-id`, `data-guest-mode`, `data-initial-balance`.

Layout uses Tailwind utilities plus Art Deco design tokens:

- Header row: back-to-lobby link, in-page `#chip-balance` pill.
- `.felt-table` panel containing the 5×3 reel window with colored payline overlays.
- Last-result line ("LEMON ×4 on line 2") and last-win amount with win highlight.
- Bet selector: six increment chips reusing `PokerChip.astro` / `.bet-chip` styling; selected
  chip gets the gold `.selected` glow; `#current-bet` shows the active bet.
- `[SPIN]` button (`.btn-gold`), `[Paytable]` and `[Settings]` toggles.
- Recent-spins strip below the table.

Each reel is a vertical column of three symbol cells. On spin, cells scroll/blur vertically
(`@keyframes spin-scroll`) and settle with a stagger (reel 0 stops first, reel 4 last) for
classic anticipation. The in-page `#chip-balance` updates instantly from `onBalanceUpdate`.

### Animation states

Driven by `GamePhase`:

| Phase | Visual |
|-------|--------|
| `idle` | SPIN enabled, bet selectable |
| `spinning` | reels animating, SPIN and bet disabled |
| `settled` + win | reels stopped, winning cells and lines pulse gold, "WIN +N" banner |
| `settled` + no win | reels stopped, subdued "No win" |
| `error` | toast "Spin failed — retry", bet refunded, SPIN re-enabled |

### Paytable panel

A drawer/modal toggled by `[Paytable]` that renders the symbol set, the 5 payline diagrams, and
the full payout table (multipliers and chip values at the current bet). It matches the actual
payout calculation by construction because both read the same `paytable` constant.

### Settings panel

A `[Settings]` panel for spin speed (slow / normal / fast → reel animation duration), sound
toggle, and quickSpin (skip animation). Persisted via `GameSettingsManager` to localStorage under
`arcturus:slots:settings:<clientUserId>`. Mirrors blackjack's settings panel.

### Responsiveness

Reels scale on mobile (grid stays 5×3; cells use `clamp()` sizing; tap targets ≥ 44px). Bet chips
wrap. Verified by E2E at mobile and desktop viewports.

### Styling approach

Tailwind utilities on elements for layout/spacing; page-scoped `<style>` for reel-specific
keyframes; `:global(...)` where needed (same convention as `blackjack.astro`). Reuses
`.felt-table`, `.btn-gold`, `.deco-*` tokens, and `PokerChip.astro`. No new components.

## Testing

Unit tests use `bun:test` with `describe` / `test` / `expect`, co-located as `*.test.ts`.

| File | Covers |
|------|--------|
| `ReelManager.test.ts` | grid is 5×3; every cell is a valid symbol; weights produce the expected distribution over 50k spins (within tolerance); seeded RNG is deterministic |
| `payoutCalculator.test.ts` | 3/4/5-of-a-kind detection per line; left-to-right rule (non-consecutive = no win); all 5 paylines evaluated; multi-line sums; payout matches the paytable exactly; multiples-of-5 invariant; Monte-Carlo RTP in 92–98% band |
| `SlotsGame.test.ts` | insufficient-balance rejection; min/max bet enforcement; bet deducted exactly once per spin; payout credited exactly once; duplicate-settlement protection (same `syncId` → no re-credit); balance never negative; history ring buffer caps at 20 |
| `GameSettingsManager.test.ts` | load / save / validate / reset; clamps; localStorage error handling |

These satisfy the three unit-test areas the issue requires: payout calculation,
insufficient-balance validation, and duplicate-settlement protection.

### E2E (`e2e/slots.spec.ts`)

Playwright, reusing `e2e/.auth/user.json`:

- Desktop and mobile viewports (responsiveness).
- Spin with bet = 1; assert balance drops by 1 then updates after settle, with no full reload.
- Bet above balance is blocked; SPIN is disabled.
- Open the paytable; assert it shows a known multiplier.
- Rapid double-spin during animation → no duplicate settlement (a single sync request per
  `syncId`).
- Refresh mid-spin → balance unchanged (no phantom deduction).

### Verification commands

```bash
bun test src/lib/slots/                 # unit
bun run test:e2e -- e2e/slots.spec.ts   # E2E
bun run lint && bun run build           # CI gates
```

## Acceptance Criteria

All acceptance criteria from the issue are covered:

- Visiting `/games/slots` shows a complete slot machine UI.
- Player can spin with 1+ chips and cannot spin below the minimum or above their balance.
- Each spin deducts the bet exactly once.
- Winning spins credit the correct payout exactly once.
- The chip balance updates without requiring a full page refresh.
- Paytable matches the actual payout calculation.
- Refreshing/retrying during a spin cannot duplicate settlement.
- Unit tests cover payout calculation, insufficient-balance validation, and duplicate-settlement
  protection.
- Basic responsive layout works on mobile and desktop.
