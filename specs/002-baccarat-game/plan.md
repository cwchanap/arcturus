# Implementation Plan: Baccarat Game with LLM Rival

**Branch**: `002-baccarat-game` | **Date**: 2025-12-06 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/002-baccarat-game/spec.md`

## Summary

Implement a Punto Banco Baccarat game with LLM-powered game assistant, following established patterns from poker and blackjack implementations. The game features standard baccarat betting (Player/Banker/Tie), side bets (Player Pair/Banker Pair), 8-deck shoe management, third-card drawing rules, and integration with existing LLM settings infrastructure.

## Technical Context

**Language/Version**: TypeScript 5.x (Astro SSR environment)
**Primary Dependencies**: Astro 5.x, Drizzle ORM, Better Auth, Tailwind CSS v4
**Storage**: Cloudflare D1 (existing schema - reuses `user.chipBalance` and `llm_settings` table)
**Testing**: Bun (unit tests) + Playwright (E2E tests)
**Target Platform**: Cloudflare Workers (edge runtime)
**Project Type**: Web application (Astro SSR)
**Performance Goals**: Round completion < 30 seconds, LLM response < 3 seconds
**Constraints**: Edge-first runtime (no Node.js APIs), 8-deck shoe management, Punto Banco rules
**Scale/Scope**: Single game page, ~15 game logic modules, reuse existing UI components

## Constitution Check

_GATE: Must pass before Phase 0 research. Re-check after Phase 1 design._

Verify compliance with `.specify/memory/constitution.md`:

- [x] **Edge-First Runtime**: Feature uses `Astro.locals.runtime.env` (NOT `process.env`)
- [x] **Factory Pattern**: Database/KV access uses factory functions (`createDb`, `createAuth`)
- [x] **Modular Architecture**: Game logic extracted to `src/lib/baccarat/` with pure functions
- [x] **Test Coverage**: Unit tests (Bun) + E2E tests (Playwright) planned
- [x] **Code Quality**: ESLint/Prettier pre-commit hooks already configured in project

_No violations or exceptions required. Feature follows established patterns from poker/blackjack._

## Project Structure

### Documentation (this feature)

```text
specs/002-baccarat-game/
├── plan.md              # This file
├── research.md          # Phase 0 output - Baccarat rules research
├── data-model.md        # Phase 1 output - Entity definitions
├── quickstart.md        # Phase 1 output - Integration guide
├── contracts/           # Phase 1 output - API/game flow contracts
│   └── game-flow.md     # Game state machine and betting flow
└── tasks.md             # Phase 2 output - Implementation tasks
```

### Source Code (repository root)

```text
src/
├── components/
│   └── (existing) PlayingCard.astro, PokerChip.astro, GameCard.astro
├── layouts/
│   └── (existing) casino.astro
├── pages/
│   └── games/
│       ├── (existing) index.astro     # Add Baccarat card
│       └── (new) baccarat.astro       # Main game page
└── lib/
    └── (new) baccarat/
        ├── index.ts                   # Module exports
        ├── types.ts                   # TypeScript interfaces
        ├── constants.ts               # Game constants (payouts, limits)
        ├── BaccaratGame.ts            # Main game state manager
        ├── DeckManager.ts             # 8-deck shoe management
        ├── handEvaluator.ts           # Hand value calculation
        ├── thirdCardRules.ts          # Punto Banco third-card logic
        ├── payoutCalculator.ts        # Bet resolution and payouts
        ├── GameSettingsManager.ts     # User settings (local storage)
        ├── BaccaratUIRenderer.ts      # UI state rendering
        ├── llmBaccaratStrategy.ts     # LLM integration for insights
        ├── baccaratClient.ts          # Client-side game orchestration
        └── *.test.ts                  # Unit tests for each module

e2e/
└── (new) baccarat.spec.ts             # E2E tests for Baccarat flows
```

**Structure Decision**: Follows existing `src/lib/{game}/` pattern established by poker and blackjack. Reuses existing UI components and casino layout. No new database tables required (uses existing `user.chipBalance` and `llm_settings`).

## Complexity Tracking

> No violations requiring justification. Feature aligns with constitution.
