# HPA-196 Sic Bo Design

## Summary

Build a small single-player Sic Bo game as the next Arcturus game slice after the wallet/module cleanup.

The design stays intentionally narrow:

- Keep all Sic Bo rules and state in `src/lib/sic-bo/`.
- Roll three client-side six-sided dice with injectable randomness.
- Support only Big, Small, Odd, Even, exact total 4–17, and Any Triple.
- Use closed string bet keys such as `big` and `total:4`.
- Use the local chip denominations `[1, 5, 10, 25, 50, 100]` as the only valid per-position amounts.
- Resolve every selected wager locally and submit one net wallet settlement for authenticated play.
- Reuse `public-game-session` plus the existing wallet settlement gate/recovery controls.
- Add one Astro route, one lobby entry, game-stat registration, focused unit tests, and representative Playwright coverage.

Do not add a shared dice engine, generic betting board/paytable framework, server-generated dice, persistence schema, ranked mode, compatibility layer, or another wallet orchestration abstraction.

## Why HPA-196 is next

HPA-545, HPA-185, HPA-195, and HPA-553 are complete. The remaining open roadmap children are either explicitly deferred or larger future-game ideas.

Sic Bo is smaller than Three-Card Showdown or Pai Gow Poker: it needs no poker evaluator, seven-card arrangement UI, dealer qualification/house-way function, or new persistence. It is the fastest next proof that a new game can use the cleaned wallet boundary without creating another framework.

## Approaches considered

### A. Local Sic Bo module + existing shared seams — selected

Create one self-contained domain under `src/lib/sic-bo/`, reuse only stable session/wallet APIs, and keep the route thin.

This is the smallest implementation and keeps game-specific rules visible in one place.

### B. Extract shared dice primitives from Craps — rejected

`src/lib/craps/diceRoller.ts` is shaped around two dice, hardcoded `Math.random`, a 2–12 total, and Craps-specific combination counts. Sic Bo needs three faces and injectable randomness.

A local three-die helper is cheaper. Extract only if a later dice game creates a genuinely stable common API.

### C. Generic betting/paytable engine — rejected

The MVP has one screen and six bet families. A cross-game registry would hide simple rules behind configuration and force unrelated games into a common model.

Use explicit Sic Bo predicates plus one local odds table, following Roulette's simple predicate + multiplier shape.

### D. Shared settlement DOM controller — rejected

HPA-545 deliberately standardized the wallet transport, settlement ID, in-memory gate, and Retry/Reset policy while leaving balance adoption, round reset, status copy, and game rendering local.

Do not add a callback-driven `settlement-controller.ts` from this game ticket. It would broaden the wallet public contract and either have only one consumer or require unrelated migrations of existing games.

Sic Bo may copy the small game-local event wiring around `createSettlementGate()` and `ensureSettlementRecoveryControls()`. Tests should avoid re-proving the gate's own state machine.

## Existing boundaries to reuse

### Public/guest session

Use `createPublicGameSession(Astro.locals.user)` exactly as Video Poker does.

The route exposes only the existing client user ID, guest-mode flag, initial balance, and balance label. Guest play remains local through the existing guest-bankroll helpers. Authenticated play calls the wallet endpoint only after a round resolves.

### Wallet settlement

Use the existing public wallet API:

- `newSettlementId('sic-bo')`
- `createSettlementGate()`
- `ensureSettlementRecoveryControls()`

One completed authenticated roll creates one command:

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

A break-even round records neither a win nor a loss but still increments `rounds`.

The gate owns pending/retry/reset state. Sic Bo must not add a queue, persisted command store, timer, backoff, or another settlement framework.

### Wager validation

Do **not** reuse `validateBet()`. It models a generic min/max range, while Sic Bo has a closed denomination set plus aggregate-slip affordability.

The game domain validates:

1. betting phase;
2. amount is one of `SIC_BO_CHIP_DENOMINATIONS`;
3. replacing the selected key would not make total stake exceed the current balance.

This keeps the same rule in unit tests and browser behavior without inventing a fake maximum wager.

## Game rules

### Dice

A round rolls exactly three independent six-sided dice.

```ts
export type DieFace = 1 | 2 | 3 | 4 | 5 | 6;
export type SicBoRoll = readonly [DieFace, DieFace, DieFace];
```

Derived values:

- `total`: 3–18.
- `isTriple`: all three dice equal.
- `isBig`: total 11–17 and not a triple.
- `isSmall`: total 4–10 and not a triple.
- `isOdd`: odd total and not a triple.
- `isEven`: even total and not a triple.

Triples lose Big, Small, Odd, and Even even when their total would otherwise qualify.

### Closed bet keys

