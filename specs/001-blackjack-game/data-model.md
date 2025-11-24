# Data Model: Blackjack Game

**Feature**: Blackjack Game with LLM Rival  
**Branch**: `001-blackjack-game`  
**Date**: November 23, 2025

## Overview

Data structures for Blackjack game implementation. All entities are in-memory (client-side) except chip balance persistence.

## Core Entities

### Card

Represents a single playing card from a standard 52-card deck.

**Fields**:

- `rank`: `'A' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K'`
- `suit`: `'hearts' | 'diamonds' | 'clubs' | 'spades'`

**Computed Properties**:

- `value`: Numeric value for Blackjack (A=1 or 11, J/Q/K=10, others=face value)
- `displayName`: Human-readable name (e.g., "Ace of Spades", "King of Hearts")

**Validation Rules**:

- Rank and suit must be valid enum values
- Each card is immutable once created

**Relationships**:

- Contained in: `Hand`, `Deck`

---

### Hand

Represents a collection of cards held by player or dealer.

**Fields**:

- `cards`: `Card[]` - Array of cards in hand
- `bet`: `number` - Amount wagered on this hand (0 for dealer)
- `isDealer`: `boolean` - True if this is dealer's hand

**Computed Properties**:

- `value`: Numeric total of hand (calculated by handEvaluator)
- `isSoft`: Boolean - true if hand contains Ace counted as 11
- `isBust`: Boolean - true if value > 21
- `isBlackjack`: Boolean - true if value === 21 && cards.length === 2
- `canSplit`: Boolean - true if 2 cards with same rank
- `canDoubleDown`: Boolean - true if 2 cards and value in [9, 10, 11]

**State Transitions**:

```
INITIAL (0-2 cards)
  → ACTIVE (player's turn)
  → STANDING (player stood)
  → COMPLETE (round over)
  → BUST (value > 21)
```

**Validation Rules**:

- Bet must be >= 0
- Cards array cannot be empty when hand is ACTIVE
- Dealer hand always has bet = 0

**Relationships**:

- Contained in: `BlackjackGameState.playerHands[]`, `BlackjackGameState.dealerHand`
- Contains: Multiple `Card` objects

---

### Deck

Manages card deck state including shuffling and dealing.

**Fields**:

- `cards`: `Card[]` - Remaining cards in deck (private)
- `dealtCards`: `Card[]` - Cards already dealt (for reshuffle tracking)

**Methods**:

- `shuffle()`: Randomize card order using Fisher-Yates algorithm
- `deal()`: Remove and return top card
- `reset()`: Restore all 52 cards and shuffle
- `needsReshuffle()`: Returns true if < 15 cards remaining

**Validation Rules**:

- Deck must contain exactly 52 cards after reset
- Cannot deal when `cards.length === 0`
- Reshuffle triggered automatically when `needsReshuffle() === true`

**State Invariants**:

- `cards.length + dealtCards.length === 52` (always)
- No duplicate cards across both arrays

---

### BlackjackGameState

Main game state container managing round flow and player/dealer hands.

**Fields**:

- `phase`: `'betting' | 'dealing' | 'player-turn' | 'dealer-turn' | 'complete'`
- `playerHands`: `Hand[]` - Array of player hands (index 0 = primary, 1+ = splits)
- `activeHandIndex`: `number` - Index of currently active player hand
- `dealerHand`: `Hand` - Dealer's hand
- `deck`: `Deck` - Card deck instance
- `playerBalance`: `number` - Current chip balance (synced from server)
- `pot`: `number` - Total chips wagered this round (sum of all hand bets)

**Computed Properties**:

- `activeHand`: `Hand` - Returns `playerHands[activeHandIndex]`
- `availableActions`: `BlackjackAction[]` - Valid actions for current game state
- `roundComplete`: `boolean` - True if phase === 'complete'

**Phase Transitions**:

```
betting
  → dealing (user clicks "Deal")
  → player-turn (cards dealt, first hand active)
  → dealer-turn (all player hands standing/bust)
  → complete (dealer finishes, winners determined)
  → betting (new round starts)
```

**Validation Rules**:

- Phase transitions must follow valid sequence
- Cannot have activeHandIndex >= playerHands.length
- playerBalance must be >= 0
- pot === sum of all hand bets

**Methods**:

- `placeBet(amount: number)`: Validate and place initial bet
- `deal()`: Deal initial cards (2 to player, 2 to dealer)
- `hit()`: Deal one card to active hand
- `stand()`: End active hand's turn, move to next hand or dealer
- `doubleDown()`: Double bet, deal one card, auto-stand
- `split()`: Create second hand from matching pair
- `settleRound()`: Determine winners, calculate payouts

---

### BlackjackSettings

User-configurable game preferences (persisted in localStorage).

**Fields**:

- `startingChips`: `number` - Default chips for new rounds (default: 1000)
- `minBet`: `number` - Minimum allowed bet (default: 10)
- `maxBet`: `number` - Maximum allowed bet (default: 1000)
- `dealerSpeed`: `'slow' | 'normal' | 'fast'` - Dealer card animation speed
- `useLLM`: `boolean` - Enable LLM-powered AI advisor (default: false)

**Validation Rules**:

- `minBet` must be > 0
- `maxBet` must be > `minBet`
- `startingChips` must be >= `minBet`
- dealerSpeed must be valid enum value

**Storage**:

- Key: `arcturus:blackjack:settings:${userId}`
- Format: JSON string in localStorage
- Loaded on page mount, updated on settings change

