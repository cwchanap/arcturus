# Arcturus Casino - Cloudflare Workers Gaming Platform

## Critical Architecture Rules

**Arcturus** is an Astro SSR casino platform running on **Cloudflare Workers** (NOT Node.js).

**⚠️ CRITICAL: Environment Access Pattern**

```typescript
// ❌ WRONG - Never use process.env in Astro pages/API routes
const db = process.env.DB;

// ✅ CORRECT - Always use Astro.locals.runtime.env for Cloudflare bindings
const db = Astro.locals.runtime.env.DB;
const secret = Astro.locals.runtime.env.BETTER_AUTH_SECRET;
```

**Why This Matters**: `process.env` doesn't exist in Cloudflare Workers runtime. Accessing it causes silent failures. All Cloudflare resources (D1 database, KV stores, secrets) MUST be accessed through `Astro.locals.runtime.env`.

**Tech Stack**:

- **Astro SSR** (`output: 'server'`) + Cloudflare adapter
- **Better Auth** (session-based authentication, mandatory for games)
- **Drizzle ORM** + **Cloudflare D1** (edge SQLite database)
- **Tailwind CSS v4** (via Vite plugin, NOT PostCSS)
- **Bun** package manager (NOT npm/yarn/pnpm)

## Authentication Flow (Better Auth + Middleware)

**Pattern**: All auth data flows through middleware → Astro.locals

1. **Middleware** (`src/middleware.ts`): Runs on EVERY request
   - Extracts session from Better Auth using request headers
   - Enriches user with `chipBalance` from database
   - Sets `Astro.locals.session` and `Astro.locals.user`
   - Handles missing DB binding gracefully

2. **Auth Factory** (`src/lib/auth.ts`):

   ```typescript
   // Server-side only - creates Better Auth instance
   export function createAuth(db: D1Database, env: Env, baseURL?: string);
   ```

3. **Client Auth** (`src/lib/auth-client.ts`):

   ```typescript
   // Browser-side functions: signIn(), signUp(), signOut()
   import { authClient } from '$lib/auth-client';
   await authClient.signIn.email({ email, password });
   ```

4. **Protected Routes**:
   ```astro
   ---
   const user = Astro.locals.user; // Injected by middleware
   if (!user) return Astro.redirect('/signin');
   ---
   ```

**Database Access Pattern**:

```typescript
import { createDb } from '../lib/db';

// In Astro pages/API routes:
const db = createDb(Astro.locals.runtime.env.DB); // ✅ Factory pattern
const [player] = await db.select().from(user).where(eq(user.id, Astro.locals.user.id));
```

## Database Workflow (Drizzle + D1)

**Schema lives in** `src/db/schema.ts` - update here for all changes.

```bash
# 1. Edit schema (add columns, tables, relations)
# 2. Generate migration SQL
bun run db:generate

# 3. Apply to local D1 (.wrangler/state/v3/d1/)
bun run db:migrate:local

# 4. Test changes with dev server
bun run dev

# 5. Deploy to production (only after testing!)
bun run db:migrate:remote
```

**⚠️ Important**:

- Migration files in `drizzle/` are **timestamped SQL snapshots**
- `package.json` scripts reference specific migration files by name
- When adding new migrations, update script paths in `package.json`
- Use `bun run db:push` for quick prototyping (skips migration files)

**Dynamic Schema Updates** (see `src/middleware.ts`):

```typescript
// Pattern: Gracefully handle missing columns at runtime
try {
	await db
		.prepare('ALTER TABLE "user" ADD COLUMN "chipBalance" integer DEFAULT 10000 NOT NULL;')
		.run();
} catch (error) {
	if (!/duplicate column name/i.test(message)) throw error;
}
```

**Query Pattern**:

```typescript
import { eq, and } from 'drizzle-orm';
import { user } from '../db/schema';

// Type-safe queries with Drizzle
const [record] = await db
	.select({ chipBalance: user.chipBalance })
	.from(user)
	.where(eq(user.id, userId))
	.limit(1);
```

