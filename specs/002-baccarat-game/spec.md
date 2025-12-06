# Feature Specification: Baccarat Game with LLM Rival

**Feature Branch**: `002-baccarat-game`  
**Created**: December 5, 2025  
**Status**: Draft  
**Input**: User description: "Implement Baccarat game, follow similar pattern with existing blackjack and poker"

## Clarifications

### Session 2025-12-05

- Q: When a player bets on Banker and wins, how should the 5% commission be collected? → A: Banker commission is deducted from winnings at payout time (player receives 0.95:1)
- Q: For Player Pair and Banker Pair side bets, what constitutes a "pair" when the first two cards are dealt? → A: Same rank only (e.g., 7♠ + 7♥ is a pair, suit doesn't matter)
- Q: Should the system allow a player to place bets on both Player and Banker in the same round? → A: Allow it (player can hedge bets; both are evaluated independently)
- Q: What should happen when a player's chip balance reaches zero during a Baccarat session? → A: Show "Insufficient Chips" message with button to return to lobby (no automatic redirect)
- Q: How should the system respond when a player attempts to place an invalid bet (below minimum, above maximum, or exceeding chip balance)? → A: Disable "Deal" button and show inline error message near bet controls until corrected

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Play Basic Baccarat Round (Priority: P1)

An authenticated player wants to play a single round of Baccarat, placing bets on Player, Banker, or Tie and watching the cards dealt to determine the winner based on standard Baccarat rules.

**Why this priority**: This is the core gameplay loop that defines Baccarat. Without this, the feature provides no value.

**Independent Test**: Can be fully tested by placing a bet on any outcome, clicking "Deal", watching cards dealt to Player and Banker hands, and seeing the round outcome with correct payouts. Delivers a complete playable Baccarat experience.

**Acceptance Scenarios**:

1. **Given** player is authenticated with sufficient chips, **When** player places a bet on "Player", "Banker", or "Tie" and clicks "Deal", **Then** two cards are dealt to both Player and Banker hands face-up
2. **Given** cards are dealt, **When** either hand totals 8 or 9 (natural), **Then** round ends immediately without drawing additional cards
3. **Given** Player hand totals 0-5 and no natural occurred, **When** third card rules apply, **Then** Player draws one additional card
4. **Given** Player stands (6-7) or drew third card, **When** Banker draws according to standard third-card rules, **Then** Banker's draw decision is correctly determined
5. **Given** both hands are final, **When** round ends, **Then** hand closest to 9 wins, and chips are awarded/deducted accordingly (Player bet pays 1:1, Banker bet pays 0.95:1, Tie pays 8:1)
6. **Given** Player and Banker hands have equal totals, **When** round ends, **Then** Tie bets win, Player/Banker bets push (returned to player)

---

### User Story 2 - Side Bets (Priority: P2)

An experienced player wants to place optional side bets (Player Pair, Banker Pair) to add excitement and increase potential winnings when specific outcomes occur.

**Why this priority**: Side bets are expected features in authentic Baccarat that significantly impact player engagement and house revenue. They're not required for basic playability but are important for player satisfaction.

**Independent Test**: Can be tested by placing a side bet on Player Pair or Banker Pair before dealing, and verifying the correct payout (11:1) when the first two cards form a pair.

**Acceptance Scenarios**:

1. **Given** player is on betting phase, **When** player views betting options, **Then** "Player Pair" and "Banker Pair" side bet options are visible
2. **Given** player places "Player Pair" bet, **When** Player's first two cards are the same rank (suit irrelevant), **Then** player wins 11:1 on the side bet
3. **Given** player places "Banker Pair" bet, **When** Banker's first two cards are the same rank (suit irrelevant), **Then** player wins 11:1 on the side bet
4. **Given** player has insufficient chips for all placed bets, **When** bet validation runs, **Then** "Deal" button is disabled and inline error message displays near bet controls
5. **Given** side bet is placed, **When** pair does not occur, **Then** side bet is lost but main bet continues normally

---

### User Story 3 - LLM-Powered Game Assistant (Priority: P3)

A player wants intelligent, natural-language insights from an AI assistant during gameplay to understand betting trends, odds, and strategic suggestions based on recent game history.

**Why this priority**: This differentiates the Baccarat experience and leverages the existing LLM infrastructure from poker and blackjack. It's a value-add feature but not required for core gameplay.

**Independent Test**: Can be tested by configuring LLM settings in profile, starting a Baccarat game, and clicking "Ask AI Rival" during betting phase to receive betting insights and odds analysis.

**Acceptance Scenarios**:

1. **Given** player has configured valid LLM API key in profile settings, **When** player starts Baccarat game, **Then** "Ask AI Rival" button is enabled
2. **Given** player is in betting phase, **When** player clicks "Ask AI Rival", **Then** AI analyzes recent round history and provides betting suggestions with odds commentary
3. **Given** player has not configured LLM settings, **When** player enables LLM option in game settings, **Then** overlay appears prompting user to configure API key
4. **Given** round completes, **When** AI is enabled, **Then** AI provides brief commentary on the outcome and any notable patterns
5. **Given** player has placed side bets, **When** asking AI for advice, **Then** AI includes side bet odds and recommendations in response

---

### User Story 4 - Game History and Statistics (Priority: P4)

A player wants to view a history of recent rounds showing winning hands and track patterns (Player wins, Banker wins, Ties) to inform their betting strategy.

**Why this priority**: Pattern tracking is a key aspect of Baccarat culture and player engagement. It improves player retention but isn't required for initial playability.

**Independent Test**: Can be tested by playing multiple rounds and verifying the history panel updates correctly, showing accurate win/loss patterns.

**Acceptance Scenarios**:

1. **Given** player is on Baccarat game page, **When** player views the scoreboard area, **Then** last 20 rounds are displayed as colored dots/symbols (Player=blue, Banker=red, Tie=green)
2. **Given** a round completes, **When** history updates, **Then** new result appears in the scoreboard with correct indicator
3. **Given** player views statistics panel, **When** data is available, **Then** win percentages for Player, Banker, and Tie are displayed
4. **Given** player starts a new session, **When** previous session had history, **Then** history is cleared for fresh session

---

### User Story 5 - Game Settings Customization (Priority: P5)

A player wants to customize their Baccarat experience by adjusting starting chips, minimum/maximum bets, animation speed, and LLM assistant behavior to match their preferred playing style.

**Why this priority**: Customization improves player retention and satisfaction but isn't required for initial playability. Can be added after core mechanics are validated.

**Independent Test**: Can be tested by opening game settings panel, modifying various settings, saving changes, and starting a new round to verify settings apply correctly.

**Acceptance Scenarios**:

1. **Given** player is on Baccarat game page, **When** player clicks "Configure Settings" button, **Then** settings panel expands showing all configurable options
2. **Given** settings panel is open, **When** player modifies starting chips, **Then** next new session starts with the specified chip amount
3. **Given** settings panel is open, **When** player adjusts dealing animation speed slider, **Then** card dealing animation speed changes accordingly
4. **Given** settings panel is open, **When** player toggles "Use LLM-Powered AI Assistant" checkbox, **Then** feature is enabled/disabled for subsequent rounds
5. **Given** player saves custom settings, **When** player returns to game later, **Then** previously saved settings are retained

---

### Edge Cases

- How does system handle tie outcomes with active Player/Banker bets (push)?
- What happens when LLM API call fails or times out during "Ask AI Rival"?
- What happens when player attempts to leave game mid-round with active bet?
- How does system handle card deck reshuffling - when does it occur and is it visible to player (standard 8-deck shoe)?

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: System MUST enforce authenticated user access - redirect unauthenticated users to signin page
- **FR-002**: System MUST integrate with existing chip balance system - deduct/award chips based on bet outcomes
- **FR-003**: System MUST implement standard Punto Banco Baccarat rules for drawing third cards
- **FR-004**: System MUST calculate hand values correctly: cards 2-9 are face value, 10/J/Q/K are 0, Ace is 1, total is last digit of sum
- **FR-005**: System MUST validate bets against configurable minimum ($10 default) and maximum ($5000 default) limits
- **FR-006**: System MUST validate player has sufficient chip balance before accepting bets
- **FR-007**: System MUST deal cards from an 8-deck shoe and reshuffle when fewer than 20 cards remain
- **FR-008**: System MUST display all cards face-up for both Player and Banker hands
- **FR-009**: System MUST pay winning bets correctly: Player 1:1, Banker 0.95:1 (5% commission deducted from winnings at payout), Tie 8:1, Pair bets 11:1
- **FR-010**: System MUST return Player/Banker bets as push when Tie occurs
- **FR-011**: System MUST detect and announce "Natural" when either hand totals 8 or 9 on initial deal
- **FR-012**: System MUST apply Player third-card rule: draw on 0-5, stand on 6-7
- **FR-013**: System MUST apply Banker third-card rules based on Banker total and Player's third card value
- **FR-014**: System MUST integrate with existing LLM settings infrastructure (OpenAI/Gemini API keys from user profile)
- **FR-015**: System MUST provide "Ask AI Rival" feature that analyzes betting odds and provides strategic insights via LLM
- **FR-016**: System MUST show LLM configuration overlay if LLM feature is enabled but no API key is configured
- **FR-017**: System MUST handle LLM API failures gracefully with user-friendly error messages
- **FR-018**: System MUST persist game settings (starting chips, bet limits, animation speed, LLM toggle) in browser local storage
- **FR-019**: System MUST maintain and display a history of the last 20 rounds with outcomes
- **FR-020**: System MUST use CasinoLayout component and existing UI components (PlayingCard, PokerChip) for consistency
- **FR-021**: System MUST follow modular architecture pattern: game logic in `src/lib/baccarat/` with pure functions for testability
- **FR-022**: System MUST add Baccarat game card to games lobby index page with appropriate icon and description
- **FR-023**: System MUST allow multiple bet types per round (main bet + side bets)
- **FR-024**: System MUST allow player to place bets on both Player and Banker simultaneously (hedging allowed; bets evaluated independently)
- **FR-025**: System MUST prevent placing bets after cards have been dealt
- **FR-026**: System MUST display "Insufficient Chips" message with manual "Return to Lobby" button when player's chip balance reaches zero (no automatic redirect)
- **FR-027**: System MUST disable "Deal" button and display inline error message near bet controls when bet is invalid (below minimum, above maximum, or exceeds chip balance) until player corrects the bet

### Key Entities _(include if feature involves data)_

- **BaccaratGame**: Represents a single Baccarat game session, including Player hand, Banker hand, active bets, shoe state, round phase (betting, dealing, complete), and round history
- **Hand**: Represents a collection of cards held by Player or Banker, with calculated total value (last digit of sum), natural status (8 or 9 on initial deal), and pair status (first two cards have matching rank regardless of suit)
- **Card**: Standard playing card with rank (A, 2-10, J, Q, K) and suit (hearts, diamonds, clubs, spades), with value calculation based on Baccarat rules
- **DeckManager**: Manages 8-deck shoe state including shuffle, deal, and remaining cards tracking for reshuffle triggers
- **Bet**: Represents a single bet with type (Player, Banker, Tie, PlayerPair, BankerPair), amount, and potential payout multiplier
- **BaccaratSettings**: User-configurable game parameters including starting chips, minimum/maximum bets, animation speed, and LLM assistant toggle
- **LLMBaccaratStrategy**: LLM integration module that analyzes game state (round history, current bets, odds) and generates betting insights using configured AI provider
- **RoundHistory**: Collection of recent round outcomes for scoreboard display and pattern analysis

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: Players can complete a full Baccarat round (bet, deal, resolution) in under 30 seconds with standard animations
- **SC-002**: Game correctly determines winners and applies third-card rules in 100% of test scenarios covering all hand combinations
- **SC-003**: LLM AI assistant provides contextually relevant betting insights within 3 seconds of request 95% of the time (when API is responsive)
- **SC-004**: Payouts are calculated correctly (including Banker 5% commission) in 100% of winning scenarios
- **SC-005**: Game handles edge cases (insufficient chips, API failures, shoe reshuffle) without crashes or undefined states
- **SC-006**: UI components reuse existing casino theme styling and maintain visual consistency with poker and blackjack games
- **SC-007**: Unit test coverage for game logic modules (hand evaluation, third-card rules, payout calculation) reaches at least 85%
- **SC-008**: E2E tests verify complete user flows for basic gameplay, side bets, and LLM integration
- **SC-009**: Game settings persist correctly across browser sessions and apply to new rounds immediately after saving
- **SC-010**: Players can navigate to Baccarat from games lobby and return seamlessly without losing chip balance state
- **SC-011**: Round history accurately tracks and displays last 20 rounds with correct outcome indicators
