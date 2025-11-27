# Implementation Tasks: Blackjack Game with LLM Rival

**Feature Branch**: `001-blackjack-game`  
**Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)  
**Status**: Ready for Implementation

## Overview

This document provides actionable, dependency-ordered tasks for implementing the Blackjack game feature. Tasks are organized by user story to enable independent, incremental delivery and testing.

**Implementation Strategy**: Deliver User Story 1 (P1) as MVP, then incrementally add US2, US3, US4.

---

## Phase 1: Setup & Infrastructure

**Goal**: Initialize project structure and configure development environment.

**Tasks**:

- [x] T001 Create game logic module directory at `src/lib/blackjack/`
- [x] T002 Copy DeckManager from poker to `src/lib/blackjack/DeckManager.ts` and modify for Blackjack reshuffle logic (trigger at 15 cards)
- [x] T003 Copy DeckManager tests from poker to `src/lib/blackjack/DeckManager.test.ts` and update for reshuffle behavior
- [x] T004 Create TypeScript interfaces in `src/lib/blackjack/types.ts` (Card, Hand, BlackjackGameState, BlackjackAction, RoundOutcome)
- [x] T005 Create game constants in `src/lib/blackjack/constants.ts` (DEFAULT_MIN_BET=10, DEFAULT_MAX_BET=1000, BLACKJACK_PAYOUT=1.5, RESHUFFLE_THRESHOLD=15)
- [x] T006 Create public API exports in `src/lib/blackjack/index.ts`

**Dependencies**: None - can be parallelized

---

## Phase 2: Foundational Modules

**Goal**: Implement core game logic modules required by all user stories.

**Tasks**:

- [x] T007 [P] Implement hand value calculation in `src/lib/blackjack/handEvaluator.ts` (calculateHandValue, isBlackjack, isBust, canSplit, canDoubleDown)
- [x] T008 [P] Create unit tests for handEvaluator in `src/lib/blackjack/handEvaluator.test.ts` (test Ace soft/hard logic, face cards, edge cases)
- [x] T009 [P] Implement dealer strategy in `src/lib/blackjack/dealerStrategy.ts` (shouldDealerHit function - hits on ≤16, stands on ≥17)
- [x] T010 [P] Create unit tests for dealerStrategy in `src/lib/blackjack/dealerStrategy.test.ts`
- [x] T011 Run unit tests and verify 85%+ coverage: `bun test src/lib/blackjack/`

**Dependencies**: Requires T001-T006 (types and constants)

---

## Phase 3: User Story 1 - Play Basic Blackjack Round (P1) 🎯 MVP

**Goal**: Implement core gameplay loop - player can place bet, play hand (hit/stand), see outcome, and have chips updated.

**Independent Test Criteria**:

- ✅ Player places $50 bet and clicks "Deal"
- ✅ Player receives 2 cards, dealer receives 2 cards (1 hidden)
- ✅ Player clicks "Hit" and receives additional card
- ✅ Player clicks "Stand" and dealer reveals cards and plays
- ✅ Winner determined correctly and chips updated

### Game Logic

- [x] T012 [P] [US1] Implement BlackjackGame class core methods in `src/lib/blackjack/BlackjackGame.ts` (placeBet, deal, hit, stand, settleRound - NO double/split yet)
- [x] T013 [P] [US1] Create unit tests for BlackjackGame core flow in `src/lib/blackjack/BlackjackGame.test.ts` (bet validation, deal sequence, hit/stand, round settlement)
- [x] T014 [P] [US1] Implement UI renderer in `src/lib/blackjack/BlackjackUIRenderer.ts` (renderPlayerHand, renderDealerHand, updateGameStatus, updateBalance, enableActions)
- [ ] T015 [P] [US1] Create unit tests for UIRenderer in `src/lib/blackjack/BlackjackUIRenderer.test.ts` (DOM updates, button states)

### API Endpoint

- [x] T016 [US1] Create chip balance update endpoint at `src/pages/api/chips/update.ts` (POST handler with authentication, validation, optimistic locking)
- [ ] T017 [US1] Test API endpoint manually with curl: verify balance updates, test authentication requirement, test negative balance rejection

