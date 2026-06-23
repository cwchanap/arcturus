# Google-Only Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace product email/password authentication with Google OAuth only while preserving Better Auth sessions, Cloudflare Workers runtime patterns, and reliable Playwright authentication.

**Architecture:** The app keeps Better Auth and the existing Astro middleware. `src/lib/auth.ts` becomes a Google-only auth factory with explicit Worker env validation. A guarded Better Auth plugin exposes a dev/CI-only bootstrap endpoint so Playwright can create real Better Auth session cookies without product password auth.

**Tech Stack:** Astro SSR, Cloudflare Workers runtime env, Better Auth 1.3.23, Drizzle/D1, Bun tests, Playwright.

---

## File Structure

- Modify `src/lib/auth.ts`: env validation, Google provider config, no password provider, optional E2E bootstrap plugin wiring.
- Create `src/lib/e2e-auth-bootstrap.ts`: guarded Better Auth plugin for E2E session bootstrap.
- Modify `src/env.d.ts`: required Google and Better Auth secrets, optional E2E bootstrap flags.
- Modify `src/pages/signin.astro`: single Google OAuth button and OAuth error display.
- Delete `src/pages/signup.astro`: remove password registration route.
- Modify `src/pages/index.astro` and `src/components/UserNav.astro`: replace `/signup` links with `/signin`.
- Modify `e2e/auth.setup.ts`: remove password-centric test constants and expose both test users.
- Create `e2e/bootstrap-auth.ts`: shared Playwright helper that calls the guarded bootstrap endpoint.
- Modify `e2e/global-setup.ts`: bootstrap test users via API instead of forms.
- Modify `e2e/auth-helpers.ts`, `e2e/profile.spec.ts`, and `e2e/craps.spec.ts`: remove password form usage.
- Create `e2e/auth-ui.spec.ts`: Google-only sign-in UI coverage after E2E bootstrap is in place.
- Modify `.github/workflows/e2e.yml`: add dummy Google vars and bootstrap secret for CI.
- Modify `CLAUDE.md`, `README.md`, and `.env.example`: document Google-only auth.

---

### Task 1: Auth Env Validation And Google-Only Config

**Files:**

- Modify: `src/lib/auth.ts`
- Modify: `src/env.d.ts`
- Test: `src/lib/auth.test.ts`

- [ ] **Step 1: Write failing auth config tests**

Create `src/lib/auth.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { buildAuthConfig, getRequiredAuthConfig } from './auth';

const drizzleDb = {} as Parameters<typeof buildAuthConfig>[0];

const completeEnv = {
	BETTER_AUTH_SECRET: 'test-better-auth-secret',
	GOOGLE_CLIENT_ID: 'test-google-client-id',
	GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
};

describe('auth configuration', () => {
	test('requires Better Auth and Google OAuth secrets', () => {
		expect(() => getRequiredAuthConfig({})).toThrow(
			'Missing required auth environment binding(s): BETTER_AUTH_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET',
		);
	});

	test('returns normalized required auth config', () => {
		expect(getRequiredAuthConfig(completeEnv)).toEqual({
			betterAuthSecret: 'test-better-auth-secret',
			googleClientId: 'test-google-client-id',
			googleClientSecret: 'test-google-client-secret',
		});
	});

	test('builds Google-only Better Auth options', () => {
		const config = buildAuthConfig(drizzleDb, completeEnv, 'http://localhost:2000');

		expect(config.secret).toBe('test-better-auth-secret');
		expect(config.emailAndPassword).toEqual({ enabled: false });
		expect(config.socialProviders?.google?.clientId).toBe('test-google-client-id');
		expect(config.socialProviders?.google?.clientSecret).toBe('test-google-client-secret');
		expect(config.baseURL).toBe('http://localhost:2000');
		expect(config.trustedOrigins).toEqual(['http://localhost:2000']);
	});
});
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run:

```bash
bun test src/lib/auth.test.ts
```

Expected: FAIL because `buildAuthConfig` and `getRequiredAuthConfig` are not exported from `src/lib/auth.ts`.

- [ ] **Step 3: Implement env validation and Google-only config**

Replace `src/lib/auth.ts` with:

```ts
import { betterAuth } from 'better-auth';
import type { BetterAuthOptions, BetterAuthPlugin } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../db/schema';

export type AuthEnvInput = Partial<
	Pick<Env, 'BETTER_AUTH_SECRET' | 'GOOGLE_CLIENT_ID' | 'GOOGLE_CLIENT_SECRET'>
>;

