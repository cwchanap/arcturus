# Data Model: Baccarat Game

**Feature**: 002-baccarat-game | **Date**: 2025-12-06

## Overview

This document defines the TypeScript interfaces and types for the Baccarat game implementation. All entities are client-side only (no new database tables required).

---

## Core Types

### Card

```typescript
interface Card {
	rank: Rank;
	suit: Suit;
}

type Rank = 'A' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K';
type Suit = 'hearts' | 'diamonds' | 'clubs' | 'spades';
```

**Value Calculation**:

- `A` = 1
- `2-9` = face value
- `10`, `J`, `Q`, `K` = 0

---

### Hand

```typescript
interface Hand {
	cards: Card[];
}
```

**Computed Properties** (via pure functions):

- `getValue(hand: Hand): number` - Returns last digit of card sum (0-9)
- `isNatural(hand: Hand): boolean` - Returns true if initial 2 cards total 8 or 9
- `isPair(hand: Hand): boolean` - Returns true if first 2 cards have matching rank

---

### Bet

```typescript
interface Bet {
	type: BetType;
	amount: number;
}

type BetType = 'player' | 'banker' | 'tie' | 'playerPair' | 'bankerPair';
```

**Payout Multipliers** (constants):
| BetType | Multiplier | Note |
|---------|------------|------|
| `player` | 1.0 | 1:1 |
| `banker` | 0.95 | 1:1 minus 5% commission |
| `tie` | 8.0 | 8:1 |
| `playerPair` | 11.0 | 11:1 |
| `bankerPair` | 11.0 | 11:1 |

---

### BetResult

```typescript
interface BetResult {
	bet: Bet;
	outcome: 'win' | 'lose' | 'push';
	payout: number; // Amount won (positive) or lost (negative)
}
```

---

### RoundOutcome

```typescript
interface RoundOutcome {
	winner: 'player' | 'banker' | 'tie';
	playerHand: Hand;
	bankerHand: Hand;
	playerValue: number;
	bankerValue: number;
	playerPair: boolean;
	bankerPair: boolean;
	isNatural: boolean;
	betResults: BetResult[];
	timestamp: number;
}
```

---

### GamePhase

```typescript
type GamePhase =
	| 'betting' // Accepting bets
	| 'dealing' // Initial 4 cards being dealt
	| 'playerThird' // Player third card (if applicable)
	| 'bankerThird' // Banker third card (if applicable)
	| 'resolution'; // Determining winner, processing payouts
```

---

### BaccaratGameState

```typescript
interface BaccaratGameState {
	phase: GamePhase;
	playerHand: Hand;
	bankerHand: Hand;
	activeBets: Bet[];
	chipBalance: number;
	roundHistory: RoundOutcome[]; // Last 20 rounds
	shoeCardsRemaining: number;
	settings: BaccaratSettings;
}
```

---

### BaccaratSettings

```typescript
interface BaccaratSettings {
	startingChips: number; // Default: 1000
	minBet: number; // Default: 10
	maxBet: number; // Default: 5000
	animationSpeed: AnimationSpeed;
	llmEnabled: boolean;
	soundEnabled: boolean;
}

type AnimationSpeed = 'slow' | 'normal' | 'fast';
```

**Storage**: Browser localStorage with key `baccarat-settings`

---

### DeckState

```typescript
interface DeckState {
	cards: Card[];
	deckCount: number; // 8 for baccarat
	reshuffleThreshold: number; // 20
}
```

---

### LLMBaccaratContext

```typescript
interface LLMBaccaratContext {
	roundHistory: RoundOutcome[];
	currentBets: Bet[];
	chipBalance: number;
	shoeCardsRemaining: number;
	query?: string; // Optional user question
}

interface LLMBaccaratResponse {
	advice: string;
	confidence?: 'low' | 'medium' | 'high';
	suggestedBets?: BetType[];
}
```

---

## Entity Relationships

```
BaccaratGameState
├── playerHand: Hand
│   └── cards: Card[]
├── bankerHand: Hand
│   └── cards: Card[]
├── activeBets: Bet[]
├── roundHistory: RoundOutcome[]
│   ├── playerHand: Hand
│   ├── bankerHand: Hand
│   └── betResults: BetResult[]
│       └── bet: Bet
└── settings: BaccaratSettings
```

---

## Validation Rules

### Bet Validation

1. `amount >= settings.minBet`
2. `amount <= settings.maxBet`
3. `totalBets <= chipBalance`
4. `phase === 'betting'`
5. Same bet type cannot be placed twice (update amount instead)

### Hand Validation

1. Hand must have 2-3 cards
2. Cards must be valid (rank + suit combinations)

### State Transitions

1. `betting` → `dealing`: At least one bet placed
2. `dealing` → `playerThird` | `resolution`: Based on hand values
3. `playerThird` → `bankerThird` | `resolution`: Based on rules
4. `bankerThird` → `resolution`: Always
5. `resolution` → `betting`: After payout processing

---

## Database Integration (Existing Tables)

**No new tables required.** Uses existing:

### `user` table

- `chipBalance`: Updated on round resolution via existing API

### `llm_settings` table

- Accessed for LLM configuration (API keys, model selection)
- Read-only from game perspective

---

## Constants

```typescript
const BACCARAT_CONSTANTS = {
	DECK_COUNT: 8,
	RESHUFFLE_THRESHOLD: 20,
	DEFAULT_MIN_BET: 10,
	DEFAULT_MAX_BET: 5000,
	DEFAULT_STARTING_CHIPS: 1000,
	MAX_HISTORY_LENGTH: 20,

	PAYOUTS: {
		player: 1.0,
		banker: 0.95,
		tie: 8.0,
		playerPair: 11.0,
		bankerPair: 11.0,
	},

	CARD_VALUES: {
		A: 1,
		'2': 2,
		'3': 3,
		'4': 4,
		'5': 5,
		'6': 6,
		'7': 7,
		'8': 8,
		'9': 9,
		'10': 0,
		J: 0,
		Q: 0,
		K: 0,
	},
} as const;
```
