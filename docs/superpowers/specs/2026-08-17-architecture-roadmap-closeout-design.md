# HPA-167 Architecture Roadmap Closeout Design

## Summary

Close HPA-167 as a completed architecture roadmap rather than starting another architecture refactor.

The concrete roadmap work is already shipped:

- HPA-542 isolated private-room multiplayer Poker from the persistent account wallet.
- HPA-545 replaced game-specific chip-sync machinery with the focused wallet settlement boundary.
- HPA-185 created the shared browser-local BYOK AI module.
- HPA-195 proved the new-game path with Video Poker.
- HPA-553 unified Ranked Blackjack and Daily Challenge into the focused `blackjack-run` module.
- HPA-196, HPA-198, and HPA-197 subsequently added Sic Bo, Three-Card Showdown, and Pai Gow Poker without introducing a generic game framework.

HPA-174 and HPA-177 are not unfinished roadmap requirements. Both explicitly say to defer implementation until product evidence appears, so they remain Backlog after HPA-167 closes.

The repository closeout is documentation-only, but it must refresh both audiences that currently describe the architecture:

- `README.md` for repository orientation;
- `CLAUDE.md` and `AGENTS.md` for always-on contributor/agent guidance.

No runtime code, schema, migration, API, game rule, settlement behavior, AI behavior, or multiplayer behavior changes in this slice.

## Why this is the next actionable task

The Arcturus project has no issue in Todo. Among HPA-167 children, the concrete architecture and game-validation slices are Done. The only open children are:

- HPA-174 — deferred until a shipped AI/gameplay flow creates a concrete need to reopen completed Blackjack runs;
- HPA-177 — deferred until repeated multi-day Daily participation or a direct request creates a need for weekly comparison.

Selecting either deferred feature now would ignore its explicit evidence gate. Creating another architecture cleanup ticket would also be speculative because the roadmap's intended seams are already present on `main`:

- `src/lib/wallet/` owns play-money settlement, including a focused public-game composition used by several newer games;
- `src/lib/ai/` owns provider settings and browser transport;
- `src/lib/blackjack-run/` and `src/server/blackjack-run/` own the unified Ranked/Daily Blackjack lifecycle;
- `src/lib/mp-poker/` and `src/server/mp/` keep multiplayer room-local;
- newer games live in focused modules such as `video-poker`, `sic-bo`, `three-card-showdown`, and `pai-gow-poker`.

The roadmap therefore has a concrete completion action: make the repository and contributor-facing architecture guidance match the code that already shipped, then close the umbrella issue.

## Options considered

### A. Close HPA-167 and refresh existing architecture guidance — selected

Use shipped code and completed child issues as the evidence. Refresh `README.md`, `CLAUDE.md`, and `AGENTS.md`, then mark the roadmap Done after the closeout PR merges.

This remains a documentation-only KISS/YAGNI closeout. It fixes stale guidance without creating a new architecture document or runtime cleanup project.

### B. Implement HPA-174 or HPA-177 before closing

Rejected. Both tickets intentionally require product evidence before implementation. Their prerequisite HPA-553 being Done makes them technically possible, not product-actionable.

### C. Create another architecture cleanup slice

Rejected. No current failure or duplicated abstraction justifies one. The roadmap specifically warns against generic frameworks, compatibility machinery, and architecture work without a concrete consumer.

## Closeout evidence

HPA-167's definition of done is satisfied by the shipped sequence rather than by one final refactor.

### Stable shared concepts exist where there are real consumers

Wallet behavior is centralized under `src/lib/wallet/`. Several newer public games use `createPublicGameSettlementController`, while older games and server-authoritative modes still use lower-level wallet primitives or `settleWalletRound` directly. That mixed usage is acceptable: the roadmap requires sharing a stable concept where concrete reuse exists, not forcing every game through one client composition.

AI provider configuration and transport live under `src/lib/ai/`; game-specific strategy and prompts remain owned by the games that use them.

Ranked and Daily Blackjack share one Blackjack-specific run module instead of parallel session stacks or a generic cross-game session framework.

### New games remain local

Video Poker, Sic Bo, Three-Card Showdown, and Pai Gow Poker were added as focused modules. Shared extraction happened only after concrete duplicate consumers appeared, such as the neutral card/deck primitive, the public-game settlement composition, and ordinary five-card poker comparison.

No base game class, game plugin system, generic paytable engine, generic arrangement engine, or cross-game session framework was required.

