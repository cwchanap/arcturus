# Google-Only Authentication Migration — Design

**Status:** Approved for planning  
**Date:** 2026-06-23  
**Scope:** Replace product email/password authentication with Google OAuth only. Keep existing Better Auth sessions, D1 user economy data, and Cloudflare Workers runtime patterns.

---

## 1. Goals

- Make Google OAuth the only product authentication method.
- Remove password sign-in and sign-up from the user-facing app.
- Remove the `/signup` route and update CTAs to route through `/signin`.
- Preserve the existing Better Auth session/middleware architecture and chip-balance enrichment.
- Require Google OAuth credentials in real app configuration, with no silent fallback.
- Keep Playwright E2E reliable without using real Google accounts.

## 2. Non-goals

- No account migration from password users to Google users.
- No automatic deletion of existing rows. Old local rows can be deleted manually.
- No temporary dual-auth migration window.
- No real Google login in CI.
- No replacement of Better Auth.

## 3. Decisions

| Topic | Decision |
| --- | --- |
| Existing password users | Clean break; no preservation by email |
| `/signup` | Remove route entirely |
| Old database rows | Leave untouched; manual cleanup is acceptable |
| Missing Google credentials | Fail hard instead of falling back |
| E2E auth | Use guarded dev/CI-only session bootstrap |

---

## 4. Architecture

`src/lib/auth.ts` remains the server-side auth factory, but its runtime configuration changes:

- Configure `socialProviders.google` with `env.GOOGLE_CLIENT_ID` and `env.GOOGLE_CLIENT_SECRET`.
- Remove or explicitly disable `emailAndPassword`.
- Keep the existing Drizzle/D1 adapter.
- Keep `BETTER_AUTH_SECRET` as the Better Auth secret.
- Stop relying on `process.env` inside Worker runtime auth code.

The auth API route stays at:

```text
/api/auth/[...all]
```

It continues to construct Better Auth from `Astro.locals.runtime.env` and return `auth.handler(context.request)`.

Middleware stays responsible for:

- Calling `auth.api.getSession()`.
- Setting `Astro.locals.session`.
- Setting `Astro.locals.user`.
- Enriching the session user with `chipBalance`.
- Handling missing DB binding by treating the request as unauthenticated.

Protected pages continue to redirect unauthenticated users to `/signin`.

---

## 5. Routes And UI

`/signin` becomes the only auth entry page.

The page renders one primary button: continue with Google. The client handler calls:

```ts
await authClient.signIn.social({
	provider: 'google',
	callbackURL: '/',
	errorCallbackURL: '/signin',
});
```

The page should show a concise error state if redirected back with an OAuth error query parameter.

`/signup` is removed. Links and CTAs that currently point at `/signup` move to `/signin`. Marketing copy may still say users get 10,000 free chips, because Better Auth will create a new Google-backed user on first login and the existing `user.chipBalance` default remains 10000.

Profile sign-out continues to use `authClient.signOut()` and redirect to `/signin`.

---

## 6. Data Model

No database migration is required for the auth model. The existing schema already has the Better Auth tables needed for OAuth:

- `user`
- `session`
- `account`
- `verification`

New Google users are represented as normal Better Auth users plus `account` rows with Google provider metadata.

The existing `account.password` column may remain in the schema because it is part of the current Better Auth-compatible table shape. Removing it would be a separate schema cleanup and is not needed for this migration.

Old local password users, sessions, and related gameplay rows can remain until manually deleted. The implementation must not include destructive migration logic.

---

## 7. Configuration

`Env` gains required Google OAuth bindings:

```ts
GOOGLE_CLIENT_ID: string;
GOOGLE_CLIENT_SECRET: string;
```

`BETTER_AUTH_SECRET` remains required for auth/session signing.

Local development uses `.dev.vars`:

```text
BETTER_AUTH_SECRET=<local-secret>
GOOGLE_CLIENT_ID=<google-oauth-client-id>
GOOGLE_CLIENT_SECRET=<google-oauth-client-secret>
```

Production uses Cloudflare secrets:

```bash
wrangler secret put BETTER_AUTH_SECRET
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
```

Google OAuth authorized redirect URIs:

```text
http://localhost:2000/api/auth/callback/google
https://<production-origin>/api/auth/callback/google
```

The implementation should validate required real-auth configuration before constructing the app auth object. Missing credentials should fail loudly so misconfigured deployments are caught immediately.

---

## 8. E2E And Dev/Test Auth

Playwright tests cannot use password forms after this migration. They will use a guarded dev/CI-only bootstrap path that creates authenticated storage state for test users without exposing a product password login.

The bootstrap path should require both:

```text
ENABLE_E2E_AUTH_BOOTSTRAP=true
E2E_AUTH_BOOTSTRAP_SECRET=<random-secret>
```

The endpoint or helper must reject requests when either guard is absent or invalid. Normal production config must not enable this path.

`e2e/global-setup.ts` should call the bootstrap path for the existing two test identities and save storage state to:

```text
e2e/.auth/user.json
e2e/.auth/user-2.json
```

The preferred implementation is the least invasive mechanism that produces real Better Auth session cookies consumed by the normal middleware. It may create clearly test-marked user/account rows or use a Better Auth session API if one is available and stable.

Tests that currently fill `/signin` and `/signup` email/password forms must be updated. Product-facing auth tests should assert:

- `/signin` renders the Google-only sign-in button.
- Protected routes redirect to `/signin`.
- Authenticated storage state reaches profile/game pages.
- Profile sign-out clears the session and returns to `/signin`.

---

## 9. Error Handling

- Missing real Google credentials fail app auth initialization.
- Google OAuth errors redirect to `/signin` and render a concise user-facing error.
- Missing DB binding keeps the current behavior: unauthenticated locals and protected-route redirects.
- E2E bootstrap requests without the correct flag and secret return a 404 or 403 and never create sessions.

---

## 10. Documentation Updates

Update repo guidance and setup docs so they match the new auth system:

- `CLAUDE.md`: replace email/password client examples with Google social sign-in.
- `README.md`: describe Google-only auth and Cloudflare secret setup.
- `.env.example`: document `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `BETTER_AUTH_SECRET`.
- GitHub Actions E2E workflow: add only E2E bootstrap env values, not real Google credentials.

---

## 11. Verification

Before implementation is considered complete:

- `bun run lint`
- `bun run test`
- `bun run build`
- Targeted Playwright auth/profile coverage, including E2E global setup and profile sign-out.

If full Playwright coverage is too slow during implementation, run the auth/profile subset first and note any broader suite that was not run.

---

## 12. Implementation Boundaries

This migration should stay focused on authentication:

- Do not rewrite game logic.
- Do not change chip economy behavior.
- Do not delete historical data.
- Do not add another social provider.
- Do not introduce a general test-login feature outside the guarded E2E path.