```ts
export type SicBoExactTotal =
  | 4 | 5 | 6 | 7 | 8 | 9 | 10
  | 11 | 12 | 13 | 14 | 15 | 16 | 17;

export type SicBoBetKey =
  | 'big'
  | 'small'
  | 'odd'
  | 'even'
  | 'any-triple'
  | `total:${SicBoExactTotal}`;
```

Use these keys directly in `data-bet-key`; do not add a parser-friendly open string type or tagged-object adapter.

### Chip denominations

```ts
export const SIC_BO_CHIP_DENOMINATIONS = [1, 5, 10, 25, 50, 100] as const;
```

This is intentionally a Sic-Bo-local copy. Roulette and Slots having the same small list does not justify shared chip infrastructure.

Only these values are valid per-position wager amounts. A different denomination replaces the selected amount for that key. Re-clicking the already-selected denomination clears that key.

A separate **Clear bets** control calls `clearBets()` so a retained slip can always be reduced after a loss or wallet Reset.

### Selected payout variant

Use the following **net odds**:

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

These values are deliberate, not transcription errors: they match the conservative Sic Bo Paytable A published in 58 Pa. Code § 625a.6. HPA-196 chooses that variant as-is; it does not normalize to a different regional paytable.

Changing the selected variant before release is a direct source edit; do not add ruleset/version machinery.

### Round accounting

Suppose selected wagers total `stake`.

1. `roll()` verifies betting phase and `getRollError() === null`.
2. Roll three dice once.
3. Resolve every selected bet independently.
4. A winner contributes `amount * (odds + 1)` gross return.
5. Local balance becomes `balance - stake + grossReturn`.
6. `netDelta = grossReturn - stake`.
7. Store a compact per-bet result and move to `complete`.

The fixed denomination contract also keeps normal wallet deltas far below the wallet sanity guard. With a maximum 100-chip position, the largest positive current round is 5,200 chips (50:1 exact-total plus matching 1:1 size and parity bets), not an unbounded all-in wager.

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

Tests live beside the corresponding domain files, plus one `client.init.test.ts` for Sic-Bo-specific DOM behavior.

### `dice.ts`

```ts
export function rollDie(random: () => number = Math.random): DieFace;
export function rollThreeDice(random: () => number = Math.random): SicBoRoll;
```

Use `Math.floor(random() * 6) + 1`. Do not add an RNG interface/service.

### `rules.ts`

Own payout data and bet recognition:

```ts
export const SIC_BO_CHIP_DENOMINATIONS = [1, 5, 10, 25, 50, 100] as const;
export const TOTAL_ODDS: Readonly<Record<SicBoExactTotal, number>>;
export function getBetOdds(key: SicBoBetKey): number;
export function isWinningBet(key: SicBoBetKey, roll: SicBoRoll): boolean;
export function resolveBet(bet: SicBoBet, roll: SicBoRoll): SicBoBetResult;
```

Keep predicates explicit; do not create a generic expression engine.

### `game.ts`

`SicBoGame` owns balance, selected wagers, phase, and the last result.

```ts
export class SicBoGame {
  constructor(initialBalance: number, random?: () => number);
  getState(): Readonly<SicBoState>;
  getTotalStake(): number;
  getBetError(key: SicBoBetKey, amount: number): string | null;
  getRollError(): string | null;
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
- `getBetError()` rejects values outside `SIC_BO_CHIP_DENOMINATIONS` and aggregate stake above balance.
- `setBet()` rechecks `getBetError()` as an invariant fallback.
- `getRollError()` rejects wrong phase, empty slip, or current stake above balance.
- `roll()` rechecks phase/eligibility and can occur once before `resetRound()`.
- `resetRound()` keeps selected bets and clears the previous roll/result.
- `setBalance()` accepts only non-negative finite balances and truncates to whole chips.
- If retained selections exceed a newly adopted server balance, Roll is disabled until the player clears/replaces bets.

### `client.ts`

Own browser composition only:

- read root session metadata;
- instantiate `SicBoGame`;
- restore/persist guest bankroll;
- bind denomination controls;
- map `data-bet-key` to the closed domain keys;
- implement same-denomination re-click → `clearBet()`;
- bind **Clear bets** → `clearBets()`;
- render balance, selections, stake, dice, result, and action state;
- build one game-local settlement command;
- submit through one settlement gate;
- delegate explicit Retry to `gate.retry()` and Reset to `gate.reset()`;
- adopt successful authoritative balance;
- dispatch existing achievement events.

Do not calculate payouts or winning predicates in DOM handlers.

## Action-button state

The single primary button is `Roll` in `betting` and `New Round` in `complete`.

The client must scope Roll validation to the betting phase so `getRollError()` cannot deadlock the New Round action:

```ts
const state = game.getState();
action.textContent = state.phase === 'betting' ? 'Roll' : 'New Round';
action.disabled =
  (state.phase === 'betting' && game.getRollError() !== null) ||
  (!isGuestMode && gate.isBlocked);
