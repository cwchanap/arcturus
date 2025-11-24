# Arcturus Casino Platform Constitution

<!--
Sync Impact Report (2025-11-23):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Version Change: [UNVERSIONED] → 1.0.0 (Initial constitution)

Principles Defined:
- I. Edge-First Runtime (NEW): Cloudflare Workers constraints
- II. Factory Pattern for Bindings (NEW): Environment access patterns
- III. Modular Game Architecture (NEW): Game logic organization
- IV. Test Coverage Standards (NEW): Unit + E2E testing requirements
- V. Code Quality Enforcement (NEW): Automated quality gates

Sections Added:
- Core Principles (5 principles defined)
- Development Standards (tech stack, code style, testing)
- Deployment & Security (Cloudflare patterns, secrets management)
- Governance (amendment process, compliance)

Templates Updated:
✅ plan-template.md - Constitution Check section aligned
✅ spec-template.md - Requirements structure aligned
✅ tasks-template.md - Task categorization aligned
✅ checklist-template.md - Format compatible
✅ agent-file-template.md - References updated

Follow-up TODOs: None
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
-->

## Core Principles

### I. Edge-First Runtime

**All code MUST run on Cloudflare Workers edge runtime, NOT Node.js.**

- MUST use `Astro.locals.runtime.env` for environment variables (NEVER `process.env`)
- MUST use factory patterns for D1 database and KV bindings
- MUST test with Cloudflare Workers compatibility in mind
- MUST avoid Node.js-specific APIs (fs, child_process, etc.)

**Rationale**: Cloudflare Workers provide global edge distribution with zero cold starts. Using Node.js patterns breaks deployment. This constraint ensures production parity and prevents "works locally" failures.

### II. Factory Pattern for Bindings

**All Cloudflare bindings (D1, KV, secrets) MUST be accessed via factory functions.**

- Database access: `createDb(Astro.locals.runtime.env.DB)`
- Auth instance: `createAuth(dbBinding, env, baseURL)`
- MUST NOT pass raw bindings through component props
- MUST centralize binding logic in `src/lib/` modules

**Rationale**: Factory patterns enforce type safety, enable testing with mocks, and provide a single source of truth for binding configuration. Direct binding access creates tight coupling and makes unit testing impossible.

### III. Modular Game Architecture

**Game logic MUST be extracted to standalone, testable modules in `src/lib/{game}/`.**

- Pure functions for game rules (e.g., hand evaluation, pot calculation)
- Class-based game state managers (e.g., `PokerGame.ts`)
- UI rendering separated from game logic (e.g., `PokerUIRenderer.ts`)
- AI/strategy modules isolated (e.g., `aiStrategy.ts`, `llmAIStrategy.ts`)
- MUST include unit tests for all game logic modules

**Rationale**: Casino games have complex rules that require thorough testing. Modular architecture enables unit testing of game logic independently of UI, supports code reuse across games, and prevents monolithic page files.

### IV. Test Coverage Standards

**Features MUST have appropriate test coverage before deployment.**

- **Unit Tests** (Bun): Game logic, utilities, pure functions
- **E2E Tests** (Playwright): Critical user flows (auth, gameplay, transactions)
- MUST test Cloudflare Workers-specific patterns (env access, D1 queries)
- E2E tests MUST reuse auth state via global setup (no repeated logins)
- MUST NOT deploy features with failing tests

**Rationale**: Casino platforms handle real money (chips) and must be reliable. Comprehensive testing prevents bugs that could affect user balances or game fairness. E2E tests validate production-like behavior on Cloudflare Workers.

### V. Code Quality Enforcement

**Code quality is enforced automatically via pre-commit hooks and CI.**

- **Tabs** (width 2) for indentation, **single quotes**, **semicolons required**
- ESLint MUST pass with **0 warnings** (max-warnings=0)
- Prettier MUST pass format checks
- Husky + lint-staged run checks on commit
- MUST NOT bypass hooks with `--no-verify` without explicit justification

**Rationale**: Automated enforcement ensures consistency across contributions, prevents style debates, and catches common errors before PR review. Zero-warning policy prevents warning accumulation.

## Development Standards

### Technology Stack

**Core Technologies** (NON-NEGOTIABLE):

