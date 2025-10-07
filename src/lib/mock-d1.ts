import type { D1Database } from '@cloudflare/workers-types';

// Utility to access the local wrangler-managed SQLite database during development.
export async function getMockD1Database(): Promise<D1Database> {
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
