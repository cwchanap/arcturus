# HPA-196 Sic Bo Design

## Summary

Build a small single-player Sic Bo game as the next Arcturus game slice after the wallet settlement cleanup and Video Poker.

The selected design is intentionally narrow:

- Keep all Sic Bo rules and state in `src/lib/sic-bo/`.
- Roll three client-side six-sided dice with an injectable random function for deterministic tests.
- Support only Big, Small, Odd, Even, exact total 4–17, and Any Triple.
- Resolve every selected wager in one local round and submit one net wallet settlement for authenticated play.
- Reuse `src/lib/bet-validation.ts`, `src/lib/public-game-session.ts`, and the public `src/lib/wallet` APIs.
- Add one Astro route, one lobby entry, game-stat registration, focused unit tests, and one representative Playwright flow.

Do not add a shared dice-game framework, generic betting-board model, server-authoritative outcome service, persistence schema, ranked mode, compatibility layer, anti-cheat layer, or automatic settlement queue.

## Why HPA-196 is next

HPA-553 is already in progress with its own design PR, so creating another design PR for it would duplicate work. The remaining open roadmap children are either explicitly deferred or low-priority future-game ideas.

HPA-196, HPA-197, and HPA-198 are all now unblocked because HPA-545 is complete. Sic Bo is the smallest of those slices: it needs no poker hand evaluator, no seven-card arrangement UI, no dealer house-way function, and no new persistence. It therefore gives the fastest validation that another casual game can use the cleaned wallet boundary without introducing another framework.

## Design approaches considered

### A. Local Sic Bo module + existing shared seams — selected

Create one self-contained domain under `src/lib/sic-bo/`, reuse only stable shared session/wager/wallet APIs, and keep the route thin.

**Why selected:** smallest implementation, easiest to test, matches Video Poker's successful modular-monolith shape, and keeps game-specific rules visible in one place.

### B. Extract shared dice primitives from Craps first — rejected

Move Craps dice types and rolling functions into a new shared package and migrate Craps before implementing Sic Bo.

**Why rejected:** the existing Craps helper is explicitly shaped around two dice and a 2–12 total. Sic Bo needs three dice and a 3–18 total. Extracting a generic dice package now would create churn in a completed game for only one new consumer. Keep Sic Bo's three-die helper local; extract later only if a third dice game creates a genuinely stable common API.

### C. Add a generic betting-board/payout engine — rejected

Represent bets through a cross-game registry with reusable selection, validation, payout, rendering, and settlement abstractions.

**Why rejected:** the MVP has six bet families and one screen. A generic engine would hide simple rules behind configuration and force unrelated games into a common model. The local bet union and payout table are easier to understand and change.

## Existing boundaries to reuse

### Public/guest session

Use `createPublicGameSession(Astro.locals.user)` exactly as Video Poker does. The route passes only the existing user ID, guest-mode flag, initial balance, and balance label to the browser.

Guest play stays local and persists through the existing guest bankroll helpers. Authenticated play uses the wallet endpoint only after a round resolves.

### Wager validation

Reuse `validateBet()` for the generic positive/range check, but keep Sic Bo's total selected-wager affordability inside the Sic Bo game state.

The UI may offer chip amounts from a small fixed set, for example `1`, `5`, `10`, `25`, `50`, and `100`. A selected bet is valid only when the amount is a whole chip value and the sum of all selected wagers does not exceed the current local balance.

Do not create a reusable bet-slip validator.

### Wallet settlement

Use the existing public wallet API:

- `newSettlementId('sic-bo')`
- `createSettlementGate()`
- `ensureSettlementRecoveryControls()`

One completed roll creates one command:

```ts
{
  settlementId,
  game: 'sic-bo',
  delta: result.netDelta,
  stats: {
    rounds: 1,
    wins: result.netDelta > 0 ? 1 : 0,
    losses: result.netDelta < 0 ? 1 : 0,
    biggestWin: Math.max(result.netDelta, 0),
  },
}
```

A break-even round records neither a win nor a loss but still increments rounds.

The gate owns retry/reset state. Sic Bo must not add another pending queue, persisted command store, timer, retry backoff, or recovery abstraction.

## Game rules

### Dice

A round rolls exactly three independent six-sided dice.

```ts
type DieFace = 1 | 2 | 3 | 4 | 5 | 6;
type SicBoRoll = readonly [DieFace, DieFace, DieFace];
```

Derived values:

