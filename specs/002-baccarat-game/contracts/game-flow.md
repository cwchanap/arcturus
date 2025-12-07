# Game Flow Contract: Baccarat

**Feature**: 002-baccarat-game | **Date**: 2025-12-06

## State Machine

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                  │
│    ┌─────────┐     ┌─────────┐     ┌─────────────┐              │
│ ──►│ BETTING │────►│ DEALING │────►│ PLAYER_THIRD│──┐           │
│    └─────────┘     └─────────┘     └─────────────┘  │           │
│         ▲              │                │           │           │
│         │              │ (natural)      │           ▼           │
│         │              │           ┌─────────────┐              │
│         │              └──────────►│ RESOLUTION  │◄─────────────┤
│         │                          └─────────────┘              │
│         │                               │           ▲           │
│         │                               │           │           │
│         └───────────────────────────────┘     ┌─────────────┐   │
│                                               │ BANKER_THIRD│───┘
│                                               └─────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Phase Transitions

### BETTING → DEALING

**Trigger**: `deal()` called
**Preconditions**:

- At least one bet placed
- All bets valid (within limits, sufficient balance)
- Phase is `betting`

**Actions**:

1. Lock all bets
2. Deduct total bet amount from chip balance
3. Check shoe for reshuffle (if < 20 cards, reshuffle first)
4. Deal 4 cards: Player1, Banker1, Player2, Banker2

**Postconditions**:

- Player hand has 2 cards
- Banker hand has 2 cards
- Phase is `dealing`

---

### DEALING → RESOLUTION (Natural)

**Trigger**: Either hand is natural (8 or 9)
**Preconditions**:

- Player or Banker hand value is 8 or 9

**Actions**:

1. Skip third card phases
2. Proceed directly to resolution

---

### DEALING → PLAYER_THIRD

**Trigger**: No natural, Player must draw
**Preconditions**:

- No natural
- Player total is 0-5

**Actions**:

1. Deal one card to Player hand

**Postconditions**:

- Player hand has 3 cards
- Phase is `playerThird`

---

### DEALING → BANKER_THIRD

**Trigger**: No natural, Player stands
**Preconditions**:

- No natural
- Player total is 6-7 (Player stands)
- Banker total is 0-5 (must draw)

**Actions**:

1. Deal one card to Banker hand

---

### PLAYER_THIRD → BANKER_THIRD

**Trigger**: Banker must draw based on third card rules
**Preconditions**:

- Player drew third card
- Banker draws according to third-card table

**Actions**:

1. Evaluate Banker draw decision
2. If draw: Deal one card to Banker hand

---

### PLAYER_THIRD → RESOLUTION

**Trigger**: Banker stands
**Preconditions**:

- Player drew third card
- Banker stands according to third-card table

---

### BANKER_THIRD → RESOLUTION

**Trigger**: Always (after Banker third card dealt)

---

### RESOLUTION → BETTING

**Trigger**: `newRound()` called
**Preconditions**:

- All payouts processed

**Actions**:

1. Compare hand values
2. Determine winner (Player/Banker/Tie)
3. Check pair outcomes
4. Calculate payouts for each bet
5. Update chip balance
6. Add round to history (max 20)
7. Clear hands and bets

**Postconditions**:

- Chip balance updated
- History updated
- Hands cleared
- Bets cleared
- Phase is `betting`

---

## API Contract

### BaccaratGame Class

```typescript
class BaccaratGame {
	// State
	getState(): BaccaratGameState;

	// Betting Phase
	placeBet(type: BetType, amount: number): BetResult | Error;
	removeBet(type: BetType): boolean;
	clearBets(): void;

	// Game Flow
	deal(): void; // BETTING → DEALING
	newRound(): void; // RESOLUTION → BETTING

	// Query
	canDeal(): boolean;
	getBetTotal(): number;
	getWinner(): 'player' | 'banker' | 'tie' | null;

	// Settings
	updateSettings(settings: Partial<BaccaratSettings>): void;
}
```

---

### Pure Functions

