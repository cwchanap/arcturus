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

HPA-174 and HPA-177 are not unfinished architecture work. Both explicitly require later product evidence, so they remain Backlog after HPA-167 closes.

The repository closeout stays documentation-only. Refresh the two real documentation sources:

- `README.md` for repository orientation;
- `CLAUDE.md` for always-on contributor/agent guidance.

`AGENTS.md` is not a separate document. Git tracks it as a symbolic link to `CLAUDE.md`; keep that symlink unchanged and edit `CLAUDE.md` only.

No runtime code, schema, migration, API, game rule, settlement behavior, AI behavior, multiplayer behavior, test, or configuration changes belong in this slice.

## Why this is the next actionable task

The Arcturus project has no issue in Todo. The concrete HPA-167 architecture sequence is complete, while the only remaining open children are deliberately deferred product ideas:

- HPA-174 waits for a concrete need to reopen completed Blackjack runs;
- HPA-177 waits for repeated multi-day Daily participation or a direct request for weekly comparison.

Selecting either now would ignore its own evidence gate. Creating another architecture cleanup ticket would also be speculative because the intended seams already exist on `main`:

- `src/lib/wallet/` owns common play-money settlement concerns;
- `src/lib/ai/` owns browser-local BYOK settings and provider transport;
- `src/lib/blackjack-run/` and `src/server/blackjack-run/` own the unified Ranked/Daily Blackjack lifecycle;
- `src/lib/mp-poker/` and `src/server/mp/` keep private multiplayer room-local;
- `src/lib/game-stats/`, `src/lib/achievements/`, and `src/lib/leaderboard/` own shared cross-game progression/reporting concerns;
- newer games live in focused modules such as `video-poker`, `sic-bo`, `three-card-showdown`, and `pai-gow-poker`.

The closeout action is therefore to make the existing orientation surfaces accurately describe the shipped code, then close the umbrella issue.

## Options considered

### A. Close HPA-167 and refresh existing guidance — selected

Use shipped code and completed children as evidence. Update `README.md` and `CLAUDE.md`, keep the `AGENTS.md -> CLAUDE.md` symlink unchanged, then mark HPA-167 Done after the closeout PR merges.

This is the smallest option that prevents the old architecture template from being copied into future work.

### B. Implement HPA-174 or HPA-177 before closing

Rejected. Their prerequisite being complete makes them technically possible, not product-actionable.

### C. Create another architecture cleanup slice

Rejected. No current failure or duplicate-maintenance problem justifies another refactor. Runtime cleanup should start from a concrete feature or maintenance cost, not from a desire for directory or client uniformity.

## Closeout evidence

### Stable shared concepts exist where there are real consumers

Wallet behavior is centralized under `src/lib/wallet/`, but not every game uses the same client composition. `createPublicGameSettlementController` is currently a proven seam for four newer public games: Video Poker, Sic Bo, Three-Card Showdown, and Pai Gow Poker. Older games and server-authoritative modes may use lower-level wallet APIs or server settlement directly.

That mixed reality is intentional. The roadmap calls for extracting stable concepts after concrete reuse appears, not retrofitting every game behind one abstraction.

AI provider configuration and transport live under `src/lib/ai/`, while game-specific prompts and deterministic strategy remain game-owned.

Ranked and Daily Blackjack share one Blackjack-specific run module instead of parallel session stacks or a generic cross-game session framework.

Cross-game progression/reporting is also explicit rather than game-local duplication:

- `src/lib/game-stats/` owns the closed game identifier/label/icon registration and statistics logic;
- `src/lib/achievements/` consumes shared game/progression facts;
- `src/lib/leaderboard/` owns leaderboard behavior.

### New games remain local

Video Poker, Sic Bo, Three-Card Showdown, and Pai Gow Poker were added as focused modules. They are organized by concrete responsibilities such as rules/state, evaluator/paytable, client composition, and tests—not by a mandatory `Game` class, renderer, deck manager, settings manager, or LLM file template.

Shared extraction happened only after real duplicate consumers appeared. No base game class, plugin system, generic paytable engine, generic arrangement engine, or cross-game session framework was required.

### Multiplayer stays secondary and isolated

Private-room Poker remains split between browser/pure logic under `src/lib/mp-poker/*` and Worker-only orchestration under `src/server/mp/multiplayer-poker-room.ts`. Multiplayer stacks stay room-local rather than settling through the persistent D1 wallet.

No public matchmaking, friends, tournaments, spectator system, or social platform is reintroduced as part of closeout.

