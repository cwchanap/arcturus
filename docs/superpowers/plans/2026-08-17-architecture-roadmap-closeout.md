# HPA-167 Architecture Roadmap Closeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refresh the repository and contributor-facing architecture guidance to match the modular application already shipped, then close HPA-167 without starting a speculative follow-up refactor.

**Architecture:** This is a documentation-only closeout. Keep the existing Astro + Cloudflare Worker + D1 application and all runtime modules unchanged; update `README.md` and `CLAUDE.md`, keep the `AGENTS.md -> CLAUDE.md` symlink unchanged, then close the Linear roadmap while leaving HPA-174 and HPA-177 deferred.

**Tech Stack:** Markdown, Astro 5 repository conventions, Bun/Prettier validation, GitHub, Linear.

## Global Constraints

- No runtime, schema, migration, API, game-rule, AI, settlement, multiplayer, test, or config changes.
- Do not implement HPA-174 or HPA-177.
- Do not create a replacement architecture roadmap or cleanup ticket unless a concrete defect blocks closeout.
- Do not move modules merely to make directory names uniform.
- Shared code remains justified by multiple real consumers, not hypothetical reuse.
- Keep one Astro + Cloudflare Worker + D1 application; do not add services, plugin systems, event buses, service containers, or generic session frameworks.
- `README.md` is an orientation document, not an exhaustive table/file inventory.
- `CLAUDE.md` is contributor guidance, not a mandatory per-game filename template.
- `AGENTS.md` is a Git symlink to `CLAUDE.md`; edit `CLAUDE.md` only and leave the symlink unchanged.
- Prefer thin route/API adapters, but do not refactor older mixed pages solely for consistency in this ticket.
- Do not claim every single-player game uses `createPublicGameSettlementController`; it is a proven newer public-game composition with four current game consumers.
- The implementation diff must stay limited to `README.md`, `CLAUDE.md`, plus the already-added design and plan documents.
- HPA-167 is marked Done only after the documentation implementation merges.
- HPA-174 and HPA-177 remain Backlog after HPA-167 closes.

---

## Task 1: Reconfirm the shipped architecture and registration surfaces

**Files:**
- Read only: `AGENTS.md`
- Read only: `CLAUDE.md`
- Read only: `.prettierignore`
- Read only: `src/lib/wallet/`
- Read only: `src/lib/ai/`
- Read only: `src/lib/blackjack-run/`
- Read only: `src/lib/missions/`
- Read only: `src/lib/game-stats/`
- Read only: `src/lib/achievements/`
- Read only: `src/lib/leaderboard/`
- Read only: `src/lib/mp-poker/`
- Read only: `src/server/blackjack-run/`
- Read only: `src/server/mp/`
- Read only: `src/pages/index.astro`
- Read only: `src/pages/games/index.astro`
- Read only: `src/lib/game-stats/constants.ts`

**Interfaces:**
- Consumes: current `main` architecture and registration facts.
- Produces: verified facts for the documentation edits; no source changes.

- [ ] **Step 1: Verify `AGENTS.md` is the existing symlink, not a second document**

Run:

```bash
test -L AGENTS.md && [ "$(readlink AGENTS.md)" = "CLAUDE.md" ]
git ls-files -s AGENTS.md
```

Expected first command: exit code `0` with no output.

Expected `git ls-files` line begins with symlink mode:

```text
120000
```

Do not replace or rewrite the symlink.

- [ ] **Step 2: Verify every shared architecture boundary named by the docs exists**

Run:

```bash
test -d src/lib/wallet && \
test -d src/lib/ai && \
test -d src/lib/blackjack-run && \
test -d src/server/blackjack-run && \
test -d src/lib/mp-poker && \
test -d src/server/mp && \
test -d src/lib/missions && \
test -d src/lib/game-stats && \
test -d src/lib/achievements && \
test -d src/lib/leaderboard && \
test -d src/lib/video-poker && \
test -d src/lib/sic-bo && \
test -d src/lib/three-card-showdown && \
test -d src/lib/pai-gow-poker
```

