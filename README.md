# Arcturus - Astro with Authentication

An Astro project with Better Auth, Drizzle ORM, and Cloudflare D1 database integration, ready to deploy on Cloudflare Workers.

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

```
/
├── .husky/                # Git hooks
├── drizzle/              # Database migrations
├── public/               # Static assets
├── src/
│   ├── components/       # Astro components
│   ├── db/
│   │   └── schema.ts     # Database schema
│   ├── layouts/          # Page layouts
│   ├── lib/
│   │   ├── auth.ts       # Server-side auth
│   │   ├── auth-client.ts # Client-side auth
│   │   └── db.ts         # Database client
│   ├── pages/
│   │   ├── api/
│   │   │   ├── auth/     # Better Auth API endpoints
│   │   │   ├── chips/    # Chip balance API
│   │   │   └── profile/  # Profile settings API
│   │   ├── games/        # Casino game routes
│   │   ├── index.astro   # Home page
│   │   ├── signin.astro  # Sign in page
│   │   └── profile.astro # Protected profile page
│   └── styles/
│       └── global.css    # Global styles
├── astro.config.mjs      # Astro configuration
├── drizzle.config.ts     # Drizzle configuration
├── wrangler.toml         # Cloudflare Workers config
└── tsconfig.json         # TypeScript configuration
```

## Routes

- `/` - Home page
- `/signin` - Sign in page
- `/profile` - Protected profile page (requires authentication)
- `/api/auth/*` - Authentication API endpoints

A separate sign-up route is intentionally absent; first-time players start from `/signin` and continue with Google.

## Database Schema

The project includes tables for:

- **users** - User accounts
- **sessions** - Active sessions
- **accounts** - OAuth provider accounts
- **verification** - Email verification tokens

## Deployment

1. Build the project:

```sh
bun run build
```

2. Configure Cloudflare secrets:

```sh
wrangler secret put BETTER_AUTH_SECRET
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put MP_AUTH_SECRET
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
