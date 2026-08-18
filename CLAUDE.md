# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Arcturus is a play-money casino and game project built as one Astro application on Cloudflare Workers with D1 persistence. The codebase is intentionally a modular monolith: game rules stay close to each game, while stable shared concerns such as wallet settlement, progression, and optional BYOK AI transport have small focused boundaries.

**Contributor guide alias:** `AGENTS.md` is a Git symlink to this file. Edit `CLAUDE.md` only; do not maintain a second copy.

## Critical Architecture Rules

**Runtime Environment**: Cloudflare Workers (NOT Node.js)

```typescript
// ❌ WRONG - process.env doesn't exist in Cloudflare Workers
const db = process.env.DB;

// ✅ CORRECT - Always use Astro.locals.runtime.env
const db = Astro.locals.runtime.env.DB;
const secret = Astro.locals.runtime.env.BETTER_AUTH_SECRET;
```

**Tech Stack**:

- **Astro SSR** (`output: 'server'`) with Cloudflare adapter
- **Better Auth** - Session-based authentication
- **Drizzle ORM** + **Cloudflare D1** - Edge SQLite database
- **Cloudflare Durable Objects** - One `MultiplayerPokerRoom` instance per private multiplayer poker room (binding: `MULTIPLAYER_POKER_ROOMS`). Hibernatable WebSockets for real-time game state.
- **Tailwind CSS v4** - Via Vite plugin (NOT PostCSS)
- **Bun** - Package manager and test runner
- **Playwright** - E2E testing

## Development Commands

```bash
# Development
bun run dev                    # Start dev server (http://localhost:2000)
bun run build                  # Build for Cloudflare Workers
bun run preview                # Preview production build

# Database
bun run db:generate            # Generate migration from schema
bun run db:migrate:local       # Apply to local D1
bun run db:migrate:remote      # Apply to production D1
bun run db:studio              # Open Drizzle Studio
bun run setup:db               # Bootstrap fresh local database

# Code Quality
bun run lint                   # ESLint check (max 0 warnings)
bun run lint:fix               # Auto-fix issues
bun run format                 # Format with Prettier
bun run format:check           # Check formatting (CI)

# Testing
bun run test                   # Unit tests (Bun)
bun run test:coverage          # Generate coverage reports
bun run test:e2e               # E2E tests (Playwright)
bun run test:e2e:ui            # E2E tests with UI
bun run test:e2e:headed        # E2E tests headed mode
bun run test:e2e:report        # Show E2E test report

# Deployment
bun run deploy                 # Build + deploy to Cloudflare
```

**Important**: Dev server runs on port 2000 (NOT 4321) to avoid conflicts. Always use `http://localhost:2000`.

## Authentication Architecture

**Flow**: Request → Middleware → Better Auth → Astro.locals

1. **Middleware** (`src/middleware.ts`):
   - Runs on EVERY request
   - Extracts session using Better Auth
   - Enriches user object with `chipBalance` from database
   - Sets `Astro.locals.session` and `Astro.locals.user`
   - Handles missing DB binding gracefully

2. **Auth Factory** (`src/lib/auth.ts`):

   ```typescript
   // Server-side only - creates Better Auth instance
   export function createAuth(db: D1Database, env: Env, baseURL?: string);
   ```

3. **Client Auth** (`src/lib/auth-client.ts`):

   ```typescript
   // Browser-side functions
   import { authClient } from '$lib/auth-client';
   await authClient.signIn.social({ provider: 'google', callbackURL: '/' });
   await authClient.signOut();
   ```

4. **Protected Routes**:
   ```astro
   ---
   const user = Astro.locals.user; // Injected by middleware
   if (!user) return Astro.redirect('/signin');
   ---
   ```

## Database Patterns

**Schema Location**: `src/db/schema.ts` - Single source of truth

**Factory Pattern**:

```typescript
import { createDb } from '../lib/db';

// In Astro pages/API routes:
const db = createDb(Astro.locals.runtime.env.DB);
const [player] = await db.select().from(user).where(eq(user.id, Astro.locals.user.id));
```

**Migration Workflow**:

```bash
# 1. Edit src/db/schema.ts
# 2. Generate migration
bun run db:generate

# 3. Apply locally
bun run db:migrate:local

# 4. Test with dev server
bun run dev

# 5. Deploy to production (only after testing!)
bun run db:migrate:remote
```

**Dynamic Schema Updates**: The middleware includes graceful schema initialization for `chipBalance` column. See `src/middleware.ts` for the pattern of handling missing columns at runtime.

**Important**: `scripts/apply-migrations.ts` automatically discovers numbered SQL files under `drizzle/`. Generate and commit the migration; do not add per-file paths to the migration scripts in `package.json`.

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