export function getRequiredAuthConfig(env: AuthEnvInput) {
	const missing = [
		['BETTER_AUTH_SECRET', env.BETTER_AUTH_SECRET],
		['GOOGLE_CLIENT_ID', env.GOOGLE_CLIENT_ID],
		['GOOGLE_CLIENT_SECRET', env.GOOGLE_CLIENT_SECRET],
	]
		.filter(([, value]) => typeof value !== 'string' || value.trim().length === 0)
		.map(([key]) => key);

	if (missing.length > 0) {
		throw new Error(`Missing required auth environment binding(s): ${missing.join(', ')}`);
	}

	return {
		betterAuthSecret: env.BETTER_AUTH_SECRET as string,
		googleClientId: env.GOOGLE_CLIENT_ID as string,
		googleClientSecret: env.GOOGLE_CLIENT_SECRET as string,
	};
}

export function buildAuthConfig(
	drizzleDb: ReturnType<typeof drizzle>,
	env: AuthEnvInput,
	baseURL?: string,
	plugins: BetterAuthPlugin[] = [],
): BetterAuthOptions {
	const authEnv = getRequiredAuthConfig(env);
	const authConfig: BetterAuthOptions = {
		database: drizzleAdapter(drizzleDb, {
			provider: 'sqlite',
		}),
		secret: authEnv.betterAuthSecret,
		emailAndPassword: {
			enabled: false,
		},
		socialProviders: {
			google: {
				clientId: authEnv.googleClientId,
				clientSecret: authEnv.googleClientSecret,
			},
		},
		plugins,
	};

	if (baseURL) {
		authConfig.baseURL = baseURL;
		authConfig.trustedOrigins = [baseURL];
	}

	return authConfig;
}

export function createAuth(db: D1Database, env: Env, baseURL?: string) {
	const drizzleDb = drizzle(db, { schema });
	return betterAuth(buildAuthConfig(drizzleDb, env, baseURL));
}

export type Auth = ReturnType<typeof createAuth>;
```

Update `src/env.d.ts`:

```ts
interface Env {
	DB: D1Database;
	BETTER_AUTH_SECRET: string;
	GOOGLE_CLIENT_ID: string;
	GOOGLE_CLIENT_SECRET: string;
	ENABLE_E2E_AUTH_BOOTSTRAP?: string;
	E2E_AUTH_BOOTSTRAP_SECRET?: string;
	MP_AUTH_SECRET?: string;
	arcturus: DurableObjectNamespace;
	WORKER_ORIGIN?: string;
}
```

- [ ] **Step 4: Run the focused test and confirm it passes**

Run:

```bash
bun test src/lib/auth.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/lib/auth.ts src/env.d.ts src/lib/auth.test.ts
git commit -m "feat(auth): configure google-only auth"
```

---

### Task 2: E2E Better Auth Bootstrap Plugin

**Files:**

- Create: `src/lib/e2e-auth-bootstrap.ts`
- Test: `src/lib/e2e-auth-bootstrap.test.ts`

- [ ] **Step 1: Write failing bootstrap helper tests**

Create `src/lib/e2e-auth-bootstrap.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import {
	E2E_BOOTSTRAP_SECRET_HEADER,
	getE2eBootstrapSecret,
	isE2eBootstrapRequestAuthorized,
	shouldInstallE2eAuthBootstrap,
} from './e2e-auth-bootstrap';

describe('e2e auth bootstrap guards', () => {
	test('requires both the enable flag and secret before installing', () => {
		expect(shouldInstallE2eAuthBootstrap({})).toBe(false);
		expect(shouldInstallE2eAuthBootstrap({ ENABLE_E2E_AUTH_BOOTSTRAP: 'true' })).toBe(false);
		expect(
			shouldInstallE2eAuthBootstrap({
				ENABLE_E2E_AUTH_BOOTSTRAP: 'false',
				E2E_AUTH_BOOTSTRAP_SECRET: 'secret',
			}),
		).toBe(false);
		expect(
			shouldInstallE2eAuthBootstrap({
				ENABLE_E2E_AUTH_BOOTSTRAP: 'true',
				E2E_AUTH_BOOTSTRAP_SECRET: 'secret',
			}),
		).toBe(true);
	});

	test('normalizes blank bootstrap secrets to null', () => {
		expect(getE2eBootstrapSecret({ E2E_AUTH_BOOTSTRAP_SECRET: '   ' })).toBeNull();
		expect(getE2eBootstrapSecret({ E2E_AUTH_BOOTSTRAP_SECRET: 'secret' })).toBe('secret');
	});

	test('authorizes only the matching header secret', () => {
		const env = {
			ENABLE_E2E_AUTH_BOOTSTRAP: 'true',
			E2E_AUTH_BOOTSTRAP_SECRET: 'secret',
		};

		expect(isE2eBootstrapRequestAuthorized(new Headers(), env)).toBe(false);
		expect(
			isE2eBootstrapRequestAuthorized(new Headers({ [E2E_BOOTSTRAP_SECRET_HEADER]: 'wrong' }), env),
		).toBe(false);
		expect(
			isE2eBootstrapRequestAuthorized(
				new Headers({ [E2E_BOOTSTRAP_SECRET_HEADER]: 'secret' }),
				env,
			),
		).toBe(true);
	});
});
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run:

```bash
bun test src/lib/e2e-auth-bootstrap.test.ts
```

Expected: FAIL because `src/lib/e2e-auth-bootstrap.ts` does not exist.

- [ ] **Step 3: Implement the guarded Better Auth plugin**

Create `src/lib/e2e-auth-bootstrap.ts`:

```ts
import { setSessionCookie } from 'better-auth/cookies';
import { createAuthEndpoint, type BetterAuthPlugin } from 'better-auth/plugins';
import { z } from 'zod';

export const E2E_BOOTSTRAP_SECRET_HEADER = 'x-e2e-auth-bootstrap-secret';
const E2E_BOOTSTRAP_PROVIDER_ID = 'e2e-bootstrap';

type E2eBootstrapEnv = Partial<
	Pick<Env, 'ENABLE_E2E_AUTH_BOOTSTRAP' | 'E2E_AUTH_BOOTSTRAP_SECRET'>
>;

const bootstrapBodySchema = z.object({
	email: z.string().email(),
	name: z.string().min(1),
	accountId: z.string().min(1).optional(),
});

type BootstrapBody = z.infer<typeof bootstrapBodySchema>;

export function getE2eBootstrapSecret(env: E2eBootstrapEnv): string | null {
	const secret = env.E2E_AUTH_BOOTSTRAP_SECRET?.trim();
	return secret && secret.length > 0 ? secret : null;
}

export function shouldInstallE2eAuthBootstrap(env: E2eBootstrapEnv): boolean {
	return env.ENABLE_E2E_AUTH_BOOTSTRAP === 'true' && getE2eBootstrapSecret(env) !== null;
}

export function isE2eBootstrapRequestAuthorized(headers: Headers, env: E2eBootstrapEnv): boolean {
	const expected = getE2eBootstrapSecret(env);
	return expected !== null && headers.get(E2E_BOOTSTRAP_SECRET_HEADER) === expected;
}

export function e2eAuthBootstrapPlugin(env: E2eBootstrapEnv): BetterAuthPlugin {
	return {
		id: 'e2e-auth-bootstrap',
		endpoints: {
			e2eAuthBootstrap: createAuthEndpoint(
				'/e2e/bootstrap',
				{
					method: 'POST',
					body: bootstrapBodySchema,
				},
				async (ctx) => {
					if (!shouldInstallE2eAuthBootstrap(env)) {
						return ctx.json({ error: 'NOT_FOUND' }, { status: 404 });
					}

					if (!isE2eBootstrapRequestAuthorized(ctx.headers, env)) {
						return ctx.json({ error: 'FORBIDDEN' }, { status: 403 });
					}

					const body = ctx.body as BootstrapBody;
					const accountId = body.accountId ?? `e2e:${body.email}`;
					const existingUser = await ctx.context.internalAdapter.findUserByEmail(body.email, {
						includeAccounts: true,
					});
					const authUser =
						existingUser?.user ??
						(await ctx.context.internalAdapter.createUser(
							{
								email: body.email,
								emailVerified: true,
								image: null,
								name: body.name,
							},
							ctx,
						));

					const existingAccount = await ctx.context.internalAdapter.findAccountByProviderId(
						accountId,
						E2E_BOOTSTRAP_PROVIDER_ID,
					);

					if (existingAccount && existingAccount.userId !== authUser.id) {
						return ctx.json({ error: 'ACCOUNT_CONFLICT' }, { status: 409 });
					}

					if (!existingAccount) {
						await ctx.context.internalAdapter.linkAccount(
							{
								accountId,
								providerId: E2E_BOOTSTRAP_PROVIDER_ID,
								userId: authUser.id,
							},
							ctx,
						);
					}

					const session = await ctx.context.internalAdapter.createSession(authUser.id, ctx);
					await setSessionCookie(ctx, { session, user: authUser });

					return ctx.json({
						ok: true,
						sessionId: session.id,
						userId: authUser.id,
					});
				},
			),
		},
	};
}
```

- [ ] **Step 4: Run the focused test and confirm it passes**

Run:

```bash
bun test src/lib/e2e-auth-bootstrap.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/lib/e2e-auth-bootstrap.ts src/lib/e2e-auth-bootstrap.test.ts
git commit -m "test(auth): add guarded e2e session bootstrap"
```

---

