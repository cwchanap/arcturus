# HPA-167 Architecture Roadmap Closeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refresh the top-level repository architecture documentation to match the modular application already shipped, then close HPA-167 without starting a speculative follow-up refactor.

**Architecture:** This is a documentation-only closeout. Keep the existing Astro + Cloudflare Worker + D1 application and all runtime modules unchanged; update `README.md` to describe the current module boundaries, then use shipped child-issue evidence to close the Linear roadmap while leaving HPA-174 and HPA-177 deferred.

**Tech Stack:** Markdown, Astro 5 repository conventions, Bun/Prettier validation, GitHub, Linear.

## Global Constraints

- No runtime, schema, migration, API, game-rule, AI, settlement, or multiplayer behavior changes.
- Do not implement HPA-174 or HPA-177.
- Do not create a replacement architecture roadmap or cleanup ticket unless validation finds a concrete defect that blocks this closeout.
- Do not move modules merely to make directory names uniform.
- Shared code remains justified by multiple real consumers, not hypothetical reuse.
- Keep one Astro + Cloudflare Worker + D1 application; do not add services, plugin systems, event buses, service containers, or generic session frameworks.
- `README.md` is an orientation document, not an exhaustive table/file inventory.
- The implementation diff must stay limited to `README.md` plus the already-added design and plan documents.
- HPA-167 is marked Done only after the README implementation merges.
- HPA-174 and HPA-177 remain Backlog after HPA-167 closes.

---

## Task 1: Refresh the README around the shipped modular architecture

**Files:**
- Modify: `README.md`
- Existing evidence only: `src/lib/wallet/`
- Existing evidence only: `src/lib/ai/`
- Existing evidence only: `src/lib/blackjack-run/`
- Existing evidence only: `src/server/blackjack-run/`
- Existing evidence only: `src/lib/mp-poker/`
- Existing evidence only: `src/server/mp/`
- Existing evidence only: `src/lib/video-poker/`
- Existing evidence only: `src/lib/sic-bo/`
- Existing evidence only: `src/lib/three-card-showdown/`
- Existing evidence only: `src/lib/pai-gow-poker/`

**Interfaces:**
- Consumes: the existing module boundaries already shipped on `main`.
- Produces: one current top-level architecture description for contributors; no runtime interface changes.

- [ ] **Step 1: Verify every architecture boundary named by the README exists before documenting it**

Run:

```bash
test -d src/lib/wallet && \
test -d src/lib/ai && \
test -d src/lib/blackjack-run && \
test -d src/server/blackjack-run && \
test -d src/lib/mp-poker && \
test -d src/server/mp && \
test -d src/lib/video-poker && \
test -d src/lib/sic-bo && \
test -d src/lib/three-card-showdown && \
test -d src/lib/pai-gow-poker
```

Expected: exit code `0` with no output.

If one of these paths is missing on the implementation branch, inspect current `main` before changing the design. Do not create the missing path as part of this ticket.

- [ ] **Step 2: Replace the starter-era title and opening description**

Change:

```markdown
# Arcturus - Astro with Authentication

An Astro project with Better Auth, Drizzle ORM, and Cloudflare D1 database integration, ready to deploy on Cloudflare Workers.
```

To:

```markdown
# Arcturus

Arcturus is a play-money casino and game project built as one Astro application on Cloudflare Workers with D1 persistence. The codebase is intentionally a modular monolith: game rules stay close to each game, while stable shared concerns such as wallet settlement and optional BYOK AI transport have small focused boundaries.
```

Keep the existing technology/features list below it. Do not rewrite the README into marketing copy.

- [ ] **Step 3: Add a concise `Architecture` section before `Quick Start`**

Insert exactly this shape after the existing Features list:

```markdown
## Architecture

Arcturus stays as one deployable Astro + Cloudflare Worker application backed by D1.

- Product code lives primarily in focused `src/lib/<domain>/` modules. Game-specific rules, state transitions, and UI composition stay with the game that owns them.
- Worker-only persistence or orchestration lives under `src/server/<domain>/` when a feature needs it. Astro pages and API routes are adapters rather than a second business-logic layer.
- `src/lib/wallet/` owns play-money settlement and the shared public-game settlement composition used by single-player games.
- `src/lib/ai/` owns browser-local BYOK settings and OpenAI/Gemini transport; game prompts and deterministic strategy remain game-owned.
- `src/lib/blackjack-run/` plus `src/server/blackjack-run/` own the unified Ranked/Daily Blackjack lifecycle.
- `src/lib/mp-poker/` plus `src/server/mp/` keep private-room multiplayer isolated with room-local chips.
- Newer games such as Video Poker, Sic Bo, Three-Card Showdown, and Pai Gow Poker remain self-contained modules and reuse shared seams only when there is a concrete common contract.

The project deliberately avoids a generic game engine, plugin framework, cross-game session framework, and compatibility infrastructure for hypothetical consumers. Prefer a local implementation first; extract shared code when multiple active consumers prove the same concept is stable.
```