## Key Patterns

1. **Factory Pattern for Cloudflare Bindings**:

   ```typescript
   const db = createDb(Astro.locals.runtime.env.DB);
   const auth = createAuth(dbBinding, env, baseURL);
   ```

2. **Protected Routes**:

   ```astro
   ---
   const user = Astro.locals.user;
   if (!user) return Astro.redirect('/signin');
   ---
   ```

3. **Middleware Enrichment**: `chipBalance` is automatically added to user object in middleware

4. **Modular Game Logic**: Keep game rules, state, evaluation, payouts, and browser composition under `src/lib/<game>/`, split by real responsibilities. There is no required `Game` class, UI renderer, deck manager, settings manager, or LLM file. Prefer pure domain functions/state where practical and keep game-specific policy local.

5. **Mission System**: Mission board, claim, period, and progress logic lives under `src/lib/missions/`; HTTP endpoints under `src/pages/api/missions/` adapt requests to that module.

6. **AI Integration**: User-configured OpenAI/Gemini settings are stored in browser `localStorage` through `src/lib/ai`; the shared client owns provider transport and each game keeps its own prompts, validation, deterministic strategy, and fallbacks.

7. **Wallet Settlement**: `src/lib/wallet/` is the common play-money settlement boundary. Newer public games may use `createPublicGameSettlementController`; older games and server-authoritative modes may use lower-level wallet APIs directly. Do not retrofit a game solely to make all clients identical. Room-local multiplayer never settles through D1.

8. **Cross-game Progression**: Shared game identifiers/statistics live in `src/lib/game-stats/`, achievements in `src/lib/achievements/`, and ranking/leaderboards in `src/lib/leaderboard/`. New games register with those existing surfaces instead of creating parallel game identity or statistics systems.

9. **Multiplayer Poker Isolation**: Pure multiplayer logic and browser code live in `src/lib/mp-poker/*`. Worker-only room orchestration lives in `src/server/mp/multiplayer-poker-room.ts`; the `MultiplayerPokerRoom` Durable Object is bound as `MULTIPLAYER_POKER_ROOMS`. Multiplayer Poker uses room-local chips and has no D1 settlement.

10. **Route/API Boundaries**: Prefer Astro pages and API routes as thin adapters around product modules. Some older game pages still contain more orchestration; improve those only when concrete feature work needs it rather than opening a uniformity refactor.

## Database Schema

`src/db/schema.ts` is the source of truth. D1 stores the current application's persistence needs, including:

- Better Auth identity, account, and session data;
- play-money wallet and idempotent settlement data;
- game statistics, missions, and related progression data;
- Blackjack Run persistence for Ranked and Daily modes;
- focused feature data owned by the current application.

Do not maintain a duplicated exhaustive table inventory here. Breaking hobby-project schema changes may update the repository and database together without compatibility layers solely for old local data.

## Testing

**Unit Tests**: Bun test runner

- Test files: `*.test.ts` in `src/`
- Run all: `bun run test`
- Run single file: `bun test src/lib/poker/handEvaluator.test.ts`
- Run with pattern: `bun test --test-name-pattern "flush"`
- Coverage: `bun run test:coverage`

**E2E Tests**: Playwright

- Test files: `e2e/*.spec.ts`
- Global setup authenticates once and saves state to `e2e/.auth/user.json`
- All tests reuse authentication state for faster execution
- Run all: `bun run test:e2e`
- Run single file: `bunx playwright test e2e/blackjack-split.spec.ts`
- UI mode: `bun run test:e2e:ui`
- Headed mode: `bun run test:e2e:headed`

**E2E Auth**: Playwright uses the guarded auth bootstrap endpoint. Set `APP_ENV=test` or `APP_ENV=ci` with `ENABLE_E2E_AUTH_BOOTSTRAP=true` and `E2E_AUTH_BOOTSTRAP_SECRET` only in local or CI test environments.

**Local E2E env caveat**: `Astro.locals.runtime.env` is populated by `getPlatformProxy()` from `wrangler.toml [vars]` + `.dev.vars`/`.env` files, NOT from the parent process's `process.env`. So `APP_ENV=test bun run dev` in `playwright.config.ts webServer.command` will NOT reach the Worker — the bootstrap plugin still sees `undefined` and `/api/auth/e2e/bootstrap` 404s. To run E2E locally, the bootstrap vars must live in `.dev.vars` (gitignored, so each dev adds them manually). CI works because the env is injected at the runner level into the deployed config.

## Code Style

**Auto-enforced by pre-commit hooks** (Husky + lint-staged):

