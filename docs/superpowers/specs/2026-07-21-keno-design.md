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
| Chip-sync transport | **Direct single-round POST to `/api/chips/update` with a client-generated `syncId` driving the server's `canonicalSyncPayload` receipt path**, serialized through a client-side FIFO outbox. NOT `ChipSyncCoordinator` (which hardcodes `gameType:'slots'`, coalesces rounds, and mints its own server `syncId`). Note: blackjack sends no `syncId` at all, so Keno is the first game to drive the generic chip-update receipt path with a client `syncId` (roulette does the same but via its own endpoint/table). See Settlement Flow. |
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
- `src/lib/game-stats/game-stats.test.ts:422` — update the existing game-count assertion
  `expect(GAME_TYPES.length).toBe(6)` → `.toBe(7)` (and any parallel count/iteration
  assertions in that file that assume the six-game set).
- `src/pages/index.astro` — add a Keno entry to the `games` array:
  ```ts
  { name: 'Keno', emblem: 'spark' as const, players: 0, minBet: 1, href: '/games/keno' },
  ```
  (`emblem: 'spark'` is a valid `GameCard` emblem (`'cards' | 'dice' | 'wheel' | 'spark'`).
  It duplicates the Slots emblem — intentional for now since no Keno-specific emblem exists;
  revisit if a dedicated `DecoIcon` variant is added. `featured: false` since this is a casual
  side game, not a flagship title.)

## Settlement Flow (single draw)

### syncId identity and transport

The client generates one authoritative `syncId` per draw, and **the game round's `syncId` IS
the chip-receipt `syncId`.** Keno sends the full canonical payload to `POST /api/chips/update`,
which routes it through the server's existing `canonicalSyncPayload` path
(`src/pages/api/chips/update.ts:1105+`) — optimistic-lock UPDATE + `chip_sync_receipt` INSERT
gated on `changes() = 1`, with receipt replay on `syncId` collision. This makes Keno exact-once
per `syncId`.

**Relationship to existing games (verified):**
- `ChipSyncCoordinator` (slots) is **not** used — it hardcodes `gameType:'slots'`, coalesces
  multiple rounds, and generates its own server `syncId` that differs from the game round's.
- `blackjackClient.ts` sends **no `syncId`** (body at :1069 has `previousBalance/delta/gameType/
  outcome/...` but no `syncId`), so blackjack takes the server's non-receipt path (`:1405`).
  Keno is the first game to drive the receipt path through `/api/chips/update` with a
  client-generated `syncId`; roulette does the same but through its own `/api/roulette/spin`
  endpoint and `roulette_round` table.

### Serialized outbox (no in-flight overlap)

Two distinct concurrency hazards must be handled separately:

1. **Same-draw double-submit** (button double-click during the ~1.5s reveal) → guarded by a
   per-draw `drawInFlight` flag. Set at commit; cleared in a `finally` only after the draw's
   sync payload has been **enqueued** to the outbox (not after it settles). While set: Draw
   disabled, pick/bet changes ignored, second click is a no-op.