- **Runtime**: Cloudflare Workers (edge compute)
- **Framework**: Astro SSR (`output: 'server'`) with Cloudflare adapter
- **Authentication**: Better Auth (session-based, NOT JWT)
- **Database**: Drizzle ORM + Cloudflare D1 (edge SQLite)
- **Styling**: Tailwind CSS v4 (via Vite plugin, NOT PostCSS)
- **Package Manager**: Bun (NOT npm/yarn/pnpm)
- **Testing**: Bun (unit) + Playwright (E2E)

### Code Style

**Naming Conventions**:

- Astro components: `PascalCase.astro` (e.g., `PlayingCard.astro`)
- Routes: `kebab-case.astro` (e.g., `poker.astro`)
- TypeScript: `camelCase` for variables/functions, `PascalCase` for types/classes
- Database tables: `snake_case` (Drizzle convention, e.g., `llm_settings`)

**File Organization**:

- Components: `/src/components/` (reusable UI)
- Pages: `/src/pages/` (routes, API endpoints)
- Game logic: `/src/lib/{game}/` (modular, testable)
- Layouts: `/src/layouts/` (use `casino.astro` for games)
- Database: `/src/db/schema.ts` (single source of truth)

### Testing Requirements

**Unit Tests** (`bun run test`):

- MUST test pure functions (game rules, utilities)
- MUST NOT rely on global state or external dependencies
- MUST run in isolation without network/database access

**E2E Tests** (`bun run test:e2e`):

- MUST cover critical user journeys (signup, signin, game play, chip transactions)
- MUST use global setup for authentication (save to `e2e/.auth/user.json`)
- MUST clean up test data after runs
- MUST test against local Cloudflare Workers dev server (port 2000)

**Test Account** (for E2E):

- Email: `e2e-test@arcturus.local`
- Password: `PlaywrightTest123!`
- Name: `E2E Test User`

## Deployment & Security

### Database Migrations

**Migration Workflow** (MANDATORY):

1. Edit `src/db/schema.ts` (single source of truth)
2. Generate migration: `bun run db:generate`
3. Apply locally: `bun run db:migrate:local`
4. Test with dev server: `bun run dev`
5. Deploy to production: `bun run db:migrate:remote` (ONLY after testing)

**Rules**:

- MUST update `package.json` migration script paths when adding new migrations
- MUST test migrations locally before production deployment
- MUST handle missing columns gracefully in middleware (see `chipBalance` pattern)

### Secrets Management

**Cloudflare Secrets** (MANDATORY):

- MUST store secrets via `wrangler secret put` (NOT in `wrangler.toml` or `.env`)
- MUST access secrets via `Astro.locals.runtime.env.SECRET_NAME`
- MUST generate `BETTER_AUTH_SECRET` with `openssl rand -base64 32`
- MUST rotate secrets on security incidents

**User Secrets** (LLM API keys):

- MUST encrypt API keys in `llm_settings` table
- MUST validate API keys before storing
- MUST NOT log or expose API keys in error messages

### Protected Routes

**Authentication Pattern** (MANDATORY):

```astro
---
const user = Astro.locals.user; // Injected by middleware
if (!user) return Astro.redirect('/signin');
---
```

**Rules**:

- MUST protect all routes in `/pages/games/` and `/pages/profile.astro`
- MUST use middleware-injected `Astro.locals.user` (includes `chipBalance`)
- MUST NOT implement custom auth checks (use middleware pattern)

## Governance

### Constitution Authority

This constitution supersedes all other development practices and style guides. When in conflict:

1. **Constitution** takes precedence
2. **CLAUDE.md** provides implementation guidance (MUST align with constitution)
3. **Local conventions** apply only where constitution is silent

### Amendment Process

**MAJOR version** (X.0.0): Backward-incompatible changes

- Removing/redefining core principles
- Changing non-negotiable tech stack requirements
- Removing mandatory gates or checks

**MINOR version** (0.X.0): Additive changes

- Adding new principles or sections
- Expanding guidance on existing principles
- Adding new mandatory requirements

**PATCH version** (0.0.X): Clarifications

- Fixing typos or wording
- Adding examples or rationale
- Non-semantic refinements

### Compliance Review

**Pre-commit checks** (automated):

- Linting (ESLint with 0 warnings)
- Formatting (Prettier)
- Commit message format (via Husky)

**PR requirements** (mandatory):

- Constitution compliance verification
- Test coverage for new features
- Migration scripts for schema changes
- Deployment checklist completion (for production PRs)

**Runtime guidance**: See `CLAUDE.md` for day-to-day development patterns and troubleshooting.

---

**Version**: 1.0.0 | **Ratified**: 2025-11-23 | **Last Amended**: 2025-11-23