- `total`: 3–18.
- `isTriple`: all three dice equal.
- `isBig`: total 11–17 and not a triple.
- `isSmall`: total 4–10 and not a triple.
- `isOdd`: odd total and not a triple.
- `isEven`: even total and not a triple.

Triples lose Big, Small, Odd, and Even even when the total would otherwise qualify.

### MVP bet types

```ts
type SicBoBetType =
  | 'big'
  | 'small'
  | 'odd'
  | 'even'
  | 'any-triple'
  | { total: 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 };
```

The concrete implementation may use a tagged object instead of the illustrative union if that produces simpler TypeScript and DOM mapping.

Only one wager per bet key is stored. Clicking a selected bet with a new chip amount replaces that amount; clearing a bet removes it. No duplicate bet rows or wager-stack history is needed.

### MVP payout table

Store payout odds as a local plain object. Values below are **net odds**; a winning bet returns its stake plus winnings.

| Bet | Net odds |
| --- | ---: |
| Big | 1:1 |
| Small | 1:1 |
| Odd | 1:1 |
| Even | 1:1 |
| Any Triple | 24:1 |
| Total 4 or 17 | 50:1 |
| Total 5 or 16 | 18:1 |
| Total 6 or 15 | 14:1 |
| Total 7 or 14 | 12:1 |
| Total 8 or 13 | 8:1 |
| Total 9, 10, 11, or 12 | 6:1 |

There is no configurable paytable or rule version. Changing these values before launch is a direct source edit.

### Round accounting

Suppose selected wagers total `stake`.

1. `roll()` validates at least one wager and `stake <= balance`.
2. The game deducts the full `stake` locally.
3. It rolls three dice once.
4. Each selected wager is evaluated independently.
5. Every winning wager contributes `amount * (odds + 1)` gross return.
6. Local balance becomes `balance - stake + grossReturn`.
7. `netDelta = grossReturn - stake`.
8. The round becomes complete and exposes a compact per-bet result breakdown.

This lets simultaneous bets resolve naturally while still producing one wallet settlement.

## Module shape

```text
src/lib/sic-bo/
  types.ts
  dice.ts
  rules.ts
  game.ts
  client.ts
  index.ts
```

Tests live beside their corresponding files.

### `types.ts`

Own only Sic Bo domain types:

- `DieFace`
- `SicBoRoll`
- `SicBoBetKey`
- `SicBoBet`
- `SicBoBetResult`
- `SicBoRoundResult`
- `SicBoState`
- `SicBoPhase`

No DOM, wallet, Astro, or persistence types belong here.

### `dice.ts`

Expose:

```ts
export function rollDie(random?: () => number): DieFace;
export function rollThreeDice(random?: () => number): SicBoRoll;
```

Use `Math.floor(random() * 6) + 1`. Keep the injectable function; do not add an RNG interface/service.

Do not import `src/lib/craps/diceRoller.ts`. That helper is typed around two-die Craps rolls and totals and is not a clean shared primitive for Sic Bo.

### `rules.ts`

Own all bet recognition and payout data:

```ts
export const TOTAL_ODDS: Readonly<Record<SicBoExactTotal, number>>;
export function getBetOdds(key: SicBoBetKey): number;
export function isWinningBet(key: SicBoBetKey, roll: SicBoRoll): boolean;
export function resolveBet(bet: SicBoBet, roll: SicBoRoll): SicBoBetResult;
```

Keep category logic explicit rather than data-driving every predicate through a generic expression engine.

### `game.ts`

`SicBoGame` owns pure balance, selected wagers, phase, and the last result.

Suggested public API:

```ts
export class SicBoGame {
  constructor(initialBalance: number, random?: () => number);
  getState(): Readonly<SicBoState>;
  getTotalStake(): number;
  getBetError(key: SicBoBetKey, amount: number): string | null;
  setBet(key: SicBoBetKey, amount: number): void;
  clearBet(key: SicBoBetKey): void;
  clearBets(): void;
  roll(): SicBoRoundResult;
  resetRound(): void;
  setBalance(balance: number): void;
}
```

Rules:

- Bet editing is allowed only in `betting` phase.
- Bet amount must be a positive whole number.
- Replacing one bet calculates affordability against all other selected bets plus the new amount.
- `roll()` rejects an empty bet slip or unaffordable state.
- `roll()` may only happen once before `resetRound()`.
- `resetRound()` keeps the selected bets by default so repeat play is fast, but returns to `betting` phase and clears the previous dice/result.
- If the kept selections now exceed the authoritative balance after settlement, Roll stays disabled until the player reduces bets.