Expected: exit code `0` with no output.

If a path is missing on the implementation branch, inspect current `main` before changing the design. Do not create a missing path as part of this ticket.

- [ ] **Step 3: Verify the actual public-game settlement consumers**

Run:

```bash
set -euo pipefail
expected="src/lib/pai-gow-poker/client.ts
src/lib/sic-bo/client.ts
src/lib/three-card-showdown/client.ts
src/lib/video-poker/client.ts"
actual=$(rg -l "createPublicGameSettlementController" src/lib \
  | grep -v '/wallet/' \
  | grep -v '\.test\.ts$' \
  | sort)
[ "$actual" = "$expected" ]
```

Expected: exit code `0` with no output, confirming the four current game consumers:

```text
src/lib/pai-gow-poker/client.ts
src/lib/sic-bo/client.ts
src/lib/three-card-showdown/client.ts
src/lib/video-poker/client.ts
```

If the set changed on current `main`, update `expected` to match the current proven seam before re-running. Do not retrofit unrelated games merely to make the list uniform.

- [ ] **Step 4: Verify the real new-game registration surfaces**

Run:

```bash
rg -n "GAME_TYPES|GAME_TYPE_LABELS|GAME_TYPE_ICONS" src/lib/game-stats/constants.ts
cat src/pages/games/index.astro
rg -n "pai-gow-poker" src/lib/game-stats/constants.ts src/pages/index.astro
```

Confirm:

- `GAME_TYPES` is a closed game-id tuple;
- `GAME_TYPE_LABELS` and `GAME_TYPE_ICONS` are keyed by that tuple;
- `src/pages/games/index.astro` only redirects to `/#games`;
- the latest game is registered in `src/lib/game-stats/constants.ts` and `src/pages/index.astro`.

Do not move registration as part of this documentation closeout.

- [ ] **Step 5: Verify the newer game shape is responsibility-based rather than class-template-based**

Run:

```bash
find src/lib/video-poker -maxdepth 1 -type f -print | sort
```

Confirm the module contains concrete files such as `game.ts`, `evaluator.ts`, `paytable.ts`, `client.ts`, `types.ts`, and focused tests rather than mandatory `GameUIRenderer`, `DeckManager`, `GameSettingsManager`, or LLM files.

---

## Task 2: Refresh README around the shipped modular architecture

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 1 verified facts.
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

Arcturus is a play-money casino and game project built as one Astro application on Cloudflare Workers with D1 persistence. The codebase is intentionally a modular monolith: game rules stay close to each game, while stable shared concerns such as wallet settlement, progression, and optional BYOK AI transport have small focused boundaries.
```

Keep the existing technology/features list below it. Do not rewrite the README into marketing copy.

- [ ] **Step 2: Add a concise `Architecture` section before `Quick Start`**

Insert:

```markdown
## Architecture

Arcturus stays as one deployable Astro + Cloudflare Worker application backed by D1.

- Product code lives primarily in focused `src/lib/<domain>/` modules. Game-specific rules, state transitions, and UI composition stay with the game that owns them.
- Worker-only persistence or orchestration lives under `src/server/<domain>/` when a feature needs it. Prefer thin Astro pages and API routes as adapters; some older game pages still contain more orchestration and are not refactored solely for uniformity.
- `src/lib/wallet/` owns common play-money settlement. Newer public games may compose through `public-game-settlement`; other games use wallet primitives or server settlement directly. Private multiplayer stays room-local.
- `src/lib/ai/` owns browser-local BYOK settings and OpenAI/Gemini transport; game prompts and deterministic strategy remain game-owned.
- `src/lib/blackjack-run/` plus `src/server/blackjack-run/` own the unified Ranked/Daily Blackjack lifecycle.
- `src/lib/mp-poker/` plus `src/server/mp/` keep private-room multiplayer isolated with room-local chips.
- `src/lib/game-stats/`, `src/lib/achievements/`, and `src/lib/leaderboard/` own cross-game statistics, progression, and ranking concerns; new games register with the shared game-stat identifiers instead of inventing game-local statistics identities.
- Newer games such as Video Poker, Sic Bo, Three-Card Showdown, and Pai Gow Poker remain self-contained modules and reuse shared seams only when there is a concrete common contract.

