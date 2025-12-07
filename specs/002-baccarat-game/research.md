# Research: Baccarat Game Implementation

**Feature**: 002-baccarat-game | **Date**: 2025-12-06

## Overview

Research findings for implementing Punto Banco Baccarat, the most common casino variant. All rules and patterns documented here inform the implementation design.

---

## 1. Punto Banco Rules (Standard Casino Baccarat)

### Decision: Use Standard Punto Banco Rules

**Rationale**: Most widely played variant in casinos worldwide. Fixed drawing rules (no player decisions on third card), making it ideal for automated implementation.
**Alternatives Considered**: Chemin de Fer (player decisions), Baccarat Banque (more complex) - rejected as less common and more complex.

### Hand Value Calculation

- Cards 2-9: Face value
- 10, J, Q, K: Value 0
- Ace: Value 1
- Hand total = last digit of sum (e.g., 7 + 8 = 15 → value 5)

### Natural Win

- Either hand totals 8 or 9 on initial two cards
- Round ends immediately, no third cards drawn

### Player Third-Card Rule

| Player Total | Action          |
| ------------ | --------------- |
| 0-5          | Draw            |
| 6-7          | Stand           |
| 8-9          | Natural (stand) |

### Banker Third-Card Rule

Banker draws based on their total AND Player's third card value:

| Banker Total | Player 3rd Card Value | Action          |
| ------------ | --------------------- | --------------- |
| 0-2          | Any                   | Draw            |
| 3            | 0-7, 9                | Draw            |
| 3            | 8                     | Stand           |
| 4            | 2-7                   | Draw            |
| 4            | 0, 1, 8, 9            | Stand           |
| 5            | 4-7                   | Draw            |
| 5            | 0-3, 8, 9             | Stand           |
| 6            | 6-7                   | Draw            |
| 6            | 0-5, 8, 9             | Stand           |
| 7            | Any                   | Stand           |
| 8-9          | Any                   | Natural (stand) |

**If Player stands (6-7)**: Banker draws on 0-5, stands on 6-7.

---

## 2. Payout Structure

### Decision: Standard Casino Payouts

**Rationale**: Industry standard payouts ensure realistic gameplay and proper house edge simulation.

| Bet Type    | Payout                 | House Edge |
| ----------- | ---------------------- | ---------- |
| Player      | 1:1                    | 1.24%      |
| Banker      | 0.95:1 (5% commission) | 1.06%      |
| Tie         | 8:1                    | 14.36%     |
| Player Pair | 11:1                   | 11.25%     |
| Banker Pair | 11:1                   | 11.25%     |

### Commission Handling

**Decision**: Deduct 5% commission from Banker winnings at payout time (not accumulated).
**Rationale**: Simpler implementation, matches spec clarification. Commission-free variants exist but add complexity.

---

## 3. Shoe Management

### Decision: 8-Deck Shoe with 20-Card Reshuffle Threshold

**Rationale**: Standard casino practice (6-8 decks typical). 20-card threshold prevents running out mid-round.

- Total cards: 8 × 52 = 416 cards
- Reshuffle trigger: < 20 cards remaining
- Maximum cards per round: 6 (2 per hand + 2 possible third cards)

### Implementation Pattern

Reuse existing `DeckManager` pattern from blackjack with modifications:

- Constructor accepts deck count parameter
- Track remaining cards
- Reshuffle when threshold reached (between rounds only)

---

## 4. Architecture Patterns

### Decision: Follow Existing Game Module Pattern

**Rationale**: Consistency with poker/blackjack, proven testable architecture.

**Reference Implementation** (blackjack):

```
src/lib/blackjack/
├── BlackjackGame.ts       → BaccaratGame.ts
├── DeckManager.ts         → DeckManager.ts (8-deck variant)
├── handEvaluator.ts       → handEvaluator.ts (baccarat rules)
├── dealerStrategy.ts      → thirdCardRules.ts (drawing rules)
├── GameSettingsManager.ts → GameSettingsManager.ts
├── BlackjackUIRenderer.ts → BaccaratUIRenderer.ts
├── llmBlackjackStrategy.ts → llmBaccaratStrategy.ts
├── types.ts               → types.ts
├── constants.ts           → constants.ts
└── index.ts               → index.ts
```