2. **Cross-draw sync overlap** (a second draw's sync starting before the first settles) →
   guarded by a **single-worker FIFO outbox**. Each completed draw produces one
   `PendingReceipt` (the full canonical payload below) appended to a queue. A single drain
   loop processes the head of the queue to completion before starting the next. This guarantees
   each sync's `previousBalance` (= `serverSyncedBalance`) reflects the prior sync's committed
   result, so no two in-flight syncs ever race on the same `previousBalance` (which would 409)
   and no draw's delta is lost or double-counted.

### PendingReceipt (durable, 7-field payload)

The client sends **exactly these 7 fields** and re-sends the same 7 on every retry:

```ts
type PendingReceipt = {
  syncId: string;
  previousBalance: number;   // serverSyncedBalance at enqueue time (rebased on BALANCE_MISMATCH — see drain loop)
  delta: number;             // game.getBalance() - previousBalance, captured at enqueue time
  gameType: 'keno';
  outcome: 'win' | 'loss' | 'push';   // from delta sign
  handCount: 1;
  biggestWinCandidate: number | undefined;  // delta > 0 ? delta : undefined
};
```

**The client must NOT send `statsDelta`, `winsIncrement`, or `lossesIncrement`.** Keno is not
in `BATCHED_GAME_TYPES`, so the server rejects any `statsDelta` with `STATS_DELTA_NOT_ALLOWED`
(400, `update.ts:704`). This is safe w.r.t. `doesChipSyncReceiptMatch` (`update.ts:138`, which
compares 10 fields including those three) precisely because the server **derives** the three
omitted fields deterministically from the 7 the client sends: `statsDeltaForTracking =
validatedStatsDelta ?? delta` (`:1006`, = `delta` for keno), and `winsIncrement`/`lossesIncrement`
from `outcome` (`:992-1003`). So a retry that resends the identical 7 fields causes the server
to rebuild the identical derived triple → receipt match succeeds → cached replay. The contract
is: send 7, server derives 3, retry reproduces all 10.

`delta` is snapshotted at enqueue time and never recomputed, so a later draw doesn't mutate it.
`previousBalance` is the only field a retry may rewrite, and only on BALANCE_MISMATCH (below).
The outbox is persisted to `localStorage` (`arcturus:keno:outbox:<clientUserId>`) so a mid-sync
tab close can resume on next load — the drain loop runs on startup, replaying any pending
receipts. (Guest mode persists to the same key; authenticated mode persists best-effort and
clears each receipt on successful drain.)

### Drain loop (per receipt)

```
pop head PendingReceipt →
  POST /api/chips/update with the 7-field payload (same syncId) →
    200:  serverSyncedBalance = response.balance; game.setBalance(response.balance);
          drop receipt from outbox; drain next.
    409 BALANCE_MISMATCH (response.currentBalance present):
          REBASE AND RE-SUBMIT — do NOT drop. The server's branch order is: receipt-existence
          check first (update.ts:1105-1181), so a syncId that already committed returns the
          cached 200 and never reaches BALANCE_MISMATCH. Therefore BALANCE_MISMATCH (update.ts:1221)
          fires ONLY when no receipt exists yet AND clientPreviousBalance !== serverBalance —
          a genuine concurrent write from another tab/game that committed first. The draw's delta
          was never applied and no receipt was written. So: set previousBalance :=
          response.currentBalance (keep syncId, keep delta, keep all other fields), re-queue at
          the head, and retry immediately. The retry hits no-receipt + matched-balance → fresh
          insert on top of the authoritative balance (e.g. 1050 + 100 = 1150), preserving the
          delta. Exact-once holds (syncId still gates it; serialized outbox means only one
          rebased receipt is ever in flight). If a further concurrent write races the retry, the
          server returns BALANCE_MISMATCH again with a fresh currentBalance → rebase again.
          Bounded-retry the rebases; if the bound is exhausted, fall through to the terminal-4xx
          rule (drop, adopt currentBalance, hard error) so a permanently-contended account can't
          wedge the outbox.
    409 MP_ESCROW_ACTIVE (NO currentBalance in chips/update.ts — only roulette's spin endpoint
          returns one):
          Refetch the authoritative balance via a fresh GET of the user row (or wait for the
          next successful sync to rebase). Do NOT adopt game.getBalance(). Pause the drain
          until escrow clears (the MP hand will release it); surface a toast.
    409 SYNC_ID_REUSE_MISMATCH:
          The server has this syncId for a DIFFERENT payload — a real client bug or a syncId
          collision. Surface as a hard error; refetch balance; drop the receipt (terminal).
    429 RATE_LIMITED: respect Retry-After; re-queue the SAME receipt at the head (do not drop);
          the drain loop sleeps then retries. NOTE: MIN_UPDATE_INTERVAL_MS is 2s (update.ts:447),
          and the FIFO outbox spaces back-to-back draws' syncs <2s apart, so rapid successive
          draws reliably eat one 429 each before succeeding — this is expected, not a bug.
          kenoClient.test.ts case (b) includes this 2s-window 429 explicitly.
    Any other 4xx (DELTA_EXCEEDS_LIMIT, INSUFFICIENT_BALANCE, STATS_DELTA_NOT_ALLOWED,
          STATS_DELTA_WAGER_INCONSISTENCY, INVALID_*): TERMINAL. Normal keno play cannot trigger
          these (top prize 250k vs maxWin 500k; loss 5 vs maxLoss 10k; no statsDelta sent), so
          hitting one means a corrupted outbox or a client bug — a naive "retry at head" loop
          would spin forever on the poison receipt and block the whole outbox. Drop the receipt,
          adopt response.currentBalance if present, surface a hard error. (This also backstops a
          statsDelta leak if one ever slips in.)
    Network failure (after bounded retries): LEAVE the receipt at the head of the outbox;
          back off and retry. Crucially, do NOT set serverSyncedBalance = game.getBalance() —
          we cannot distinguish "request lost" from "server committed, response lost." The
          durable receipt makes this safe: on next drain attempt (or next page load), the same
          7-field payload is resent; if it had committed, the server returns the cached 200 and
          we adopt response.balance.
```

### Game round flow

1. Player commits a ticket (1–10 picks + wager) and taps **Draw**.
2. `kenoClient` checks `drawInFlight`; if set, no-op. Otherwise sets it, generates a `syncId`,
   and calls `KenoGame.draw(syncId)`:
   - Validates `syncId` (reject `INVALID_SYNC_ID`).
   - Returns cached `DrawResult` if `syncId` already exists in history (idempotent replay —
     matches `SlotsGame.spin`).
   - Validates wager and selection **at draw time only** (see Error Handling — setters accept
     a 0–10 draft so `Clear` works). `draw()` throws via `fail` (toast + throw).
   - Debits wager, emits `onBalanceUpdate`.
   - Calls `DrawManager.draw()` → 20 distinct numbers in 1–80 (crypto RNG by default).
   - Computes hits via `selection.countHits`, payout via `payoutCalculator.evaluateDraw`; the
     `DrawResult` carries `netDelta` and a derived `outcome` so tests can assert outcome labels
     without re-deriving them (see Data Model).
   - Credits payout, appends `DrawResult` to history (capped at `MAX_HISTORY=20`, FIFO),
     emits `onRoundComplete` + `onBalanceUpdate`.
3. Animation plays (~1.5s). On completion, `kenoClient` snapshots the
   `PendingReceipt { syncId, previousBalance: serverSyncedBalance, delta: game.getBalance() −
   serverSyncedBalance, ... }`, appends it to the persisted outbox, and clears `drawInFlight`.
4. The drain loop sends the receipt per the table above. On 200, `serverSyncedBalance` adopts
   `response.balance` and the receipt is dropped.
5. Server applies the delta under optimistic lock, writes `chip_sync_receipt`
   (PK `userId+syncId`) → exact-once. A replay (same `syncId`, same canonical payload) returns
   the cached receipt row.
6. Guest mode (`shouldSyncAccountChips === false`): no fetch. The drain loop is a no-op;
   balance persists in `localStorage` via `persistGuestBankroll('keno', clientUserId, balance)`;
   `serverSyncedBalance` tracks the guest bankroll locally; the outbox stays empty.

## Paytable

Realistic standard published-style paytable. Multiplier is per 1-unit bet; chip payout =
`multiplier × bet` (gross/total-returned convention: the player's net on a hit is
`(multiplier − 1) × bet`, and `netDelta = payout − bet = (multiplier − 1) × bet`).
Configurable in `constants.ts`; stamped with `PAYTABLE_VERSION = '2026-07-standard-v1'`.

| Spots | Catch → multiplier | RTP |
|-------|--------------------|-----|
| 1 | 1→3 | 75.00% |
| 2 | 2→12 | 72.15% |
| 3 | 3→45 · 2→2 | 90.19% |
| 4 | 4→130 · 3→5 · 2→1 | 82.71% |
| 5 | 5→500 · 4→20 · 3→2 | 73.22% |
| 6 | 6→1500 · 5→50 · 4→7 · 3→1 | 67.78% |
| 7 | 7→5000 · 6→150 · 5→15 · 4→2 · 3→1 | 64.08% |
| 8 | 8→15000 · 7→400 · 6→50 · 5→10 · 4→2 | 59.37% |
| 9 | 9→25000 · 8→2000 · 7→200 · 6→30 · 5→8 · 4→2 | 86.22% |
| 10 | 10→50000 · 9→4000 · 8→500 · 7→120 · 6→25 · 5→5 | 83.53% |

RTP is computed from the hypergeometric distribution
`P(catch k of s picks | 20 drawn from 80) = C(20,k)·C(60,s−k) / C(80,s)` and summed as
`Σ P(k)·multiplier(k)`. All spot counts land in the standard Keno band (≈59–90%); the table
is house-favorable everywhere (no player-positive tier). The exact computation is checked into
the repo as a runnable script alongside `payoutCalculator.test.ts` so the RTP column is
auditable and stays in sync if any multiplier changes.

Notes:
- **No catch-0 consolation bonus.** An earlier draft had a 10-spot catch-0 → 5× bonus; combined
  with the mid tiers that produced a player-positive 104.84% RTP (broken). The bonus is dropped
  for MVP — it may be re-added in a future tuning pass only after recomputing RTP. With no
  catch-0 tier, the outcome semantics simplify: `hitCount === 0` is always a loss.
- `MAX_BET=5` keeps the top prize (10-spot catch-10) at 250,000 chips — 2× headroom under
  `GAME_LIMITS.keno.maxWin=500000`. All other prizes at `MAX_BET=5` fit trivially under the cap
  (next-highest: 9-spot catch-9 = 125,000).
- Within each spot count, paying tiers are strictly monotonic (more catches > fewer catches).
- `push` occurs only when `multiplier === 1` (e.g. 4-spot catch-2). All non-paying tiers
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
    outcome: 'win' | 'loss' | 'push';  // netDelta > 0 → win, < 0 → loss, === 0 → push
    paytableVersion: string;
    timestamp: number;
  }
  ```
  `outcome` is computed in `KenoGame.draw` from `netDelta` and stored on the record so the UI
  and tests can read it without re-deriving. (`evaluateDraw` returns only the raw
  `{hits, hitCount, multiplier, payout}`; it does NOT classify outcome — that is `KenoGame`'s
  job.) With no catch-0 bonus, `hitCount === 0` ⟹ `multiplier === 0` ⟹ `outcome === 'loss'`.
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
    payout potential), **Clear** (deselect all → empty 0-pick draft; Draw disabled until
    ≥1 pick), **Repeat Ticket** (re-apply last ticket's picks), **Draw** (disabled until 1–10
    picks selected and balance ≥ bet, AND disabled while `drawInFlight` is set — see
    Settlement Flow).
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
| `INVALID_SELECTION` | duplicates, out-of-range (non 1–80), non-integers in a pick | `setSelection` / `togglePick` |
| `INVALID_DRAW_SELECTION` | draw attempted with <1 or >10 picks | `draw` |
| `INSUFFICIENT_BALANCE` | wager > balance | `draw` |
| `INVALID_SYNC_ID` | missing/empty `syncId` | `draw` |

**Two-path error routing, matching `SlotsGame` exactly:**

- **Programmatic setters** (`setBet`, `setSelection`, `togglePick`, `clearSelection`) throw
  via `buildError(code, msg)` — plain `Error` with a `code` property, **no toast**. These are
  caller bugs (the UI clamps before calling); emitting `onError` here would leak a toast even
  when the caller swallows the throw. Mirrors `SlotsGame.setBet`.
- **`draw(syncId)`** throws via `fail(code, msg)` — emits `onError` (toast) THEN throws.
  `INSUFFICIENT_BALANCE`, `INVALID_DRAW_SELECTION`, and `INVALID_SYNC_ID` are runtime
  conditions the player should see, not caller bugs. Mirrors `SlotsGame.spin`/`SlotsGame.fail`.

**Draft state — selection is validated at draw time, not at set time.** The selection setters
must accept a **0–10 pick draft** so `Clear` works: `clearSelection()` yields an empty draft
(0 picks) which is a valid UI state ("Pick 1–10 numbers"). The lower/upper pick-count bounds
are enforced by `draw()` as `INVALID_DRAW_SELECTION`, NOT by `setSelection`. Per-pick
invariants (duplicates, range 1–80, integer) ARE enforced by the setters as `INVALID_SELECTION`
— those are genuine caller bugs, not a valid draft state. `validateSelection` (pure helper)
exposes the full check for the UI to gate the Draw button (`canDraw` ⟺ 1–10 valid picks).
`quickPick(n)` is guaranteed to return a valid ticket (correct count, unique, in-range).

**Chip-sync failures** are NOT `KenoErrorCode`s — they surface as HTTP responses handled by
the outbox drain loop in `kenoClient` (see Settlement Flow for the full 200/409×3/429/network
table). No `ChipSyncCoordinator` involvement.

## Testing

### Unit tests (Bun)

- `DrawManager.test.ts` — `draw()` returns exactly 20 numbers; all in range 1–80; all
  distinct; injectable `Rng` is deterministic for a seeded sequence; the default RNG path
  exercises `crypto.getRandomValues` (mocked) and produces unbiased output (no `byte % 80`
  modulo skew — verified by asserting uniform bucket counts over a large seeded sample, or by
  structural check that Fisher–Yates rejection sampling is used).
- `selection.test.ts` — `validateSelection` accepts all valid 1–10 pick sets and rejects
  duplicates, out-of-range, non-integers, non-array; **`setSelection`/`togglePick` ACCEPT a
  0–10 draft** (so `clearSelection` works); `quickPick(n)` produces `n` unique in-range
  numbers; `countHits` is correct for known inputs.
- `payoutCalculator.test.ts` — every spot-count × hit-count branch in `PAYTABLE` is covered,
  payout scales linearly with bet, strictly monotonic within each spot count, no payout for
  non-paying tiers. **RTP audit:** a runnable computation asserts each spot-count's RTP lands
  in [0.55, 0.95] (house-favorable) — this is the regression net against the original
  104.84% 10-spot bug.
- `KenoGame.test.ts` — balance debit/credit, `syncId` replay returns cached `DrawResult`,
  history cap eviction at `MAX_HISTORY`, `setBet`/`setSelection`/`togglePick`/`clearSelection`
  throw via `buildError` (no `onError` emission) and accept a 0–10 draft, `draw` throws via
  `fail` (`onError` emitted then throw) for `INSUFFICIENT_BALANCE`/`INVALID_DRAW_SELECTION`/
  `INVALID_SYNC_ID`, every `KenoErrorCode` in the right condition, `canDraw` gating. **Outcome
  labels:** `draw()` results carry `outcome` derived from `netDelta`; cover win/loss/push
  (push = multiplier===1, e.g. 4-spot catch-2; loss = multiplier 0; win = the rest).
- `kenoClient.test.ts` (sync state machine) — covers the outbox drain loop end-to-end with a
  mocked `fetch`: (a) two rapid draws enqueue two receipts and they drain **serially** (second
  send's `previousBalance` equals the first's committed `response.balance`, never overlapping);
  (b) 429 re-queues the same 7-field payload at the head (verifies `syncId`+`delta`+
  `previousBalance`+`outcome`+`handCount`+`biggestWinCandidate` resent; asserts `statsDelta`/
  `winsIncrement`/`lossesIncrement` are NEVER sent). Includes the realistic 2s-rate-limit window
  (`MIN_UPDATE_INTERVAL_MS`) where back-to-back draws each eat one 429 before succeeding; (c) 409
  `BALANCE_MISMATCH` **rebases and resubmits** — `previousBalance := response.currentBalance`,
  same `syncId`+`delta` retained, retried until a 200 applies the delta on top of the authoritative
  balance (verifies the delta is NOT lost; this is the regression net for the original "drop loses
  the win" bug); (d) network failure leaves the receipt at the head and retries the identical
  payload (does NOT adopt local balance); (e) a terminal 4xx (`DELTA_EXCEEDS_LIMIT` or
  `STATS_DELTA_NOT_ALLOWED`) drops the receipt, adopts `currentBalance` if present, surfaces the
  error, and does NOT loop; (f) a persisted outbox on load re-drains; (g) guest mode
  (`guestModeValue === 'true'`) skips all fetches and persists balance to `localStorage`.

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

**MVP scope = single-draw.** The issue lists multi-draw (5/10 batches) under "MVP scope" but
gates it on "when idempotent batch settlement is complete," and its multi-draw acceptance
criterion is phrased conditionally ("Any enabled multi-draw mode…"). This spec implements the
single-draw path and explicitly **defers the multi-draw criteria** — they are not claimed as
covered. Single-draw settlement (the hardest single-draw AC: "updates chips and statistics
exactly once") IS covered, via the client-generated-`syncId` receipt path + serialized outbox.

| Issue criterion | Coverage |
|-----------------|----------|
| Select 1–10 unique numbers manually or via Quick Pick | UI + `selection.ts` |
| Reject invalid/duplicate/out-of-range/over-limit selections | `selection.validateSelection` + unit tests (draft-state: count enforced at draw time) |
| Every draw = 20 unique valid numbers | `DrawManager` (crypto RNG, unbiased) + unit tests |
| Match counting + every payout branch has unit coverage | `selection.countHits` + `payoutCalculator` full-branch tests + RTP audit |
| UI shows the exact paytable for the chosen spot count | Paytable modal, re-renders on spot-count change; enabled before first draw |
| Wagers cannot exceed available balance | `INSUFFICIENT_BALANCE` check in `KenoGame.draw` |
| Single-draw settlement updates chips and stats exactly once | Client-`syncId` receipt path + serialized outbox + durable full-payload retry; `chip_sync_receipt` PK `userId+syncId`; `kenoClient` sync unit tests |
| Guest and authenticated modes | `createPublicGameSession` + guest bankroll persistence (outbox is a no-op in guest mode) |
| Playwright coverage for manual select, Quick Pick, controlled draw, payout, repeat-ticket | `e2e/keno.spec.ts` |
| Multi-draw resume / no duplicate draws | **Deferred** — out of MVP scope; UI shows 5/10 as "Coming soon". Tracked in Out of Scope. |

## Out of Scope (deferred)

- **Multi-draw batches (5/10 draws):** gated on idempotent batch settlement per the issue.
  Will be a separate spec that extends this one; forward-compat is limited to the
  number-of-draws control being present-but-disabled. The single-draw outbox/receipt model
  here is a foundation for, not an implementation of, multi-draw.
- **Server-side draw authority / `keno_round` table:** the issue's "authoritative draws /
  server-verified round events" language is **relaxed** for play-money MVP to client-side
  `crypto.getRandomValues` + capped-delta server trust (consistent with slots/craps). Ranked
  or seasonal Keno integrity would require a server-authoritative migration (roulette-style);
  flagged as a known MVP limitation, not a silent one.
- **Server-side paytable-version audit column:** not in MVP; `PAYTABLE_VERSION` is recorded on
  the client `DrawResult` only.
- **catch-0 consolation bonus:** dropped to fix the 104.84% RTP 10-spot table; may be re-added
  in a tuning pass after RTP recompute.
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
