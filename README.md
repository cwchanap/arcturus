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

- Email/Password authentication
- OAuth providers (GitHub, Google)
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

2. Set up authentication (see [AUTH_SETUP.md](./AUTH_SETUP.md) for detailed instructions):

```sh
# Login to Cloudflare
wrangler login

# Create D1 database
wrangler d1 create arcturus

# Update wrangler.toml with your database ID

# Generate migrations
bun run db:generate

# Apply migrations locally
bun run db:migrate
```

3. Create `.env` file (copy from `.env.example`):

```sh
cp .env.example .env
```

4. Start development server:

```sh
bun run dev
```

Visit `http://localhost:4321`

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
│   │   ├── api/auth/     # Auth API endpoints
│   │   ├── dashboard.astro # Protected page
│   │   ├── signin.astro  # Sign in page
│   │   └── signup.astro  # Sign up page
│   └── styles/           # Global styles
├── astro.config.mjs      # Astro configuration
├── drizzle.config.ts     # Drizzle configuration
├── wrangler.toml         # Cloudflare Workers config
└── tsconfig.json         # TypeScript configuration
```

## Routes

- `/` - Home page
- `/signin` - Sign in page
- `/signup` - Sign up page
- `/dashboard` - Protected dashboard (requires authentication)
- `/api/auth/*` - Authentication API endpoints

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

2. Deploy to Cloudflare:

```sh
wrangler deploy
```

For detailed deployment instructions, see [AUTH_SETUP.md](./AUTH_SETUP.md).

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

### OAuth Providers

To enable OAuth providers (GitHub, Google), you need to:

1. Create OAuth applications on the respective platforms
2. Add the client ID and secret to your environment variables
3. Configure the callback URLs

Detailed instructions in [AUTH_SETUP.md](./AUTH_SETUP.md).

## Learn More

- [Astro Documentation](https://docs.astro.build)
- [Better Auth Documentation](https://better-auth.com)
- [Drizzle ORM Documentation](https://orm.drizzle.team)
- [Cloudflare Workers Documentation](https://developers.cloudflare.com/workers)
- [Cloudflare D1 Documentation](https://developers.cloudflare.com/d1)

## License

MIT
