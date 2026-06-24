import { setSessionCookie } from 'better-auth/cookies';
import { createAuthEndpoint, type BetterAuthPlugin } from 'better-auth/plugins';
import { APIError } from 'better-auth';
import { z } from 'zod';

// NOTE: This constant is intentionally duplicated in e2e/bootstrap-auth.ts.
// The Worker-side plugin and the Node-side Playwright helper live in separate
// runtime contexts (Cloudflare Workers vs Node test runner) and must not share
// imports. Keep both copies in sync.
export const E2E_BOOTSTRAP_SECRET_HEADER = 'x-e2e-auth-bootstrap-secret';
export const E2E_BOOTSTRAP_PROVIDER_ID = 'e2e-bootstrap';

export type E2eBootstrapEnv = Partial<
	Pick<Env, 'APP_ENV' | 'ENABLE_E2E_AUTH_BOOTSTRAP' | 'E2E_AUTH_BOOTSTRAP_SECRET'>
>;

/**
 * Minimal shape of a better-auth account row, as returned by
 * `internalAdapter.findUserByEmail(email, { includeAccounts: true })`.
 */
export interface BootstrapAccount {
	providerId: string;
	accountId: string;
}

/**
 * Returns true only when the matched user already owns an `e2e-bootstrap`
 * account. The bootstrap endpoint must never reuse (and therefore authenticate
 * as) an identity created via a real provider (e.g. Google) just because the
 * email collided — that would let a bootstrap request mint a session for a
 * non-bootstrap user.
 */
export function hasBootstrapAccount(accounts: BootstrapAccount[] | undefined | null): boolean {
	return (
		Array.isArray(accounts) && accounts.some((acc) => acc.providerId === E2E_BOOTSTRAP_PROVIDER_ID)
	);
}

const bootstrapBodySchema = z.object({
	email: z.string().email(),
	name: z.string().min(1),
	accountId: z.string().min(1).optional(),
});

export function getE2eBootstrapSecret(env: E2eBootstrapEnv): string | null {
	const secret = env.E2E_AUTH_BOOTSTRAP_SECRET?.trim();
	return secret && secret.length > 0 ? secret : null;
}

export function isE2eAuthBootstrapRuntimeAllowed(env: E2eBootstrapEnv): boolean {
	return env.APP_ENV === 'test' || env.APP_ENV === 'ci';
}

export function shouldInstallE2eAuthBootstrap(env: E2eBootstrapEnv): boolean {
	return (
		isE2eAuthBootstrapRuntimeAllowed(env) &&
		env.ENABLE_E2E_AUTH_BOOTSTRAP === 'true' &&
		getE2eBootstrapSecret(env) !== null
	);
}

function constantTimeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return diff === 0;
}

export function isE2eBootstrapRequestAuthorized(headers: Headers, env: E2eBootstrapEnv): boolean {
	const expected = getE2eBootstrapSecret(env);
	if (expected === null) return false;
	const provided = headers.get(E2E_BOOTSTRAP_SECRET_HEADER);
	if (provided === null) return false;
	return constantTimeEqual(provided, expected);
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
					// Defense-in-depth: the plugin is only installed when
					// shouldInstallE2eAuthBootstrap returns true (see getAuthPlugins),
					// so this check is expected to always pass at request time. It
					// guards against future changes to plugin installation logic.
					if (!shouldInstallE2eAuthBootstrap(env)) {
						throw new APIError('NOT_FOUND', { message: 'NOT_FOUND' });
					}

					if (!isE2eBootstrapRequestAuthorized(ctx.headers ?? new Headers(), env)) {
						throw new APIError('FORBIDDEN', { message: 'FORBIDDEN' });
					}

					const body = ctx.body;
					const accountId = body.accountId ?? `e2e:${body.email}`;
					const existingUser = await ctx.context.internalAdapter.findUserByEmail(body.email, {
						includeAccounts: true,
					});

					let authUser;
					if (existingUser) {
						// Only reuse an identity that was itself bootstrapped. Matching a
						// real (e.g. Google) user purely by email and minting a session
						// for it would let the bootstrap endpoint authenticate as a
						// non-bootstrap identity.
						if (!hasBootstrapAccount(existingUser.accounts)) {
							throw new APIError('CONFLICT', { message: 'EMAIL_CONFLICT' });
						}
						authUser = existingUser.user;
					} else {
						authUser = await ctx.context.internalAdapter.createUser(
							{
								email: body.email,
								emailVerified: true,
								image: null,
								name: body.name,
							},
							ctx,
						);
					}

					const existingAccount = await ctx.context.internalAdapter.findAccountByProviderId(
						accountId,
						E2E_BOOTSTRAP_PROVIDER_ID,
					);

					if (existingAccount && existingAccount.userId !== authUser.id) {
						throw new APIError('CONFLICT', { message: 'ACCOUNT_CONFLICT' });
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
