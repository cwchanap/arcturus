# Tasks: Baccarat Game with LLM Rival

**Input**: Design documents from `/specs/002-baccarat-game/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/game-flow.md, quickstart.md

**Tests**: Unit tests (Bun) and E2E tests (Playwright) are required per Success Criteria SC-007 and SC-008.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- **Source code**: `src/lib/baccarat/` (game logic), `src/pages/games/` (routes)
- **Tests**: Unit tests co-located in `src/lib/baccarat/*.test.ts`, E2E in `e2e/`
- **Components**: Reuse existing `src/components/` (PlayingCard, PokerChip, GameCard)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and module structure

- [x] T001 Create `src/lib/baccarat/` directory structure with index.ts module exports
- [x] T002 [P] Create `src/lib/baccarat/types.ts` with all TypeScript interfaces from data-model.md
- [x] T003 [P] Create `src/lib/baccarat/constants.ts` with game constants (payouts, deck count, thresholds)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before ANY user story can be implemented

**CRITICAL**: No user story work can begin until this phase is complete

- [x] T004 Implement `src/lib/baccarat/DeckManager.ts` with 8-deck shoe creation, shuffle, and deal
- [x] T005 [P] Write unit tests for DeckManager in `src/lib/baccarat/DeckManager.test.ts`
- [x] T006 Implement `src/lib/baccarat/handEvaluator.ts` with getHandValue, isNatural, isPair functions
- [x] T007 [P] Write unit tests for handEvaluator (getHandValue, isNatural, isPair) in `src/lib/baccarat/handEvaluator.test.ts`
- [x] T008 Implement `src/lib/baccarat/thirdCardRules.ts` with shouldPlayerDraw, shouldBankerDraw functions
- [x] T009 [P] Write unit tests for thirdCardRules in `src/lib/baccarat/thirdCardRules.test.ts`
- [x] T010 Implement `src/lib/baccarat/payoutCalculator.ts` with calculatePayout, calculateTotalPayout functions
- [x] T011 [P] Write unit tests for payoutCalculator in `src/lib/baccarat/payoutCalculator.test.ts`

**Checkpoint**: Foundation ready - all pure game logic functions tested and working

---

## Phase 3: User Story 1 - Play Basic Baccarat Round (Priority: P1) MVP

**Goal**: Enable players to complete a full Baccarat round with Player/Banker/Tie bets and standard third-card rules

**Independent Test**: Place a bet on Player/Banker/Tie, click "Deal", watch cards dealt with correct third-card logic, see round outcome with correct payouts

### Unit Tests for User Story 1

- [x] T012 [P] [US1] Write unit tests for BaccaratGame class (state machine, bet placement, deal flow) in `src/lib/baccarat/BaccaratGame.test.ts`

### Implementation for User Story 1

- [x] T013 [US1] Implement `src/lib/baccarat/BaccaratGame.ts` with state machine (betting, dealing, playerThird, bankerThird, resolution phases)
- [x] T014 [US1] Add bet placement methods (placeBet, removeBet, clearBets) to BaccaratGame with validation
- [x] T015 [US1] Add deal() method with card dealing, natural detection, and third-card logic to BaccaratGame
- [x] T016 [US1] Add round resolution and payout processing to BaccaratGame
- [x] T017 [US1] Implement `src/lib/baccarat/BaccaratUIRenderer.ts` for UI state rendering and card animations
- [x] T018 [US1] Implement `src/lib/baccarat/baccaratClient.ts` client-side game orchestration class
- [x] T019 [US1] Create `src/pages/games/baccarat.astro` game page with CasinoLayout and auth check
- [x] T020 [US1] Build betting UI section (Player/Banker/Tie bet areas with chip selection) in baccarat.astro
- [x] T021 [US1] Build card display areas (Player hand, Banker hand) with PlayingCard components in baccarat.astro
- [x] T022 [US1] Add Deal button with validation and phase-aware state in baccarat.astro
- [x] T023 [US1] Implement card dealing animations and round result display in baccarat.astro
- [x] T024 [US1] Add chip balance display and sync with server via `/api/profile/update-balance` in baccarat.astro
- [x] T025 [US1] Implement "Insufficient Chips" overlay with "Return to Lobby" button per FR-026

### E2E Test for User Story 1

- [x] T026 [US1] Write E2E test for complete round flow (bet, deal, resolution) in `e2e/baccarat.spec.ts`

**Checkpoint**: User Story 1 complete - players can play basic Baccarat rounds with main bets

---

## Phase 4: User Story 2 - Side Bets (Priority: P2)

**Goal**: Add Player Pair and Banker Pair side bets with 11:1 payouts

**Independent Test**: Place Player Pair or Banker Pair bet before dealing, verify correct 11:1 payout when pair occurs

### Unit Tests for User Story 2

- [x] T027 [P] [US2] Write unit tests for side bet payouts (playerPair, bankerPair) in `src/lib/baccarat/payoutCalculator.test.ts`

### Implementation for User Story 2

- [x] T028 [US2] Add side bet placement support (playerPair, bankerPair) to BaccaratGame
- [x] T029 [US2] Update payout calculation to include pair bet outcomes in BaccaratGame
- [x] T030 [US2] Add Player Pair and Banker Pair betting UI areas in baccarat.astro
- [x] T031 [US2] Display pair indicators when pairs are detected in round result UI

### E2E Test for User Story 2

- [x] T032 [US2] Add E2E test for side bet flow in `e2e/baccarat.spec.ts`

**Checkpoint**: User Story 2 complete - players can place and win side bets

---

## Phase 5: User Story 3 - LLM-Powered Game Assistant (Priority: P3)

**Goal**: Integrate LLM for betting insights and pattern analysis using existing llm-settings infrastructure

**Independent Test**: Configure LLM settings in profile, start Baccarat game, click "Ask AI Rival" to receive betting advice

### Implementation for User Story 3

- [x] T033 [US3] Implement `src/lib/baccarat/llmBaccaratStrategy.ts` adapting existing LLM strategy pattern from poker/blackjack
- [x] T034 [US3] Create system prompt template for Baccarat betting advice in llmBaccaratStrategy.ts
- [x] T035 [US3] Add "Ask AI Rival" button and response display panel in baccarat.astro
- [x] T036 [US3] Implement LLM request handling with loading state and error fallback in baccarat.astro
- [x] T037 [US3] Add LLM configuration overlay prompt when LLM enabled but no API key configured

### Unit Tests for User Story 3

- [x] T038 [P] [US3] Write unit tests for llmBaccaratStrategy context building in `src/lib/baccarat/llmBaccaratStrategy.test.ts`

**Checkpoint**: User Story 3 complete - players can get AI-powered betting insights

---

## Phase 6: User Story 4 - Game History and Statistics (Priority: P4)

**Goal**: Display last 20 rounds in scoreboard with color-coded outcomes and basic win statistics

**Independent Test**: Play multiple rounds, verify scoreboard updates correctly showing P/B/T outcomes with correct colors

### Implementation for User Story 4

- [x] T039 [US4] Add roundHistory tracking (max 20 rounds) to BaccaratGame state
- [x] T040 [US4] Build scoreboard UI component showing colored dots (Player=blue, Banker=red, Tie=green) in baccarat.astro
- [x] T041 [US4] Add win percentage statistics display (Player/Banker/Tie percentages) in baccarat.astro
- [x] T042 [US4] Implement history clear on new session start

**Checkpoint**: User Story 4 complete - players can track patterns and statistics

---

## Phase 7: User Story 5 - Game Settings Customization (Priority: P5)

**Goal**: Allow players to customize starting chips, bet limits, animation speed, and LLM toggle with localStorage persistence

**Independent Test**: Open settings panel, modify values, save, verify settings persist across browser sessions

### Implementation for User Story 5

- [x] T043 [US5] Implement `src/lib/baccarat/GameSettingsManager.ts` with localStorage persistence
- [x] T044 [P] [US5] Write unit tests for GameSettingsManager in `src/lib/baccarat/GameSettingsManager.test.ts`
- [x] T045 [US5] Build settings panel UI with form controls for all settings in baccarat.astro
- [x] T046 [US5] Wire settings panel to GameSettingsManager with save/reset functionality
- [x] T047 [US5] Apply animation speed setting to card dealing animations in BaccaratUIRenderer

**Checkpoint**: User Story 5 complete - players can customize their game experience

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Integration, lobby, and final quality checks

- [x] T048 Add Baccarat game card to games lobby in `src/pages/games/index.astro`
- [x] T049 [P] Update `src/lib/baccarat/index.ts` with complete module exports
- [x] T050 Run all unit tests and ensure 100% pass rate for game logic modules
- [x] T051 [P] Write E2E test for settings persistence in `e2e/baccarat.spec.ts`
- [x] T052 [P] Write E2E test for LLM integration flow in `e2e/baccarat.spec.ts`
- [x] T053 Run full E2E test suite and fix any failures
- [x] T054 Run quickstart.md validation scenarios manually
- [x] T055 Code review for edge cases: tie push, shoe reshuffle, LLM timeout handling, mid-round exit (forfeit bet per research.md)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories
- **User Story 1 (Phase 3)**: Depends on Foundational - delivers MVP
- **User Story 2 (Phase 4)**: Depends on User Story 1 (extends BaccaratGame)
- **User Story 3 (Phase 5)**: Depends on User Story 1 (requires game state)
- **User Story 4 (Phase 6)**: Depends on User Story 1 (requires round completion)
- **User Story 5 (Phase 7)**: Depends on User Story 1 (settings applied to game)
- **Polish (Phase 8)**: Depends on all user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational - No dependencies on other stories
- **User Story 2 (P2)**: Extends US1's BaccaratGame with side bet support
- **User Story 3 (P3)**: Can start after US1 - uses game state for LLM context
- **User Story 4 (P4)**: Can start after US1 - uses roundHistory from game state
- **User Story 5 (P5)**: Can start after US1 - settings apply to game initialization

### Within Each User Story

- Unit tests SHOULD be written first to define expected behavior
- Core game logic before UI implementation
- UI layout before interactive features
- E2E tests after implementation complete

### Parallel Opportunities

**Phase 1 (Setup)**:

```
T002 types.ts || T003 constants.ts
```

**Phase 2 (Foundational)**:

```
T004 DeckManager.ts → T005 DeckManager.test.ts
T006 handEvaluator.ts → T007 handEvaluator.test.ts
T008 thirdCardRules.ts → T009 thirdCardRules.test.ts
T010 payoutCalculator.ts → T011 payoutCalculator.test.ts

After each module complete, tests can run in parallel:
T005 || T007 || T009 || T011
```

**User Stories 3-5 (after US1 complete)**:

```
US3, US4, US5 can be developed in parallel by different team members
```

---

## Parallel Example: Foundational Phase

```bash
# Launch foundational modules in parallel (different files):
Task: "Implement DeckManager in src/lib/baccarat/DeckManager.ts"
Task: "Implement handEvaluator in src/lib/baccarat/handEvaluator.ts"
Task: "Implement thirdCardRules in src/lib/baccarat/thirdCardRules.ts"
Task: "Implement payoutCalculator in src/lib/baccarat/payoutCalculator.ts"

# After modules complete, launch all tests in parallel:
Task: "Write unit tests for DeckManager in src/lib/baccarat/DeckManager.test.ts"
Task: "Write unit tests for handEvaluator in src/lib/baccarat/handEvaluator.test.ts"
Task: "Write unit tests for thirdCardRules in src/lib/baccarat/thirdCardRules.test.ts"
Task: "Write unit tests for payoutCalculator in src/lib/baccarat/payoutCalculator.test.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL - blocks all stories)
3. Complete Phase 3: User Story 1
4. **STOP and VALIDATE**: Test basic Baccarat round end-to-end
5. Deploy/demo if ready - players can play Baccarat with main bets

### Incremental Delivery

1. Complete Setup + Foundational -> Core game logic ready
2. Add User Story 1 -> Test independently -> Deploy (MVP!)
3. Add User Story 2 -> Test side bets -> Deploy
4. Add User Story 3 -> Test LLM integration -> Deploy
5. Add User Story 4 -> Test history tracking -> Deploy
6. Add User Story 5 -> Test settings persistence -> Deploy
7. Each story adds value without breaking previous stories

### Parallel Team Strategy

With multiple developers:

1. Team completes Setup + Foundational together
2. Once Foundational is done:
   - Developer A: User Story 1 (MVP, must complete first)
3. After US1 complete:
   - Developer A: User Story 2 (extends game)
   - Developer B: User Story 3 (LLM integration)
   - Developer C: User Story 4 (history) + User Story 5 (settings)
4. Stories integrate and ship independently

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story should be independently completable and testable
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- Reuse existing components: PlayingCard.astro, PokerChip.astro, CasinoLayout
- Follow existing patterns from src/lib/blackjack/ and src/lib/poker/