### Multiplayer stays secondary and isolated

Private-room Poker remains split between:

- browser/pure logic under `src/lib/mp-poker/*`;
- Worker-only room orchestration under `src/server/mp/multiplayer-poker-room.ts`;
- room-local chips rather than persistent D1 wallet settlement.

No public matchmaking, friends, tournaments, spectator system, or social platform is reintroduced as part of closeout.

### Compatibility and hardening are not allowed to reopen the roadmap

The roadmap intentionally accepts breaking hobby-project transitions and defers hostile-user/security hardening and rare recovery machinery. Closeout does not create follow-up work merely because stronger production-grade variants are possible.

A new architecture ticket should require a concrete current maintenance problem or multiple real consumers that cannot cleanly use an existing seam.

## Documentation changes

Do not create a third architecture document. Refresh the existing orientation surfaces only.

### README product and architecture orientation

Replace the generic "Astro with Authentication" framing with a short description of Arcturus as a play-money casino/game project built on Astro, Cloudflare Workers, and D1.

Add a concise `Architecture` section that records the long-lived rules:

- one Astro + Cloudflare Worker application and one D1 database;
- product modules under `src/lib/<domain>`;
- Worker-only persistence/orchestration under `src/server/<domain>` when needed;
- prefer thin Astro pages/API routes as adapters, without claiming every older game page has already been refactored to that shape;
- shared code only for stable concepts with multiple real consumers;
- no generic game/session/plugin framework.

Name the current important boundaries accurately:

- `src/lib/wallet/` — play-money settlement; newer public games may compose through `public-game-settlement`, while other games call wallet primitives/server settlement directly;
- `src/lib/ai/` — browser-local BYOK settings and provider transport;
- `src/lib/blackjack-run/` + `src/server/blackjack-run/` — unified Ranked/Daily Blackjack;
- `src/lib/mp-poker/` + `src/server/mp/` — isolated private-room multiplayer;
- focused per-game modules such as `video-poker`, `sic-bo`, `three-card-showdown`, and `pai-gow-poker`.

The README must not imply that every single-player game uses `createPublicGameSettlementController`.

### README project structure

Replace the starter-era `src/lib` example with a compact illustrative tree showing the real `src/lib/<domain>` + `src/server/<domain>` split.

The tree is orientation, not an exhaustive inventory. Do not list every game, route, migration, table, or API file.

### README routes

The current route list still describes the auth starter while the repository contains a full game area.

Replace it with a stable short list:

- `/` — home;
- `/signin` — Google sign-in entry;
- `/profile` — account/profile;
- `/games` and `/games/*` — game lobby and game routes;
- `/api/*` — application HTTP endpoints.

Do not enumerate every game or endpoint.

### README database description

Replace the auth-only table list with stable application-level wording:

- Better Auth identity/session data;
- play-money wallet and idempotent settlement data;
- game statistics/missions/progression data;
- Blackjack Run persistence;
- other focused feature data owned by the current application.

Avoid listing every table name because that would make the README unnecessarily brittle.

### CLAUDE.md and AGENTS.md project structure

The contributor guides currently teach a pre-roadmap tree that omits `wallet/`, `blackjack-run/`, and the missions directory and over-focuses on Poker/Blackjack/Baccarat class layouts.

Refresh their `Project Structure` sections to the same illustrative architecture used by the README, while retaining contributor-relevant load-bearing paths such as:

- `src/middleware.ts`;
- `src/db/schema.ts`;
- `src/pages/games/` and `src/pages/api/`;
- `src/lib/missions/`;
- `src/lib/wallet/`, `src/lib/ai/`, `src/lib/blackjack-run/`, and `src/lib/mp-poker/`;
- `src/server/blackjack-run/` and `src/server/mp/`.

Do not turn either file into a per-game file inventory.

### CLAUDE.md and AGENTS.md key patterns

Update stale guidance that would otherwise contradict the refreshed tree:

- `Modular Game Logic` must say games own focused files by responsibility; no mandatory `Game` class, renderer, deck manager, settings manager, or LLM file exists.
- `Mission System` must point to `src/lib/missions/`, not deleted `src/lib/missions.ts`.
- `Wallet Settlement` must distinguish the common wallet boundary from the optional newer public-game composition; do not require every game to use one client controller.
- Thin route/API adapters remain the preferred direction, but do not trigger a refactor of older mixed pages in this closeout.

### CLAUDE.md and AGENTS.md database guidance

