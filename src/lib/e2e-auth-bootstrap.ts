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

					if (!isE2eBootstrapRequestAuthorized(ctx.headers ?? new Headers(), env)) {
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