## Development & Testing Commands

```bash
# Development
bun run dev                    # Local server on http://localhost:2000 (NOT 4321!)
bun run build                  # Build for Cloudflare Workers
bun run preview                # Preview production build locally

# Code Quality (auto-enforced by pre-commit hooks)
bun run lint                   # ESLint check (max 0 warnings)
bun run lint:fix               # Auto-fix issues
bun run format                 # Prettier write
bun run format:check           # Check formatting (CI)

# Testing
bun run test                   # Run Bun test suite
bun run test:coverage          # Generate coverage reports

# Database (see Database Workflow section)
bun run db:generate            # Generate migration from schema
bun run db:migrate:local       # Apply to local D1
bun run db:migrate:remote      # Apply to production D1
bun run db:studio              # Drizzle Studio UI
bun run setup:db               # Bootstrap fresh local database

# Deployment
bun run deploy                 # Build + deploy to Cloudflare Workers
```

**Port Configuration**: Dev server runs on **port 2000** (see `astro.config.mjs`) to avoid conflicts. Always use `http://localhost:2000`.

**Pre-commit Hooks** (Husky + lint-staged):

- Auto-formats all staged files
- Runs ESLint on `.js`, `.ts`, `.astro` files
- Enforces style: tabs (width 2), single quotes, semicolons
- Unused vars starting with `_` are allowed
- `console.log` warns, `console.warn/error` allowed

## Project Structure & Key Patterns

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
│   │   ├── missions/           # Mission completion
│   │   └── profile/            # User settings (LLM)
│   ├── signin.astro
│   └── profile.astro
├── lib/
│   ├── auth.ts            # Server auth factory
│   ├── auth-client.ts     # Browser auth utils
│   ├── db.ts              # Database factory
│   ├── missions.ts        # Mission system logic
│   ├── llm-settings.ts    # User LLM config
│   └── poker/             # Poker game logic (modular)
│       ├── types.ts       # TypeScript interfaces
│       ├── constants.ts   # Game constants
│       ├── player.ts      # Player utilities (pure functions)
│       ├── handEvaluator.ts    # Hand ranking logic
│       ├── potCalculator.ts    # Pot + side pots
│       ├── aiStrategy.ts       # AI decision engine
│       └── PokerGame.ts        # Main game class
├── db/
│   └── schema.ts          # Drizzle schema (single source of truth)
└── middleware.ts          # Auth + session injection (runs on EVERY request)

drizzle/                   # Generated SQL migrations
```

**Key Patterns**:

1. **Factory Pattern** for Cloudflare bindings:

   ```typescript
   const db = createDb(Astro.locals.runtime.env.DB);
   const auth = createAuth(dbBinding, env, baseURL);
   ```

2. **Protected Routes** - Check `Astro.locals.user`:

   ```astro
   ---
   const user = Astro.locals.user;
   if (!user) return Astro.redirect('/signin');
   ---
   ```

3. **Middleware Enrichment** - `chipBalance` added to user object automatically

4. **Modular Game Logic** - Extract into `src/lib/{game}/` with pure functions for testability

5. **Mission System** - Daily login rewards, chip balance updates (see `src/lib/missions.ts`)

6. **LLM Integration** - User-configured AI settings (OpenAI/Gemini) for poker assistant

## Code Quality & Style

**Auto-enforced by pre-commit hooks** (Husky + lint-staged):

- **Tabs** (not spaces) - width 2
- **Single quotes** for strings
- **Semicolons** required
- **ESLint flat config** (`eslint.config.js`) - unused vars starting with `_` allowed
- **Console**: `console.log` warns, `console.warn/error` allowed

**Files are auto-formatted on commit** - don't fight the tools!

**Naming Conventions**:

- Astro components: `PascalCase.astro`
- Routes: `kebab-case.astro`
- TypeScript: `camelCase` for variables/functions, `PascalCase` for types/interfaces
- Database tables: `snake_case` (Drizzle convention)

## Configuration Files

- `astro.config.mjs`: SSR mode (`output: 'server'`), Cloudflare adapter, **port 2000** (intentional), Tailwind v4 via Vite plugin
- `wrangler.toml`: D1 binding name is `"DB"`, KV binding for sessions, `database_id` must match actual D1 instance
- `drizzle.config.ts`: Schema path (`src/db/schema.ts`) and migrations output (`drizzle/`)
- `src/env.d.ts`: TypeScript definitions for `Env` interface and `App.Locals`
- `eslint.config.js`: Flat config with TypeScript + Astro support
- `package.json`: All scripts use `bun` (not npm/yarn), migration scripts reference specific SQL files

## Test Accounts

When validating auth flows (especially in Chrome Dev MCP), use:

- Email: `test@cwchanap.dev`
- Password: `password123`

**⚠️ Important**: Reset password after demos and clean related D1 records when done.

## Deployment Checklist

Before deploying to Cloudflare:

1. Create D1 database: `wrangler d1 create arcturus-db`
2. Update `database_id` in `wrangler.toml`
3. Set secret: `wrangler secret put BETTER_AUTH_SECRET` (generate with `openssl rand -base64 32`)
4. Apply migrations: `bun run db:migrate:remote`
5. Deploy: `bun run deploy` (builds + deploys)

## Debugging & Common Issues

```bash
# Local D1 queries
wrangler d1 execute arcturus-db --local --command="SELECT * FROM user"

