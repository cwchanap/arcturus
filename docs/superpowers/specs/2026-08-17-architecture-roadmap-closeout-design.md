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

HPA-174 and HPA-177 are not unfinished roadmap requirements. Both explicitly say to defer implementation until product evidence appears. Their revisit triggers have not been established by the current Linear backlog, so they remain Backlog after HPA-167 closes.

The only repository change for closeout is to refresh the top-level README so it describes the modular application that now exists instead of mostly describing the original Astro starter structure.

No runtime code, schema, API, game rule, settlement behavior, AI behavior, or multiplayer behavior changes in this slice.

## Why this is the next actionable task

The Arcturus project has no issue in Todo. Among HPA-167 children, the concrete architecture and game-validation slices are Done. The only open children are:

- HPA-174 — deferred until a shipped AI/gameplay flow creates a concrete need to reopen completed Blackjack runs;
- HPA-177 — deferred until repeated multi-day Daily participation or a direct request creates a need for weekly comparison.

Selecting either deferred feature now would ignore its explicit evidence gate. Creating another architecture cleanup ticket would also be speculative because the roadmap's intended seams are already present on `main`:

- `src/lib/wallet/` owns wallet settlement and public-game settlement composition;
- `src/lib/ai/` owns provider settings and browser transport;
- `src/lib/blackjack-run/` and `src/server/blackjack-run/` own the unified Ranked/Daily Blackjack lifecycle;
- `src/lib/mp-poker/` and `src/server/mp/` keep multiplayer room-local;
- newer games live in focused modules such as `video-poker`, `sic-bo`, `three-card-showdown`, and `pai-gow-poker`.

The roadmap therefore has a concrete completion action: record the resulting architecture accurately and close the umbrella issue.

## Options considered

### A. Close HPA-167 and refresh the README — selected

Use shipped code and completed child issues as the evidence. Update only stale top-level architecture documentation, then mark the roadmap Done after the closeout PR merges.

This is the smallest option and matches the project's KISS/YAGNI direction.

### B. Implement HPA-174 or HPA-177 before closing

Rejected. Both tickets intentionally require product evidence before implementation. Their prerequisite HPA-553 being Done makes them technically possible, not product-actionable.

### C. Create another architecture cleanup slice

Rejected. No current failure or duplicated abstraction justifies one. The roadmap specifically warns against generic frameworks, compatibility machinery, and architecture work without a concrete consumer.

## Closeout evidence

HPA-167's definition of done is satisfied by the shipped sequence rather than by one final refactor.

### Stable shared concepts exist where there are real consumers

Wallet behavior is centralized under `src/lib/wallet/`, including the focused public-game settlement composition used by newer single-player games. This replaces copying settlement queues, outboxes, rebasing, and retry policy into every game.

AI provider configuration and transport live under `src/lib/ai/`; game-specific strategy and prompts remain owned by the games that use them.

Ranked and Daily Blackjack share one Blackjack-specific run module instead of parallel session stacks or a generic cross-game session framework.

### New games remain local

Video Poker, Sic Bo, Three-Card Showdown, and Pai Gow Poker were added as focused modules. Shared extraction happened only after concrete duplicate consumers appeared, such as the neutral card/deck primitive, the public-game settlement composition, and ordinary five-card poker comparison.

No base game class, game plugin system, generic paytable engine, generic arrangement engine, or cross-game session framework was required.

### Multiplayer stays secondary and isolated

The README already documents the current private-room Poker shape:

- browser/pure logic under `src/lib/mp-poker/*`;
- Worker-only room orchestration under `src/server/mp/multiplayer-poker-room.ts`;
- room-local chips rather than persistent D1 wallet settlement.

No public matchmaking, friends, tournaments, spectator system, or social platform is reintroduced as part of closeout.

### Compatibility and hardening are not allowed to reopen the roadmap

The roadmap intentionally accepts breaking hobby-project transitions and defers hostile-user/security hardening and rare recovery machinery. Closeout does not create follow-up work merely because stronger production-grade variants are possible.