The project deliberately avoids a generic game engine, plugin framework, cross-game session framework, and compatibility infrastructure for hypothetical consumers. Prefer a local implementation first; extract shared code when multiple active consumers prove the same concept is stable.
```

Do not add a diagram, ADR framework, or another architecture document.

- [ ] **Step 3: Replace `Project Structure` with the shared illustrative tree**

Replace the current code block under `## Project Structure` with exactly:

````markdown
```text
/
├── drizzle/                 # D1 migrations
├── public/                  # Static assets
├── src/
│   ├── components/          # Shared Astro presentation components
│   ├── db/
│   │   └── schema.ts        # Application schema source of truth
│   ├── lib/
│   │   ├── achievements/    # Cross-game achievement logic
│   │   ├── ai/              # Browser-local BYOK provider boundary
│   │   ├── blackjack-run/   # Ranked/Daily Blackjack client/domain logic
│   │   ├── game-stats/      # Shared game ids, labels, icons, and statistics
│   │   ├── leaderboard/     # Shared ranking/leaderboard logic
│   │   ├── missions/        # Mission board/progression logic
│   │   ├── mp-poker/        # Pure/private-room multiplayer Poker logic
│   │   ├── wallet/          # Play-money settlement boundary
│   │   └── <game>/          # Focused game-owned modules
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

This same fenced tree is used in `CLAUDE.md` so the two real documentation sources do not drift on the architecture map.

- [ ] **Step 4: Replace the stale `Routes` list with stable route groups**

Replace the existing route list with:

```markdown
## Routes

- `/` - Home page and game lobby
- `/signin` - Google sign-in entry
- `/profile` - Account/profile page
- `/games` - Redirects to the homepage game section (`/#games`); not a separate game index page
- `/games/*` - Individual game routes
- `/api/*` - Application HTTP endpoints

A separate sign-up route is intentionally absent; first-time players start from `/signin` and continue with Google.
```

Do not list every game or endpoint.

- [ ] **Step 5: Replace the auth-only `Database Schema` list with the shared stable wording**

Replace the current table list with exactly:

```markdown
## Database Schema

`src/db/schema.ts` is the source of truth. D1 stores the current application's persistence needs, including:

- Better Auth identity, account, and session data;
- play-money wallet and idempotent settlement data;
- game statistics, missions, and related progression data;
- Blackjack Run persistence for Ranked and Daily modes;
- focused feature data owned by the current application.

Better Auth persists sessions in D1 via `drizzleAdapter`; there is no KV session store.