### Task 3: Wire The Bootstrap Plugin Into Auth

**Files:**

- Modify: `src/lib/auth.ts`
- Modify: `src/lib/auth.test.ts`

- [ ] **Step 1: Add failing plugin wiring coverage**

Append this test to `src/lib/auth.test.ts`:

```ts
test('includes the E2E bootstrap plugin only when explicitly enabled', () => {
	const disabledConfig = buildAuthConfig(drizzleDb, completeEnv, undefined, []);
	expect(disabledConfig.plugins).toEqual([]);
});
```

Change the existing auth import at the top of `src/lib/auth.test.ts` to include `getAuthPlugins`:

```ts
import { buildAuthConfig, getAuthPlugins, getRequiredAuthConfig } from './auth';
```

Add this test after the existing auth configuration tests:

```ts
test('getAuthPlugins installs the E2E bootstrap plugin when guarded env is present', () => {
	expect(getAuthPlugins(completeEnv).map((plugin) => plugin.id)).toEqual([]);
	expect(
		getAuthPlugins({
			...completeEnv,
			ENABLE_E2E_AUTH_BOOTSTRAP: 'true',
			E2E_AUTH_BOOTSTRAP_SECRET: 'secret',
		}).map((plugin) => plugin.id),
	).toEqual(['e2e-auth-bootstrap']);
});
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run:

```bash
bun test src/lib/auth.test.ts
```

Expected: FAIL because `getAuthPlugins` is not exported.

- [ ] **Step 3: Implement plugin selection and pass it to Better Auth**

Update `src/lib/auth.ts` imports:

```ts
import { e2eAuthBootstrapPlugin, shouldInstallE2eAuthBootstrap } from './e2e-auth-bootstrap';
```

Add this function before `createAuth`:

```ts
export function getAuthPlugins(env: AuthEnvInput & Partial<Env>): BetterAuthPlugin[] {
	return shouldInstallE2eAuthBootstrap(env) ? [e2eAuthBootstrapPlugin(env)] : [];
}
```

Update `createAuth`:

```ts
export function createAuth(db: D1Database, env: Env, baseURL?: string) {
	const drizzleDb = drizzle(db, { schema });
	return betterAuth(buildAuthConfig(drizzleDb, env, baseURL, getAuthPlugins(env)));
}
```

- [ ] **Step 4: Run focused auth tests**

Run:

```bash
bun test src/lib/auth.test.ts src/lib/e2e-auth-bootstrap.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/lib/auth.ts src/lib/auth.test.ts
git commit -m "feat(auth): wire guarded e2e bootstrap plugin"
```

---

### Task 4: Replace Password UI With Google-Only Sign-In

**Files:**

- Modify: `src/pages/signin.astro`
- Delete: `src/pages/signup.astro`
- Modify: `src/pages/index.astro`
- Modify: `src/components/UserNav.astro`

- [ ] **Step 1: Run the current product password surface scan**

Run:

```bash
rg -n 'href="/signup"|/signup|signUp\.email|signIn\.email|input\[name="password"\]' src
```

Expected: matches in `src/pages/signin.astro`, `src/pages/signup.astro`, `src/pages/index.astro`, and `src/components/UserNav.astro`.

- [ ] **Step 2: Replace the sign-in page**

Replace `src/pages/signin.astro` with:

```astro
---
import CasinoLayout from '../layouts/casino.astro';

const url = new URL(Astro.request.url);
const hasAuthError = url.searchParams.has('error') || url.searchParams.has('error_description');
---

<CasinoLayout title="Sign In - Arcturus Casino">
	<div class="min-h-[80vh] flex items-center justify-center py-12 px-4 sm:px-6 lg:px-8">
		<div class="max-w-md w-full">
			<div
				class="bg-slate-800/50 backdrop-blur-sm rounded-2xl p-8 border border-yellow-500/20 shadow-2xl"
			>
				<div class="text-center mb-8">
					<div class="text-6xl mb-4">🎰</div>
					<h2
						class="text-3xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-yellow-400 to-amber-500"
					>
						Welcome to Arcturus
					</h2>
					<p class="mt-2 text-slate-400">
						Continue with Google to play with your virtual chip balance.
					</p>
				</div>

				{
					hasAuthError && (
						<div class="mb-4 p-4 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
							Google sign-in did not complete. Please try again.
						</div>
					)
				}

				<button
					type="button"
					id="google-signin"
					class="w-full py-4 bg-white rounded-lg font-bold text-lg text-slate-900 hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-yellow-500 focus:ring-offset-2 focus:ring-offset-slate-800 transition-all duration-300 shadow-lg flex items-center justify-center gap-3"
				>
					<span class="text-xl">G</span>
					<span>Continue with Google</span>
				</button>
			</div>

			<div class="text-center mt-6">
				<a href="/" class="text-slate-400 hover:text-yellow-400 transition-colors">
					← Back to Home
				</a>
			</div>
		</div>
	</div>