**Relationships**:

- Referenced by: `BlackjackGame` (applies settings on initialization)

---

### BlackjackAction

Enum of valid player actions during gameplay.

**Values**:

- `'hit'` - Request another card
- `'stand'` - End turn without additional cards
- `'double-down'` - Double bet, take one card, auto-stand
- `'split'` - Split matching pair into two hands
- `'ask-ai'` - Request LLM strategic advice (not a game action)

**Availability Rules**:

```typescript
function getAvailableActions(gameState: BlackjackGameState): BlackjackAction[] {
	const { activeHand, playerBalance, phase } = gameState;

	if (phase !== 'player-turn') return [];

	const actions: BlackjackAction[] = ['hit', 'stand'];

	if (activeHand.canDoubleDown && playerBalance >= activeHand.bet) {
		actions.push('double-down');
	}

	if (activeHand.canSplit && playerBalance >= activeHand.bet) {
		actions.push('split');
	}

	return actions;
}
```

---

### RoundOutcome

Represents the result of a completed Blackjack round for payout calculation.

**Fields**:

- `handIndex`: `number` - Which player hand (for split hands)
- `result`: `'win' | 'loss' | 'push' | 'blackjack'`
- `payout`: `number` - Chips won/lost (negative for losses)

**Payout Calculation**:

- **Blackjack**: Bet × 1.5 (e.g., $10 bet → $15 win)
- **Win**: Bet × 1 (e.g., $10 bet → $10 win)
- **Push**: Bet × 0 (original bet returned)
- **Loss**: Bet × -1 (bet lost)

**Validation Rules**:

- Payout must match result type calculation
- handIndex must reference valid player hand

---

## Data Flow Diagrams

### Round Lifecycle

```
User Input (Place Bet)
  ↓
[Betting Phase]
  ↓
Deal Initial Cards (2 player, 2 dealer)
  ↓
[Player Turn Phase]
  ↓
Player Actions (Hit/Stand/Double/Split) ←─┐
  ↓                                       │
More Hands? ──────────────────────────────┘
  ↓ No
[Dealer Turn Phase]
  ↓
Dealer Draws (hits on ≤16, stands on ≥17)
  ↓
[Complete Phase]
  ↓
Determine Winners (compare hand values)
  ↓
Calculate Payouts
  ↓
Update Chip Balance (API call)
  ↓
[Betting Phase] (new round)
```

### Split Hand Flow

```
User Clicks "Split"
  ↓
Validate (same rank, sufficient chips)
  ↓
Create Second Hand
  ├─→ Hand 1: Keep first card
  └─→ Hand 2: Move second card
  ↓
Deal One Card to Each Hand
  ↓
Set activeHandIndex = 0
  ↓
Play Hand 1 to Completion (Hit/Stand)
  ↓
Set activeHandIndex = 1
  ↓
Play Hand 2 to Completion (Hit/Stand)
  ↓
Continue to Dealer Turn
```

---

## Database Integration

### Existing Tables (Reused)

**user** table:

- `chipBalance` field updated on round completion
- No schema changes needed

**llm_settings** table:

- Queried for API keys when LLM feature enabled
- No schema changes needed

### No New Tables Required

All game state is client-side (in-memory). Only persistence points:

1. **Chip balance**: Updated via API call to existing endpoint
2. **Game settings**: Stored in browser localStorage
3. **LLM settings**: Already in database from poker implementation

---

## Type Definitions Summary

```typescript
// Core game types
type Rank = 'A' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K';
type Suit = 'hearts' | 'diamonds' | 'clubs' | 'spades';
type GamePhase = 'betting' | 'dealing' | 'player-turn' | 'dealer-turn' | 'complete';
type DealerSpeed = 'slow' | 'normal' | 'fast';
type BlackjackAction = 'hit' | 'stand' | 'double-down' | 'split' | 'ask-ai';
type RoundResult = 'win' | 'loss' | 'push' | 'blackjack';

// Entity interfaces
interface Card {
	rank: Rank;
	suit: Suit;
}
interface Hand {
	cards: Card[];
	bet: number;
	isDealer: boolean;
}
interface Deck {
	/* methods only */
}
interface BlackjackGameState {
	/* see above */
}
interface BlackjackSettings {
	/* see above */
}
interface RoundOutcome {
	handIndex: number;
	result: RoundResult;
	payout: number;
}
```

---

## Validation Matrix

| Entity             | Validation Rule             | Enforcement Point                |
| ------------------ | --------------------------- | -------------------------------- |
| Card               | Valid rank/suit enums       | Constructor                      |
| Hand               | Bet >= 0                    | `placeBet()` method              |
| Hand               | Non-empty cards when ACTIVE | Phase transition guard           |
| Deck               | 52 cards after reset        | `reset()` method + unit tests    |
| BlackjackGameState | Balance >= 0                | Before allowing bet/double/split |
| BlackjackGameState | Valid phase transitions     | State machine guards             |
| BlackjackSettings  | minBet < maxBet             | Settings save method             |
| RoundOutcome       | Payout matches result       | `calculatePayout()` function     |

---

## Performance Considerations

- **Hand value calculation**: O(n) where n = cards in hand (max ~10 cards) - negligible
- **Deck shuffle**: O(52) Fisher-Yates - runs once per ~4-5 rounds
- **State updates**: Immutable updates preferred for React-like re-rendering
- **localStorage**: Settings written only on user change (not per round)

**No performance bottlenecks identified** for single-player browser game.
