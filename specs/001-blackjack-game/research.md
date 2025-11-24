# Research: Blackjack Game Implementation

**Feature**: Blackjack Game with LLM Rival  
**Branch**: `001-blackjack-game`  
**Date**: November 23, 2025

## Overview

Research findings for implementing Blackjack game following Arcturus platform patterns. Focus areas: component reusability, game state management, LLM integration, and Blackjack-specific rules.

## Decision 1: DeckManager Reusability

**Decision**: Reuse poker's `DeckManager.ts` with minimal modifications

**Rationale**:

- Both games use standard 52-card deck
- Poker's DeckManager already implements Fisher-Yates shuffle and deck tracking
- Only difference: Blackjack needs reshuffle trigger at 15 cards remaining (vs poker's per-hand reset)
- Cost of duplication > cost of minor adaptation

**Implementation Approach**:

- Copy `src/lib/poker/DeckManager.ts` → `src/lib/blackjack/DeckManager.ts`
- Modify to track `remainingCards` count
- Add `needsReshuffle()` method returning `this.remainingCards < 15`
- Keep existing `shuffle()`, `deal()`, `reset()` methods

**Alternatives Considered**:

- **Shared DeckManager in `src/lib/shared/`**: Rejected - adds unnecessary abstraction for 100 LOC; games may diverge (e.g., multi-deck Blackjack)
- **Build new from scratch**: Rejected - reinvents wheel; Fisher-Yates shuffle is non-trivial

**Test Requirements**:

- Unit tests for reshuffle trigger logic
- Verify 52-card deck composition after shuffle
- Test deterministic behavior with seeded RNG

---

## Decision 2: Hand Value Calculation

**Decision**: Implement Ace soft/hard total calculation using dedicated `handEvaluator.ts`

**Rationale**:

- Blackjack Ace logic differs from poker: Aces count as 1 or 11 (player's advantage)
- "Soft" hand: contains Ace counted as 11 (e.g., A♠ 6♣ = soft 17)
- "Hard" hand: Ace counted as 1, or no Aces (e.g., A♠ 6♣ 10♥ = hard 17)
- Critical for gameplay: "soft 17" can hit without busting, "hard 17" is risky

**Implementation Approach**:

```typescript
export function calculateHandValue(cards: Card[]): {
	value: number;
	isSoft: boolean;
	isBust: boolean;
} {
	// Count Aces and non-Aces separately
	// Try to use Ace as 11 if total ≤ 21
	// If bust, downgrade Aces to 1 until ≤ 21 or all Aces exhausted
}
```

**Edge Cases**:

- Multiple Aces: Only one Ace can be 11 (e.g., A♠ A♣ = 12, not 22)
- Face cards: J, Q, K all count as 10
- Blackjack detection: Exactly 21 with 2 cards (Ace + 10-value)

**Alternatives Considered**:

- **Reuse poker hand evaluator**: Rejected - fundamentally different logic; poker compares hands, Blackjack calculates numeric total
- **Inline calculation in game class**: Rejected - untestable; violates modular architecture principle

---

## Decision 3: LLM Integration Pattern

**Decision**: Follow poker's LLM pattern using `llmBlackjackStrategy.ts` with context-adapted prompts

**Rationale**:

- Poker's `llmAIStrategy.ts` already handles API key management, provider selection, error handling
- Pattern proven: fetches LLM settings, constructs prompt, calls API, parses response
- Blackjack context simpler than poker: no multi-player betting rounds, clearer strategic advice

**Implementation Approach**:

- Create `llmBlackjackStrategy.ts` mirroring poker structure
- Prompt engineering for Blackjack:

  ```
  You are an experienced Blackjack advisor. Analyze this situation:
  - Your hand: [cards] (Total: X, soft/hard)
  - Dealer showing: [card]
  - Available actions: Hit, Stand, [Double Down], [Split]

  Provide brief strategic advice (1-2 sentences) on what action to take and why.
  ```

- Reuse existing `getLlmSettings()` from `src/lib/llm-settings.ts`
- Handle API failures: catch errors, show user-friendly message, allow continue without AI

**API Call Pattern**:

```typescript
export async function getBlackjackAdvice(
	playerHand: Card[],
	dealerCard: Card,
	availableActions: BlackjackAction[],
	userId: string,
): Promise<string> {
	const settings = await getLlmSettings(db, userId);
	// Validate API key exists
	// Construct prompt
	// Call OpenAI/Gemini API
	// Return advice or friendly error
}
```

**Alternatives Considered**:

- **Basic strategy table lookup**: Rejected - less engaging than LLM personality; can be added as fallback
- **Shared LLM strategy module**: Rejected - poker and Blackjack have different context structures (community cards vs dealer card)

---

## Decision 4: Split Hand Management

**Decision**: Use array of `Hand` objects in game state to handle splits

**Rationale**:

- Player can split once (or multiple times in advanced rules)
- Each split hand plays independently with its own bet
- UI must show multiple hands with active hand indicator

**Implementation Approach**:

```typescript
interface BlackjackGameState {
	playerHands: Hand[]; // [0] = primary, [1+] = split hands
	activeHandIndex: number;
	dealerHand: Hand;
	phase: 'betting' | 'player-turn' | 'dealer-turn' | 'complete';
}
```

**Split Flow**:

1. Validate: 2 cards with same rank, sufficient chips for 2nd bet
2. Split hand into two: `[Card1], [Card2]`
3. Deal one card to each split hand
4. Play first hand to completion (hit/stand)
5. Switch to second hand, play to completion
6. Dealer reveals and plays once
7. Compare dealer hand against each player hand independently

**Edge Cases**:

- **Splitting Aces**: Standard rule = deal one card per Ace, no additional hits allowed (implement in Phase 1)
- **Resplitting**: Not supported in MVP (can add in future iteration)
- **Doubling after split**: Allowed (if player has chips)

**Alternatives Considered**:

- **Single hand with "split flag"**: Rejected - complex state machine; hard to test
- **Recursive split support**: Rejected - adds complexity; defer to future iteration

---

## Decision 5: Game Settings Persistence

**Decision**: Use browser `localStorage` for game settings (no database table needed)

**Rationale**:

- Settings are UI preferences, not critical data
- Per-user but device-specific (acceptable for casino game settings)
- No backend API needed - simpler implementation
- Follows poker game pattern: `GameSettingsManager.ts` with localStorage

**Settings Schema**:

```typescript
interface BlackjackSettings {
	startingChips: number; // Default: 1000
	minBet: number; // Default: 10
	maxBet: number; // Default: 1000
	dealerSpeed: 'slow' | 'normal' | 'fast'; // Default: 'normal'
	useLLM: boolean; // Default: false
}
```

**Storage Key**: `arcturus:blackjack:settings:${userId}`

**Alternatives Considered**:

- **Database table**: Rejected - over-engineering for UI preferences; adds migration complexity
- **URL query parameters**: Rejected - settings not meant to be shareable; poor UX for persistence

---

## Decision 6: Chip Balance Integration

**Decision**: Read chip balance from `Astro.locals.user.chipBalance`, update via in-memory tracking during game, sync on round end

**Rationale**:

- Chip balance already managed by middleware (`src/middleware.ts`)
- Game operates on local balance copy during round for performance
- Only persist to database on round completion (win/loss)
- Prevents mid-round database corruption if player leaves

**Implementation Approach**:

```typescript
// On page load
const initialBalance = Astro.locals.user.chipBalance;

// During game (client-side)
let currentBalance = initialBalance;
let currentBet = 0;

// On round complete
async function settleRound(outcome: 'win' | 'loss' | 'push' | 'blackjack') {
	const balanceChange = calculateBalanceChange(currentBet, outcome);
	currentBalance += balanceChange;

	// Update database via API call
	await fetch('/api/chips/update', {
		method: 'POST',
		body: JSON.stringify({ userId, newBalance: currentBalance }),
	});
}
```

**Edge Cases**:

- **Insufficient chips**: Disable betting/actions requiring chips; show warning
- **Concurrent sessions**: Not supported - last write wins (acceptable for MVP)
- **API failure**: Show error, allow retry, prevent game progression until synced

**Alternatives Considered**:

- **Real-time database sync**: Rejected - overkill for single-player game; adds latency
- **Optimistic UI only**: Rejected - must persist wins/losses for user balance integrity

---

## Decision 7: UI Animation Strategy

**Decision**: CSS transitions for card dealing, JavaScript requestAnimationFrame for dealer turn simulation

**Rationale**:

- CSS transitions provide 60fps animations with GPU acceleration
- Dealer turn requires timed card reveals (configurable speed) - JS-controlled timing
- No animation library needed (Tailwind CSS v4 + vanilla JS sufficient)

**Implementation**:

- Card deal: Translate card from deck position to hand position (CSS `transform` transition)
- Dealer reveal: Flip hidden card using CSS `rotateY` transform
- Dealer draw: Sequential card deals with `setTimeout` based on `dealerSpeed` setting

**Performance Target**: Maintain 60fps during animations (validated via Chrome DevTools)

**Alternatives Considered**:

- **Framer Motion / GSAP**: Rejected - adds bundle size for simple animations
- **Canvas-based animations**: Rejected - accessibility concerns; harder to maintain

---

## Technology Stack Confirmation

All technologies align with existing Arcturus infrastructure:

| Technology         | Usage                   | Status                  |
| ------------------ | ----------------------- | ----------------------- |
| TypeScript 5.x     | Game logic modules      | ✅ Existing             |
| Astro SSR          | Page rendering          | ✅ Existing             |
| Tailwind CSS v4    | Styling                 | ✅ Existing             |
| Drizzle ORM        | Database (chip balance) | ✅ Existing             |
| Better Auth        | Authentication          | ✅ Existing             |
| Bun                | Unit testing            | ✅ Existing             |
| Playwright         | E2E testing             | ✅ Existing             |
| OpenAI/Gemini APIs | LLM advice              | ✅ Existing integration |

**No new dependencies required** - Feature built entirely with existing stack.

---

## Best Practices Applied

### 1. Modular Architecture

- Pure functions for game rules (hand evaluation, bet validation)
- Class-based state manager (`BlackjackGame.ts`)
- Separated UI rendering (`BlackjackUIRenderer.ts`)
- Isolated LLM integration (`llmBlackjackStrategy.ts`)

### 2. Testing Strategy

- Unit tests for pure functions (handEvaluator, dealerStrategy)
- Integration tests for game state transitions
- E2E tests for critical user flows (basic game, split, LLM advice)
- Mock LLM API calls in tests to avoid rate limits

### 3. Error Handling

- Graceful LLM API failures (show error, allow continue)
- Chip balance validation before actions
- Card deck reshuffle detection
- Network error handling for chip sync

### 4. Accessibility

- Card values announced via aria-live regions for screen readers
- Keyboard shortcuts for game actions (H=Hit, S=Stand, D=Double, P=Split)
- Focus management for sequential turn flow
- High contrast mode support via Tailwind

---

## Open Questions (Resolved)

All technical unknowns from spec have been resolved through research:

1. **DeckManager reuse** → Yes, with minor modifications for reshuffle
2. **LLM integration pattern** → Follow poker's proven pattern
3. **Split hand management** → Array of Hand objects
4. **Settings persistence** → localStorage (no DB table)
5. **Chip balance sync** → In-memory during game, persist on round end
6. **UI animations** → CSS transitions + JS timing

**No blocking issues identified** - Ready to proceed to Phase 1 (Design).