Do not add a diagram, ADR framework, or a second architecture document in this ticket.

- [ ] **Step 4: Replace the stale `Project Structure` example with the modular shape**

Replace the current `## Project Structure` code block with:

````markdown
## Project Structure

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
│   │   ├── wallet/          # Play-money settlement boundary
│   │   ├── mp-poker/        # Pure/private-room multiplayer Poker logic
│   │   └── <game>/          # Focused game modules such as video-poker or sic-bo
│   ├── pages/
│   │   ├── api/             # Thin HTTP adapters
│   │   └── games/           # Astro game routes
│   ├── server/
│   │   ├── blackjack-run/   # Blackjack Run persistence/application services
│   │   └── mp/              # Multiplayer Durable Object orchestration
│   └── styles/
│       └── global.css
├── astro.config.mjs
├── drizzle.config.ts
├── wrangler.toml
└── tsconfig.json
```
````

The tree is intentionally illustrative. Do not enumerate every game, route, migration, or test directory.

- [ ] **Step 5: Replace the auth-only `Database Schema` list with stable application-level wording**

Replace:

```markdown
## Database Schema

The project includes tables for:

- **users** - User accounts
- **sessions** - Active sessions
- **accounts** - OAuth provider accounts
- **verification** - Email verification tokens
```

With:

```markdown
## Database Schema

D1 stores the current application's persistence needs, including:

- Better Auth identity, account, and session data;
- the play-money wallet and idempotent settlement records;
- game statistics, missions, and related progression data;
- the unified Blackjack Run persistence used by Ranked and Daily modes;
- focused feature data that belongs to the current application.

The schema is intentionally allowed to evolve with breaking hobby-project changes; the repository does not preserve compatibility layers solely for old local data.
```

Do not add an exhaustive table-name inventory.

- [ ] **Step 6: Keep the existing Multiplayer Poker section and verify it still matches the architecture summary**

Confirm these statements remain present and unchanged in meaning:

```text
src/lib/mp-poker/*
src/server/mp/multiplayer-poker-room.ts
MULTIPLAYER_POKER_ROOMS
room-local chips; no D1 settlement for multiplayer poker
```

If wording needs a small edit to avoid duplication with the new Architecture section, preserve all four facts above.

- [ ] **Step 7: Format-check the changed documentation**

Run:

```bash
bunx prettier --check README.md \
  docs/superpowers/specs/2026-08-17-architecture-roadmap-closeout-design.md \
  docs/superpowers/plans/2026-08-17-architecture-roadmap-closeout.md
```

Expected: all three files pass Prettier.

If formatting fails, run:

```bash
bunx prettier --write README.md \
  docs/superpowers/specs/2026-08-17-architecture-roadmap-closeout-design.md \
  docs/superpowers/plans/2026-08-17-architecture-roadmap-closeout.md
```

Then rerun the check.

- [ ] **Step 8: Verify the implementation did not expand into runtime work**

Run:

```bash
git diff --name-only origin/main...HEAD
```

Expected paths only:

```text
README.md
docs/superpowers/plans/2026-08-17-architecture-roadmap-closeout.md
docs/superpowers/specs/2026-08-17-architecture-roadmap-closeout-design.md
```

Then run:

```bash
git diff --check
```

Expected: no whitespace errors.

Do not run the full unit or Playwright suite for this documentation-only change. If the diff contains runtime/config/schema/test files, stop and remove those changes unless a separately reviewed concrete defect requires them.

- [ ] **Step 9: Commit the README closeout implementation**

```bash
git add README.md \
  docs/superpowers/specs/2026-08-17-architecture-roadmap-closeout-design.md \
  docs/superpowers/plans/2026-08-17-architecture-roadmap-closeout.md
git commit -m "docs: close out architecture roadmap"
```

Expected: one documentation commit for the implementation phase; the design branch may already contain earlier doc commits from planning.

---

## Task 2: Close HPA-167 after the documentation PR merges

**Files:**
- Modify: none in the repository.
- Linear: `HPA-167`
- Linear evidence: children of `HPA-167`

**Interfaces:**
- Consumes: merged README closeout plus the existing HPA-167 child statuses.
- Produces: HPA-167 in `Done`, with HPA-174 and HPA-177 still in `Backlog`.

- [ ] **Step 1: Re-read HPA-167 and all direct children after merge**

Using the connected Linear tools, fetch `HPA-167` and list issues with `parentId = HPA-167`.

Expected concrete architecture children to be Done:

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
- <PR> refreshed the README to document the resulting modular-monolith boundaries.

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