### UI Implementation

- [x] T018 [US1] Create Blackjack game page at `src/pages/games/blackjack.astro` (import CasinoLayout, PlayingCard, PokerChip components, auth check, basic UI structure)
- [x] T019 [US1] Implement betting UI in blackjack.astro (bet input, bet slider, quick bet chips, "Deal" button)
- [x] T020 [US1] Implement player hand display area in blackjack.astro (card container, hand value display, bet amount display)
- [x] T021 [US1] Implement dealer hand display area in blackjack.astro (card container with hidden card placeholder, dealer total display)
- [x] T022 [US1] Implement action buttons in blackjack.astro (Hit, Stand buttons with disabled states, game status message area)
- [x] T023 [US1] Wire up game initialization in blackjack.astro `<script>` block (import BlackjackGame, instantiate on page load, attach event listeners)
- [x] T024 [US1] Implement round completion flow in blackjack.astro (show winner message, update balance via API, enable new round)
- [x] T025 [US1] Add CSS animations for card dealing in blackjack.astro (CSS transforms, transition timing based on dealerSpeed)

### Game Lobby Integration

- [x] T026 [US1] Add Blackjack GameCard to `src/pages/games/index.astro` (title="Blackjack", description="Beat the dealer to 21", href="/games/blackjack", icon="🃏")

### Testing

- [ ] T027 [US1] Create E2E test for basic gameplay at `e2e/blackjack-gameplay.spec.ts` (test bet → deal → hit → stand → outcome flow)
- [ ] T028 [US1] Test E2E scenario: player wins with higher hand
- [ ] T029 [US1] Test E2E scenario: player busts (over 21)
- [ ] T030 [US1] Test E2E scenario: dealer busts, player wins
- [ ] T031 [US1] Test E2E scenario: player gets Blackjack (Ace + 10-value)
- [ ] T032 [US1] Test E2E scenario: push (tie) between player and dealer
- [ ] T033 [US1] Run E2E tests: `bun run test:e2e e2e/blackjack-gameplay.spec.ts`

### User Story 1 Validation

- [ ] T034 [US1] Manual test: Complete 10 rounds end-to-end in browser at `http://localhost:2000/games/blackjack`
- [ ] T035 [US1] Verify acceptance criteria: All 6 acceptance scenarios from spec.md pass
- [ ] T036 [US1] Verify chip balance persists correctly across rounds
- [ ] T037 [US1] Verify game accessible from lobby and returns seamlessly

**Dependencies**: Requires Phase 2 (handEvaluator, dealerStrategy)

---

## Phase 4: User Story 2 - Advanced Blackjack Actions (P2)

**Goal**: Add Double Down and Split actions for experienced players.

**Independent Test Criteria**:

- ✅ Player with hand total 11 sees enabled "Double Down" button
- ✅ Player clicks "Double Down", bet doubles, receives one card, turn ends
- ✅ Player with pair of 8s sees enabled "Split" button
- ✅ Player clicks "Split", hand splits into two, plays each independently
- ✅ Insufficient chips disables Double/Split with tooltip

### Game Logic Extensions

- [x] T038 [P] [US2] Extend BlackjackGame class in `src/lib/blackjack/BlackjackGame.ts` - add doubleDown() method (validate 2-card hand totaling 9/10/11, double bet, deal one card, auto-stand)
- [x] T039 [P] [US2] Extend BlackjackGame class - add split() method (validate same rank, sufficient chips, create second hand, deal one card to each, manage activeHandIndex)
- [x] T040 [P] [US2] Update BlackjackGame unit tests in `BlackjackGame.test.ts` - test doubleDown scenarios (valid hands, insufficient chips, card count)
- [x] T041 [P] [US2] Update BlackjackGame unit tests - test split scenarios (matching pairs, non-matching pairs, multiple hands, chip validation)

### UI Extensions