- **Tabs** (not spaces) - width 2
- **Single quotes** for strings
- **Semicolons** required
- **Unused vars** starting with `_` are allowed
- **Console**: `console.log` warns, `console.warn/error` allowed

**Naming Conventions**:

- Astro components: `PascalCase.astro`
- Routes: `kebab-case.astro`
- TypeScript: `camelCase` for variables/functions, `PascalCase` for types/interfaces
- Database tables: `snake_case` (Drizzle convention)

## Configuration Files

- `astro.config.mjs`: SSR mode, Cloudflare adapter, port 2000, Tailwind v4 via Vite
- `wrangler.toml`: D1 binding name is `"DB"`; Better Auth persists sessions in D1 via `drizzleAdapter` (no KV session store)
- `drizzle.config.ts`: Schema path and migrations output
- `src/env.d.ts`: TypeScript definitions for `Env` interface and `App.Locals`
- `eslint.config.js`: Flat config with TypeScript + Astro support
- `playwright.config.ts`: E2E test configuration with global setup
- `package.json`: All scripts use `bun`; migration scripts delegate numbered SQL discovery to `scripts/apply-migrations.ts`

## Deployment

Before deploying to Cloudflare:

1. Create D1 database: `wrangler d1 create arcturus-db`
2. Update `database_id` in `wrangler.toml`
3. Set secret: `wrangler secret put BETTER_AUTH_SECRET` (generate with `openssl rand -base64 32`)
4. Set Google OAuth client secret: `wrangler secret put GOOGLE_CLIENT_SECRET` (`GOOGLE_CLIENT_ID` is a public Worker var already declared in `wrangler.toml`)
5. Deploy the new Worker and verify it: `bun run deploy`
6. Apply migrations after the new Worker is live: `bun run db:migrate:remote`

**Why deploy before migrate:** the running Worker must already understand the
new schema before the database changes it. Migrating first can break requests
still served by old code (e.g. HPA-185 drops the `llm_settings` table the old
Worker reads). If the migration SQL succeeds but recording fails, the
migration runner prints `MANUAL RECOVERY REQUIRED` and the exact command to run:

```bash
wrangler d1 execute arcturus --remote --command="INSERT INTO _migrations (name, appliedAt) VALUES ('<migration>', <appliedAt>)"
```

Copy that command from the runner output with its printed migration filename and
timestamp; do not rerun SQL that already succeeded.

## Common Issues

**"Database not configured"** → Check `wrangler.toml` has valid `database_id`

**Auth not working** → Verify migrations applied: `bun run db:migrate:local`

**Build fails** → Clear cache: `rm -rf .astro node_modules && bun install`

**`process.env` undefined** → Use `Astro.locals.runtime.env` (Cloudflare Workers pattern)

**Port conflict** → Dev server uses port 2000, not 4321

**"bun not found"** → Restart shell: `zsh -il -c 'bun --version'`

## Debugging

```bash
# Local D1 queries
wrangler d1 execute arcturus-db --local --command="SELECT * FROM user"

# Production logs
wrangler tail

# Check secrets
wrangler secret list
```

## Building New Games

Use the smallest relevant shipped module as the reference, especially newer focused games such as `src/lib/video-poker/`, `src/lib/sic-bo/`, `src/lib/three-card-showdown/`, or `src/lib/pai-gow-poker/`.

1. Add `src/pages/games/<game>.astro` as the route/UI composition layer. Reuse existing layout, public-session, card-slot, or presentation helpers only when they match the game.
2. Keep game-owned rules, state transitions, evaluation, payouts, and browser behavior under `src/lib/<game>/`. Split files by actual responsibility; there is no mandatory filename or class template.
3. Reuse shared seams such as `src/lib/cards.ts`, wager validation, `src/lib/wallet/`, `src/lib/ai/`, or other neutral helpers only when the existing contract fits. Do not widen a shared API for hypothetical reuse.
4. Keep game-specific phases, prompts, payout policy, wildcard/ranking rules, rendering decisions, and settlement-command mapping local.
5. Register the game: add its id to `GAME_TYPES` and matching label/icon entries to `GAME_TYPE_LABELS` and `GAME_TYPE_ICONS` in `src/lib/game-stats/constants.ts`, then add its lobby card in `src/pages/index.astro`. `src/pages/games/index.astro` is only a redirect to `/#games`. Add focused unit tests plus one representative Playwright journey.
6. Do not add a base game class, generic paytable/session/plugin framework, mandatory settings or LLM layer, compatibility adapter, or new persistence system unless a concrete requirement proves it is needed.

A newer game may use `createPublicGameSettlementController`, but that is not a universal requirement. Choose the smallest existing wallet/public-session seam that fits the concrete game.
