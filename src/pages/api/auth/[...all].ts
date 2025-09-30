import { createAuth } from '../../../lib/auth';
import type { APIRoute } from 'astro';

// Workaround for local development - use a mock D1 binding
async function getMockD1Database() {
	// In development, we'll use the local SQLite database directly
	const fs = await import('node:fs/promises');
	const { join } = await import('node:path');
	const { default: Database } = await import('better-sqlite3');

	const wranglerDir = join(process.cwd(), '.wrangler/state/v3/d1/miniflare-D1DatabaseObject');
	const files = await fs.readdir(wranglerDir);
	const dbFile = files.find((file) => file.endsWith('.sqlite'));

	if (!dbFile) {
		throw new Error('Could not find local D1 database file');
	}

	const dbPath = join(wranglerDir, dbFile);
	const sqlite = new Database(dbPath);

	// Create a D1-like interface
	return {
		prepare: (query: string) => {
			const stmt = sqlite.prepare(query);
			type StatementParams = Parameters<typeof stmt.run>;
			return {
				bind: (...params: StatementParams) => ({
					all: () => {
						const results = stmt.all(...params);
						return { results, success: true };
					},
					first: () => stmt.get(...params),
					run: () => {
						const info = stmt.run(...params);
						return {
							success: true,
							meta: { changes: info.changes, last_row_id: info.lastInsertRowid },
						};
					},
				}),
				all: () => {
					const results = stmt.all();
					return { results, success: true };
				},
				first: () => stmt.get(),
				run: () => {
					const info = stmt.run();
					return {
						success: true,
						meta: { changes: info.changes, last_row_id: info.lastInsertRowid },
					};
				},
			};
		},
	} as unknown as D1Database;
}

export const ALL: APIRoute = async (context) => {
	// Try to get runtime from context.locals first (production)
	const runtime = context.locals.runtime;
	let env = runtime?.env;
	let db: D1Database | null = env?.DB || null;

	// Fallback to mock D1 database (development)
	if (!db && import.meta.env.DEV) {
		try {
			db = await getMockD1Database();
			env = { DB: db, BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET } as Env;
		} catch (error) {
			console.error('Error creating mock D1 database:', error);
		}
	}

	if (!db || !env) {
		return new Response('Database not configured', { status: 500 });
	}

	// Get the base URL from the request
	const url = new URL(context.request.url);
	const baseURL = `${url.protocol}//${url.host}`;

	const auth = createAuth(db, env, baseURL);

	return auth.handler(context.request);
};
