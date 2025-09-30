# Local Development Setup

This guide explains how to set up and use a local Cloudflare D1 database for development.

## Quick Start

### 1. Install Dependencies

```bash
bun install
```

### 2. Setup Local Database

Run the automated setup script:

```bash
bun run setup:db
```

Or manually:

```bash
bun run db:migrate:local
```

### 3. Start Development Server

```bash
bun run dev
```

Visit [http://localhost:2000](http://localhost:2000)

## Understanding Local D1 Database

### How It Works

- **Wrangler** creates a local SQLite database in `.wrangler/state/v3/d1/`
- The `--local` flag tells Wrangler to use the local database instead of production
- Migrations are applied using `wrangler d1 execute` with `--local` flag
- Astro's Cloudflare adapter uses the local database during development

### Database Location

```
.wrangler/state/v3/d1/miniflare-D1DatabaseObject/
└── [database files stored here]
```

This directory is automatically created when you run migrations locally.

## Development Workflow

### Working with the Database

#### Query Local Database

```bash
# Simple query
wrangler d1 execute arcturus-db --local --command="SELECT * FROM user"

# Multiple queries
wrangler d1 execute arcturus-db --local --command="SELECT * FROM user; SELECT * FROM session;"

# Query with file
wrangler d1 execute arcturus-db --local --file=./queries.sql
```

#### View Database with Drizzle Studio

```bash
bun run db:studio
```

Opens at [https://local.drizzle.studio](https://local.drizzle.studio)

**Note**: Drizzle Studio connects to the local D1 database automatically.

### Making Schema Changes

1. **Edit schema**: `src/db/schema.ts`
2. **Generate migration**:
   ```bash
   bun run db:generate
   ```
3. **Apply locally**:
   ```bash
   bun run db:migrate:local
   ```
4. **Test your changes**:
   ```bash
   bun run dev
   ```

### Reset Local Database

If you need to start fresh:

```bash
# Remove local database
rm -rf .wrangler/state

# Re-run setup
bun run setup:db
```

## Package.json Scripts

```json
{
	"setup:db": "tsx scripts/setup-local-db.ts",
	"db:generate": "drizzle-kit generate",
	"db:push": "drizzle-kit push",
	"db:migrate:local": "wrangler d1 execute arcturus-db --local --file=./drizzle/0000_powerful_wrecking_crew.sql",
	"db:migrate:remote": "wrangler d1 execute arcturus-db --remote --file=./drizzle/0000_powerful_wrecking_crew.sql",
	"db:studio": "drizzle-kit studio"
}
```

### Script Explanations

- **`setup:db`**: Automated setup script for local database (runs with tsx)
- **`db:generate`**: Creates a new migration file based on schema changes
- **`db:push`**: Pushes schema directly to database (skips migrations - use for quick prototyping)
- **`db:migrate:local`**: Applies migrations to local development database
- **`db:migrate:remote`**: Applies migrations to production database
- **`db:studio`**: Opens Drizzle Studio for visual database management

## Local vs Production

### Local Development (--local flag)

- Uses SQLite database in `.wrangler/state/`
- No remote connection needed
- Fast and isolated
- Perfect for development and testing

### Production (--remote flag)

- Connects to Cloudflare D1 database
- Requires Cloudflare authentication
- Used for deployment

## Troubleshooting

### Database Not Found

**Problem**: `Error: No database with name arcturus-db found`

**Solution**: The local database is created automatically when you run migrations. Make sure to run:

```bash
bun run setup:db
```

### Migration Already Applied

**Problem**: `Error: UNIQUE constraint failed`

**Solution**: The migration was already applied. If you need to reset:

```bash
rm -rf .wrangler/state
bun run setup:db
```

### Table Not Found

**Problem**: `Error: no such table: user`

**Solution**: Migrations haven't been applied. Run:

```bash
bun run setup:db
```

### Stale Data

**Problem**: Old data from previous development sessions

**Solution**: Reset the local database:

```bash
rm -rf .wrangler/state
bun run setup:db
```

## Development Tips

### 1. Use db:push for Rapid Prototyping

When experimenting with schema changes:

```bash
# Make changes to src/db/schema.ts
bun run db:push
```

This pushes changes directly without creating migration files. Perfect for trying things out!

### 2. Inspect Database Structure

```bash
wrangler d1 execute arcturus-db --local --command="SELECT sql FROM sqlite_master WHERE type='table'"
```

### 3. Check Table Contents

```bash
wrangler d1 execute arcturus-db --local --command="SELECT * FROM user LIMIT 5"
```

### 4. Test Authentication Locally

1. Start dev server: `bun run dev`
2. Visit: http://localhost:2000/signup
3. Create a test account
4. Verify in database:
   ```bash
   wrangler d1 execute arcturus-db --local --command="SELECT * FROM user"
   ```

### 5. Seed Test Data

Create a `seed.sql` file:

```sql
INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
VALUES
  ('test-1', 'Test Player', 'test@example.com', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
```

Apply it:

```bash
wrangler d1 execute arcturus-db --local --file=./seed.sql
```

## Git Ignore

The `.wrangler/` directory should be in `.gitignore` so your local database won't be committed to version control.

## Next Steps

Once your local development is working:

1. **Test thoroughly** with local database
2. **Create production database**: `wrangler d1 create arcturus-db`
3. **Update `wrangler.toml`** with production database ID
4. **Apply migrations to production**: `bun run db:migrate:remote`
5. **Deploy**: `bun run deploy`

See [AUTH_SETUP.md](./AUTH_SETUP.md) for complete production deployment instructions.
