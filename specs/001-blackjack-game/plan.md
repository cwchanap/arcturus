# Implementation Plan: Blackjack Game with LLM Rival

**Branch**: `001-blackjack-game` | **Date**: November 23, 2025 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-blackjack-game/spec.md`

**Note**: This template is filled in by the `/speckit.plan` command. See `.specify/templates/commands/plan.md` for the execution workflow.

## Summary

Build a complete Blackjack casino game that integrates with Arcturus platform infrastructure (authentication, chip balance, UI components). The game implements standard Blackjack rules including advanced actions (Double Down, Split), provides LLM-powered AI rival support using existing OpenAI/Gemini integration, and offers customizable game settings. Architecture follows the proven poker game pattern: modular game logic in `src/lib/blackjack/`, client-side state management, and comprehensive test coverage.

## Technical Context

**Language/Version**: TypeScript 5.x (Astro SSR environment)  
**Primary Dependencies**: Astro 5.x, Drizzle ORM, Better Auth, Tailwind CSS v4, existing `llm-settings` infrastructure  
**Storage**: Cloudflare D1 (existing schema - reuses `user.chipBalance` and `llm_settings` table, no new tables needed)  
**Testing**: Bun (unit tests for game logic) + Playwright (E2E tests for gameplay flows)  
**Target Platform**: Cloudflare Workers (edge runtime, NOT Node.js)
**Project Type**: Web application - SSR page with client-side game logic  
**Performance Goals**: Game round completion <60s, LLM advice <3s response time, 60 fps card animations  
**Constraints**: Edge runtime compatibility (no Node.js APIs), chip balance transactions must be atomic, LLM calls must handle failures gracefully  
**Scale/Scope**: ~2000 LOC game logic (8-10 modules), 1 new route (`/games/blackjack.astro`), 1 game card in lobby, reuses 3 UI components

## Constitution Check

_GATE: Must pass before Phase 0 research. Re-check after Phase 1 design._

Verify compliance with `.specify/memory/constitution.md`:

- [x] **Edge-First Runtime**: Feature uses `Astro.locals.runtime.env` - Page uses `Astro.locals.user` (includes chipBalance) and LLM settings accessed via middleware pattern
- [x] **Factory Pattern**: Database/KV access uses factory functions - No new database access needed (reuses middleware-injected user data); LLM calls use existing `llm-settings.ts` module
- [x] **Modular Architecture**: Game logic extracted to `src/lib/blackjack/` with pure functions - Following poker game pattern with 8-10 testable modules
- [x] **Test Coverage**: Unit tests (Bun) + E2E tests (Playwright) planned - SC-007 requires 85%+ unit coverage, SC-008 requires E2E flow verification
- [x] **Code Quality**: ESLint/Prettier pre-commit hooks configured - Existing Husky hooks apply automatically

**No exceptions needed** - Feature fully complies with constitution. Reuses existing infrastructure (auth, chips, LLM settings) without introducing new patterns or complexity.

## Project Structure

### Documentation (this feature)

```text
specs/[###-feature]/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output (/speckit.plan command)
├── data-model.md        # Phase 1 output (/speckit.plan command)
├── quickstart.md        # Phase 1 output (/speckit.plan command)
├── contracts/           # Phase 1 output (/speckit.plan command)
└── tasks.md             # Phase 2 output (/speckit.tasks command - NOT created by /speckit.plan)
```

### Source Code (repository root)

**Structure Decision**: Astro SSR web application - follows existing Arcturus project structure. New code added to established directories; no new top-level directories needed.

```text
src/
├── pages/
│   └── games/
│       ├── index.astro          # MODIFY - Add Blackjack game card
│       └── blackjack.astro      # NEW - Main game page
├── lib/
│   ├── blackjack/               # NEW - Game logic modules (8-10 files)
│   │   ├── types.ts             # TypeScript interfaces
│   │   ├── constants.ts         # Game constants (bet limits, dealer rules)
│   │   ├── BlackjackGame.ts     # Main game state manager class
│   │   ├── DeckManager.ts       # Card deck shuffling/dealing (reuse poker's?)
│   │   ├── handEvaluator.ts     # Hand value calculation (Ace soft/hard, bust)
│   │   ├── dealerStrategy.ts    # Dealer AI (hits on ≤16, stands on ≥17)
│   │   ├── llmBlackjackStrategy.ts  # LLM integration for player advice
│   │   ├── GameSettingsManager.ts   # Settings persistence (localStorage)
│   │   ├── BlackjackUIRenderer.ts   # UI update logic
│   │   └── index.ts             # Public API exports
│   └── llm-settings.ts          # EXISTING - Reused for API keys
├── components/
│   ├── PlayingCard.astro        # EXISTING - Reused for cards
│   ├── PokerChip.astro          # EXISTING - Reused for betting UI
│   └── GameCard.astro           # EXISTING - Reused for lobby
└── layouts/
    └── casino.astro             # EXISTING - Reused for game layout

e2e/
├── blackjack-gameplay.spec.ts   # NEW - E2E test for basic round
├── blackjack-split.spec.ts      # NEW - E2E test for split action
└── blackjack-llm.spec.ts        # NEW - E2E test for LLM integration

# All other directories unchanged (middleware, db, etc.)
```

## Complexity Tracking

**No violations** - All constitution requirements satisfied. No additional complexity introduced.

---

## Phase 0: Research (Complete)

**Status**: ✅ Complete  
**Output**: [research.md](./research.md)

### Key Decisions Made

1. **DeckManager Reusability**: Reuse poker's DeckManager with reshuffle trigger modification
2. **Hand Value Calculation**: Dedicated handEvaluator for Ace soft/hard logic
3. **LLM Integration**: Follow poker's proven pattern with Blackjack-specific prompts
4. **Split Hand Management**: Array of Hand objects for independent hand play
5. **Game Settings Persistence**: localStorage (no database table needed)
6. **Chip Balance Integration**: In-memory during game, sync via API on round end
7. **UI Animation Strategy**: CSS transitions + JavaScript timing for dealer

**No blocking issues identified** - All technical unknowns resolved.

---

## Phase 1: Design & Contracts (Complete)

**Status**: ✅ Complete  
**Outputs**:

- [data-model.md](./data-model.md) - Core entity definitions
- [contracts/chip-balance-api.md](./contracts/chip-balance-api.md) - API specification
- [quickstart.md](./quickstart.md) - Developer guide

### Data Model Summary

**Core Entities**:

- `Card` - Playing card with rank/suit
- `Hand` - Collection of cards with bet and computed properties
- `Deck` - Card management with shuffle/deal/reshuffle logic
- `BlackjackGameState` - Main game state with phase transitions
- `BlackjackSettings` - User preferences (localStorage)
- `RoundOutcome` - Result tracking for payouts

**No new database tables required** - Reuses existing `user.chipBalance` and `llm_settings`.

### API Contracts

**New Endpoint**: `POST /api/chips/update`

- Updates user chip balance after round completion
- Atomic update with optimistic locking
- Error handling for concurrent updates
- See [contracts/chip-balance-api.md](./contracts/chip-balance-api.md) for full specification

### Constitution Check (Post-Design)

**Re-verification after design phase**:

- [x] **Edge-First Runtime**: ✅ No Node.js APIs used; all environment access via Astro.locals
- [x] **Factory Pattern**: ✅ Database access via existing createDb factory
- [x] **Modular Architecture**: ✅ 9 modules in `src/lib/blackjack/` with pure functions
- [x] **Test Coverage**: ✅ Unit tests for all modules + 3 E2E test files planned
- [x] **Code Quality**: ✅ Existing Husky hooks enforce quality automatically

**Result**: All constitution requirements satisfied ✅

---

## Implementation Readiness

### Prerequisites Satisfied

- [x] Technical context defined
- [x] Constitution compliance verified
- [x] Research decisions documented
- [x] Data model specified
- [x] API contracts defined
- [x] Developer quickstart guide created
- [x] Agent context updated (CLAUDE.md)

### Next Steps

The plan is **complete and ready for task generation**. Proceed with:

```bash
/speckit.tasks
```

This will generate `tasks.md` with actionable, dependency-ordered implementation tasks based on this plan.

### Estimated Effort

- **Full Implementation** (P1-P4): ~7 working days
- **MVP** (P1 only - basic gameplay): ~4 working days
- **Lines of Code**: ~2000 LOC across 9 game modules + 1 page + 1 API endpoint + 3 E2E tests

### Risk Assessment

**Low Risk** - Feature leverages proven patterns:

- Similar architecture to existing poker game
- Reuses established infrastructure (auth, chips, LLM)
- No new database migrations required
- Clear specification with comprehensive test requirements

**Potential Challenges**:

- Split hand logic complexity (mitigated by clear data model)
- LLM prompt engineering for quality advice (can iterate after MVP)
- Animation performance on low-end devices (use CSS GPU acceleration)

All challenges have documented mitigation strategies in research.md.