Do not treat this README as an exhaustive table inventory. Breaking hobby-project schema changes may update the repository and database together without compatibility layers solely for old local data.
```

The bullet list itself stays identical between README and CLAUDE so the Task 4 consistency check passes; the D1-versus-KV note is a non-bullet sentence that does not participate in that comparison.

Additionally, update CLAUDE's `Configuration Files` entry for `wrangler.toml` so it no longer claims a KV binding for sessions. Replace:

```text
- `wrangler.toml`: D1 binding name is `"DB"`, KV binding for sessions
```

With:

```text
- `wrangler.toml`: D1 binding name is `"DB"`; Better Auth persists sessions in D1 via `drizzleAdapter` (no KV session store)
```

The CLAUDE `Database Schema` bullets are left unchanged; only the `Configuration Files` entry is corrected.

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

## Task 3: Refresh `CLAUDE.md` as the single contributor guide

**Files:**
- Modify: `CLAUDE.md`
- Do not modify: `AGENTS.md` (symlink to `CLAUDE.md`)

**Interfaces:**
- Consumes: Task 1 evidence and the same architecture vocabulary used in README.
- Produces: current contributor guidance that no longer teaches the pre-roadmap game template.

- [ ] **Step 1: Update the overview and document the symlink explicitly**

Replace the stale project-overview paragraph with a current concise description of the modular play-money casino/game application.

Add this contributor note immediately after the overview:

```markdown
**Contributor guide alias:** `AGENTS.md` is a Git symlink to this file. Edit `CLAUDE.md` only; do not maintain a second copy.
```

Do not replace the symlink with a regular file.

- [ ] **Step 2: Replace `Project Structure` with the exact same fenced tree as README**

Use exactly:

````markdown
## Project Structure

```text
/
├── drizzle/                 # D1 migrations
├── public/                  # Static assets
├── src/
│   ├── components/          # Shared Astro presentation components
│   ├── db/
│   │   └── schema.ts        # Application schema source of truth
│   ├── lib/
│   │   ├── achievements/    # Cross-game achievement logic
│   │   ├── ai/              # Browser-local BYOK provider boundary
│   │   ├── blackjack-run/   # Ranked/Daily Blackjack client/domain logic
│   │   ├── game-stats/      # Shared game ids, labels, icons, and statistics
│   │   ├── leaderboard/     # Shared ranking/leaderboard logic
│   │   ├── missions/        # Mission board/progression logic
│   │   ├── mp-poker/        # Pure/private-room multiplayer Poker logic
│   │   ├── wallet/          # Play-money settlement boundary
│   │   └── <game>/          # Focused game-owned modules
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

Do not restore an exhaustive Poker/Blackjack/Baccarat class inventory.

- [ ] **Step 3: Replace stale `Key Patterns` architecture items**

Keep unrelated valid items such as Cloudflare binding factories and protected-route examples. Replace the stale architecture items with:

```markdown
4. **Modular Game Logic**: Keep game rules, state, evaluation, payouts, and browser composition under `src/lib/<game>/`, split by real responsibilities. There is no required `Game` class, UI renderer, deck manager, settings manager, or LLM file. Prefer pure domain functions/state where practical and keep game-specific policy local.

5. **Mission System**: Mission board, claim, period, and progress logic lives under `src/lib/missions/`; HTTP endpoints under `src/pages/api/missions/` adapt requests to that module.

6. **AI Integration**: User-configured OpenAI/Gemini settings are stored in browser `localStorage` through `src/lib/ai`; the shared client owns provider transport and each game keeps its own prompts, validation, deterministic strategy, and fallbacks.

7. **Wallet Settlement**: `src/lib/wallet/` is the common play-money settlement boundary. Newer public games may use `createPublicGameSettlementController`; older games and server-authoritative modes may use lower-level wallet APIs directly. Do not retrofit a game solely to make all clients identical. Room-local multiplayer never settles through D1.

8. **Cross-game Progression**: Shared game identifiers/statistics live in `src/lib/game-stats/`, achievements in `src/lib/achievements/`, and ranking/leaderboards in `src/lib/leaderboard/`. New games register with those existing surfaces instead of creating parallel game identity or statistics systems.

9. **Multiplayer Poker Isolation**: Pure multiplayer logic and browser code live in `src/lib/mp-poker/*`. Worker-only room orchestration lives in `src/server/mp/multiplayer-poker-room.ts`; the `MultiplayerPokerRoom` Durable Object is bound as `MULTIPLAYER_POKER_ROOMS`. Multiplayer Poker uses room-local chips and has no D1 settlement.

10. **Route/API Boundaries**: Prefer Astro pages and API routes as thin adapters around product modules. Some older game pages still contain more orchestration; improve those only when concrete feature work needs it rather than opening a uniformity refactor.
```

- [ ] **Step 4: Replace `Database Schema` with the exact same bullets as README**

Use exactly:

```markdown
## Database Schema

`src/db/schema.ts` is the source of truth. D1 stores the current application's persistence needs, including:

- Better Auth identity, account, and session data;
- play-money wallet and idempotent settlement data;
- game statistics, missions, and related progression data;
- Blackjack Run persistence for Ranked and Daily modes;
- focused feature data owned by the current application.

Do not maintain a duplicated exhaustive table inventory here. Breaking hobby-project schema changes may update the repository and database together without compatibility layers solely for old local data.
```

- [ ] **Step 5: Replace `Building New Games` with the concrete local-first recipe**

Replace the current class/template section with:

```markdown
## Building New Games

Use the smallest relevant shipped module as the reference, especially newer focused games such as `src/lib/video-poker/`, `src/lib/sic-bo/`, `src/lib/three-card-showdown/`, or `src/lib/pai-gow-poker/`.

1. Add `src/pages/games/<game>.astro` as the route/UI composition layer. Reuse existing layout, public-session, card-slot, or presentation helpers only when they match the game.
2. Keep game-owned rules, state transitions, evaluation, payouts, and browser behavior under `src/lib/<game>/`. Split files by actual responsibility; there is no mandatory filename or class template.
3. Reuse shared seams such as `src/lib/cards.ts`, wager validation, `src/lib/wallet/`, `src/lib/ai/`, or other neutral helpers only when the existing contract fits. Do not widen a shared API for hypothetical reuse.
4. Keep game-specific phases, prompts, payout policy, wildcard/ranking rules, rendering decisions, and settlement-command mapping local.
5. Register the game: add its id to `GAME_TYPES` and matching label/icon entries to `GAME_TYPE_LABELS` and `GAME_TYPE_ICONS` in `src/lib/game-stats/constants.ts`, then add its lobby card in `src/pages/index.astro`. `src/pages/games/index.astro` is only a redirect to `/#games`. Add focused unit tests plus one representative Playwright journey.
6. Do not add a base game class, generic paytable/session/plugin framework, mandatory settings or LLM layer, compatibility adapter, or new persistence system unless a concrete requirement proves it is needed.

A newer game may use `createPublicGameSettlementController`, but that is not a universal requirement. Choose the smallest existing wallet/public-session seam that fits the concrete game.
```

- [ ] **Step 6: Confirm stale paths/templates are gone from the contributor guide**

Run:

```bash
! rg -n "src/lib/missions\.ts|YourGameUIRenderer|GameSettingsManager|llmYourGameStrategy" CLAUDE.md
rg -n "src/lib/game-stats/constants\.ts|src/pages/index\.astro|AGENTS\.md.*symlink" CLAUDE.md
```

Expected first command: exit code `0` with no matches.

Expected second command: matches the registration recipe and symlink note.

---

## Task 4: Validate the documentation-only closeout

**Files:**
- Validate: `README.md`
- Validate: `CLAUDE.md`
- Verify unchanged symlink: `AGENTS.md`

**Interfaces:**
- Consumes: completed README and CLAUDE edits.
- Produces: evidence that the closeout is accurate, internally aligned, and documentation-only.

- [ ] **Step 1: Format-check only files Prettier actually owns**

Run:

```bash
bunx prettier --check README.md CLAUDE.md
```

Expected:

```text
All matched files use Prettier code style!
```

`docs/superpowers/` is intentionally listed in `.prettierignore`, so the historical plan/spec files are not part of this formatting check. `AGENTS.md` is a symlink and is not passed as an explicit Prettier target.

If formatting fails, run:

```bash
bunx prettier --write README.md CLAUDE.md
bunx prettier --check README.md CLAUDE.md
```

- [ ] **Step 2: Verify README and CLAUDE share the same architecture tree and database bullets**

Run:

```bash
python - <<'PY'
from pathlib import Path


def section(text: str, heading: str) -> str:
    marker = f"## {heading}\n"
    start = text.index(marker) + len(marker)
    end = text.find("\n## ", start)
    return text[start:] if end == -1 else text[start:end]


def text_tree(text: str) -> str:
    body = section(text, "Project Structure")
    start = body.index("```text\n")
    end = body.index("\n```", start) + len("\n```")
    return body[start:end]


def db_bullets(text: str) -> list[str]:
    body = section(text, "Database Schema")
    return [line for line in body.splitlines() if line.startswith("- ")]

readme = Path("README.md").read_text()
claude = Path("CLAUDE.md").read_text()

assert text_tree(readme) == text_tree(claude), "Project Structure trees drifted"
assert db_bullets(readme) == db_bullets(claude), "Database Schema bullets drifted"
PY
```

Expected: exit code `0` with no output.

This replaces the previous inert CLAUDE-to-AGENTS comparison; the symlink already guarantees those two paths resolve to the same content.

- [ ] **Step 3: Re-verify the symlink remained unchanged**

Run:

```bash
test -L AGENTS.md && [ "$(readlink AGENTS.md)" = "CLAUDE.md" ]
git diff -- AGENTS.md
```

Expected: first command exits `0`; second command produces no diff.

- [ ] **Step 4: Verify implementation scope**

Run:

```bash
git diff --name-only origin/main...HEAD
```

Expected paths only:

```text
CLAUDE.md
README.md
docs/superpowers/plans/2026-08-17-architecture-roadmap-closeout.md
docs/superpowers/specs/2026-08-17-architecture-roadmap-closeout-design.md
```

Then run:

```bash
git diff --check
```

Expected: no whitespace errors.

Do not run the full unit or Playwright suite for this documentation-only change. If runtime/config/schema/test files appear, remove those changes unless a separately reviewed concrete defect requires them.

- [ ] **Step 5: Commit the documentation implementation**

```bash
git add README.md CLAUDE.md
git commit -m "docs: close out architecture roadmap"
```

Expected: one documentation implementation commit; the planning documents are already committed on the branch.

---

## Task 5: Close HPA-167 after the documentation PR merges

**Files:**
- Modify: none in the repository.
- Linear: `HPA-167`
- Linear evidence: direct children of `HPA-167`

**Interfaces:**
- Consumes: merged documentation closeout plus current HPA-167 child states.
- Produces: HPA-167 in `Done`, with HPA-174 and HPA-177 still in `Backlog`.

- [ ] **Step 1: Re-read HPA-167 and all direct children after merge**

Using the connected Linear tools, fetch HPA-167 and its direct children.

Expected:

- every non-deferred active architecture/game-validation child is `Done`;
- HPA-174 is `Backlog`;
- HPA-177 is `Backlog`;
- canceled/duplicate social or multiplayer expansions do not block closeout.

Do not copy another hard-coded child-id checklist into this verification step; the closeout comment below is the canonical shipped-baseline list.

- [ ] **Step 2: Verify the deferred issue descriptions still contain their evidence gates**

Read HPA-174 and confirm it still requires a concrete need to reopen completed Blackjack runs.

Read HPA-177 and confirm it still requires repeated multi-day Daily participation or a direct request for weekly comparison.

If either issue was intentionally promoted by a later product decision, do not silently close the roadmap; reassess against that new evidence.

- [ ] **Step 3: Add one canonical HPA-167 closeout comment**

Post this comment, replacing `<PR>` with the merged closeout PR number:

```markdown
Architecture roadmap closeout is complete.

Shipped baseline:
- HPA-542 isolated private-room Poker from the persistent wallet.
- HPA-545 established the focused wallet settlement boundary.
- HPA-185 established the browser-local BYOK AI boundary.
- HPA-195 proved the clean new-game module path with Video Poker.
- HPA-553 unified Ranked/Daily Blackjack behind `blackjack-run`.
- HPA-196, HPA-198, and HPA-197 subsequently added Sic Bo, Three-Card Showdown, and Pai Gow Poker without a generic game framework.
- <PR> refreshed README and the CLAUDE/AGENTS contributor guidance to document the resulting modular-monolith boundaries and real new-game registration surfaces.

HPA-174 and HPA-177 remain intentionally deferred until their existing product-evidence triggers are met. No replacement architecture epic is needed now.
```

`AGENTS.md` in that comment refers to the contributor-facing alias; the repository change itself edits `CLAUDE.md` only because `AGENTS.md` remains its symlink.

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

This is the terminal state for the architecture roadmap. Future architecture work starts from a concrete feature or maintenance problem rather than reopening HPA-167 by default.