- [x] T042 [US2] Add Double Down button to `src/pages/games/blackjack.astro` (button with conditional enable/disable, tooltip for chip requirement)
- [x] T043 [US2] Add Split button to `src/pages/games/blackjack.astro` (button with conditional enable/disable, tooltip for chip requirement)
- [x] T044 [US2] Update BlackjackUIRenderer in `BlackjackUIRenderer.ts` - add renderSplitHands() method (display multiple player hands, highlight active hand)
- [x] T045 [US2] Update BlackjackUIRenderer - modify updateActions() to handle Double/Split button states based on game state
- [x] T046 [US2] Wire up Double Down and Split buttons in blackjack.astro `<script>` (attach click handlers, update UI after actions)

### Testing

- [x] T047 [US2] Create E2E test for split action at `e2e/blackjack-split.spec.ts` (test split pair → play first hand → play second hand → dealer turn → outcome)
- [x] T048 [US2] Test E2E scenario: double down with hand total 11
- [x] T049 [US2] Test E2E scenario: double down with hand total 10
- [x] T050 [US2] Test E2E scenario: split pair of 8s and win both hands
- [x] T051 [US2] Test E2E scenario: split pair, win one hand, lose other
- [x] T052 [US2] Test E2E scenario: insufficient chips disables Double/Split buttons
- [x] T053 [US2] Run E2E tests: `bun run test:e2e e2e/blackjack-split.spec.ts`

### User Story 2 Validation

- [x] T054 [US2] Manual test: Test all Double Down scenarios (hands 9, 10, 11, insufficient chips)
- [x] T055 [US2] Manual test: Test Split with various pairs (8s, Aces, face cards)
- [x] T056 [US2] Verify acceptance criteria: All 5 acceptance scenarios from spec.md pass
- [x] T057 [US2] Verify Double/Split work correctly with different chip balances

**Dependencies**: Requires Phase 3 (US1 complete)

---

## Phase 5: User Story 3 - LLM-Powered AI Rival (P3)

**Goal**: Integrate LLM for strategic gameplay advice and personality-driven commentary.

**Independent Test Criteria**:

- ✅ Player with configured API key sees enabled "Ask AI Rival" button
- ✅ Player clicks button, receives contextual advice within 3 seconds
- ✅ Player without API key sees overlay prompting configuration
- ✅ AI advice adapts when game state changes (new card drawn)
- ✅ AI provides outcome commentary at round end

### LLM Integration

- [x] T058 [P] [US3] Implement LLM Blackjack strategy in `src/lib/blackjack/llmBlackjackStrategy.ts` (getBlackjackAdvice function - fetch settings, construct prompt, call OpenAI/Gemini API)
- [x] T059 [P] [US3] Create Blackjack-specific prompt template in llmBlackjackStrategy.ts (include player hand, dealer card, available actions, request brief advice)
- [x] T060 [P] [US3] Add error handling in llmBlackjackStrategy.ts (no API key, API failure, timeout, network error)
- [x] T061 [P] [US3] Create unit tests for llmBlackjackStrategy in `llmBlackjackStrategy.test.ts` (mock API calls, test error scenarios)

### UI Integration

