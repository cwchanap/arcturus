# HPA-167 Architecture Roadmap Closeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refresh the repository and contributor-facing architecture guidance to match the modular application already shipped, then close HPA-167 without starting a speculative follow-up refactor.

**Architecture:** This is a documentation-only closeout. Keep the existing Astro + Cloudflare Worker + D1 application and all runtime modules unchanged; update `README.md`, `CLAUDE.md`, and `AGENTS.md` to describe the current module boundaries and local-first new-game recipe, then use shipped child-issue evidence to close the Linear roadmap while leaving HPA-174 and HPA-177 deferred.

**Tech Stack:** Markdown, Astro 5 repository conventions, Bun/Prettier validation, GitHub, Linear.

## Global Constraints

- No runtime, schema, migration, API, game-rule, AI, settlement, or multiplayer behavior changes.
- Do not implement HPA-174 or HPA-177.
- Do not create a replacement architecture roadmap or cleanup ticket unless validation finds a concrete defect that blocks this closeout.
- Do not move modules merely to make directory names uniform.
- Shared code remains justified by multiple real consumers, not hypothetical reuse.
- Keep one Astro + Cloudflare Worker + D1 application; do not add services, plugin systems, event buses, service containers, or generic session frameworks.
- `README.md` is an orientation document, not an exhaustive table/file inventory.
- `CLAUDE.md` and `AGENTS.md` are contributor guidance, not a mandatory per-game filename template.
- Prefer thin route/API adapters, but do not refactor older mixed pages solely for consistency in this ticket.
- Do not claim every single-player game uses `createPublicGameSettlementController`; it is a proven newer public-game composition with four current game consumers.
- The implementation diff must stay limited to `README.md`, `CLAUDE.md`, `AGENTS.md`, plus the already-added design and plan documents.
- HPA-167 is marked Done only after the documentation implementation merges.
- HPA-174 and HPA-177 remain Backlog after HPA-167 closes.

---

## Task 1: Reconfirm the shipped architecture before editing guidance

**Files:**
- Read only: `src/lib/wallet/`
- Read only: `src/lib/ai/`
- Read only: `src/lib/blackjack-run/`
- Read only: `src/server/blackjack-run/`
- Read only: `src/lib/mp-poker/`
- Read only: `src/server/mp/`
- Read only: `src/lib/missions/`
- Read only: `src/lib/video-poker/`
- Read only: `src/lib/sic-bo/`
- Read only: `src/lib/three-card-showdown/`
- Read only: `src/lib/pai-gow-poker/`

**Interfaces:**
- Consumes: current `main` module boundaries.
- Produces: verified facts for the documentation edits; no source changes.

- [ ] **Step 1: Verify every named architecture boundary exists**

Run:

```bash
test -d src/lib/wallet && \
test -d src/lib/ai && \
test -d src/lib/blackjack-run && \
test -d src/server/blackjack-run && \
test -d src/lib/mp-poker && \
test -d src/server/mp && \
test -d src/lib/missions && \
test -d src/lib/video-poker && \
test -d src/lib/sic-bo && \
test -d src/lib/three-card-showdown && \
test -d src/lib/pai-gow-poker
```

Expected: exit code `0` with no output.

If one of these paths is missing on the implementation branch, inspect current `main` before changing the design. Do not create a missing path as part of this ticket.

- [ ] **Step 2: Verify the actual public-game settlement consumers**

Run:

```bash
rg -l "createPublicGameSettlementController" src/lib \
  | grep -v '/wallet/' \
  | grep -v '\.test\.ts$' \
  | sort
```

Expected current game consumers:

```text
src/lib/pai-gow-poker/client.ts
src/lib/sic-bo/client.ts
src/lib/three-card-showdown/client.ts
src/lib/video-poker/client.ts
```

If the set changed on current `main`, document the current proven seam accurately. Do not retrofit unrelated games merely to make the list uniform.

- [ ] **Step 3: Verify the newer game recipe is responsibility-based, not class-template-based**

Run:

```bash
find src/lib/video-poker -maxdepth 1 -type f -print | sort
```

Confirm the module is organized around concrete responsibilities such as `game.ts`, `evaluator.ts`, `paytable.ts`, `client.ts`, `types.ts`, and focused tests rather than mandatory `GameUIRenderer`, `DeckManager`, `GameSettingsManager`, or LLM files.