</CasinoLayout>

<script>
	import { authClient } from '../lib/auth-client';

	const googleButton = document.getElementById('google-signin') as HTMLButtonElement | null;
	googleButton?.addEventListener('click', async () => {
		googleButton.disabled = true;
		try {
			await authClient.signIn.social({
				provider: 'google',
				callbackURL: '/',
				errorCallbackURL: '/signin',
			});
		} catch (error) {
			console.error('Google sign-in error:', error);
			googleButton.disabled = false;
		}
	});
</script>
```

- [ ] **Step 3: Delete the signup route**

Run:

```bash
git rm src/pages/signup.astro
```

Expected: `src/pages/signup.astro` is removed from the index.

- [ ] **Step 4: Update app links from `/signup` to `/signin`**

In `src/pages/index.astro`, replace every `href="/signup"` with `href="/signin"`.

In `src/components/UserNav.astro`, replace the unauthenticated block with:

```astro
<div class="flex items-center gap-3">
	<a href="/signin" class="text-sm text-gray-700 hover:text-gray-900"> Sign In </a>
	<a
		href="/signin"
		class="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700"
	>
		Join Free
	</a>
</div>
```

- [ ] **Step 5: Verify no product route points at `/signup`**

Run:

```bash
rg -n 'href="/signup"|/signup|signUp\.email|signIn\.email|input\[name="password"\]' src e2e
```

Expected: matches remain only in E2E files that will be changed in Tasks 5 and 6. There should be no `src/` matches.

- [ ] **Step 6: Run build to catch deleted-route references**

Run:

```bash
bun run build
```

Expected: PASS with local `.dev.vars` containing non-empty `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, and `GOOGLE_CLIENT_SECRET`.

- [ ] **Step 7: Commit**

Run:

```bash
git add src/pages/signin.astro src/pages/index.astro src/components/UserNav.astro
git add -u src/pages/signup.astro
git commit -m "feat(auth): replace password pages with google sign-in"
```

---

### Task 5: Bootstrap Playwright Storage State Without Password Forms

**Files:**

- Modify: `e2e/auth.setup.ts`
- Create: `e2e/bootstrap-auth.ts`
- Modify: `e2e/global-setup.ts`

- [ ] **Step 1: Write the shared E2E auth constants**

Replace `e2e/auth.setup.ts` with:

```ts
/**
 * Authentication setup constants and utilities for Playwright tests.
 * The real product auth flow is Google-only; tests use a guarded bootstrap endpoint.
 */

export const TEST_USER = {
	email: 'e2e-test@arcturus.local',
	name: 'E2E Test User',
} as const;

export const TEST_USER_2 = {
	email: 'e2e-test-2@arcturus.local',
	name: 'E2E Test User 2',
} as const;

export const TEST_USERS = [
	{
		credentials: TEST_USER,
		authFile: 'user.json',
	},
	{
		credentials: TEST_USER_2,
		authFile: 'user-2.json',
	},
] as const;

export const AUTH_FILE = './e2e/.auth/user.json';
```

- [ ] **Step 2: Create the bootstrap helper**

Create `e2e/bootstrap-auth.ts`:

```ts
import fs from 'fs';
import path from 'path';
import type { BrowserContext, Page } from '@playwright/test';

const E2E_BOOTSTRAP_SECRET_HEADER = 'x-e2e-auth-bootstrap-secret';

export type E2eUserCredentials = {
	email: string;
	name: string;
};

function readDevVars(): Record<string, string> {
	const filePath = path.join(process.cwd(), '.dev.vars');
	if (!fs.existsSync(filePath)) return {};

	return Object.fromEntries(
		fs
			.readFileSync(filePath, 'utf8')
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line.length > 0 && !line.startsWith('#'))
			.map((line) => {
				const separatorIndex = line.indexOf('=');
				if (separatorIndex === -1) return [line, ''];
				return [line.slice(0, separatorIndex), line.slice(separatorIndex + 1)];
			}),
	);
}

export function getE2eBootstrapSecret(): string {
	const secret = process.env.E2E_AUTH_BOOTSTRAP_SECRET ?? readDevVars().E2E_AUTH_BOOTSTRAP_SECRET;
	if (!secret) {
		throw new Error(
			'E2E_AUTH_BOOTSTRAP_SECRET must be set in the environment or .dev.vars for Playwright auth bootstrap',
		);
	}
	return secret;
}

export async function bootstrapTestUser(
	context: BrowserContext,
	baseURL: string,
	credentials: E2eUserCredentials,
): Promise<void> {
	const response = await context.request.post(`${baseURL}/api/auth/e2e/bootstrap`, {
		data: credentials,
		headers: {
			[E2E_BOOTSTRAP_SECRET_HEADER]: getE2eBootstrapSecret(),
		},
	});

	if (!response.ok()) {
		const body = await response.text().catch(() => '');
		throw new Error(`E2E auth bootstrap failed: ${response.status()} ${body}`);
	}
}

export async function bootstrapPage(
	page: Page,
	baseURL: string,
	credentials: E2eUserCredentials,
): Promise<void> {
	await bootstrapTestUser(page.context(), baseURL, credentials);
	await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
}
```

