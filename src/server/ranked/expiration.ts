import { createRankedLogEntry, type RankedLogEntry } from './logging';
import { createRankedRepository } from './repository';

export interface RankedExpirationDeps {
	expire(sessionId: string): Promise<unknown>;
	nowSeconds?: () => number;
	log?: (entry: RankedLogEntry) => void;
}

function currentEpochSeconds(): number {
	return Math.trunc(Date.now() / 1000);
}

function defaultLog(entry: RankedLogEntry): void {
	console.warn('[RANKED]', entry);
}

export async function runRankedExpiration(
	db: D1Database,
	deps: RankedExpirationDeps,
): Promise<void> {
	const repository = createRankedRepository(db);
	const nowSeconds = (deps.nowSeconds ?? currentEpochSeconds)();
	const sessionIds = await repository.listExpiredSessions(nowSeconds);
	const log = deps.log ?? defaultLog;

	for (const sessionId of sessionIds) {
		try {
			await deps.expire(sessionId);
			log(createRankedLogEntry('ranked_session_expired', { sessionId }));
		} catch {
			log(createRankedLogEntry('ranked_invariant_violation', { sessionId }));
		}
	}
}

export async function runRankedRateLimitCleanup(db: D1Database, nowSeconds: number): Promise<void> {
	await createRankedRepository(db).deleteExpiredRateBuckets(nowSeconds);
}
