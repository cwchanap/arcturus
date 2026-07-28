/**
 * Shared mock D1Database helper for mission unit tests.
 *
 * The Miniflare integration tests (board-integration, seed, claim,
 * progress-integration, reroll) prove correctness against real workerd
 * SQLite. But Miniflare is a transitive dep of wrangler and may not
 * contribute to CI coverage. These mock-based tests give us a
 * coverage floor that runs anywhere `bun test` runs — no workerd
 * required.
 *
 * Usage: create a `MockD1` with `makeMockD1()`, register result
 * handlers by SQL prefix with `onFirst()`, `onAll()`, `onRun()`, then
 * pass `mock.binding` as the D1Database argument to the function under
 * test. Inspect `mock.calls` to verify the SQL + bind params issued.
 */

export interface PreparedCall {
	sql: string;
	args: unknown[];
}

interface RunResult {
	meta?: { changes?: number };
	[key: string]: unknown;
}

interface FirstResult {
	[key: string]: unknown;
}

interface AllResult {
	results?: Record<string, unknown>[];
	[key: string]: unknown;
}

type FirstHandler = (args: unknown[]) => FirstResult | null;
type AllHandler = (args: unknown[]) => AllResult;
type RunHandler = (args: unknown[]) => RunResult;

interface Handlers {
	first: Map<string, FirstHandler>;
	all: Map<string, AllHandler>;
	run: Map<string, RunHandler>;
}

export interface MockD1 {
	binding: D1Database;
	calls: PreparedCall[];
	/** Register a handler for `.first()` on statements whose SQL starts with `prefix`. */
	onFirst(prefix: string, handler: FirstHandler): void;
	/** Register a handler for `.all()` on statements whose SQL starts with `prefix`. */
	onAll(prefix: string, handler: AllHandler): void;
	/** Register a handler for `.run()` on statements whose SQL starts with `prefix`. */
	onRun(prefix: string, handler: RunHandler): void;
}

function matchHandler<T>(map: Map<string, T>, sql: string): T | undefined {
	// Longest prefix match — most specific handler wins.
	let best: { prefix: string; handler: T } | null = null;
	for (const [prefix, handler] of map) {
		if (sql.startsWith(prefix)) {
			if (!best || prefix.length > best.prefix.length) best = { prefix, handler };
		}
	}
	return best?.handler;
}

export function makeMockD1(): MockD1 {
	const calls: PreparedCall[] = [];
	const handlers: Handlers = {
		first: new Map(),
		all: new Map(),
		run: new Map(),
	};

	function makeBound(sql: string, args: unknown[]) {
		return {
			sql,
			args,
			first: async <T = FirstResult>(): Promise<T | null> => {
				calls.push({ sql, args });
				const h = matchHandler(handlers.first, sql);
				return (h ? h(args) : null) as T | null;
			},
			all: async <T = Record<string, unknown>>(): Promise<{ results: T[] }> => {
				calls.push({ sql, args });
				const h = matchHandler(handlers.all, sql);
				const result = h ? h(args) : { results: [] };
				return result as { results: T[] };
			},
			run: async <T = RunResult>(): Promise<T> => {
				calls.push({ sql, args });
				const h = matchHandler(handlers.run, sql);
				return (h ? h(args) : { meta: { changes: 0 } }) as T;
			},
		};
	}

	const binding = {
		prepare(sql: string) {
			return {
				sql,
				bind(...args: unknown[]) {
					return makeBound(sql, args);
				},
			};
		},
		async batch<T = RunResult>(stmts: { run: () => Promise<T> }[]): Promise<T[]> {
			const results: T[] = [];
			for (const stmt of stmts) {
				results.push(await stmt.run());
			}
			return results;
		},
	} as unknown as D1Database;

	return {
		binding,
		calls,
		onFirst(prefix, handler) {
			handlers.first.set(prefix, handler);
		},
		onAll(prefix, handler) {
			handlers.all.set(prefix, handler);
		},
		onRun(prefix, handler) {
			handlers.run.set(prefix, handler);
		},
	};
}
