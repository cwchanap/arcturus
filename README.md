# Arcturus

Arcturus is a play-money casino and game project built as one Astro application on Cloudflare Workers with D1 persistence. The codebase is intentionally a modular monolith: game rules stay close to each game, while stable shared concerns such as wallet settlement, progression, and optional BYOK AI transport have small focused boundaries.

## Features

- 🚀 **Astro** - Fast, modern web framework
- 🎨 **Tailwind CSS** - Utility-first CSS framework
- 🔐 **Better Auth** - Modern authentication library
- 🗄️ **Drizzle ORM** - TypeScript ORM
- ☁️ **Cloudflare D1** - Edge-native SQL database
- 🌐 **Cloudflare Workers** - Deploy globally on the edge
- ✨ **Code Quality** - ESLint, Prettier, Husky, lint-staged

## Authentication Features

- Google OAuth authentication
- Session management
- Protected routes
- User dashboard

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

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) installed
- Cloudflare account (for deployment)

### Installation

1. Clone and install dependencies:

```sh
bun install
```

2. Set up the local database:

```sh
# Login to Cloudflare
wrangler login

# Create D1 database
wrangler d1 create arcturus

# Update wrangler.toml with your database ID

# Generate migrations
bun run db:generate

# Apply migrations locally
bun run db:migrate:local
```

3. Create `.dev.vars` for local Cloudflare Workers secrets:

```sh
BETTER_AUTH_SECRET=<secret>
GOOGLE_CLIENT_ID=<google-client-id>
GOOGLE_CLIENT_SECRET=<google-client-secret>
```

Configure the Google OAuth app with `http://localhost:2000/api/auth/callback/google` as an authorized redirect URI for local development.

For Playwright E2E authentication, use local-only bootstrap bindings: set `APP_ENV=test`, `ENABLE_E2E_AUTH_BOOTSTRAP=true`, and `E2E_AUTH_BOOTSTRAP_SECRET` in `.dev.vars`. Do not set those values in production.

4. Start development server:

```sh
bun run dev
```

Visit `http://localhost:2000`

## Available Scripts

### Development

- `bun run dev` - Start development server
- `bun run build` - Build for production
- `bun run preview` - Preview production build

### Database

- `bun run db:generate` - Generate database migrations
- `bun run db:migrate:local` - Apply migrations locally
- `bun run db:migrate:remote` - Apply migrations to production
- `bun run db:studio` - Open Drizzle Studio

### Code Quality

- `bun run lint` - Check code with ESLint
- `bun run lint:fix` - Fix ESLint issues
- `bun run format` - Format code with Prettier
- `bun run format:check` - Check formatting

### Deployment

- `bun run deploy` - Build and deploy to Cloudflare

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

## Routes

- `/` - Home page and game lobby
- `/signin` - Google sign-in entry
- `/profile` - Account/profile page
- `/games` - Redirects to the homepage game section (`/#games`); not a separate game index page
- `/games/*` - Individual game routes
- `/api/*` - Application HTTP endpoints

A separate sign-up route is intentionally absent; first-time players start from `/signin` and continue with Google.

## Multiplayer Poker

- Pure multiplayer logic and browser code live under `src/lib/mp-poker/*`.
- Worker-only room orchestration lives in `src/server/mp/multiplayer-poker-room.ts`.
- `MultiplayerPokerRoom` is the Durable Object class bound as `MULTIPLAYER_POKER_ROOMS`.
- Multiplayer stacks are room-local chips; there is no D1 settlement for multiplayer poker.

## Database Schema

`src/db/schema.ts` is the source of truth. D1 stores the current application's persistence needs, including:

- Better Auth identity, account, and session data;
- play-money wallet and idempotent settlement data;
- game statistics, missions, and related progression data;
- Blackjack Run persistence for Ranked and Daily modes;
- focused feature data owned by the current application.

Better Auth persists sessions in D1 via `drizzleAdapter`; there is no KV session store.

Do not treat this README as an exhaustive table inventory. Breaking hobby-project schema changes may update the repository and database together without compatibility layers solely for old local data.

## Deployment

1. Build the project:

```sh
bun run build
```

2. Configure Cloudflare secrets:

```sh
wrangler secret put BETTER_AUTH_SECRET
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put WORKER_ORIGIN
```

`GOOGLE_CLIENT_ID` is already declared as a public Worker var in `wrangler.toml`, so it does not need to be set as a secret.

3. Deploy to Cloudflare:

```sh
wrangler deploy
```

Configure the production Google OAuth app with `https://<production-origin>/api/auth/callback/google` before deploying.

## Code Quality

This project uses modern linting and formatting tools:

- **ESLint** - Flat config with TypeScript and Astro support
- **Prettier** - Consistent code formatting
- **Husky** - Git hooks for automated checks
- **lint-staged** - Run checks only on changed files

See [CODE_QUALITY.md](./CODE_QUALITY.md) for details.

## Configuration

### Environment Variables

See `.env.example` for required environment variables.

### Google OAuth

To enable Google OAuth, you need to:

1. Create a Google OAuth application
2. Add the client ID and secret to your environment variables
3. Configure the callback URLs:
   - `http://localhost:2000/api/auth/callback/google`
   - `https://<production-origin>/api/auth/callback/google`

## Learn More

- [Astro Documentation](https://docs.astro.build)
- [Better Auth Documentation](https://better-auth.com)
- [Drizzle ORM Documentation](https://orm.drizzle.team)
- [Cloudflare Workers Documentation](https://developers.cloudflare.com/workers)
- [Cloudflare D1 Documentation](https://developers.cloudflare.com/d1)

## License

MIT