Keeping selections across rounds is a small usability feature and requires no extra persistence model.

### `client.ts`

Own browser composition only:

- read root session metadata;
- instantiate `SicBoGame`;
- restore/persist guest bankroll;
- bind chip denomination controls;
- map bet buttons to `SicBoBetKey`;
- render selected wager amounts, total stake, balance, dice, per-bet result, and Roll/New Round action;
- build the game-local wallet settlement command;
- submit through one settlement gate;
- call `gate.retry()` and `gate.reset()` for recovery;
- adopt successful server balance with `game.setBalance(result.balance)`;
- dispatch existing achievement events.

The client must not own payout formulas or dice qualification logic.

## Route and UI

Create `src/pages/games/sic-bo.astro`.

Use the current Art Deco/felt presentation and existing public-game root conventions.

The screen needs only:

1. Header with back link, game title, and chip balance.
2. Three large dice placeholders/results.
3. Chip denomination selector.
4. One compact bet board containing Big, Small, Odd, Even, Any Triple, and total 4–17 buttons.
5. Selected stake shown directly on each bet button.
6. Total stake and status/result text.
7. Primary `Roll` / `New Round` button.
8. Existing wallet recovery controls host for authenticated failures.
9. Compact rules/paytable explanation below the table.

Do not add drag-and-drop chips, animated dice physics, sound, betting history, strategy advice, statistics dashboard widgets, or a separate mobile UI.

Add Sic Bo to `src/pages/index.astro` with the dice emblem, `players: 0`, and `minBet: 1`; do not mark it Featured.

## Game statistics

Add `sic-bo` to `GAME_TYPES`, `GAME_TYPE_LABELS`, and `GAME_TYPE_ICONS` using label `Sic Bo` and the existing dice emoji.

No database schema change is required because the wallet/stat path stores game identifiers textually and validates against the application game-type list.

## Failure behavior

### Ordinary validation

User-correctable conditions should render messages and disable Roll instead of relying on exceptions:

- no selected bets;
- non-whole or non-positive wager;
- selected total stake exceeds balance.

The pure game methods still enforce these as invariant fallbacks.

### Authenticated settlement failure

After the local roll is complete:

- keep the completed result visible;
- block New Round while the settlement gate is failed/pending;
- show existing Retry/Reset recovery controls;
- Retry reuses the exact pending command and settlement ID;
- Reset discards the failed local result and restores the last server-confirmed balance before returning to betting state.

Guest play never calls `/api/wallet/settle`.

## Testing

### Unit tests

Cover:

- dice values always stay in 1–6 and injected randomness is deterministic;
- triples suppress Big/Small/Odd/Even;
- Big/Small and Odd/Even boundaries;
- every exact-total payout group;
- Any Triple win/loss;
- simultaneous selected bets with mixed wins/losses;
- total stake and net-delta accounting;
- replacing/clearing bets;
- empty/over-balance wager rejection;
- one-roll-per-round lifecycle;
- deep-cloned state/result snapshots so browser code cannot mutate internal state.

### Browser tests

Add one representative `e2e/sic-bo.spec.ts` covering:

- route loads and lobby link works;
- guest can select a wager, roll, see three dice/result, and start another round with local bankroll persistence;
- authenticated successful settlement submits exactly one `sic-bo` wallet command and adopts authoritative balance;
- one settlement failure exposes Retry/Reset and blocks New Round until recovery.

Do not duplicate the wallet gate's complete unit test matrix inside Sic Bo.

## Explicit non-goals

- Specific doubles or specific triples.
- Single-number wagers.
- Combination wagers.
- Ranked/daily Sic Bo.
- Server-generated or server-verifiable dice.
- New database tables or migrations.
- Generic dice, betting-board, paytable, game-session, settlement, or plugin frameworks.
- Reuse/refactor of the existing Craps implementation.
- Historical round replay or persistence.
- Automated retry/backoff or crash recovery.
- Anti-cheat/security hardening.
- Animations, audio, advanced accessibility modes, or cosmetic polish beyond the existing component/style baseline.

## Acceptance gate

The implementation is accepted when:

- the limited MVP bet set is playable end-to-end;
- all payout behavior lives in the Sic Bo domain, not the route/client;
- guest play stays local;
- authenticated play produces exactly one wallet settlement per resolved roll;
- Sic Bo is registered in the lobby and game statistics;
- focused unit and E2E coverage passes;
- no new persistence or generic cross-game framework is introduced.