### Compatibility and hardening do not reopen the roadmap

The roadmap intentionally accepts breaking hobby-project transitions and defers hostile-user/security hardening and rare recovery machinery. Closeout does not create follow-up work merely because stronger production-grade variants are possible.

Future architecture work should require a concrete current maintenance problem or multiple real consumers that cannot cleanly use an existing seam.

## Documentation changes

Do not create a third architecture document. Refresh the existing orientation surfaces only.

### `AGENTS.md` remains a symlink

Git tracks `AGENTS.md` with symlink mode `120000`, and its blob target is `CLAUDE.md`.

The implementation must:

- edit `CLAUDE.md` only;
- leave the `AGENTS.md` symlink unchanged;
- document near the top of `CLAUDE.md` that `AGENTS.md` points to it, so future contributors do not attempt duplicate edits.

### README product and architecture orientation

Replace the generic "Astro with Authentication" framing with a short description of Arcturus as a play-money casino/game project built on Astro, Cloudflare Workers, and D1.

Add a concise `Architecture` section that records the long-lived rules:

- one Astro + Cloudflare Worker application and one D1 database;
- product modules under `src/lib/<domain>`;
- Worker-only persistence/orchestration under `src/server/<domain>` when needed;
- prefer thin Astro pages/API routes as adapters without claiming every older page has already been refactored to that shape;
- shared code only for stable concepts with multiple real consumers;
- no generic game/session/plugin framework.

Name the important shared boundaries without turning README into an inventory:

- `src/lib/wallet/` — common play-money settlement boundary; newer public games may use `public-game-settlement`, while other modes can use lower-level wallet/server settlement;
- `src/lib/ai/` — browser-local BYOK settings and provider transport;
- `src/lib/blackjack-run/` + `src/server/blackjack-run/` — unified Ranked/Daily Blackjack;
- `src/lib/mp-poker/` + `src/server/mp/` — isolated private-room multiplayer;
- `src/lib/game-stats/`, `src/lib/achievements/`, and `src/lib/leaderboard/` — cross-game statistics, progression, and ranking surfaces;
- focused per-game modules for game-owned rules and UI behavior.

### Shared illustrative project tree

README and CLAUDE should use the same compact illustrative project tree for the architecture-relevant paths. Include:

- `src/db/schema.ts`;
- `src/middleware.ts`;
- `src/pages/games/` and `src/pages/api/`;
- `src/lib/ai/`, `blackjack-run/`, `missions/`, `wallet/`, `mp-poker/`, `game-stats/`, `achievements/`, `leaderboard/`, and `<game>/`;
- `src/server/blackjack-run/` and `src/server/mp/`.

Do not enumerate every game, route, migration, table, or test file.

### README routes

Replace the auth-starter route list with stable route groups:

- `/` — home;
- `/signin` — Google sign-in entry;
- `/profile` — account/profile;
- `/games` and `/games/*` — game entry and individual game routes;
- `/api/*` — application HTTP endpoints.

Do not enumerate every game or endpoint.

### Shared database wording

README and CLAUDE should use the same stable application-level database bullet list and point to `src/db/schema.ts` as the source of truth:

- Better Auth identity, account, and session data;
- play-money wallet and idempotent settlement data;
- game statistics, missions, and related progression data;
- Blackjack Run persistence for Ranked and Daily modes;
- focused feature data owned by the current application.

Do not maintain a duplicated exhaustive table-name inventory.

### CLAUDE key patterns

Replace stale guidance that contradicts the shipped architecture:

- `Modular Game Logic`: files are split by real responsibility; there is no required `Game` class, renderer, deck manager, settings manager, or LLM file.
- `Mission System`: point to `src/lib/missions/`, not the deleted `src/lib/missions.ts`.
- `Wallet Settlement`: distinguish the common wallet boundary from the optional newer public-game controller; do not require every game to use one client composition.
- `Cross-game progression`: name `game-stats`, `achievements`, and `leaderboard` as shared concepts used by multiple games.
- `Route/API Boundaries`: thin adapters are preferred, but older mixed pages are not refactored solely for consistency.

### CLAUDE Building New Games recipe

Replace the old class-based template with a concrete local-first recipe based on the newer game modules:

1. Add `src/pages/games/<game>.astro` as the route/UI composition layer.
2. Keep game-owned rules, state transitions, evaluation, payouts, and browser behavior under `src/lib/<game>/`, split by actual responsibility.
3. Reuse shared seams only when their existing contracts fit; do not widen them for hypothetical reuse.
4. Keep game-specific phases, prompts, payout policy, wildcard/ranking rules, rendering decisions, and settlement-command mapping local.
5. Register the game in `src/lib/game-stats/constants.ts`: add the id to `GAME_TYPES` and add matching `GAME_TYPE_LABELS` and `GAME_TYPE_ICONS` entries. Add the lobby card in `src/pages/index.astro`; `src/pages/games/index.astro` is only a redirect to the homepage game section. Add focused unit tests plus one representative Playwright journey.
6. Do not add a base game class, generic paytable/session/plugin framework, mandatory settings/LLM layer, compatibility adapter, or new persistence system without a concrete requirement.

The icon registration is included because `GAME_TYPE_ICONS` is a `Record` keyed by the closed `GAME_TYPES` union; a new game identifier must keep the matching label and icon maps complete.

## Linear closeout

Do not mark HPA-167 Done when the planning PR is opened.

After the documentation implementation merges:

1. re-read HPA-167 and its direct children;
2. verify every non-deferred child is Done and HPA-174/HPA-177 remain intentionally deferred;
3. add one concise closeout comment containing the canonical shipped baseline list and the documentation refresh;
4. mark only HPA-167 Done;
5. re-fetch HPA-167, HPA-174, and HPA-177 to verify the terminal states.

Do not close HPA-174 or HPA-177.

## Validation

This is documentation-only implementation. Full unit/E2E execution is unnecessary unless runtime files accidentally enter the diff.

Required fact checks include:

```bash
test -L AGENTS.md
[ "$(readlink AGENTS.md)" = "CLAUDE.md" ]

test -d src/lib/wallet
test -d src/lib/ai
test -d src/lib/blackjack-run
test -d src/server/blackjack-run
test -d src/lib/mp-poker
test -d src/server/mp
test -d src/lib/missions
test -d src/lib/game-stats
test -d src/lib/achievements
test -d src/lib/leaderboard
test -d src/lib/video-poker
```

Required public-game settlement consumer check:

```bash
rg -l "createPublicGameSettlementController" src/lib \
  | grep -v '/wallet/' \
  | grep -v '\.test\.ts$' \
  | sort
```

The current result should be the four newer game clients for Video Poker, Sic Bo, Three-Card Showdown, and Pai Gow Poker. Documentation must not generalize that into a universal single-player path.

Required documentation formatting check:

```bash
bunx prettier --check README.md CLAUDE.md
```

`docs/superpowers/` is intentionally listed in `.prettierignore`, so the historical planning/spec files are not included in this Prettier command. `AGENTS.md` is also omitted because it is a symlink rather than an independently formatted document.

The implementation plan also includes a direct README-to-CLAUDE consistency check for the shared project tree and database bullet list.

Final scope check:

```bash
git diff --name-only origin/main...HEAD
```

Expected implementation branch changes are limited to:

```text
README.md
CLAUDE.md
docs/superpowers/specs/2026-08-17-architecture-roadmap-closeout-design.md
docs/superpowers/plans/2026-08-17-architecture-roadmap-closeout.md
```

`AGENTS.md` must not appear because its symlink is unchanged.

## Non-goals

- Implement HPA-174 or HPA-177.
- Add another game.
- Refactor existing game modules merely for consistency.
- Refactor older pages solely to make all adapters uniform.
- Move old modules into a new directory layout.
- Add a base game class, plugin architecture, generic session/repository layer, event bus, or service container.
- Add compatibility adapters or migrate historical data.
- Add production-grade security, anti-cheat, durable queues, distributed locking, or recovery machinery.
- Create another architecture/contributor document.
- Run broad cleanup unrelated to stale architecture guidance.

## Definition of done

- `README.md` accurately describes the current modular-monolith boundaries, route groups, progression modules, and persistence at an orientation level.
- `CLAUDE.md` no longer teaches the deleted missions path or the old mandatory class/renderer/deck-manager game template.
- `CLAUDE.md` tells contributors that `AGENTS.md` is its symlink and should not be edited separately.
- The new-game recipe names the real game registration surfaces in `src/lib/game-stats/constants.ts` and `src/pages/index.astro`.
- README and CLAUDE share the same illustrative architecture tree and database bullet list.
- Wallet wording reflects the actual mixed consumers instead of claiming one universal single-player composition.
- No runtime behavior changes.
- HPA-174 and HPA-177 remain deferred.
- After merge, HPA-167 closes with one concise shipped-evidence comment.