A new architecture ticket should require a concrete current maintenance problem or at least two real consumers that cannot cleanly use an existing seam.

## Repository documentation change

Update `README.md` only.

### Product description

Replace the generic "Astro with Authentication" framing with a short description of Arcturus as a play-money casino/game project built on Astro, Cloudflare Workers, and D1.

Do not turn the README into a product brochure or enumerate every feature.

### Architecture section

Add a concise architecture section that records the long-lived rules:

- one Astro + Cloudflare Worker application and one D1 database;
- product modules under `src/lib/<domain>`;
- Worker-only persistence/orchestration under `src/server/<domain>` when needed;
- thin Astro pages/API routes as adapters;
- shared code only for stable concepts with multiple real consumers;
- no generic game/session/plugin framework.

Name the current important boundaries:

- `src/lib/wallet/` — play-money settlement and public-game settlement composition;
- `src/lib/ai/` — browser-local BYOK settings and provider transport;
- `src/lib/blackjack-run/` + `src/server/blackjack-run/` — unified Ranked/Daily Blackjack;
- `src/lib/mp-poker/` + `src/server/mp/` — isolated private-room multiplayer;
- focused per-game modules such as `video-poker`, `sic-bo`, `three-card-showdown`, and `pai-gow-poker`.

### Project structure

Replace the starter-era `src/lib` example that lists only auth/db files with a compact tree showing the real module split.

The tree is illustrative, not an exhaustive inventory. Do not list every game or API file.

### Database description

Replace the auth-only table list with a stable description:

- Better Auth identity/session data;
- play-money wallet and idempotent settlement data;
- game statistics/missions/progression data;
- Blackjack Run persistence;
- other focused feature tables that are owned by the current application.

Avoid listing every table name because that would make the README unnecessarily brittle.

## Linear closeout

Do not mark HPA-167 Done when the design PR is opened.

After the implementation change merges:

1. re-read HPA-167 children;
2. verify the concrete roadmap children remain Done and HPA-174/HPA-177 remain intentionally deferred;
3. add a short closeout comment citing the shipped modules/PR sequence and the README refresh;
4. mark HPA-167 Done.

Do not close HPA-174 or HPA-177. Their Backlog state is the desired state until their own revisit triggers are met.

## Validation

This is documentation-only implementation. Full unit/E2E execution is unnecessary unless implementation accidentally touches runtime code.

Required checks:

```bash
test -d src/lib/wallet
test -d src/lib/ai
test -d src/lib/blackjack-run
test -d src/server/blackjack-run
test -d src/lib/mp-poker
test -d src/server/mp
test -d src/lib/video-poker
test -d src/lib/sic-bo
test -d src/lib/three-card-showdown
test -d src/lib/pai-gow-poker
bunx prettier --check README.md docs/superpowers/specs/2026-08-17-architecture-roadmap-closeout-design.md docs/superpowers/plans/2026-08-17-architecture-roadmap-closeout.md
git diff --check
```

Final scope check:

```bash
git diff --name-only origin/main...HEAD
```

Expected implementation branch changes are limited to:

```text
README.md
docs/superpowers/specs/2026-08-17-architecture-roadmap-closeout-design.md
docs/superpowers/plans/2026-08-17-architecture-roadmap-closeout.md
```

If runtime/schema/config/test files appear, stop and justify the concrete defect before expanding scope.

## Non-goals

- Implement HPA-174 or HPA-177.
- Add another game.
- Refactor existing game modules merely for consistency.
- Move old modules into a new directory layout.
- Add a base game class, plugin architecture, generic session/repository layer, event bus, or service container.
- Add compatibility adapters or migrate historical data.
- Add production-grade security, anti-cheat, durable queues, distributed locking, or recovery machinery.
- Run broad cleanup unrelated to stale README architecture documentation.

## Definition of done

- `README.md` accurately describes the current modular-monolith boundaries without becoming an exhaustive architecture manual.
- No runtime behavior changes.
- The diff contains only the README plus this design and its implementation plan.
- HPA-174 and HPA-177 remain deferred.
- After merge, HPA-167 is closed with a concise shipped-evidence comment.