Replace the stale auth-era table inventory with the same stable application-level description used by README and point to `src/db/schema.ts` as the source of truth.

### CLAUDE.md and AGENTS.md Building New Games recipe

Replace the old class-based template with the shipped local-first recipe demonstrated by newer modules such as Video Poker:

1. add a thin `src/pages/games/<game>.astro` route that composes the game UI and current session/presentation seams it actually needs;
2. keep rules/state/evaluation/client code under `src/lib/<game>/`, splitting files by real responsibility rather than a required filename template;
3. reuse existing shared seams such as cards, wager validation, public-game session, wallet settlement, card-slot helpers, or AI transport only when their contracts already match;
4. keep game-specific prompts, payouts, phases, wildcard rules, render decisions, and settlement command mapping local;
5. add focused unit tests plus one representative E2E journey and register the game in the existing lobby/stat surfaces that genuinely apply;
6. do not create a base game class, generic paytable/session/plugin framework, mandatory LLM layer, or compatibility abstraction for a hypothetical future consumer.

This is guidance, not a required file list. A new game should copy the smallest relevant shipped seam, not recreate the old Poker/Blackjack/Baccarat class structure.

## Linear closeout

Do not mark HPA-167 Done when the design PR is opened.

After the documentation implementation merges:

1. re-read HPA-167 children;
2. verify the concrete roadmap children remain Done and HPA-174/HPA-177 remain intentionally deferred;
3. add a short closeout comment citing the shipped modules/PR sequence and the documentation refresh;
4. mark HPA-167 Done.

Do not close HPA-174 or HPA-177. Their Backlog state is the desired state until their own revisit triggers are met.

## Validation

This is documentation-only implementation. Full unit/E2E execution is unnecessary unless implementation accidentally touches runtime code.

Required path checks:

```bash
test -d src/lib/wallet
test -d src/lib/ai
test -d src/lib/blackjack-run
test -d src/server/blackjack-run
test -d src/lib/mp-poker
test -d src/server/mp
test -d src/lib/missions
test -d src/lib/video-poker
test -d src/lib/sic-bo
test -d src/lib/three-card-showdown
test -d src/lib/pai-gow-poker
```

Required settlement-consumer check:

```bash
rg -l "createPublicGameSettlementController" src/lib \
  | grep -v '/wallet/' \
  | grep -v '\.test\.ts$' \
  | sort
```

The current result should be the four newer game clients for Video Poker, Sic Bo, Three-Card Showdown, and Pai Gow Poker. Documentation must describe this as a proven newer-game composition, not the universal single-player path.

Documentation checks:

```bash
bunx prettier --check README.md CLAUDE.md AGENTS.md \
  docs/superpowers/specs/2026-08-17-architecture-roadmap-closeout-design.md \
  docs/superpowers/plans/2026-08-17-architecture-roadmap-closeout.md
git diff --check
```

Final scope check:

```bash
git diff --name-only origin/main...HEAD
```

Expected implementation branch changes are limited to:

```text
README.md
CLAUDE.md
AGENTS.md
docs/superpowers/specs/2026-08-17-architecture-roadmap-closeout-design.md
docs/superpowers/plans/2026-08-17-architecture-roadmap-closeout.md
```

If runtime/schema/config/test files appear, stop and justify the concrete defect before expanding scope.

## Non-goals

- Implement HPA-174 or HPA-177.
- Add another game.
- Refactor existing game modules merely for consistency.
- Refactor older pages solely to make all adapters uniform.
- Move old modules into a new directory layout.
- Add a base game class, plugin architecture, generic session/repository layer, event bus, or service container.
- Add compatibility adapters or migrate historical data.
- Add production-grade security, anti-cheat, durable queues, distributed locking, or recovery machinery.
- Create a third architecture/contributor document.
- Run broad cleanup unrelated to stale architecture guidance.

## Definition of done

- `README.md` accurately describes the current modular-monolith boundaries, routes, and persistence at an orientation level.
- `CLAUDE.md` and `AGENTS.md` no longer teach the deleted missions path or the old mandatory class/renderer/deck-manager game template.
- Wallet wording reflects the actual mixed consumers instead of claiming one universal single-player composition.
- No runtime behavior changes.
- The diff contains only README/contributor docs plus this design and its implementation plan.
- HPA-174 and HPA-177 remain deferred.
- After merge, HPA-167 is closed with a concise shipped-evidence comment.