### State Machine

```
BETTING → DEALING → PLAYER_THIRD → BANKER_THIRD → RESOLUTION → BETTING
           ↓ (natural)                              ↑
           └──────────────────────────────────────┘
```

---

## 5. UI/UX Patterns

### Decision: Reuse Existing Casino Components

**Rationale**: Visual consistency, reduced development time.

**Components to Reuse**:

- `PlayingCard.astro` - Card rendering
- `PokerChip.astro` - Bet visualization
- `GameCard.astro` - Game selection card
- `casino.astro` layout - Page structure

**New UI Elements**:

- Betting area with Player/Banker/Tie zones
- Side bet buttons (Player Pair, Banker Pair)
- Scoreboard (last 20 rounds)
- Hand display areas (Player/Banker)

### Layout Reference

Standard baccarat table layout:

```
┌─────────────────────────────────────────┐
│           BANKER HAND                    │
│           [Card][Card][Card?]            │
├─────────────────────────────────────────┤
│           PLAYER HAND                    │
│           [Card][Card][Card?]            │
├───────┬───────────┬───────────┬─────────┤
│P.PAIR │  PLAYER   │   TIE     │ B.PAIR  │
│ (11:1)│   (1:1)   │  (8:1)   │ (11:1)  │
├───────┴───────────┴───────────┴─────────┤
│             BANKER (0.95:1)              │
├─────────────────────────────────────────┤
│ Scoreboard │ Chips │ Settings │ AI Rival│
└─────────────────────────────────────────┘
```

---

## 6. LLM Integration

### Decision: Adapt Existing LLM Strategy Pattern

**Rationale**: Reuse proven infrastructure from poker/blackjack.

**Insights to Provide**:

- Betting odds analysis based on historical data
- Pattern commentary (streaks, chops)
- Side bet risk assessment
- General strategic guidance (avoid tie bets, house edge info)

**Prompt Template Structure**:

```
System: You are a Baccarat strategy advisor...
Context: Last 20 rounds: [P, B, T, P, B, B, ...]
Current shoe: X cards remaining
Player's bets: [list]
Question: [user query or general advice request]
```

---

## 7. Settings Persistence

### Decision: Browser Local Storage (Same as Blackjack)

**Rationale**: No server-side storage needed for game preferences. Matches existing pattern.

**Settings Schema**:

```typescript
interface BaccaratSettings {
	startingChips: number; // Default: 1000
	minBet: number; // Default: 10
	maxBet: number; // Default: 5000
	animationSpeed: 'slow' | 'normal' | 'fast';
	llmEnabled: boolean;
	soundEnabled: boolean;
}
```

---

## 8. Edge Cases

### Tie Outcome with Player/Banker Bets

**Decision**: Push (bets returned) per standard rules.
**Implementation**: Check for tie before processing Player/Banker bet outcomes.

### LLM API Failure

**Decision**: Show user-friendly error, allow gameplay to continue without AI.
**Implementation**: Try-catch with fallback message, don't block game flow.

### Mid-Round Exit

**Decision**: Allow exit, current bet is forfeit (no persistence of mid-round state).
**Rationale**: Simplifies implementation; matches typical casino behavior.

### Insufficient Chips

**Decision**: Display "Insufficient Chips" message with manual "Return to Lobby" button (per spec clarification).
**Implementation**: Check balance before accepting new bets, show overlay when balance < minBet.

---

## Summary

All technical decisions align with:

- Standard Punto Banco Baccarat rules
- Existing Arcturus architecture patterns
- Constitution requirements (edge-first, modular, tested)

No outstanding clarifications needed. Ready for Phase 1 design.
