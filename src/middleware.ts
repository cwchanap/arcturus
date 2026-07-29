import type { D1Database } from '@cloudflare/workers-types';
import { defineMiddleware } from 'astro:middleware';
import { eq } from 'drizzle-orm';
import { createAuth } from './lib/auth';
import { createDb } from './lib/db';
import { user as userTable } from './db/schema';

let chipBalanceColumnEnsured = false;

async function ensureChipBalanceColumn(db: D1Database) {
	if (chipBalanceColumnEnsured) {
		return;
	}

	try {
		await db
			.prepare('ALTER TABLE "user" ADD COLUMN "chipBalance" integer DEFAULT 10000 NOT NULL;')
			.run();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!/duplicate column name/i.test(message)) {
			throw error;
		}
	}

	chipBalanceColumnEnsured = true;
}

function createLegacySyncId(): string {
	const randomPart =
		typeof crypto !== 'undefined' && 'randomUUID' in crypto
			? crypto.randomUUID()
			: `${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
	return `legacy_${randomPart}`;
}

async function withLegacyChipSyncId(request: Request): Promise<Request | null> {
	if (
		request.method !== 'POST' ||
		new URL(request.url).pathname !== '/api/chips/update' ||
		!request.headers.get('content-type')?.includes('application/json')
	) {
		return null;
	}

	try {
		const body = (await request.clone().json()) as unknown;
		if (
			typeof body !== 'object' ||
			body === null ||
			Array.isArray(body) ||
			Object.hasOwn(body, 'syncId')
		) {
			return null;
		}

		const headers = new Headers(request.headers);
		headers.delete('content-length');

		return new Request(request.url, {
			method: request.method,
			headers,
			body: JSON.stringify({ ...body, syncId: createLegacySyncId() }),
			redirect: request.redirect,
			signal: request.signal,
		});
	} catch {
		return null;
	}
}

export const onRequest = defineMiddleware(async (context, next) => {
	const rewrittenRequest = await withLegacyChipSyncId(context.request);
	const continueRequest = () => (rewrittenRequest ? next(rewrittenRequest) : next());
	const runtime = context.locals.runtime;
	const env = runtime?.env ?? null;
	const dbBinding = env?.DB ?? null;

	if (!dbBinding || !env) {
		context.locals.session = null;
		context.locals.user = null;
		return continueRequest();
	}

	if (dbBinding && env) {
		// Get the base URL from the request
		const url = new URL(context.request.url);
		const baseURL = `${url.protocol}//${url.host}`;

		// createAuth (and therefore createDb/getSession) must live inside the
		// try below: getRequiredAuthConfig throws when BETTER_AUTH_SECRET /
		// GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET is missing. The middleware
		// runs on every request, so an unguarded throw here takes the whole
		// site down. Falling back to a null session keeps the site online
		// (matching the !dbBinding branch above) while the error is logged.
		try {
			const auth = createAuth(dbBinding, env, baseURL);
			const db = createDb(dbBinding);

			const session = await auth.api.getSession({
				headers: context.request.headers,
			});

			let enrichedUser: App.Locals['user'] = null;

			if (session?.user) {
				await ensureChipBalanceColumn(dbBinding);

				const rawBalance = (session.user as { chipBalance?: number | string | null }).chipBalance;
				let chipBalanceValue =
					typeof rawBalance === 'number'
						? rawBalance
						: typeof rawBalance === 'string'
							? Number(rawBalance)
							: null;

				if (chipBalanceValue === null) {
					try {
						const [row] = await db
							.select({ chipBalance: userTable.chipBalance })
							.from(userTable)
							.where(eq(userTable.id, session.user.id))
							.limit(1);
						chipBalanceValue = row?.chipBalance ?? null;
					} catch (balanceError) {
						console.error('Error loading chip balance:', balanceError);
					}
				}

				if (chipBalanceValue === null) {
					chipBalanceValue = 0;
				}

				// Chip balances are stored/displayed as whole chips.
				// Historically, some game payout math could produce fractional values; normalize.
				if (typeof chipBalanceValue === 'number' && Number.isFinite(chipBalanceValue)) {
					chipBalanceValue = Math.trunc(chipBalanceValue);
				} else {
					chipBalanceValue = 0;
				}

				enrichedUser = {
					...session.user,
					chipBalance: chipBalanceValue,
				};
			}

			context.locals.session = session
				? {
						...session,
						user: enrichedUser ?? session.user,
					}
				: null;
			context.locals.user = enrichedUser ?? (session?.user as App.Locals['user']);
		} catch (error) {
			console.error('Error getting session:', error);
			context.locals.session = null;
			context.locals.user = null;
		}
	}

	return continueRequest();
});