- [x] T062 [US3] Add "Ask AI Rival" button to `src/pages/games/blackjack.astro` (positioned near action buttons, disabled when not player's turn)
- [x] T063 [US3] Add AI advice display area in blackjack.astro (message box for AI responses, loading state, error messages)
- [x] T064 [US3] Add LLM configuration overlay to blackjack.astro (modal showing API key requirement, link to profile settings, "Play without LLM" button)
- [x] T065 [US3] Wire up AI advice in blackjack.astro `<script>` (click handler calls llmBlackjackStrategy, displays advice, handles errors)
- [x] T066 [US3] Implement overlay logic in blackjack.astro (show if LLM enabled but no API key, close on button click or API key config)
- [x] T067 [US3] Add round outcome commentary in blackjack.astro (call LLM at round end for brief comment, display in game status area)

### Testing

- [x] T068 [US3] Create E2E test for LLM integration at `e2e/blackjack-llm.spec.ts` (mock LLM API, test advice request/response)
- [x] T069 [US3] Test E2E scenario: player with API key clicks "Ask AI Rival" and receives advice
- [x] T070 [US3] Test E2E scenario: player without API key sees configuration overlay
- [x] T071 [US3] Test E2E scenario: LLM API failure shows user-friendly error message
- [x] T072 [US3] Test E2E scenario: AI provides outcome commentary at round end
- [x] T073 [US3] Run E2E tests: `bun run test:e2e e2e/blackjack-llm.spec.ts`

### User Story 3 Validation

- [x] T074 [US3] Manual test: Configure OpenAI API key in profile, test AI advice
- [x] T075 [US3] Manual test: Configure Gemini API key in profile, test AI advice
- [x] T076 [US3] Manual test: Enable LLM without API key, verify overlay appears
- [x] T077 [US3] Verify acceptance criteria: All 5 acceptance scenarios from spec.md pass
- [x] T078 [US3] Verify AI advice quality and relevance for various game states

**Dependencies**: Requires Phase 3 (US1 complete), can be developed in parallel with Phase 4 (US2)

---

## Phase 6: User Story 4 - Game Settings Customization (P4)

**Goal**: Allow players to customize game experience via settings panel.

**Independent Test Criteria**:

- ✅ Player clicks "Configure Settings", panel expands with all options
- ✅ Player modifies starting chips, next round starts with new amount

### Settings Module

- [x] T079 [P] [US4] Implement GameSettingsManager in `src/lib/blackjack/GameSettingsManager.ts` (loadSettings, saveSettings, resetSettings, validateSettings)
- [x] T080 [P] [US4] Define settings schema in GameSettingsManager (startingChips, minBet, maxBet, dealerSpeed, useLLM)
- [x] T081 [P] [US4] Implement localStorage persistence in GameSettingsManager (key: `arcturus:blackjack:settings:${userId}`)
- [x] T082 [P] [US4] Create unit tests for GameSettingsManager in `GameSettingsManager.test.ts` (load/save, validation, defaults, localStorage mocks)

### UI Implementation

- [ ] T083 [US4] Add settings panel to `src/pages/games/blackjack.astro` (collapsible section below game controls, "Configure Settings" toggle button)
- [ ] T084 [US4] Add starting chips input to settings panel (number input, validation, min/max constraints)
- [ ] T085 [US4] Add min/max bet inputs to settings panel (number inputs with validation)
- [ ] T086 [US4] Add dealer speed selector to settings panel (dropdown with Slow/Normal/Fast options)
- [ ] T087 [US4] Add LLM toggle checkbox to settings panel (checkbox with description, warning about API key requirement)
- [ ] T088 [US4] Add "Save Settings" and "Reset" buttons to settings panel
- [ ] T089 [US4] Wire up settings panel in blackjack.astro `<script>` (load settings on init, save on button click, apply to game state, reset to defaults)
- [ ] T090 [US4] Update BlackjackGame to accept settings parameter in constructor (apply startingChips, minBet, maxBet)
- [ ] T091 [US4] Update BlackjackUIRenderer to use dealerSpeed setting for animation timing

### Testing

- [ ] T092 [US4] Test settings persistence: save settings, reload page, verify settings retained
- [ ] T093 [US4] Test settings validation: attempt invalid values (negative chips, minBet > maxBet), verify rejected
- [ ] T094 [US4] Test reset functionality: modify settings, click reset, verify defaults restored
- [ ] T095 [US4] Test settings application: change starting chips, start new round, verify chips updated
- [ ] T096 [US4] Test dealer speed: adjust slider, observe dealer card animation speed changes

### User Story 4 Validation

- [ ] T097 [US4] Manual test: Modify all settings, start new round, verify each setting applies correctly
- [ ] T098 [US4] Manual test: Save settings, close browser, reopen, verify settings persist
- [ ] T099 [US4] Manual test: Reset settings to defaults, verify all values revert
- [ ] T100 [US4] Verify acceptance criteria: All 6 acceptance scenarios from spec.md pass
- [ ] T101 [US4] Verify settings UX is intuitive and responsive

**Dependencies**: Requires Phase 3 (US1 complete), can be developed in parallel with Phase 4 (US2) and Phase 5 (US3)

---

## Phase 7: Polish & Cross-Cutting Concerns

**Goal**: Final polish, accessibility, edge cases, and deployment preparation.

**Tasks**:

- [ ] T102 [P] Add keyboard shortcuts to blackjack.astro (H=Hit, S=Stand, D=Double, P=Split, Space=Deal)
- [ ] T103 [P] Add aria-live regions for screen readers in blackjack.astro (announce card deals, hand values, game outcomes)
- [ ] T104 [P] Implement focus management in blackjack.astro (focus moves to relevant button/input for turn progression)
- [ ] T105 [P] Test responsive design on mobile/tablet (verify layout, button sizes, card displays)
- [ ] T106 [P] Add loading states for API calls (chip update, LLM advice - spinners or skeleton screens)
- [ ] T107 Test edge case: player chip balance reaches zero mid-game (disable betting, show "Out of Chips" message)
- [ ] T108 Test edge case: dealer Blackjack with player Blackjack (verify push/tie logic)
- [ ] T109 Test edge case: split Aces receive one card each (implement standard rule if not already)
- [ ] T110 Test edge case: deck reshuffle occurs mid-round (verify seamless reshuffle, notify player)
- [ ] T111 Test edge case: player leaves page mid-round (verify chip state safe, no balance corruption)
- [ ] T112 Run full test suite: `bun test && bun run test:e2e`
- [ ] T113 Verify test coverage: `bun run test:coverage` (target: 85%+)
- [ ] T114 Run linter: `bun run lint` (ensure 0 warnings)
- [ ] T115 Run formatter check: `bun run format:check`
- [ ] T116 Build for production: `bun run build`
- [ ] T117 Preview production build: `bun run preview` and manually test all features
- [ ] T118 Performance audit: Run Lighthouse, verify page load <2s, animations 60fps
- [ ] T119 Update CLAUDE.md if needed (add Blackjack-specific patterns or gotchas)
- [ ] T120 Create PR with feature summary, link to spec and tasks

**Dependencies**: Requires all user story phases complete (Phases 3-6)

---

## Task Dependencies & Execution Order

### Critical Path (Must Complete in Order)

```
Phase 1 (Setup)
  → Phase 2 (Foundational)
  → Phase 3 (US1 - MVP)
  → [Phase 4 (US2), Phase 5 (US3), Phase 6 (US4) can be parallel]
  → Phase 7 (Polish)
```

### User Story Completion Order

**Priority Order** (from spec.md):

1. **US1 (P1)** - MVP - Must complete first
2. **US2 (P2)** - Can start after US1 complete
3. **US3 (P3)** - Can start after US1 complete (parallel with US2)
4. **US4 (P4)** - Can start after US1 complete (parallel with US2/US3)

### Independent User Story Testing

Each user story is independently testable:

- **US1**: Test bet → deal → hit/stand → outcome without needing US2/US3/US4
- **US2**: Test double/split without needing LLM or settings
- **US3**: Test LLM advice without needing double/split or settings
- **US4**: Test settings without needing double/split or LLM

---

## Parallel Execution Opportunities

### Within Phase 2 (Foundational)

- T007 (handEvaluator) || T009 (dealerStrategy) - different files, no dependencies
- T008 (handEvaluator tests) || T010 (dealerStrategy tests) - different files

### Within Phase 3 (US1)

- T012 (BlackjackGame) || T014 (UIRenderer) - different modules
- T013 (BlackjackGame tests) || T015 (UIRenderer tests) - different test files
- T019-T025 (UI implementation) - can be split among multiple developers

### Across Phases 4-6 (After US1 Complete)

- Phase 4 (US2), Phase 5 (US3), Phase 6 (US4) are independent and can be developed in parallel by different developers

### Within Phase 7 (Polish)

- T102-T106 (accessibility, responsive, loading states) - all parallelizable

---

## Testing Strategy

### Unit Tests (Target: 85%+ coverage)

- **Modules to test**: handEvaluator, dealerStrategy, BlackjackGame, DeckManager, GameSettingsManager, UIRenderer, llmBlackjackStrategy
- **Run**: `bun test src/lib/blackjack/`
- **Coverage**: `bun run test:coverage`

### E2E Tests (Critical user flows)

- **blackjack-gameplay.spec.ts**: Basic round flow (T027-T033)
- **blackjack-split.spec.ts**: Advanced actions (T047-T053)
- **blackjack-llm.spec.ts**: LLM integration (T068-T073)
- **Run**: `bun run test:e2e`

### Manual Testing

- Each user story has dedicated validation tasks (T034-T037, T054-T057, T074-T078, T097-T101)
- Edge case testing in Phase 7 (T107-T111)

---

## Implementation Milestones

### Milestone 1: MVP (US1 - Basic Gameplay) - Days 1-4

**Deliverable**: Playable Blackjack game with bet, deal, hit, stand, chip updates

- Complete Phases 1-3 (T001-T037)
- **Demo**: Show complete round from bet to outcome

### Milestone 2: Advanced Actions (US2) - Days 5-6

**Deliverable**: Double Down and Split features working

- Complete Phase 4 (T038-T057)
- **Demo**: Show double down and split scenarios

### Milestone 3: LLM Integration (US3) - Days 5-6 (parallel with M2)

**Deliverable**: AI Rival provides strategic advice

- Complete Phase 5 (T058-T078)
- **Demo**: Show AI advice in various game states

### Milestone 4: Settings & Polish (US4 + Polish) - Day 7

**Deliverable**: Customizable settings and production-ready feature

- Complete Phases 6-7 (T079-T120)
- **Demo**: Full feature walkthrough with all user stories

---

## Success Criteria Verification

Map success criteria from spec.md to task completion:

- **SC-001** (Complete round <60s): Verified in T034 manual testing
- **SC-002** (100% correct winners): Verified by T027-T032 E2E tests
- **SC-003** (LLM advice <3s): Verified in T069 E2E test
- **SC-004** (Double/Split correct states): Verified by T047-T053 E2E tests
- **SC-005** (Handle edge cases): Verified in T107-T111
- **SC-006** (UI consistency): Verified in T018-T025, T105
- **SC-007** (85%+ test coverage): Verified in T113
- **SC-008** (E2E flow tests): Completed in T027-T033, T047-T053, T068-T073
- **SC-009** (Settings persist): Verified in T092, T098
- **SC-010** (Seamless navigation): Verified in T037

---

## Risk Mitigation

### Risk: Split hand logic complexity

**Mitigation**:

- Comprehensive unit tests (T040-T041)
- E2E tests for all split scenarios (T047-T051)
- Clear data model with Hand array (from data-model.md)

### Risk: LLM prompt quality

**Mitigation**:

- Manual testing with different game states (T074-T078)
- Iterate on prompt template in llmBlackjackStrategy.ts (T059)
- Error handling for API failures (T060, T071)

### Risk: Animation performance

**Mitigation**:

- Use CSS GPU-accelerated transforms (T025)
- Performance audit with Lighthouse (T118)
- Test on low-end devices (T105)

---

## Task Summary

**Total Tasks**: 120  
**By Phase**:

- Phase 1 (Setup): 6 tasks
- Phase 2 (Foundational): 5 tasks
- Phase 3 (US1 - MVP): 26 tasks
- Phase 4 (US2): 20 tasks
- Phase 5 (US3): 21 tasks
- Phase 6 (US4): 23 tasks
- Phase 7 (Polish): 19 tasks

**By User Story**:

- US1 (P1 - MVP): 26 tasks (T012-T037)
- US2 (P2 - Advanced): 20 tasks (T038-T057)
- US3 (P3 - LLM): 21 tasks (T058-T078)
- US4 (P4 - Settings): 23 tasks (T079-T101)
- Infrastructure: 30 tasks (Setup + Foundational + Polish)

**Parallelizable Tasks**: 41 tasks marked with [P]

**Estimated Effort**:

- Full Implementation: ~7 working days (all user stories)
- MVP Only (US1): ~4 working days

---

## Next Steps

1. **Start with MVP**: Complete Phases 1-3 (T001-T037) for User Story 1
2. **Verify MVP works**: Run E2E tests (T033), manual testing (T034-T037)
3. **Incremental delivery**: Add US2, US3, US4 in priority order
4. **Polish**: Complete Phase 7 before final deployment

**Ready to implement!** All tasks are actionable and dependencies are clear.
