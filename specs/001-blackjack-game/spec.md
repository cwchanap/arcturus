# Feature Specification: Blackjack Game with LLM Rival

**Feature Branch**: `001-blackjack-game`  
**Created**: November 23, 2025  
**Status**: Draft  
**Input**: User description: "Build the black jack game. Support LLM rival similar to existing texas poker game."

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Play Basic Blackjack Round (Priority: P1)

An authenticated player wants to play a single round of Blackjack against the dealer, placing bets and making standard gameplay decisions (Hit, Stand) to try to beat the dealer without busting.

**Why this priority**: This is the core gameplay loop that defines Blackjack. Without this, the feature provides no value.

**Independent Test**: Can be fully tested by placing a bet, receiving initial cards, making Hit/Stand decisions, and seeing the round outcome. Delivers a complete playable Blackjack experience.

**Acceptance Scenarios**:

1. **Given** player is authenticated with sufficient chips, **When** player places a minimum bet and clicks "Deal", **Then** player receives 2 face-up cards, dealer receives 1 face-up and 1 face-down card
2. **Given** player has cards totaling less than 21, **When** player clicks "Hit", **Then** player receives one additional card and hand total updates
3. **Given** player has cards totaling more than 21, **When** player's turn ends, **Then** player sees "BUST" message and loses their bet
4. **Given** player clicks "Stand", **When** dealer reveals their hidden card, **Then** dealer draws cards according to standard rules (hits on 16 or less, stands on 17+)
5. **Given** both player and dealer have final hands, **When** round ends, **Then** winner is determined and chips are awarded/deducted accordingly
6. **Given** player has Ace + 10-value card as initial hand, **When** cards are dealt, **Then** player is notified of "Blackjack" and wins 1.5x bet (unless dealer also has Blackjack)

---

### User Story 2 - Advanced Blackjack Actions (Priority: P2)

An experienced player wants to use advanced Blackjack strategies including Double Down and Split to maximize their winning potential in advantageous situations.

**Why this priority**: These actions are expected features in authentic Blackjack that significantly impact strategy and player engagement. They're not required for basic playability but are important for player satisfaction.

**Independent Test**: Can be tested by creating specific card scenarios (e.g., pair of 8s for split, hand total of 11 for double down) and verifying the actions are available and execute correctly.

**Acceptance Scenarios**:

1. **Given** player has initial hand totaling 9, 10, or 11, **When** player views available actions, **Then** "Double Down" button is enabled
2. **Given** player clicks "Double Down", **When** action executes, **Then** bet is doubled, player receives exactly one more card, and turn automatically ends
3. **Given** player has two cards of the same rank (e.g., two 8s), **When** player views available actions, **Then** "Split" button is enabled (if player has chips for second bet)
4. **Given** player clicks "Split", **When** action executes, **Then** hand splits into two separate hands, each with one original card, and player plays each hand independently
5. **Given** player has insufficient chips for double down or split, **When** player views actions, **Then** these buttons are disabled with tooltip explaining chip requirement

---

### User Story 3 - LLM-Powered Dealer Assistant (Priority: P3)

A player wants intelligent, natural-language advice from an AI rival during gameplay to help them make better decisions, with the AI personality providing contextual suggestions based on game state.

**Why this priority**: This differentiates the Blackjack experience and leverages the existing LLM infrastructure from poker. It's a value-add feature but not required for core gameplay.

**Independent Test**: Can be tested by configuring LLM settings in profile, starting a Blackjack game, and clicking "Ask AI Rival" during player's turn to receive contextual advice.

**Acceptance Scenarios**:

1. **Given** player has configured valid LLM API key in profile settings, **When** player starts Blackjack game, **Then** "Ask AI Rival" button is enabled
2. **Given** player's turn is active, **When** player clicks "Ask AI Rival", **Then** AI analyzes current hand, dealer's visible card, and provides strategic advice (e.g., "I'd hit here - dealer shows a strong 10")
3. **Given** player has not configured LLM settings, **When** player enables LLM option in game settings, **Then** overlay appears prompting user to configure API key
4. **Given** AI is providing advice, **When** game state changes (new card drawn), **Then** subsequent AI advice adapts to the new situation
5. **Given** player is using LLM rival, **When** round ends, **Then** AI provides brief commentary on the outcome (e.g., "Nice stand - you read the dealer perfectly!")

---

### User Story 4 - Game Settings Customization (Priority: P4)

A player wants to customize their Blackjack experience by adjusting starting chips, minimum/maximum bets, dealer AI speed, and LLM assistant behavior to match their preferred playing style.

**Why this priority**: Customization improves player retention and satisfaction but isn't required for initial playability. Can be added after core mechanics are validated.

**Independent Test**: Can be tested by opening game settings panel, modifying various settings, saving changes, and starting a new round to verify settings apply correctly.

**Acceptance Scenarios**:

