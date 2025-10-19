---
trigger: manual
---

# Repository Guidelines

## Project Structure & Module Organization

This Astro application is organized by feature under `src/`. Route files live in `src/pages`, shared layouts in `src/layouts`, and reusable UI in `src/components`. Auth and database utilities sit in `src/lib` and `src/db`; update Drizzle schema code here and keep generated SQL snapshots in `drizzle/`. Static assets belong in `public/`, middleware logic stays in `src/middleware.ts`, and workflow helpers go under `scripts/`. Production builds output to `dist/` and should remain untracked.

## Build, Test, and Development Commands

Install dependencies with `bun install`. Run `bun run dev` for the local server and `bun run preview` to inspect a production build. Create deployable artifacts via `bun run build`. Maintain database structure with `bun run db:generate`, apply migrations locally using `bun run db:migrate:local`, and bootstrap a fresh D1 instance through `bun run setup:db`. Lint with `bun run lint`, auto-fix using `bun run lint:fix`, and confirm formatting through `bun run format:check` before opening a PR.

## Coding Style & Naming Conventions

ESLint (configured in `eslint.config.js`) and Prettier enforce two-space indentation, TypeScript strictness, and Astro best practices. Prefer named exports for shared helpers, keep Astro component filenames in PascalCase, and mirror URL paths with kebab-case route names. Tailwind utility classes may remain inline; move repeated patterns into `src/styles` or shared components.

## Testing Guidelines

An automated suite is not yet committed. Until we standardize one, validate features by running `bun run preview` and manually exercising key pages, auth transitions, and D1 interactions. When adding substantial functionality, include lightweight regression scripts (e.g., Astro component checks or Playwright smoke tests) under a `tests/` directory so the CI workflow can adopt them later.

## Test Accounts

Use the Chrome Dev MCP environment to exercise the full sign-up flow with the shared QA account:

- Email: `test@cwchanap.dev`
- Password: `password123`
  Reset the password after demos and clean related D1 records once the scenario is complete.

## Commit & Pull Request Guidelines

Use short, imperative commit subjects (see `git log` examples such as `Update logo navigation` or `feat: add casino gaming platform`). Group related edits, and add concise bodies for context or follow-up tasks. Pull requests should describe the change, link issues, and include screenshots or output when touching UI or database flows. Note the commands you ran (lint, preview, migrations) to speed up review and avoid regressions.

## Security & Configuration Tips

Store secrets in local `.dev.vars` files or Wrangler environment variables; never commit credentials. Follow `AUTH_SETUP.md` when adjusting providers and document new environment keys in PRs. Confirm `wrangler.toml` bindings stay aligned with the latest Drizzle migrations before deploying.

## Dev server

URL: http://localhost:2000/. Always check before starting a new one
