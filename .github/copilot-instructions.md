# Arcturus Casino - Casino Gaming Platform

## Architecture Overview

**Arcturus Casino** is a casino gaming platform built with Astro SSR and deployed to Cloudflare Workers. Players can enjoy games like Texas Hold'em Poker, Blackjack, Roulette, and more.

**Tech Stack**:

- **Astro SSR** - Server-side rendering on Cloudflare Workers
- **Better Auth** - Player authentication (required to play games)
- **Drizzle ORM** with **Cloudflare D1** - Edge database for player data
- **Tailwind CSS v4** - Styling with Vite plugin
- **Bun** - Package manager

**Critical Runtime Requirement**: Cloudflare bindings (database, secrets) are accessed via `runtime.env.DB`, NOT `process.env`. Always use `Astro.locals.runtime.env` for Cloudflare resources.

## Building Casino Games

### Game Structure Pattern

All games follow this structure (see `src/pages/games/poker.astro`):

```astro
---
import CasinoLayout from '../../layouts/casino.astro';
import PlayingCard from '../../components/PlayingCard.astro';
import PokerChip from '../../components/PokerChip.astro';

const user = Astro.locals.user;
if (!user) {
	return Astro.redirect('/signin'); // Games require authentication
}
---

<CasinoLayout title="Your Game - Arcturus Casino">
	<!-- Game UI here -->
</CasinoLayout>

<script>
	// Game logic (client-side)
</script>
```

### Available Game Components

- **`PlayingCard.astro`** - Playing cards with suits (hearts, diamonds, clubs, spades)
- **`PokerChip.astro`** - Casino chips for betting
- **`GameCard.astro`** - Game selection cards in lobby
- **`Button.astro`** - Reusable button component

### Casino Layout

Use `casino.astro` layout for all games - provides:

- Header with Arcturus branding and navigation
- User balance display
- Sign out functionality
- Casino theming (dark with gold accents)

### Adding a New Game

1. Create `src/pages/games/yourgame.astro`
2. Import `CasinoLayout` and needed components
3. Check `Astro.locals.user` and redirect if null
4. Build UI using casino components
5. Add client-side game logic in `<script>` tag
6. Add to games list in `src/pages/games/index.astro`

## Player Authentication (Required Infrastructure)

### How Authentication Works

1. **Server-side** (`src/lib/auth.ts`): `createAuth()` factory function accepts `(db: D1Database, env: Env, baseURL?: string)`
2. **Middleware** (`src/middleware.ts`): Extracts session, adds `Astro.locals.session` and `Astro.locals.user` to all requests
3. **API handler** (`src/pages/api/auth/[...all].ts`): Catch-all route delegates to Better Auth
4. **Client-side** (`src/lib/auth-client.ts`): Provides `signIn`, `signUp`, `signOut` for browser

### Protecting Game Routes

**Pattern**: All games check for authenticated player:

```astro
---
const user = Astro.locals.user;
if (!user) {
	return Astro.redirect('/signin');
}
---
```

### Database Access in Games

```typescript
import { createDb } from '../lib/db';

// Always pass runtime.env.DB (Cloudflare binding)
const db = createDb(Astro.locals.runtime.env.DB);
const playerData = await db.select().from(players).where(eq(players.userId, user.id));
```

## Development Workflow

### Essential Commands

```bash
bun run dev                    # Dev server on port 2000 (see astro.config.mjs)
bun run build                  # Build for Cloudflare Workers
bun run lint && bun run format # Run quality checks before commit
```

### Database Workflow

```bash
# 1. Edit src/db/schema.ts
# 2. Generate migration
bun run db:generate

# 3. Apply locally (updates .wrangler/state/v3/d1/)
bun run db:migrate:local

# 4. For production (after testing)
bun run db:migrate:remote

# Quick prototyping (skips migrations)
bun run db:push

# Visual DB management
bun run db:studio
```

**Important**: Migration files are in `drizzle/` and referenced by name in `package.json` scripts. Update script paths when adding new migrations.

## Project Structure

```
src/
├── components/
│   ├── PlayingCard.astro   # Card component (hearts, diamonds, clubs, spades)
│   ├── PokerChip.astro     # Casino chip component
│   ├── GameCard.astro      # Game selection cards
│   └── UserNav.astro       # User navigation/balance
├── layouts/
│   ├── casino.astro        # Casino theme layout (use for all games)
│   └── main.astro          # Basic layout
├── pages/
│   ├── games/
│   │   ├── index.astro     # Game lobby
│   │   └── poker.astro     # Example: Texas Hold'em implementation
│   ├── api/auth/[...all].ts # Auth API handler
│   ├── signin.astro        # Player login
│   ├── signup.astro        # Player registration
│   └── dashboard.astro     # Player dashboard
├── lib/
│   ├── auth.ts             # Server auth config (factory)
│   ├── auth-client.ts      # Client auth utilities
│   └── db.ts               # Database factory
└── db/schema.ts            # Drizzle schema (user, session, account, verification)
```

## Code Quality & Style

**Auto-enforced by pre-commit hooks** (Husky + lint-staged):

- **Tabs** (not spaces) - width 2
- **Single quotes** for strings
- **Semicolons** required
- **ESLint flat config** - unused vars starting with `_` allowed
- **Console**: `console.log` warns, `console.warn/error` allowed

**Files are auto-formatted on commit** - don't fight the tools!

## Configuration Files

- `astro.config.mjs`: SSR mode (`output: 'server'`), Cloudflare adapter, **port 2000** (intentional)
- `wrangler.toml`: D1 binding name is `"DB"`, update `database_id` after creating D1 database
- `drizzle.config.ts`: Schema path and migrations output directory
- `src/env.d.ts`: TypeScript definitions for `Env` interface and `App.Locals`

## Deployment Checklist

Before deploying to Cloudflare:

1. Create D1 database: `wrangler d1 create arcturus-db`
2. Update `database_id` in `wrangler.toml`
3. Set secret: `wrangler secret put BETTER_AUTH_SECRET` (generate with `openssl rand -base64 32`)
4. Apply migrations: `bun run db:migrate:remote`
5. Deploy: `bun run deploy` (builds + deploys)

## Testing & Debugging

```bash
# Local D1 queries
wrangler d1 execute arcturus-db --local --command="SELECT * FROM user"

# Production logs
wrangler tail

# Check secrets
wrangler secret list
```

**Common issues**:

- "Database not configured" → Check `wrangler.toml` has valid `database_id`
- Auth not working → Verify migrations applied with `bun run db:migrate:local`
- Build fails → Clear cache: `rm -rf .astro node_modules && bun install`

## Extending the Casino

### Adding Player Balance/Stats Table

1. Add to `src/db/schema.ts`:

```typescript
export const playerStats = sqliteTable('player_stats', {
	id: text('id').primaryKey(),
	userId: text('userId')
		.notNull()
		.references(() => user.id),
	balance: integer('balance').notNull().default(1000),
	gamesPlayed: integer('gamesPlayed').notNull().default(0),
	gamesWon: integer('gamesWon').notNull().default(0),
	// ... other fields
});
```

2. Generate and apply: `bun run db:generate && bun run db:migrate:local`

### Adding Game-Specific Data

Follow the same pattern - define schema, generate migration, apply locally then to production.

### Accessing Player Session

In any `.astro` page or API route:

```typescript
const user = Astro.locals.user; // Available after middleware
const session = Astro.locals.session; // Full session object
```