Do not create or rename files as part of this check.

---

## Task 2: Refresh README around the shipped modular architecture

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 1 evidence.
- Produces: current repository orientation for human contributors; no runtime interface changes.

- [ ] **Step 1: Replace the starter-era title and opening description**

Replace:

```markdown
# Arcturus - Astro with Authentication

An Astro project with Better Auth, Drizzle ORM, and Cloudflare D1 database integration, ready to deploy on Cloudflare Workers.
```

With:

```markdown
# Arcturus

Arcturus is a play-money casino and game project built as one Astro application on Cloudflare Workers with D1 persistence. The codebase is intentionally a modular monolith: game rules stay close to each game, while stable shared concerns such as wallet settlement and optional BYOK AI transport have small focused boundaries.
```

Keep the existing technology/features list below it. Do not rewrite the README into marketing copy.

- [ ] **Step 2: Add a concise `Architecture` section before `Quick Start`**

Insert:

```markdown
## Architecture

Arcturus stays as one deployable Astro + Cloudflare Worker application backed by D1.

- Product code lives primarily in focused `src/lib/<domain>/` modules. Game-specific rules, state transitions, and UI composition stay with the game that owns them.
- Worker-only persistence or orchestration lives under `src/server/<domain>/` when a feature needs it. Prefer thin Astro pages and API routes as adapters; some older game pages still contain more orchestration and are not refactored solely for uniformity.
- `src/lib/wallet/` owns play-money settlement. Newer public games may compose through `public-game-settlement`; other games use the wallet primitives or server settlement directly. Private multiplayer stays room-local.
- `src/lib/ai/` owns browser-local BYOK settings and OpenAI/Gemini transport; game prompts and deterministic strategy remain game-owned.
- `src/lib/blackjack-run/` plus `src/server/blackjack-run/` own the unified Ranked/Daily Blackjack lifecycle.
- `src/lib/mp-poker/` plus `src/server/mp/` keep private-room multiplayer isolated with room-local chips.
- Newer games such as Video Poker, Sic Bo, Three-Card Showdown, and Pai Gow Poker remain self-contained modules and reuse shared seams only when there is a concrete common contract.

The project deliberately avoids a generic game engine, plugin framework, cross-game session framework, and compatibility infrastructure for hypothetical consumers. Prefer a local implementation first; extract shared code when multiple active consumers prove the same concept is stable.
```

Do not add a diagram, ADR framework, or another architecture document.

- [ ] **Step 3: Replace the stale `Project Structure` example with the modular shape**

Replace the current code block under `## Project Structure` with:

````markdown
```text
/
├── drizzle/                 # D1 migrations
├── public/                  # Static assets
├── src/
│   ├── components/          # Shared Astro presentation components
│   ├── db/
│   │   └── schema.ts        # Application schema
│   ├── lib/
│   │   ├── ai/              # Browser-local BYOK provider boundary
│   │   ├── blackjack-run/   # Shared Ranked/Daily Blackjack client/domain logic
│   │   ├── missions/        # Mission board/progression logic
│   │   ├── wallet/          # Play-money settlement boundary
│   │   ├── mp-poker/        # Pure/private-room multiplayer Poker logic
│   │   └── <game>/          # Focused game modules such as video-poker or sic-bo
│   ├── pages/
│   │   ├── api/             # HTTP adapters
│   │   └── games/           # Astro game routes
│   ├── server/
│   │   ├── blackjack-run/   # Blackjack Run persistence/application services
│   │   └── mp/              # Multiplayer Durable Object orchestration
│   ├── middleware.ts        # Auth/session request enrichment
│   └── styles/
│       └── global.css
├── astro.config.mjs
├── drizzle.config.ts
├── wrangler.toml
└── tsconfig.json
```
````

The tree is intentionally illustrative. Do not enumerate every game, route, migration, table, or test directory.

- [ ] **Step 4: Replace the stale `Routes` list with stable route groups**

Replace the existing route list with:

```markdown
## Routes

- `/` - Home page
- `/signin` - Google sign-in entry
- `/profile` - Account/profile page
- `/games` and `/games/*` - Game lobby and game routes
- `/api/*` - Application HTTP endpoints

A separate sign-up route is intentionally absent; first-time players start from `/signin` and continue with Google.
```

Do not list every game or endpoint.

- [ ] **Step 5: Replace the auth-only `Database Schema` list with stable application-level wording**

Replace the current table list with:

```markdown
## Database Schema

D1 stores the current application's persistence needs, including:

- Better Auth identity, account, and session data;
- the play-money wallet and idempotent settlement records;
- game statistics, missions, and related progression data;
- the unified Blackjack Run persistence used by Ranked and Daily modes;
- focused feature data that belongs to the current application.

`src/db/schema.ts` is the source of truth. The schema may evolve with breaking hobby-project changes; the repository does not preserve compatibility layers solely for old local data.
```

Do not add an exhaustive table-name inventory.

- [ ] **Step 6: Keep Multiplayer Poker facts intact**

Confirm the existing Multiplayer Poker section still communicates:

```text
src/lib/mp-poker/*
src/server/mp/multiplayer-poker-room.ts
MULTIPLAYER_POKER_ROOMS
room-local chips; no D1 settlement for multiplayer poker
```

Small wording edits are allowed to avoid duplication, but do not remove these facts.

---

## Task 3: Refresh CLAUDE.md and AGENTS.md contributor guidance

**Files:**
- Modify: `CLAUDE.md`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: Task 1 evidence and the same architecture vocabulary used in README.
- Produces: aligned contributor guidance that no longer teaches the pre-roadmap game template.

- [ ] **Step 1: Replace `Project Structure` in both files with the current illustrative tree**

Use the same structure in both files:

````markdown
## Project Structure

```text
src/
├── components/           # Shared Astro presentation components
├── layouts/              # Shared page layouts
├── pages/
│   ├── games/            # Game lobby and game routes
│   └── api/              # HTTP adapters
├── lib/
│   ├── ai/               # Browser-local BYOK settings/provider transport
│   ├── blackjack-run/    # Ranked/Daily Blackjack client/domain logic
│   ├── missions/         # Mission board/progression logic
│   ├── wallet/           # Play-money settlement boundary
│   ├── mp-poker/         # Pure/private-room multiplayer Poker logic
│   └── <game>/           # Focused game-owned modules
├── db/
│   └── schema.ts         # Drizzle schema; persistence source of truth
├── server/
│   ├── blackjack-run/    # Blackjack Run application/persistence services
│   └── mp/               # Multiplayer Durable Object orchestration
├── middleware.ts         # Auth/session request enrichment
└── styles/
    └── global.css

e2e/                      # Playwright E2E journeys
drizzle/                  # Generated SQL migrations
```
````

Do not enumerate Poker/Blackjack/Baccarat internal class files or every newer game.

- [ ] **Step 2: Replace stale `Key Patterns` items in both files**

Keep unrelated valid items such as Cloudflare binding factories and protected-route examples. Replace the stale architecture items with this guidance:

```markdown
4. **Modular Game Logic**: Keep game rules, state, evaluation, and browser composition under `src/lib/<game>/`, split by real responsibilities. There is no required `Game` class, UI renderer, deck manager, settings manager, or LLM file. Prefer pure domain functions/state where practical and keep game-specific policy local.

5. **Mission System**: Mission board, claim, period, and progress logic lives under `src/lib/missions/`; HTTP endpoints under `src/pages/api/missions/` adapt requests to that module.

6. **AI Integration**: User-configured OpenAI/Gemini settings are stored in browser `localStorage` through `src/lib/ai`; the shared client owns provider transport and each game keeps its own prompts, validation, deterministic strategy, and fallbacks.

7. **Wallet Settlement**: `src/lib/wallet/` is the common play-money settlement boundary. Newer public games may use `createPublicGameSettlementController`; older games and server-authoritative modes may use lower-level wallet APIs directly. Do not retrofit a game solely to make all clients identical. Room-local multiplayer never settles through D1.

8. **Multiplayer Poker Isolation**: Pure multiplayer logic and browser code live in `src/lib/mp-poker/*`. Worker-only room orchestration lives in `src/server/mp/multiplayer-poker-room.ts`; the `MultiplayerPokerRoom` Durable Object is bound as `MULTIPLAYER_POKER_ROOMS`. Multiplayer Poker uses room-local chips and has no D1 settlement.

9. **Route/API Boundaries**: Prefer Astro pages and API routes as thin adapters around product modules. Some older game pages still contain more orchestration; improve those only when concrete feature work needs it rather than opening a uniformity refactor.
```

Do not create a generic route/controller layer.

- [ ] **Step 3: Replace `Database Schema` in both files**

Use:

```markdown
## Database Schema

`src/db/schema.ts` is the source of truth. D1 currently stores several kinds of application data:

- Better Auth identity, account, and session data;
- play-money wallet and idempotent settlement data;
- game statistics, missions, and related progression data;
- Blackjack Run persistence for Ranked and Daily modes;
- focused feature data owned by the current application.

Do not maintain a duplicated exhaustive table inventory here. Breaking hobby-project schema changes may update the repository and database together without compatibility layers for old local data.
```

- [ ] **Step 4: Replace `Building New Games` in both files with the local-first recipe**

Replace the existing class/template section with:

````markdown
## Building New Games

Use the smallest relevant shipped module as the reference, especially newer focused games such as `src/lib/video-poker/`, `src/lib/sic-bo/`, `src/lib/three-card-showdown/`, or `src/lib/pai-gow-poker/`.

1. Add `src/pages/games/<game>.astro` as the route/UI composition layer. Reuse existing layout, public-session, card-slot, or presentation helpers only when they match the game.
2. Keep game-owned rules, state transitions, evaluation, payouts, and browser behavior under `src/lib/<game>/`. Split files by actual responsibility; there is no mandatory filename or class template.
3. Reuse shared seams such as `src/lib/cards.ts`, wager validation, `src/lib/wallet/`, `src/lib/ai/`, or other neutral helpers only when the existing contract fits. Do not widen a shared API for hypothetical reuse.
4. Keep game-specific phases, prompts, payout policy, wildcard/ranking rules, rendering decisions, and settlement-command mapping local.
5. Add focused unit tests for pure rules/state and one representative Playwright journey for the major user flow. Register the game in lobby/statistics surfaces that actually apply.
6. Do not add a base game class, generic paytable/session/plugin framework, mandatory settings or LLM layer, compatibility adapter, or new persistence system unless a concrete requirement proves it is needed.

A newer game may use `createPublicGameSettlementController`, but that is not a universal requirement. Choose the existing wallet seam that matches the concrete game instead of retrofitting unrelated games for uniformity.
````

- [ ] **Step 5: Remove stale contributor claims that contradict the new sections**

Run:

```bash
rg -n "src/lib/missions\.ts|Each game follows the same structure|Create a modular game structure following the established pattern" CLAUDE.md AGENTS.md
```

Expected: no matches.

If a stale claim remains, update the guidance. Do not delete references to legacy classes when they describe actual existing legacy code outside the architecture/new-game guidance.

- [ ] **Step 6: Verify the refreshed architecture sections stay aligned between the two contributor guides**

Run:

```bash
python - <<'PY'
from pathlib import Path

HEADINGS = ['Project Structure', 'Key Patterns', 'Database Schema', 'Building New Games']


def section(text: str, heading: str) -> str:
    marker = f'## {heading}\n'
    start = text.index(marker)
    next_heading = text.find('\n## ', start + len(marker))
    return text[start:] if next_heading == -1 else text[start:next_heading]

claude = Path('CLAUDE.md').read_text()
agents = Path('AGENTS.md').read_text()
for heading in HEADINGS:
    assert section(claude, heading) == section(agents, heading), heading
PY
```

Expected: exit code `0` with no output.

Do not require the two files to be globally byte-identical; only these refreshed architecture sections are required to match.

---

## Task 4: Validate the documentation-only implementation

**Files:**
- Modify: none beyond Tasks 2-3 and the planning docs.

**Interfaces:**
- Consumes: completed README/contributor-guide edits.
- Produces: a reviewable docs-only PR diff.

- [ ] **Step 1: Format-check all changed Markdown**

Run:

```bash
bunx prettier --check README.md CLAUDE.md AGENTS.md \
  docs/superpowers/specs/2026-08-17-architecture-roadmap-closeout-design.md \
  docs/superpowers/plans/2026-08-17-architecture-roadmap-closeout.md
```

Expected: all five files pass Prettier.

If formatting fails, run the same paths through `bunx prettier --write`, then rerun the check.

- [ ] **Step 2: Re-run the settlement-consumer check after edits**

Run:

```bash
rg -l "createPublicGameSettlementController" src/lib \
  | grep -v '/wallet/' \
  | grep -v '\.test\.ts$' \
  | sort
```

Confirm README/CLAUDE/AGENTS wording still describes the actual set as a newer-game composition rather than the universal single-player path.

- [ ] **Step 3: Verify the implementation did not expand into runtime work**

Run:

```bash
git diff --name-only origin/main...HEAD
```

Expected paths only:

```text
README.md
CLAUDE.md
AGENTS.md
docs/superpowers/plans/2026-08-17-architecture-roadmap-closeout.md
docs/superpowers/specs/2026-08-17-architecture-roadmap-closeout-design.md
```

Then run:

```bash
git diff --check
```

Expected: no whitespace errors.

Do not run the full unit or Playwright suite for this documentation-only change. If the diff contains runtime/config/schema/test files, stop and remove those changes unless a separately reviewed concrete defect requires them.

- [ ] **Step 4: Commit the closeout documentation implementation**

```bash
git add README.md CLAUDE.md AGENTS.md \
  docs/superpowers/specs/2026-08-17-architecture-roadmap-closeout-design.md \
  docs/superpowers/plans/2026-08-17-architecture-roadmap-closeout.md
git commit -m "docs: close out architecture roadmap"
```

Expected: one documentation implementation commit; earlier planning commits may already exist on the branch.

---

## Task 5: Close HPA-167 after the documentation PR merges

**Files:**
- Modify: none in the repository.
- Linear: `HPA-167`
- Linear evidence: children of `HPA-167`

**Interfaces:**
- Consumes: merged documentation closeout plus current HPA-167 child statuses.
- Produces: HPA-167 in `Done`, with HPA-174 and HPA-177 still in `Backlog`.

- [ ] **Step 1: Re-read HPA-167 and all direct children after merge**

Using the connected Linear tools, fetch HPA-167 and list issues with `parentId = HPA-167`.

Expected concrete architecture/game-validation children to be Done:

```text
HPA-542
HPA-545
HPA-185
HPA-195
HPA-553
HPA-196
HPA-198
HPA-197
```

Expected intentionally deferred children:

```text
HPA-174 -> Backlog
HPA-177 -> Backlog
```

Canceled social/multiplayer expansions do not block closeout.

- [ ] **Step 2: Verify the deferred issue descriptions still contain their evidence gates**

Read HPA-174 and confirm it still requires a concrete need to reopen completed Blackjack runs.

Read HPA-177 and confirm it still requires repeated multi-day Daily participation or a direct request for weekly comparison.

If either ticket was intentionally promoted by a later product decision, do not silently close the roadmap; reassess the closeout against that new evidence.

- [ ] **Step 3: Add one HPA-167 closeout comment**

Post this concise comment, replacing `<PR>` with the merged closeout PR number:

```markdown
Architecture roadmap closeout is complete.

Shipped baseline:
- HPA-542 isolated private-room Poker from the persistent wallet.
- HPA-545 established the focused wallet settlement boundary.
- HPA-185 established the browser-local BYOK AI boundary.
- HPA-195 proved the clean new-game module path with Video Poker.
- HPA-553 unified Ranked/Daily Blackjack behind `blackjack-run`.
- HPA-196, HPA-198, and HPA-197 subsequently added Sic Bo, Three-Card Showdown, and Pai Gow Poker without a generic game framework.
- <PR> refreshed README plus the contributor guides to document the resulting modular-monolith boundaries and local-first new-game recipe.

HPA-174 and HPA-177 remain intentionally deferred until their existing product-evidence triggers are met. No replacement architecture epic is needed now.
```

Do not add a new umbrella issue as part of this action.

- [ ] **Step 4: Mark only HPA-167 Done**

Update HPA-167 to the team's `Done` state.

Do not change the state of HPA-174 or HPA-177.

- [ ] **Step 5: Final Linear verification**

Re-fetch HPA-167, HPA-174, and HPA-177.

Expected:

```text
HPA-167 -> Done
HPA-174 -> Backlog
HPA-177 -> Backlog
```

This is the terminal state for the roadmap. Future architecture work starts from a concrete feature or maintenance problem, not by reopening HPA-167 by default.