- [ ] **Step 3: Update global setup to use bootstrap**

In `e2e/global-setup.ts`, remove password signup/signin form handling. Keep balance top-up helpers. Import bootstrap helpers and constants:

```ts
import { TEST_USERS } from './auth.setup';
import { bootstrapTestUser } from './bootstrap-auth';
```

Change `provisionUser` to this shape:

```ts
async function provisionUser(
	context: BrowserContext,
	page: Page,
	baseURL: string,
	credentials: { email: string; name: string },
	authFile: string,
): Promise<void> {
	await bootstrapTestUser(context, baseURL, credentials);

	await page.goto(`${baseURL}/missions/daily`, { waitUntil: 'networkidle' });
	await page.locator('[data-chip-balance]').first().waitFor({ state: 'attached', timeout: 10000 });

	let currentBalance = (await readChipBalanceFromPage(page)) ?? 0;
	if (currentBalance < MINIMUM_E2E_CHIP_BALANCE) {
		for (let attempt = 0; attempt < 5; attempt++) {
			const delta = MINIMUM_E2E_CHIP_BALANCE - currentBalance;
			const response = await page.request.post(`${baseURL}/api/chips/update`, {
				data: { delta, gameType: 'blackjack', previousBalance: currentBalance },
			});
			if (response.ok()) {
				let refreshed: number | null = null;
				for (let r = 0; r < 3; r++) {
					await sleep(2100);
					await page.reload({ waitUntil: 'networkidle' });
					refreshed = await readChipBalanceFromPage(page);
					if (typeof refreshed === 'number') break;
				}
				if (typeof refreshed === 'number') {
					currentBalance = refreshed;
					break;
				}
				throw new Error('Chip balance update succeeded but could not be read back');
			}
			if (response.status() === 429) {
				const retryAfter = Number(response.headers()['retry-after'] ?? '2');
				await sleep((Number.isFinite(retryAfter) ? retryAfter : 2) * 1000 + 100);
				currentBalance = (await readChipBalanceFromPage(page)) ?? currentBalance;
				continue;
			}
			if (response.status() === 409) {
				const data = (await response.json().catch(() => null)) as {
					currentBalance?: number;
				} | null;
				if (typeof data?.currentBalance === 'number') {
					currentBalance = data.currentBalance;
					continue;
				}
			}
			const errorText = await response.text().catch(() => '');
			throw new Error(`Failed to top up chip balance: ${response.status()} ${errorText}`);
		}
		if (currentBalance < MINIMUM_E2E_CHIP_BALANCE) {
			throw new Error(
				`Chip balance top-up did not reach minimum (${currentBalance} < ${MINIMUM_E2E_CHIP_BALANCE})`,
			);
		}
	}

	await context.storageState({ path: authFile });
}
```

Delete the old local `TEST_USERS` declaration from `e2e/global-setup.ts`; use the imported one.

- [ ] **Step 4: Run type/lint feedback for E2E files**

Run:

```bash
bunx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add e2e/auth.setup.ts e2e/bootstrap-auth.ts e2e/global-setup.ts
git commit -m "test(e2e): bootstrap auth without passwords"
```

---

### Task 6: Update Auth-Dependent E2E Specs

**Files:**

- Modify: `e2e/auth-helpers.ts`
- Modify: `e2e/profile.spec.ts`
- Modify: `e2e/craps.spec.ts`
- Create: `e2e/auth-ui.spec.ts`

- [ ] **Step 1: Replace `ensureLoggedIn` with bootstrap**

Replace `e2e/auth-helpers.ts` with:

```ts
import type { Page } from '@playwright/test';
import { TEST_USER } from './auth.setup';
import { bootstrapPage } from './bootstrap-auth';

export const waitForHomeRedirect = async (page: Page, timeout = 10000): Promise<boolean> => {
	try {
		await Promise.all([
			page.waitForURL((url) => url.pathname === '/', { timeout }),
			page.waitForLoadState('domcontentloaded', { timeout }),
		]);
		return true;
	} catch {
		return false;
	}
};

const isAuthenticated = async (
	page: Page,
	options: { skipNavigation?: boolean } = {},
): Promise<boolean> => {
	try {
		if (!options.skipNavigation) {
			await page.goto('/', { waitUntil: 'domcontentloaded' });
		} else {
			await page.waitForLoadState('domcontentloaded');
		}
		return await page.locator('[data-chip-balance]').first().isVisible();
	} catch {
		return false;
	}
};

export const ensureLoggedIn = async (page: Page): Promise<void> => {
	if (await isAuthenticated(page)) return;

	const baseURL = new URL(page.url()).origin;
	await bootstrapPage(page, baseURL, TEST_USER);

	if (!(await isAuthenticated(page, { skipNavigation: true }))) {
		throw new Error('Failed to authenticate test user through bootstrap');
	}
};
```

- [ ] **Step 2: Update profile sign-out test**

In `e2e/profile.spec.ts`, add:

```ts
import { bootstrapTestUser } from './bootstrap-auth';
```

Replace the sign-out test setup before `await page.goto(`${appUrl}/profile`);` with:

```ts
const context = await browser.newContext({ storageState: undefined });
await bootstrapTestUser(context, appUrl, TEST_USER);
const page = await context.newPage();
```

Remove the old `/signin` navigation, email fill, password fill, submit click, and home redirect wait from that test.

Update the final text assertion:

```ts
await expect(page.getByRole('button', { name: /continue with google/i })).toBeVisible();
```

- [ ] **Step 3: Update isolated craps test user creation**

In `e2e/craps.spec.ts`, add:

```ts
import { bootstrapTestUser } from './bootstrap-auth';
```

Replace the signup form block in `createIsolatedCrapsPage` with:

```ts
await bootstrapTestUser(context, baseURL ?? 'http://localhost:2000', {
	email: `craps-sync-${nonce}@arcturus.local`,
	name: `Craps Sync ${nonce}`,
});
await page.goto(baseURL ?? 'http://localhost:2000', { waitUntil: 'domcontentloaded' });
await gotoCraps(page);
```

- [ ] **Step 4: Confirm there is no E2E password-form usage**

Run:

```bash
rg -n '/signup|input\[name="password"\]|TEST_USER\.password|signUp\.email|signIn\.email' e2e src
```

Expected: no matches.

- [ ] **Step 5: Add Google-only auth UI coverage**

Create `e2e/auth-ui.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

test.describe('Google-only auth UI', () => {
	test('signin page exposes Google sign-in and no password form', async ({ page }) => {
		await page.goto('/signin');

		await expect(page.getByRole('button', { name: /continue with google/i })).toBeVisible();
		await expect(page.locator('input[name="email"]')).toHaveCount(0);
		await expect(page.locator('input[name="password"]')).toHaveCount(0);
	});

	test('homepage unauthenticated CTA points at signin', async ({ browser, baseURL }) => {
		const context = await browser.newContext({ storageState: undefined });
		const page = await context.newPage();
		await page.goto(baseURL ?? 'http://localhost:2000');

		await expect(page.getByRole('link', { name: /join free/i })).toHaveAttribute('href', '/signin');

		await context.close();
	});
});
```

- [ ] **Step 6: Run targeted auth UI coverage**

Run:

```bash
E2E_AUTH_BOOTSTRAP_SECRET=local-e2e-bootstrap-secret bunx playwright test e2e/auth-ui.spec.ts
```

Expected: PASS with `.dev.vars` containing non-empty `BETTER_AUTH_SECRET`, dummy Google credentials, `ENABLE_E2E_AUTH_BOOTSTRAP=true`, and matching `E2E_AUTH_BOOTSTRAP_SECRET=local-e2e-bootstrap-secret`.

- [ ] **Step 7: Commit**

Run:

```bash
git add e2e/auth-helpers.ts e2e/profile.spec.ts e2e/craps.spec.ts e2e/auth-ui.spec.ts
git commit -m "test(e2e): remove password auth assumptions"
```

---

### Task 7: CI And Documentation

**Files:**

- Modify: `.github/workflows/e2e.yml`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update CI env setup**

In `.github/workflows/e2e.yml`, update the "Create test environment file" step to:

```yaml
- name: Create test environment file
  run: |
    echo "BETTER_AUTH_SECRET=test-secret-for-ci-only-$(openssl rand -base64 32)" > .dev.vars
    echo "GOOGLE_CLIENT_ID=ci-google-client-id" >> .dev.vars
    echo "GOOGLE_CLIENT_SECRET=ci-google-client-secret" >> .dev.vars
    echo "ENABLE_E2E_AUTH_BOOTSTRAP=true" >> .dev.vars
    echo "E2E_AUTH_BOOTSTRAP_SECRET=ci-e2e-bootstrap-secret" >> .dev.vars
    echo "BETTER_AUTH_URL=http://localhost:2000" >> .dev.vars
```

