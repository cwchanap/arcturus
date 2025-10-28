<!--
SYNC IMPACT REPORT
Version: 1.0.0 → 1.0.1
Rationale: Accuracy and consistency fixes for code quality standards and testing commands

Modified Principles:
  - Code Quality Standards: Corrected indentation specification (tabs, not spaces)
  - Testing Standards: Updated test coverage command to reflect actual scope
  - Development Workflow: Added dev server port documentation

Added Sections: None
Removed Sections: None

Templates requiring updates:
  ✅ .specify/templates/plan-template.md - No changes needed (already aligned)
  ✅ .specify/templates/spec-template.md - No changes needed (already aligned)
  ✅ .specify/templates/tasks-template.md - No changes needed (already aligned)
  ⚠️  AGENTS.md - Already correct (tabs with width 2)
  ⚠️  package.json - E2E test script missing (Playwright tests mentioned but no script exists)

Follow-up TODOs:
  - Consider adding `test:e2e` script for Playwright tests (mentioned in principle but not implemented)
  - Consider adding generic `test:coverage` that covers all modules (currently poker-only)
-->

# Arcturus Casino Constitution

## Core Principles

### I. Code Quality First

Code quality is non-negotiable and enforced automatically before code enters the repository.

**Rules**:

- ESLint and Prettier MUST pass before commits (enforced via Husky pre-commit hooks)
- TypeScript strict mode MUST be enabled for all `.ts` and `.astro` files
- No `console.log` statements in production code (warnings allowed, errors/warnings permitted)
- Unused variables MUST be prefixed with `_` if intentionally unused
- All Astro components MUST follow PascalCase naming conventions
- Route files MUST use kebab-case matching their URL paths
- Named exports MUST be preferred over default exports for shared utilities

**Rationale**: Automated quality gates prevent technical debt accumulation and ensure consistency across the codebase. Pre-commit hooks catch issues before they reach code review, reducing reviewer cognitive load and maintaining high standards.

### II. Testing Standards

Testing is mandatory for business logic, game mechanics, and critical user flows. Tests MUST exist before features are considered complete.

**Rules**:

- All game logic in `src/lib/poker/` or similar MUST have unit tests with >80% coverage
- Integration tests MUST exist for authentication flows and game state transitions
- Playwright tests MUST cover critical user journeys (sign-in → game play → actions)
- Tests MUST be written before or alongside implementation (TDD encouraged but not strictly enforced)
- Test files MUST be colocated with source files (e.g., `handEvaluator.test.ts` next to `handEvaluator.ts`)
- Coverage reports MUST be generated via `bun test --coverage` and reviewed before PRs merge (example: `bun test src/lib/poker --coverage` for poker module)

**Rationale**: Casino gaming logic requires high reliability. Users expect games to work correctly, and bugs in game mechanics directly impact trust and user satisfaction. Test coverage ensures correctness and enables confident refactoring.

### III. User Experience Consistency

User experience MUST be consistent across all games and pages, following established patterns and components.

**Rules**:

- All game pages MUST use `casino.astro` layout for consistent theming
- All games MUST require authentication and redirect unauthenticated users to `/signin`
- Reusable components (`PlayingCard.astro`, `PokerChip.astro`, `Button.astro`, `GameCard.astro`) MUST be used instead of duplicating UI patterns
- Game actions MUST provide immediate visual feedback (loading states, animations, transitions)
- Error messages MUST be user-friendly and actionable (avoid technical jargon)
- All interactive elements MUST have accessible labels and keyboard navigation support
- Color contrast MUST meet WCAG AA standards for readability

**Rationale**: Consistency builds user trust and reduces cognitive load. Players should feel familiar with controls and navigation across all games. Reusable components ensure design system integrity and accelerate development.

### IV. Performance Requirements

Performance is critical for user satisfaction on edge deployments. All features MUST meet baseline performance standards.

**Rules**:

- Initial page load MUST complete in <2 seconds on 3G connections
- Time to Interactive (TTI) MUST be <3 seconds for game pages
- Database queries MUST use indexes and avoid N+1 queries
- Client-side JavaScript bundles MUST be code-split per route (Astro's default behavior)
- Images MUST be optimized and served in modern formats (WebP/AVIF with fallbacks)
- Cloudflare Workers response time MUST average <100ms (p95 <200ms)
- Game state updates MUST render within 16ms (60fps) to avoid jank

**Measurement**:

- Use Lighthouse CI for production builds (`bun run build && bun run preview`)
- Monitor Cloudflare Analytics for edge performance metrics
- Profile client-side rendering with Chrome DevTools Performance tab

**Rationale**: Edge deployment on Cloudflare Workers provides low latency, but inefficient code negates this advantage. Casino users expect snappy interactions; slow games feel broken and untrustworthy.

### V. Security & Data Integrity

Security is paramount for authentication, player data, and game fairness. All features MUST follow secure development practices.

**Rules**:

- Secrets MUST NEVER be committed to version control (use `.dev.vars` or Wrangler secrets)
- Database access MUST use Cloudflare bindings (`Astro.locals.runtime.env.DB`), NOT `process.env`
- All API routes handling sensitive data MUST validate authentication via `Astro.locals.user`
- User input MUST be validated and sanitized before database operations (use Drizzle's type safety)
- Session tokens MUST be httpOnly, secure, and SameSite=Lax
- Database migrations MUST be tested locally before applying to production (`db:migrate:local` then `db:migrate:remote`)
- SQL injection MUST be prevented via parameterized queries (Drizzle ORM enforces this)

**Rationale**: Casino platforms handle sensitive player data and financial transactions (even virtual). Security breaches destroy trust irreparably. Defense-in-depth and secure-by-default patterns are non-negotiable.

## Code Quality Standards

### Formatting & Style (Auto-Enforced)

- **Indentation**: Tabs (visual width 2 spaces when rendered)
- **Quotes**: Single quotes for strings
- **Semicolons**: Required
- **Line Length**: 100 characters (soft limit, Prettier handles wrapping)
- **Trailing Commas**: Always (improves diffs)

### TypeScript Standards

- Strict mode MUST be enabled (`tsconfig.json` → `strict: true`)
- `any` type is prohibited except with explicit justification and `@ts-expect-error` comment
- Type inference is preferred over explicit annotations when obvious
- Interfaces MUST be preferred over type aliases for object shapes
- Enums SHOULD be avoided in favor of string literal unions

### Component Standards

- Astro components MUST separate concerns (logic in frontmatter, UI in template)
- Client-side JavaScript MUST be isolated in `<script>` tags with explicit `is:inline` or bundled behavior
- Props MUST be typed via TypeScript interfaces
- Components MUST be documented with JSDoc comments for complex APIs

### Database Standards

- Schema changes MUST go through migrations (`bun run db:generate`)
- Direct SQL MUST be avoided (use Drizzle query builder)
- Foreign keys MUST be defined for relational integrity
- Indexes MUST be added for frequently queried columns

## Development Workflow

### Pre-Commit Workflow

1. Code changes are made in feature branch
2. Run `bun run lint` and `bun run format:check` manually before commit
3. Husky pre-commit hook runs automatically:
   - ESLint with `--max-warnings 0`
   - Prettier formatting check
   - Lint-staged applies fixes to staged files
4. If hooks fail, fix errors and re-stage files
5. Commit message MUST follow conventional commits style (e.g., `feat:`, `fix:`, `docs:`)

### Development Server

- Local development server runs on **port 2000** (configured in `astro.config.mjs`)
- Access via `http://localhost:2000` after running `bun run dev`

### Testing Workflow

1. For new game logic: Write unit tests in `.test.ts` files colocated with source
2. For new user flows: Add Playwright tests in `tests/` directory
3. Run tests locally: `bun test` (unit) and `bun test tests/` (integration with Playwright)
4. Generate coverage: `bun test <module-path> --coverage` (e.g., `bun test src/lib/poker --coverage`)
5. Ensure >80% coverage for game logic before marking PR ready

### Pull Request Requirements

PRs MUST include:

- Description of changes and link to related issue/spec
- Screenshots or screen recordings for UI changes
- Test results (unit + integration coverage)
- Confirmation that `bun run preview` was tested locally
- Database migration verification if schema changed
- Performance impact assessment for large features

### Review Checklist

Reviewers MUST verify:

- Constitution compliance (principles I-V)
- Test coverage meets standards
- No hard-coded secrets or credentials
- Cloudflare bindings used correctly (`runtime.env.DB`)
- Error handling present for API routes and database operations
- Accessibility standards met (keyboard nav, ARIA labels, color contrast)

### Deployment Workflow

1. Merge PR to `main` branch
2. Run `bun run build` to generate production build
3. Apply migrations to production: `bun run db:migrate:remote`
4. Deploy to Cloudflare: `bun run deploy`
5. Verify deployment via Cloudflare dashboard and tail logs: `wrangler tail`
6. Smoke test critical paths (sign-in, game load, basic actions)

## Governance

This constitution supersedes all other development practices. When conflicts arise between this document and other guidance (README, AGENTS.md, etc.), this constitution takes precedence.

**Amendment Process**:

- Amendments MUST be proposed via Pull Request to `.specify/memory/constitution.md`
- Version MUST be bumped according to semantic versioning:
  - **MAJOR**: Backward-incompatible principle removal or redefinition
  - **MINOR**: New principle added or materially expanded guidance
  - **PATCH**: Clarifications, typo fixes, non-semantic refinements
- Amendments MUST include rationale and impact assessment
- Dependent templates (plan, spec, tasks) MUST be updated to reflect changes
- Sync impact report MUST be generated and prepended as HTML comment

**Compliance Review**:

- All PRs MUST verify compliance with this constitution
- Principle violations MUST be justified and documented in `plan.md` → Complexity Tracking section
- Unjustified violations MUST be rejected in code review
- Recurring violations indicate need for constitution amendment or additional tooling

**Runtime Development Guidance**:

- For day-to-day development patterns, refer to `.github/copilot-instructions.md`
- For repository structure and workflow, refer to `AGENTS.md`
- For authentication setup, refer to `AUTH_SETUP.md`

**Version**: 1.0.1 | **Ratified**: 2025-10-27 | **Last Amended**: 2025-10-27
