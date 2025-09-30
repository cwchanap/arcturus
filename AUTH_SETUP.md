# Authentication Setup Guide

This project uses Better Auth with Drizzle ORM and Cloudflare D1 database.

## Prerequisites

1. [Bun](https://bun.sh) installed for package management
2. Cloudflare account (free tier works fine)
3. Wrangler CLI (installed with `bun install`)

## Quick Setup (3 Steps)

### Step 1: Install Dependencies

```bash
bun install
```

### Step 2: Create D1 Database

Login to Cloudflare:

```bash
bunx wrangler login
```

Create a new D1 database:

```bash
bunx wrangler d1 create arcturus-db
```

You'll see output like this:

```
✅ Successfully created DB 'arcturus-db' in region APAC
Created your database using D1's new storage backend.

[[d1_databases]]
binding = "DB"
database_name = "arcturus-db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

**Important:** Copy the `database_id` and update it in `wrangler.toml`.

### Step 3: Apply Database Migrations

The migration file already exists in `drizzle/` directory. Apply it locally:

```bash
bun run db:migrate:local
```

That's it! You can now run the development server.

## Development

Start the development server:

```bash
bun run dev
```

Visit `http://localhost:4321`

## Environment Variables (Optional)

For local development, you can create a `.env` file:

```bash
cp .env.example .env
```

Then generate and add your secret:

```bash
# Generate a secure secret
openssl rand -base64 32

# Add to .env file
BETTER_AUTH_SECRET=your_generated_secret_here
```

**Note:** For local development, the app will use a default secret if not provided. However, you **MUST** set a proper secret for production.

## Production Deployment

### 1. Set Production Secrets

Before deploying, set your production secrets:

```bash
# Generate and set the auth secret
openssl rand -base64 32
bunx wrangler secret put BETTER_AUTH_SECRET
# Paste the generated secret when prompted
```

### 2. Apply Migrations to Production

```bash
bun run db:migrate:remote
```

### 3. Deploy

```bash
bun run deploy
```

Or manually:

```bash
bun run build
bunx wrangler deploy
```

## Development

Start the development server:

```bash
bun run dev
```

The app will be available at `http://localhost:4321`

## Database Management

### View and Manage Data

Use Drizzle Studio to visually manage your database:

```bash
bun run db:studio
```

This opens a web interface at `https://local.drizzle.studio`

### Making Schema Changes

When you need to modify the database schema:

1. Edit `src/db/schema.ts`
2. Generate a new migration:
   ```bash
   bun run db:generate
   ```
3. Review the generated SQL in `drizzle/` directory
4. Apply locally:
   ```bash
   bun run db:migrate:local
   ```
5. Apply to production:
   ```bash
   bun run db:migrate:remote
   ```

**Quick Development:** Use `bun run db:push` to push schema changes directly without generating migration files (great for rapid prototyping).

## Adding OAuth Providers (Optional)

### GitHub OAuth

1. Go to https://github.com/settings/developers
2. Click "New OAuth App"
3. Fill in:
   - **Application name**: Arcturus (or your app name)
   - **Homepage URL**: `http://localhost:4321` (for dev) or your production URL
   - **Authorization callback URL**: `http://localhost:4321/api/auth/callback/github` (update for production)
4. Copy Client ID and generate a Client Secret
5. For local development, add to `.env`:
   ```
   GITHUB_CLIENT_ID=your_client_id
   GITHUB_CLIENT_SECRET=your_client_secret
   ```
6. For production, set as Cloudflare secrets:
   ```bash
   bunx wrangler secret put GITHUB_CLIENT_ID
   bunx wrangler secret put GITHUB_CLIENT_SECRET
   ```

### Google OAuth

1. Go to https://console.cloud.google.com/
2. Create a new project or select existing
3. Enable Google OAuth API
4. Go to "Credentials" → "Create Credentials" → "OAuth client ID"
5. Choose "Web application"
6. Add Authorized redirect URIs: `http://localhost:4321/api/auth/callback/google` (update for production)
7. Copy Client ID and Client Secret
8. Add to `.env` for local or set as Cloudflare secrets for production

## Routes

- `/` - Home page
- `/signin` - Sign in page
- `/signup` - Sign up page
- `/dashboard` - Protected dashboard (requires authentication)
- `/api/auth/*` - Authentication API endpoints

## Database Schema

The authentication system includes these tables:

- **user** - User accounts (id, name, email, emailVerified, image, timestamps)
- **session** - User sessions (id, expiresAt, token, ipAddress, userAgent, userId)
- **account** - OAuth provider accounts & credentials (id, accountId, providerId, userId, tokens)
- **verification** - Email verification tokens (id, identifier, value, expiresAt, timestamps)

Extend the schema in `src/db/schema.ts` as needed for your application.

## Architecture

### Server-Side Components

- `src/lib/auth.ts` - Better Auth server configuration (accepts DB binding and env)
- `src/middleware.ts` - Global middleware that adds session to all requests
- `src/pages/api/auth/[...all].ts` - Handles all auth API routes

### Client-Side Components

- `src/lib/auth-client.ts` - Better Auth client for browser interactions
- `src/pages/signin.astro` & `signup.astro` - Authentication pages
- `src/pages/dashboard.astro` - Example protected page
- `src/components/UserNav.astro` - Navigation component showing user state

### Database

- `src/db/schema.ts` - Drizzle ORM schema definitions
- `src/lib/db.ts` - Database client factory
- `drizzle.config.ts` - Drizzle Kit configuration for migrations

## Troubleshooting

### "Database not configured" error

Ensure:

1. D1 database is created: `bunx wrangler d1 list`
2. `wrangler.toml` has the correct `database_id` (not "YOUR_DATABASE_ID_HERE")
3. Migrations are applied: `bun run db:migrate:local`

### Authentication not working locally

Check:

1. Dev server is running: `bun run dev`
2. Database migrations are applied
3. No errors in the console

### OAuth redirect issues

Verify:

1. Callback URLs match exactly in OAuth provider settings
2. For local dev: `http://localhost:4321/api/auth/callback/{provider}`
3. For production: `https://your-domain.com/api/auth/callback/{provider}`
4. Secrets are set: `bunx wrangler secret list` (for production)

### Build fails

Try:

1. Delete `node_modules` and reinstall: `rm -rf node_modules && bun install`
2. Clear Astro cache: `rm -rf .astro`
3. Rebuild: `bun run build`

## Useful Commands

```bash
# Development
bun run dev                    # Start dev server
bun run build                  # Build for production
bun run preview                # Preview production build

# Database
bun run db:generate            # Generate migrations from schema changes
bun run db:push                # Push schema directly (dev only, skips migrations)
bun run db:migrate:local       # Apply migrations locally
bun run db:migrate:remote      # Apply migrations to production
bun run db:studio              # Open Drizzle Studio

# Wrangler (Cloudflare)
bunx wrangler login            # Login to Cloudflare
bunx wrangler d1 list          # List D1 databases
bunx wrangler d1 execute arcturus-db --local --command="SELECT * FROM user"  # Query local DB
bunx wrangler secret put NAME  # Set production secret
bunx wrangler secret list      # List all secrets (names only)
bunx wrangler tail             # Tail production logs
bunx wrangler deploy           # Deploy to Cloudflare

# Deployment
bun run deploy                 # Build and deploy in one command
```

## Security Best Practices

1. **Always use HTTPS in production** - Cloudflare Workers handles this automatically
2. **Set a strong secret** - Use `openssl rand -base64 32` to generate
3. **Don't commit `.env`** - It's already in `.gitignore`
4. **Rotate secrets regularly** - Especially after team member changes
5. **Use Cloudflare secrets** - Not environment variables for sensitive data in production
6. **Validate user input** - Better Auth does this by default for auth flows
7. **Monitor logs** - Use `wrangler tail` to watch for suspicious activity

## Resources

- [Better Auth Documentation](https://better-auth.com)
- [Drizzle ORM Documentation](https://orm.drizzle.team)
- [Cloudflare D1 Documentation](https://developers.cloudflare.com/d1)
- [Cloudflare Workers Documentation](https://developers.cloudflare.com/workers)
- [Astro Documentation](https://docs.astro.build)

## Adding Custom Tables

Example of adding a posts table:

1. Edit `src/db/schema.ts`:

```typescript
export const posts = sqliteTable('posts', {
	id: text('id').primaryKey(),
	title: text('title').notNull(),
	content: text('content').notNull(),
	userId: text('userId')
		.notNull()
		.references(() => user.id),
	createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
	updatedAt: integer('updatedAt', { mode: 'timestamp' }).notNull(),
});
```

2. Generate migration:

```bash
bun run db:generate
```

3. Review the generated SQL in `drizzle/` directory

4. Apply migration:

```bash
bun run db:migrate:local  # For local
bun run db:migrate:remote # For production
```

5. Use in your code:

```typescript
import { createDb } from '../lib/db';

const db = createDb(runtime.env.DB);
const allPosts = await db.select().from(posts);
```