Update the "Run Playwright tests" step env:

```yaml
env:
  CI: true
  E2E_AUTH_BOOTSTRAP_SECRET: ci-e2e-bootstrap-secret
```

- [ ] **Step 2: Update `.env.example`**

Replace `.env.example` with:

```text
# Better Auth Secret (generate with: openssl rand -base64 32)
BETTER_AUTH_SECRET=your_better_auth_secret_here

# Google OAuth credentials
# Authorized redirect URIs:
#   http://localhost:2000/api/auth/callback/google
#   https://<production-origin>/api/auth/callback/google
GOOGLE_CLIENT_ID=your_google_client_id_here
GOOGLE_CLIENT_SECRET=your_google_client_secret_here

# Playwright/local E2E only. Do not enable in production.
ENABLE_E2E_AUTH_BOOTSTRAP=false
E2E_AUTH_BOOTSTRAP_SECRET=
```

- [ ] **Step 3: Update README auth references**

In `README.md`:

- Replace "Email/Password authentication" with "Google OAuth authentication".
- Remove references to `/signup` as a route.
- Change the quick-start port text to `http://localhost:2000`.
- Document the required local `.dev.vars` values:

```text
BETTER_AUTH_SECRET=<secret>
GOOGLE_CLIENT_ID=<google-client-id>
GOOGLE_CLIENT_SECRET=<google-client-secret>
```

- Document Cloudflare secrets:

```bash
wrangler secret put BETTER_AUTH_SECRET
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
```

- [ ] **Step 4: Update repo guidance**

In `CLAUDE.md`, replace the client auth example under "Client Auth" with:

```typescript
import { authClient } from '$lib/auth-client';
await authClient.signIn.social({ provider: 'google', callbackURL: '/' });
await authClient.signOut();
```

Update the deployment section to include:

```bash
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
```

Remove text that instructs engineers to use `authClient.signIn.email` or `authClient.signUp.email`.

- [ ] **Step 5: Run documentation/code reference scan**

Run:

```bash
rg -n 'signIn\.email|signUp\.email|Email/Password|/signup|PlaywrightTest123|password authentication' README.md CLAUDE.md .env.example .github e2e src
```

Expected: no matches that describe product password auth. Matches in historical committed plan/spec docs are acceptable only outside the scanned paths.

- [ ] **Step 6: Commit**

Run:

```bash
git add .github/workflows/e2e.yml .env.example README.md CLAUDE.md
git commit -m "docs(auth): document google-only authentication"
```

---

### Task 8: Verification

**Files:**

- No new files.
- May modify files from earlier tasks only if verification exposes failures.

- [ ] **Step 1: Run unit tests**

Run:

```bash
bun run test
```

Expected: PASS.

- [ ] **Step 2: Run lint**

Run:

```bash
bun run lint
```

Expected: PASS with zero warnings.

- [ ] **Step 3: Run build**

Run:

```bash
bun run build
```

Expected: PASS. If it fails because local Google auth vars are absent, add non-secret local placeholders to `.dev.vars` for build verification:

```text
GOOGLE_CLIENT_ID=local-google-client-id
GOOGLE_CLIENT_SECRET=local-google-client-secret
```

- [ ] **Step 4: Run targeted Playwright auth/profile coverage**

Ensure `.dev.vars` contains:

```text
BETTER_AUTH_SECRET=local-test-secret
GOOGLE_CLIENT_ID=local-google-client-id
GOOGLE_CLIENT_SECRET=local-google-client-secret
ENABLE_E2E_AUTH_BOOTSTRAP=true
E2E_AUTH_BOOTSTRAP_SECRET=local-e2e-bootstrap-secret
```

Run:

```bash
E2E_AUTH_BOOTSTRAP_SECRET=local-e2e-bootstrap-secret bunx playwright test e2e/auth-ui.spec.ts e2e/profile.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Run full E2E**

Run:

```bash
E2E_AUTH_BOOTSTRAP_SECRET=local-e2e-bootstrap-secret bun run test:e2e
```

Expected: PASS.

- [ ] **Step 6: Final scan**

Run:

```bash
rg -n 'signIn\.email|signUp\.email|href="/signup"|src/pages/signup\.astro|PlaywrightTest123' src e2e README.md CLAUDE.md .env.example .github
```

Expected: no matches.

- [ ] **Step 7: Commit verification fixes if any**

If verification required changes, run:

```bash
git add <changed-files>
git commit -m "fix(auth): finish google-only verification"
```

If verification required no changes, do not create an empty commit.