```typescript
// Hand Evaluation
function getHandValue(hand: Hand): number;
function isNatural(hand: Hand): boolean;
function isPair(hand: Hand): boolean;

// Third Card Rules
function shouldPlayerDraw(playerValue: number): boolean;
function shouldBankerDraw(
	bankerValue: number,
	playerThirdCard: Card | null,
	playerStood: boolean,
): boolean;

// Payout Calculation
function calculatePayout(bet: Bet, outcome: RoundOutcome): BetResult;
function calculateTotalPayout(bets: Bet[], outcome: RoundOutcome): number;

// Deck Management
function createShoe(deckCount: number): Card[];
function shuffleDeck(cards: Card[]): Card[];
function dealCard(deck: Card[]): [Card, Card[]];
function needsReshuffle(deck: Card[], threshold: number): boolean;
```

---

## Third Card Decision Table

### Player Third Card

```typescript
function shouldPlayerDraw(playerValue: number): boolean {
	// 0-5: Draw
	// 6-7: Stand
	// 8-9: Natural (handled separately)
	return playerValue <= 5;
}
```

### Banker Third Card (Player Drew)

```typescript
function shouldBankerDrawAfterPlayerDrew(
	bankerValue: number,
	playerThirdCardValue: number,
): boolean {
	switch (bankerValue) {
		case 0:
		case 1:
		case 2:
			return true; // Always draw
		case 3:
			return playerThirdCardValue !== 8;
		case 4:
			return playerThirdCardValue >= 2 && playerThirdCardValue <= 7;
		case 5:
			return playerThirdCardValue >= 4 && playerThirdCardValue <= 7;
		case 6:
			return playerThirdCardValue === 6 || playerThirdCardValue === 7;
		case 7:
			return false; // Always stand
		default:
			return false; // 8-9 is natural
	}
}
```

### Banker Third Card (Player Stood)

```typescript
function shouldBankerDrawAfterPlayerStood(bankerValue: number): boolean {
	// Player stood on 6-7, Banker draws on 0-5
	return bankerValue <= 5;
}
```

---

## Payout Logic

```typescript
function calculatePayout(bet: Bet, outcome: RoundOutcome): BetResult {
	const { winner, playerPair, bankerPair } = outcome;

	switch (bet.type) {
		case 'player':
			if (winner === 'player') return { bet, outcome: 'win', payout: bet.amount * 1.0 };
			if (winner === 'tie') return { bet, outcome: 'push', payout: 0 };
			return { bet, outcome: 'lose', payout: -bet.amount };

		case 'banker':
			if (winner === 'banker') return { bet, outcome: 'win', payout: bet.amount * 0.95 };
			if (winner === 'tie') return { bet, outcome: 'push', payout: 0 };
			return { bet, outcome: 'lose', payout: -bet.amount };

		case 'tie':
			if (winner === 'tie') return { bet, outcome: 'win', payout: bet.amount * 8.0 };
			return { bet, outcome: 'lose', payout: -bet.amount };

		case 'playerPair':
			if (playerPair) return { bet, outcome: 'win', payout: bet.amount * 11.0 };
			return { bet, outcome: 'lose', payout: -bet.amount };

		case 'bankerPair':
			if (bankerPair) return { bet, outcome: 'win', payout: bet.amount * 11.0 };
			return { bet, outcome: 'lose', payout: -bet.amount };
	}
}
```

---

## Event Hooks (UI Integration)

```typescript
interface BaccaratGameEvents {
	onBetPlaced: (bet: Bet) => void;
	onBetRemoved: (type: BetType) => void;
	onDealStart: () => void;
	onCardDealt: (card: Card, target: 'player' | 'banker', position: number) => void;
	onNatural: (hand: 'player' | 'banker', value: number) => void;
	onThirdCard: (target: 'player' | 'banker', card: Card) => void;
	onRoundComplete: (outcome: RoundOutcome) => void;
	onBalanceUpdate: (newBalance: number) => void;
	onShoeReshuffle: () => void;
	onError: (error: Error) => void;
}
```

---

## Validation Errors

```typescript
type BaccaratError =
	| { code: 'BET_BELOW_MIN'; min: number; actual: number }
	| { code: 'BET_ABOVE_MAX'; max: number; actual: number }
	| { code: 'INSUFFICIENT_BALANCE'; required: number; available: number }
	| { code: 'INVALID_PHASE'; expected: GamePhase; actual: GamePhase }
	| { code: 'NO_BETS_PLACED' }
	| { code: 'DUPLICATE_BET'; type: BetType };
```
