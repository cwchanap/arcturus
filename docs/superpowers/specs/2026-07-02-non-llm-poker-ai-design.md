# Non-LLM Poker AI Design

Date: 2026-07-02

## Goal

Improve single-player Texas Hold'em opponents with a non-LLM AI difficulty ladder. The first implementation targets the existing single-player poker game, while keeping the decision logic modular enough to reuse later for multiplayer bots.

The AI must remain fair: it can only use the same visible information available to a player at the table. It must not inspect undealt cards, opponent hole cards, or future board cards.

## Existing Context

Single-player poker currently routes AI turns through `PokerGame.processAITurn()`, which builds a `GameContext`, calls either the LLM decision path or the local rule-based path, then executes the returned `AIDecision`.

The existing local strategy in `src/lib/poker/aiStrategy.ts` uses hand-strength thresholds, rough pot odds, personality knobs, and randomness. `src/lib/poker/handEvaluator.ts` already contains both lightweight strength helpers and a proper showdown winner evaluator. The design should preserve the public decision shape and avoid rewriting turn execution.

## Product Decisions

- Target single-player opponents first.
- Keep per-opponent personality settings.
- Add per-opponent difficulty settings.
- Use Easy, Medium, and Hard as the difficulty ladder.
- Hard should be a solid casual opponent, not a solver or near-perfect math engine.
- Bots must never use hidden information.
- LLM mode remains optional. When LLM mode falls back to local AI, it should use the improved non-LLM engine.

## User-Facing Behavior

The game settings panel adds:

- `Player 2 Difficulty`: Easy, Medium, Hard
- `Player 3 Difficulty`: Easy, Medium, Hard

Defaults:

- Player 2: Medium difficulty, Tight-Aggressive style
- Player 3: Medium difficulty, Loose-Aggressive style

Difficulty and personality are orthogonal. A player can configure combinations like Easy Tight-Aggressive or Hard Loose-Aggressive, and those combinations should produce distinct behavior.

## Difficulty Model

Easy bots are readable and beatable. They rely on coarse hand strength, overvalue obvious made hands, underweight position, fold too often to pressure, bluff rarely, and use simple raise sizes.

Medium bots are competent. They use preflop ranges, pot odds, draw strength, position, and simple board texture. They still make visible mistakes, such as calling too wide with weak pairs or missing some bluff spots.

Hard bots are solid but fair. They estimate equity from visible information, consider opponent count, pot odds, board texture, position, betting pressure, and stack-aware bet sizing. They bluff and semi-bluff selectively, but a controlled mistake rate prevents mechanical play.

## Personality Modifiers

Personality adjusts the base difficulty profile:

- Tight styles narrow continuing ranges and fold more marginal spots.
- Loose styles continue with more marginal equity.
- Aggressive styles raise more often and use larger sizes.
- Passive styles check and call more often, raise less, and bluff less.

Difficulty defines how much information the bot considers. Personality defines how it expresses the decision.

## Architecture

`src/lib/poker/aiStrategy.ts` remains the public entry point. Existing consumers can continue calling `createAIConfig()` and `makeAIDecision(context, config)`.

The improved engine should be split into focused modules:

- `aiDifficulty.ts`: difficulty names, tuning profiles, defaults, and personality-adjusted profile helpers.
- `aiEquity.ts`: visible-information equity and draw estimates based on known cards plus an abstract unknown-card pool, never the actual shuffled deck order.
- `aiBoardTexture.ts`: board texture classification such as dry, wet, paired, flush pressure, and straight pressure.
- `aiBetSizing.ts`: stack-aware bet and raise sizing by difficulty, personality, equity, pot, call amount, and board texture.
- `aiStrategy.ts`: orchestration and compatibility wrapper.

This keeps each unit testable without DOM or browser state. `PokerGame.ts` should only need small wiring changes for per-opponent difficulty.

## Data Flow

1. `GameSettingsManager` loads `aiDifficulty1`, `aiDifficulty2`, `aiPersonality1`, and `aiPersonality2`.
2. `PokerGame` creates AI configs per opponent, including both personality and difficulty.
3. On an AI turn, `PokerGame.processAITurn()` builds the existing `GameContext`.
4. If `useLLMAI` is enabled, the LLM path runs as today. Its local fallback uses the improved non-LLM engine.
5. If `useLLMAI` is disabled, `makeAIDecision(context, aiConfig)` runs the improved non-LLM engine.
6. The engine returns the existing `AIDecision` shape.
7. `PokerGame.ts` remains the final authority for legal execution and keeps its existing guards for impossible checks, calls, and raises.

## Decision Inputs

The non-LLM engine can use:

- Bot hole cards
- Visible community cards
- Abstract unknown-card combinations derived by excluding visible cards from a standard deck
- Public player states: folded, all-in, chip counts, current bets, dealer position, and action order
- Pot size
- Minimum bet and current call amount
- Betting round
- Configured difficulty and personality
- Randomness bounded by the configured mistake and bluff rates

The engine must not use:

- Opponent hole cards
- Future community cards
- Remaining deck order
- Undealt card identities

## Decision Output

The engine returns:

```ts
{
	action: 'fold' | 'check' | 'call' | 'raise',
	amount?: number,
	confidence?: number,
	reasoning?: string,
}
```

`reasoning` is for tests and debugging. It should use compact labels, for example:

```text
hard equity=0.46 potOdds=0.28 texture=wet semi-bluff
```

This text is not a player-facing coaching feature in the first implementation.

## Error Handling And Fallbacks

If any AI helper cannot produce a confident result, the strategy should fall back to a legal conservative decision:

- Check when no call is required.
- Call only when the call amount is affordable and the profile allows loose continuation.
- Fold when facing pressure and no stronger fallback applies.

`PokerGame.ts` continues to validate and execute the decision. The strategy should prefer legal outputs, but turn execution remains centralized.

Old saved settings that do not include difficulty values must merge with defaults through `GameSettingsManager`.

## Testing Plan

Unit tests:

- `aiDifficulty.test.ts`: validates Easy, Medium, and Hard profiles plus personality modifiers.
- `aiEquity.test.ts`: validates obvious visible-information spots, including premium pair, weak offsuit, flush draw, made flush, and scary paired board.
- `aiBoardTexture.test.ts`: validates dry, wet, paired, flush-pressure, and straight-pressure boards.
- `aiBetSizing.test.ts`: validates legal, stack-aware raise sizes and difficulty/personality sensitivity.
- `aiStrategy.test.ts`: updates existing expectations and adds scenarios proving difficulty changes decisions.

Integration tests:

- `PokerGame.test.ts`: verifies per-opponent difficulty is loaded into AI config.
- `GameSettingsManager.test.ts`: verifies difficulty settings persist and old saved settings merge with defaults.
- `e2e/poker-turn-flow.spec.ts`: keeps the current poker smoke flow green and verifies the settings panel exposes both difficulty controls.

## Out Of Scope

- Multiplayer bots
- Solver or GTO play
- Training from hand history
- Persisted opponent memory
- LLM prompt redesign
- Player-facing AI reasoning
- Any intentional hidden-information advantage

## Acceptance Criteria

- Single-player poker has per-opponent difficulty controls.
- Existing personality controls still work.
- Existing LLM toggle still works, and local fallback uses the improved non-LLM engine.
- Easy, Medium, and Hard produce meaningfully different decisions in targeted tests.
- Hard bots use visible-information estimates and controlled mistakes rather than hidden information.
- Existing poker turn-flow E2E remains green.
- The implementation stays within the existing Cloudflare Workers and browser-compatible runtime constraints.
