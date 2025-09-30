# Quick Start Guide

## 🚀 Get Started in 3 Steps

### 1. Install & Setup Database
```bash
# Install dependencies
bun install

# Login to Cloudflare
bunx wrangler login

# Create database
bunx wrangler d1 create arcturus-db

# Copy the database_id from output and update wrangler.toml
```

### 2. Apply Database Schema
```bash
# Apply migrations to local database
bun run db:migrate:local
```

### 3. Start Development
```bash
# Start dev server
bun run dev

# Visit http://localhost:4321
```

## 📋 Common Commands

### Development
```bash
bun run dev              # Start dev server (http://localhost:4321)
bun run build            # Build for production
bun run preview          # Preview production build
```

### Database
```bash
bun run db:generate      # Generate new migration after schema changes
bun run db:migrate:local # Apply migrations locally
bun run db:studio        # Open Drizzle Studio (visual DB manager)
```

### Deployment
```bash
# Set production secret (first time only)
openssl rand -base64 32  # Generate secret
bunx wrangler secret put BETTER_AUTH_SECRET  # Set it

# Deploy
bun run deploy           # Build and deploy to Cloudflare
```

## 🔐 Authentication Routes

| Route | Description |
|-------|-------------|
| `/` | Home page (public) |
| `/signin` | Sign in page |
| `/signup` | Sign up page |
| `/dashboard` | Protected page (requires auth) |
| `/api/auth/*` | Auth API endpoints |

## 🏗️ Project Structure

```
src/
├── components/
│   └── UserNav.astro          # Navigation with auth state
├── db/
│   └── schema.ts              # Database schema
├── layouts/
│   └── main.astro             # Main layout
├── lib/
│   ├── auth.ts                # Server-side auth config
│   ├── auth-client.ts         # Client-side auth
│   └── db.ts                  # Database client
├── pages/
│   ├── api/auth/[...all].ts   # Auth API handler
│   ├── dashboard.astro        # Protected page
│   ├── signin.astro           # Sign in
│   ├── signup.astro           # Sign up
│   └── index.astro            # Home
├── middleware.ts              # Global auth middleware
└── env.d.ts                   # TypeScript types
```

## 🗄️ Database Tables

- **user** - User accounts
- **session** - Active sessions
- **account** - OAuth provider accounts
- **verification** - Email verification tokens

## 🔧 Adding OAuth (Optional)

### GitHub
1. Create OAuth App at https://github.com/settings/developers
2. Set callback URL: `http://localhost:4321/api/auth/callback/github`
3. Add to `.env`:
   ```
   GITHUB_CLIENT_ID=your_id
   GITHUB_CLIENT_SECRET=your_secret
   ```

### Google
1. Create OAuth App at https://console.cloud.google.com/
2. Set redirect URI: `http://localhost:4321/api/auth/callback/google`
3. Add to `.env`:
   ```
   GOOGLE_CLIENT_ID=your_id
   GOOGLE_CLIENT_SECRET=your_secret
   ```

## 🐛 Troubleshooting

### "Database not configured"
- Make sure D1 database is created
- Check `wrangler.toml` has correct `database_id`
- Run `bun run db:migrate:local`

### Build fails
```bash
rm -rf node_modules .astro dist
bun install
bun run build
```

### Can't sign in locally
- Check dev server is running
- Check browser console for errors
- Verify database has tables: `bun run db:studio`

## 📚 Documentation

- **README.md** - Project overview
- **AUTH_SETUP.md** - Detailed setup guide
- **IMPLEMENTATION_SUMMARY.md** - Technical details

## 🔗 Helpful Links

- [Better Auth Docs](https://better-auth.com)
- [Drizzle ORM Docs](https://orm.drizzle.team)
- [Cloudflare D1 Docs](https://developers.cloudflare.com/d1)
- [Astro Docs](https://docs.astro.build)

## 💡 Tips

- Use `bun run db:studio` to inspect database
- Check `bunx wrangler tail` for production logs
- Use `.env` for local development only
- Always use Cloudflare secrets for production
- Test authentication flows before deploying

## 🚨 Important Notes

1. **Never commit `.env`** - It's in `.gitignore`
2. **Change default secret** - Set `BETTER_AUTH_SECRET` for production
3. **Update `wrangler.toml`** - Replace `YOUR_DATABASE_ID_HERE` with actual ID
4. **HTTPS required** - OAuth only works with HTTPS in production

## ✅ Ready to Deploy?

```bash
# 1. Set secret
openssl rand -base64 32
bunx wrangler secret put BETTER_AUTH_SECRET

# 2. Apply migrations
bun run db:migrate:remote

# 3. Deploy
bun run deploy

# 4. Visit your site
# Check deployment URL in console output
```

---

Need help? Check **AUTH_SETUP.md** for detailed instructions.