```

When complete and the gate is clear, New Round remains enabled. `roll()` still rejects the wrong phase as a domain invariant.

## Route and UI

Create `src/pages/games/sic-bo.astro` with existing Art Deco/felt conventions.

The screen contains only:

1. header/back link/title/balance;
2. three dice result cells;
3. denomination selector generated from `SIC_BO_CHIP_DENOMINATIONS`;
4. Big/Small/Odd/Even/Any Triple plus totals 4–17;
5. selected amount on each bet;
6. total stake and status/result text;
7. **Clear bets**;
8. `Roll` / `New Round`;
9. wallet recovery host;
10. compact paytable/rules text.

No drag/drop chips, dice physics, audio, history, AI, or separate mobile UI.

Add Sic Bo to `src/pages/index.astro` with the dice emblem, `players: 0`, and `minBet: 1`; do not mark it Featured. `src/pages/games/index.astro` already redirects to the lobby anchor and needs no edit.

## Game statistics

Add `sic-bo` to `GAME_TYPES`, `GAME_TYPE_LABELS`, and `GAME_TYPE_ICONS`.

Update the known exhaustive consumers at the same time:

- `src/lib/game-stats/game-stats.test.ts` — add `sic-bo` and change expected count 8 → 9.
- `e2e/profile-statistics.spec.ts` — add `sic-bo` to `CANONICAL_GAME_TYPES`.

No schema change is needed; game type storage is text and application validation is driven by `GAME_TYPES`.

## Failure behavior

### Ordinary validation

Render user-correctable errors and disable Roll for:

- no selected bets;
- invalid denomination;
- selected total stake above balance.

Pure methods still throw when a caller violates the same invariant.

### Authenticated settlement failure

After a local roll completes:

- keep dice/result visible;
- block New Round while the settlement gate is pending/failed;
- show existing Retry/Reset controls;
- Retry reuses the exact pending command/settlement ID;
- Reset clears the gate, restores the last server-confirmed balance, resets the completed round to betting, and leaves retained bets editable.

Guest play never calls `/api/wallet/settle`.

## Testing

### Domain tests

Cover:

- injectable dice values stay in 1–6;
- triple suppression;
- size/parity boundaries;
- every exact-total payout group and Any Triple;
- mixed simultaneous bets;
- total stake/net delta;
- only the six local denominations are accepted;
- replacing/clearing bets;
- empty/over-balance Roll rejection;
- retained slip after `setBalance()`;
- one Roll per round;
- deep-cloned state/result snapshots.

### Client DOM tests

Keep these Sic-Bo-specific rather than cloning the wallet gate suite:

- guest round persists local bankroll and issues no settlement request;
- same-denomination re-click clears one bet; **Clear bets** clears all;
- Roll disabled state follows `getRollError()` only while betting;
- after a completed guest round, New Round is enabled.

The game-local settlement command builder has focused win/loss/push tests.

### E2E

`e2e/sic-bo.spec.ts` covers:

- deterministic guest winning round using a three-value `Math.random` sequence, not a constant triple;
- authenticated successful settlement using `createIsolatedPage()` and exactly one `sic-bo` command;
- one failed settlement/retry path showing recovery, blocking New Round, and proving Retry sends the same command/ID.

Do not duplicate every settlement-gate branch in `client.init.test.ts`.

## Risks

- **Primary action phase:** retained `getRollError()` is valid only for deciding whether `Roll` is enabled; the client must not apply it to `New Round`.
- **Wallet delta ceiling:** the closed 100-chip per-position denomination keeps the current maximum positive round at 5,200, safely below the wallet's 1,000,000 sanity bound. Revisit this arithmetic if denominations or payout odds change materially.
- **Retained slip after authoritative balance adoption:** a lower server balance may make kept bets unaffordable; **Clear bets** and per-position clearing must always remain available in betting phase.

## Explicit non-goals

- Specific doubles/triples or single-number/combination bets.
- Ranked/daily Sic Bo.
- Server-generated/verifiable dice.
- New tables or migrations.
- Generic dice, chip, bet-board, paytable, game-session, settlement-controller, or plugin frameworks.
- Craps refactor.
- Historical replay/persistence.
- Automated retry/backoff or crash recovery.
- Anti-cheat/security hardening.
- Animation/audio/cosmetic polish beyond existing styles.

## Acceptance gate

Accepted when:

- the MVP bet set is playable across repeated rounds;
- payout behavior stays inside the Sic Bo domain;
- guest play stays local;
- authenticated play produces exactly one wallet settlement per resolved roll;
- Retry reuses the same command/ID;
- Sic Bo is registered in lobby/statistics and exhaustive fixtures;
- focused unit/E2E coverage passes;
- no new persistence or cross-game framework is introduced.
