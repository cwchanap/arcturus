import type { D1Database } from '@cloudflare/workers-types';
import { defineMiddleware } from 'astro:middleware';
import { eq } from 'drizzle-orm';
import { createAuth } from './lib/auth';
import { createDb } from './lib/db';
import { getMockD1Database } from './lib/mock-d1';
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

export const onRequest = defineMiddleware(async (context, next) => {
	const runtime = context.locals.runtime;

	let env = runtime?.env ?? null;
	let dbBinding = env?.DB ?? null;

	if (!dbBinding && import.meta.env.DEV) {
		try {
			dbBinding = await getMockD1Database();
			env = {
				DB: dbBinding,
				BETTER_AUTH_SECRET: env?.BETTER_AUTH_SECRET ?? process.env.BETTER_AUTH_SECRET,
			} as Env;
		} catch (mockError) {
			console.error('Error creating mock D1 database:', mockError);
		}
	}

	if (!dbBinding || !env) {
		context.locals.session = null;
		context.locals.user = null;
		return next();
	}

	if (dbBinding && env) {
		// Get the base URL from the request
		const url = new URL(context.request.url);
		const baseURL = `${url.protocol}//${url.host}`;

		const auth = createAuth(dbBinding, env, baseURL);
		const db = createDb(dbBinding);

		try {
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

	return next();
});