# Production logs
wrangler tail

# Check secrets
wrangler secret list
```

**Common Pitfalls**:

1. **"Database not configured"** → Check `wrangler.toml` has valid `database_id`
2. **Auth not working** → Verify migrations applied: `bun run db:migrate:local`
3. **Build fails** → Clear cache: `rm -rf .astro node_modules && bun install`
4. **`process.env` undefined** → Use `Astro.locals.runtime.env` instead (Cloudflare Workers pattern)
5. **Port conflict** → Dev server uses port 2000, not 4321 (check `astro.config.mjs`)

## Building Casino Games

**Game Structure Pattern** (see `src/pages/games/poker.astro`):

```astro
---
import CasinoLayout from '../../layouts/casino.astro';
const user = Astro.locals.user;
if (!user) return Astro.redirect('/signin'); // Games require auth
---

<CasinoLayout title="Your Game - Arcturus Casino">
	<!-- Game UI -->
</CasinoLayout>

<script>
	// Client-side game logic
</script>
```

**Available Components**:

- `PlayingCard.astro` - Cards with suits (hearts, diamonds, clubs, spades)
- `PokerChip.astro` - Casino chips
- `GameCard.astro` - Game selection cards
- `UserNav.astro` - User balance/nav

**Adding New Games**:

1. Create `src/pages/games/yourgame.astro`
2. Use `CasinoLayout` + check `Astro.locals.user`
3. Extract complex logic to `src/lib/yourgame/` (modular pattern)
4. Add to game lobby (`src/pages/games/index.astro`)

## Extending the Casino

### Adding Player Data Tables

1. **Update schema** in `src/db/schema.ts`:

   ```typescript
   export const playerStats = sqliteTable('player_stats', {
   	id: text('id').primaryKey(),
   	userId: text('userId')
   		.notNull()
   		.references(() => user.id),
   	balance: integer('balance').notNull().default(1000),
   	gamesPlayed: integer('gamesPlayed').notNull().default(0),
   	// ... other fields
   });
   ```

2. **Generate & apply**: `bun run db:generate && bun run db:migrate:local`

### Accessing Session Data

In any `.astro` page or API route:

```typescript
const user = Astro.locals.user; // Available after middleware
const session = Astro.locals.session; // Full session object
```

### Mission System Example

See `src/lib/missions.ts` for daily login rewards pattern:

- Daily login tracking with calendar day comparison
- Chip balance updates via SQL increment
- Graceful schema initialization (dynamic column addition)

### bun not found

Restart the shell : `zsh -il -c 'bun --version'`. Then you can run bun directly