1. **Given** player is on Blackjack game page, **When** player clicks "Configure Settings" button, **Then** settings panel expands showing all configurable options
2. **Given** settings panel is open, **When** player modifies starting chips, **Then** next new round starts with the specified chip amount
3. **Given** settings panel is open, **When** player adjusts dealer AI speed slider, **Then** dealer's card-drawing animation speed changes accordingly in next round
4. **Given** settings panel is open, **When** player toggles "Use LLM-Powered AI Assistant" checkbox, **Then** feature is enabled/disabled for subsequent rounds
5. **Given** player has modified settings, **When** player clicks "Reset", **Then** all settings revert to defaults
6. **Given** player saves custom settings, **When** player returns to game later, **Then** previously saved settings are retained

---

### Edge Cases

- What happens when player's chip balance reaches zero mid-round?
- How does system handle dealer Blackjack with player also having Blackjack (push/tie)?
- What happens when player attempts to split Aces - are they dealt only one card per split ace (standard rule)?
- How does system handle multiple splits (can player split again if they receive another matching card)?
- What happens when LLM API call fails or times out during "Ask AI Rival"?
- How does system handle invalid bets (below minimum, above maximum, or exceeding chip balance)?
- What happens when player attempts to leave game mid-round with active bet?
- How does system handle card deck reshuffling - when does it occur and is it visible to player?

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: System MUST enforce authenticated user access - redirect unauthenticated users to signin page
- **FR-002**: System MUST integrate with existing chip balance system - deduct/award chips based on bet outcomes
- **FR-003**: System MUST implement standard Blackjack rules: dealer hits on 16 or less, stands on 17+, Blackjack pays 1.5x
- **FR-004**: System MUST validate bets against configurable minimum ($10 default) and maximum ($1000 default) limits
- **FR-005**: System MUST validate player has sufficient chip balance before accepting bets or advanced actions (Double Down, Split)
- **FR-006**: System MUST deal cards from a standard 52-card deck and reshuffle when deck has fewer than 15 cards remaining
- **FR-007**: System MUST calculate hand values correctly: Aces count as 1 or 11 (player's advantage), face cards count as 10
- **FR-008**: System MUST display all player cards face-up and dealer's first card face-up, second card face-down until dealer's turn
- **FR-009**: System MUST prevent player actions when round is not active or it's not player's turn
- **FR-010**: System MUST enable Double Down action only on initial 2-card hand totaling 9, 10, or 11
- **FR-011**: System MUST enable Split action only when initial 2 cards have same rank and player has sufficient chips for second bet
- **FR-012**: System MUST handle split hands independently - player completes first split hand before playing second
- **FR-013**: System MUST integrate with existing LLM settings infrastructure (OpenAI/Gemini API keys from user profile)
- **FR-014**: System MUST provide "Ask AI Rival" feature that analyzes game state and returns strategic advice via LLM
- **FR-015**: System MUST show LLM configuration overlay if LLM feature is enabled but no API key is configured
- **FR-016**: System MUST handle LLM API failures gracefully with user-friendly error messages
- **FR-017**: System MUST persist game settings (starting chips, bet limits, AI speed, LLM toggle) in browser local storage
- **FR-018**: System MUST use CasinoLayout component and existing UI components (PlayingCard, PokerChip) for consistency
- **FR-019**: System MUST follow modular architecture pattern: game logic in `src/lib/blackjack/` with pure functions for testability
- **FR-020**: System MUST add Blackjack game card to games lobby index page with appropriate icon and description

### Key Entities _(include if feature involves data)_

- **BlackjackGame**: Represents a single Blackjack game session, including player hand, dealer hand, current bet, deck state, and round phase (betting, player turn, dealer turn, complete)
- **Hand**: Represents a collection of cards held by player or dealer, with calculated total value (handling Ace soft/hard totals), bust status, and Blackjack status
- **Card**: Standard playing card with rank (A, 2-10, J, Q, K) and suit (hearts, diamonds, clubs, spades), with value calculation based on Blackjack rules
- **DeckManager**: Manages card deck state including shuffle, deal, and remaining cards tracking for reshuffle triggers
- **BlackjackSettings**: User-configurable game parameters including starting chips, minimum/maximum bets, dealer AI speed, and LLM assistant toggle
- **LLMBlackjackStrategy**: LLM integration module that analyzes game state (player hand, dealer visible card, available actions) and generates strategic advice using configured AI provider

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: Players can complete a full Blackjack round (bet, deal, play, resolution) in under 60 seconds with basic actions
- **SC-002**: Game correctly determines winners in 100% of test scenarios covering all hand combinations (player win, dealer win, push, bust, Blackjack)
- **SC-003**: LLM AI Rival provides contextually relevant advice within 3 seconds of request 95% of the time (when API is responsive)
- **SC-004**: Advanced actions (Double Down, Split) are enabled/disabled correctly based on game state in 100% of scenarios
- **SC-005**: Game handles edge cases (insufficient chips, API failures, deck reshuffle) without crashes or undefined states
- **SC-006**: UI components reuse existing casino theme styling and maintain visual consistency with poker game
- **SC-007**: Unit test coverage for game logic modules (hand evaluation, deck management, bet validation) reaches at least 85%
- **SC-008**: E2E tests verify complete user flows for basic gameplay, advanced actions, and LLM integration
- **SC-009**: Game settings persist correctly across browser sessions and apply to new rounds immediately after saving
- **SC-010**: Players can navigate to Blackjack from games lobby and return seamlessly without losing chip balance state
