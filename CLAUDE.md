# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Arcturus is a casino gaming platform built with Astro SSR, running on Cloudflare Workers. It features Texas Hold'em poker with AI opponents, session-based authentication via Better Auth, and a chip-based economy system stored in Cloudflare D1.

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
   await authClient.signIn.email({ email, password });
   await authClient.signUp.email({ email, password, name });
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

**Important**: Migration scripts in `package.json` reference specific SQL files. Update these paths when adding new migrations.

## Project Structure

```
src/
├── components/           # Reusable UI components
│   ├── PlayingCard.astro  # Casino card component
│   ├── PokerChip.astro    # Casino chip component
│   └── UserNav.astro      # User balance/nav
├── layouts/
│   ├── casino.astro       # Casino theme (use for games)
│   └── AppLayout.astro    # Base layout with auth
├── pages/
│   ├── games/             # Game routes (auth required)
│   │   ├── index.astro    # Game lobby
│   │   └── poker.astro    # Texas Hold'em
│   ├── api/
│   │   ├── auth/[...all].ts    # Better Auth API
│   │   ├── missions/           # Mission completion endpoints
│   │   └── profile/            # User settings (LLM config)
│   ├── signin.astro
│   ├── signup.astro
│   └── profile.astro
├── lib/
│   ├── auth.ts            # Server auth factory
│   ├── auth-client.ts     # Browser auth utils
│   ├── db.ts              # Database factory
│   ├── missions.ts        # Mission system logic
│   ├── llm-settings.ts    # User LLM configuration
│   └── poker/             # Poker game logic (modular)
│       ├── types.ts       # TypeScript interfaces
│       ├── constants.ts   # Game constants
│       ├── player.ts      # Player utilities (pure functions)
│       ├── handEvaluator.ts    # Hand ranking logic
│       ├── potCalculator.ts    # Pot + side pots
│       ├── aiStrategy.ts       # AI decision engine
│       ├── llmAIStrategy.ts    # LLM-powered AI
│       ├── PokerGame.ts        # Main game class
│       ├── DeckManager.ts      # Deck shuffling
│       ├── AIRivalAssistant.ts # AI opponent personality
│       └── PokerUIRenderer.ts  # UI rendering logic
├── db/
│   └── schema.ts          # Drizzle schema (single source of truth)
└── middleware.ts          # Auth + session injection (runs on ALL requests)

e2e/                       # Playwright E2E tests
├── global-setup.ts        # Test authentication setup
├── auth.setup.ts          # Shared auth state
├── poker-turn-flow.spec.ts  # Poker game flow tests
└── profile.spec.ts        # Profile page tests

drizzle/                   # Generated SQL migrations
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

4. **Modular Game Logic**: Game logic extracted to `src/lib/{game}/` with pure functions for testability. See poker implementation for reference.

5. **Mission System**: Daily login rewards, chip balance updates via `src/lib/missions.ts`

6. **LLM Integration**: User-configured AI settings (OpenAI/Gemini) for poker assistant via `src/lib/llm-settings.ts` and `src/lib/poker/llmAIStrategy.ts`

## Database Schema

Tables defined in `src/db/schema.ts`:

- **user** - User accounts with `chipBalance`
- **session** - Active sessions
- **account** - OAuth provider accounts
- **verification** - Email verification tokens
- **mission** - Mission completion tracking
- **llm_settings** - User LLM configuration (API keys, model selection)

## Testing

**Unit Tests**: Bun test runner

- Test files: `*.test.ts` in `src/`
- Run: `bun run test`
- Coverage: `bun run test:coverage`

**E2E Tests**: Playwright

- Test files: `e2e/*.spec.ts`
- Global setup authenticates once and saves state to `e2e/.auth/user.json`
- All tests reuse authentication state for faster execution
- Run: `bun run test:e2e`
- UI mode: `bun run test:e2e:ui`

**Test Account**:

- Name: `E2E Test User`
- Email: `e2e-test@arcturus.local`
- Password: `PlaywrightTest123!`

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
- `wrangler.toml`: D1 binding name is `"DB"`, KV binding for sessions
- `drizzle.config.ts`: Schema path and migrations output
- `src/env.d.ts`: TypeScript definitions for `Env` interface and `App.Locals`
- `eslint.config.js`: Flat config with TypeScript + Astro support
- `playwright.config.ts`: E2E test configuration with global setup
- `package.json`: All scripts use `bun`, migration scripts reference specific SQL files

## Deployment

Before deploying to Cloudflare:

1. Create D1 database: `wrangler d1 create arcturus-db`
2. Update `database_id` in `wrangler.toml`
3. Set secret: `wrangler secret put BETTER_AUTH_SECRET` (generate with `openssl rand -base64 32`)
4. Apply migrations: `bun run db:migrate:remote`
5. Deploy: `bun run deploy`

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

**Pattern** (see `src/pages/games/poker.astro`):

```astro
---
import CasinoLayout from '../../layouts/casino.astro';
const user = Astro.locals.user;
if (!user) return Astro.redirect('/signin');
---

<CasinoLayout title="Your Game - Arcturus Casino">
	<!-- Game UI -->
</CasinoLayout>

<script>
	// Client-side game logic
</script>
```

**Steps**:

1. Create `src/pages/games/yourgame.astro`
2. Use `CasinoLayout` + check `Astro.locals.user`
3. Extract complex logic to `src/lib/yourgame/` with pure functions
4. Write unit tests for game logic
5. Add to game lobby (`src/pages/games/index.astro`)

**Available Components**:

- `PlayingCard.astro` - Cards with suits
- `PokerChip.astro` - Casino chips
- `GameCard.astro` - Game selection cards
- `UserNav.astro` - User balance/nav

## Active Technologies

- TypeScript 5.x (Astro SSR environment) + Astro 5.x, Drizzle ORM, Better Auth, Tailwind CSS v4, existing `llm-settings` infrastructure (001-blackjack-game)
- Cloudflare D1 (existing schema - reuses `user.chipBalance` and `llm_settings` table, no new tables needed) (001-blackjack-game)

## Recent Changes

- 001-blackjack-game: Added TypeScript 5.x (Astro SSR environment) + Astro 5.x, Drizzle ORM, Better Auth, Tailwind CSS v4, existing `llm-settings` infrastructure
